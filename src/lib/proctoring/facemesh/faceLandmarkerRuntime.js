import { resolveFaceMonitoringConfig } from './faceMonitoringConfig.js';

export class FaceLandmarkerRuntime {
  constructor(options = {}) {
    this.video = options.video || null;
    this.config = resolveFaceMonitoringConfig(options.config);
    this.onObservation = typeof options.onObservation === 'function' ? options.onObservation : () => {};
    this.onStatus = typeof options.onStatus === 'function' ? options.onStatus : () => {};
    this.worker = null;
    this.handWorker = null;
    this.timer = null;
    this.handTimer = null;
    this.initTimer = null;
    this.handInitTimer = null;
    this.ready = false;
    this.handReady = false;
    this.inFlight = false;
    this.handInFlight = false;
    this.requestId = 0;
    this.handRequestId = 0;
    this.lastVideoTimestampMs = -1;
    this.lastHandVideoTimestampMs = -1;
    this.lastHandCount = null;
    this.generation = 0;
    this.cancelInitialization = null;
    this.startPromise = null;
  }

  async _createFrameBitmap() {
    const sourceWidth = Number(this.video?.videoWidth || 0);
    const sourceHeight = Number(this.video?.videoHeight || 0);
    const maximumDimension = Number(this.config.maximumInferenceDimension || 640);
    const largestDimension = Math.max(sourceWidth, sourceHeight);
    if (!sourceWidth || !sourceHeight || largestDimension <= maximumDimension) {
      return createImageBitmap(this.video);
    }

    const scale = maximumDimension / largestDimension;
    try {
      return await createImageBitmap(this.video, {
        resizeWidth: Math.max(1, Math.round(sourceWidth * scale)),
        resizeHeight: Math.max(1, Math.round(sourceHeight * scale)),
        resizeQuality: 'medium',
      });
    } catch (_) {
      // Older Chromium builds may not support resize options for video frames.
      return createImageBitmap(this.video);
    }
  }

  start() {
    if (this.worker) return this.startPromise || Promise.resolve();
    if (!this.video) return Promise.resolve();
    const generation = ++this.generation;
    this.onStatus({ state: 'loading' });
    this.startPromise = new Promise((resolve, reject) => {
      const worker = new Worker(new URL('./faceLandmarker.worker.js', import.meta.url), { type: 'module' });
      this.worker = worker;
      const handModelUrl = this.config.randomForest?.handModelUrl;
      const handWorker = handModelUrl
        ? new Worker(new URL('./handLandmarker.worker.js', import.meta.url), { type: 'module' })
        : null;
      this.handWorker = handWorker;
      let settled = false;
      let faceReady = false;
      let handSettled = !handWorker;
      let faceBackend = '';
      let faceInitializationStarted = false;
      const finish = (error = null) => {
        if (settled) return;
        settled = true;
        clearTimeout(this.initTimer);
        this.initTimer = null;
        this.cancelInitialization = null;
        this.startPromise = null;
        if (error) reject(error);
        else resolve();
      };
      const startFaceInitialization = () => {
        if (faceInitializationStarted || generation !== this.generation) return;
        faceInitializationStarted = true;
        worker.postMessage({
          type: 'init',
          modelUrl: this.config.modelUrl,
          wasmRoot: this.config.wasmRoot,
          options: this.config,
        });
      };
      const beginCaptureIfReady = () => {
        if (!faceReady || !handSettled || settled) return;
        clearTimeout(this.handInitTimer);
        this.handInitTimer = null;
        this.ready = true;
        this.onStatus({
          state: 'ready',
          backend: faceBackend,
          handTrackingAvailable: this.handReady,
        });
        const intervalMs = Math.round(1000 / this.config.inferenceFps);
        this.timer = setInterval(() => this._captureFrame(), intervalMs);
        this._captureFrame();
        if (this.handReady) {
          const handIntervalMs = Number(this.config.randomForest?.handInferenceIntervalMs || 300);
          this.handTimer = setInterval(() => this._captureHandFrame(), handIntervalMs);
          this._captureHandFrame();
        }
        finish();
      };
      const settleUnavailableHand = message => {
        if (handSettled) {
          this._disableHandTracking(message);
          return;
        }
        handSettled = true;
        this.handReady = false;
        this.handInFlight = false;
        this.lastHandCount = null;
        clearTimeout(this.handInitTimer);
        this.handInitTimer = null;
        if (this.handWorker) {
          this.handWorker.terminate();
          this.handWorker = null;
        }
        this.onStatus({ state: 'hand-unavailable', message });
        startFaceInitialization();
        beginCaptureIfReady();
      };
      this.cancelInitialization = () => finish(new Error('Face Landmarker initialization was cancelled.'));

      worker.addEventListener('message', event => {
        if (generation !== this.generation) return;
        const message = event.data || {};
        if (message.type === 'ready') {
          faceReady = true;
          faceBackend = message.backend || '';
          beginCaptureIfReady();
        } else if (message.type === 'fallback') {
          this.onStatus({ state: 'fallback', message: message.message || 'GPU unavailable; using CPU.' });
        } else if (message.type === 'hand-unavailable') {
          this.onStatus({ state: 'hand-unavailable', message: message.message || 'Hand tracking is unavailable.' });
        } else if (message.type === 'result') {
          this.inFlight = false;
          this.onObservation({
            ...message.observation,
            handCount: this.handReady ? this.lastHandCount : null,
            handTrackingAvailable: this.handReady,
            wallClockMs: Date.now(),
          });
        } else if (message.type === 'inference-error') {
          this.inFlight = false;
          this.onStatus({ state: 'degraded', message: message.message || 'Face inference failed.' });
        } else if (message.type === 'init-error') {
          const error = new Error(message.message || 'Face Landmarker failed to initialize.');
          this.onStatus({ state: 'error', message: error.message });
          finish(error);
          this.stop();
        }
      });
      worker.addEventListener('error', event => {
        const error = new Error(event.message || 'Face Landmarker worker failed.');
        this.onStatus({ state: 'error', message: error.message });
        finish(error);
        this.stop();
      });

      if (handWorker) {
        handWorker.addEventListener('message', event => {
          if (generation !== this.generation) return;
          const message = event.data || {};
          if (message.type === 'ready') {
            handSettled = true;
            this.handReady = true;
            this.lastHandCount = null;
            startFaceInitialization();
            beginCaptureIfReady();
          } else if (message.type === 'result') {
            this.handInFlight = false;
            this.lastHandCount = Number.isFinite(Number(message.handCount))
              ? Math.min(3, Math.max(0, Math.round(Number(message.handCount))))
              : null;
          } else if (message.type === 'init-error') {
            settleUnavailableHand(message.message || 'Hand Landmarker failed to initialize.');
          } else if (message.type === 'inference-error') {
            this._disableHandTracking(message.message || 'Hand inference failed.');
          }
        });
        handWorker.addEventListener('error', event => {
          settleUnavailableHand(event.message || 'Hand Landmarker worker failed.');
        });
        this.handInitTimer = setTimeout(() => {
          settleUnavailableHand('Hand Landmarker initialization timed out.');
        }, Math.min(10000, this.config.initTimeoutMs));
        handWorker.postMessage({
          type: 'init',
          modelUrl: handModelUrl,
          options: this.config.randomForest,
        });
      }

      this.initTimer = setTimeout(() => {
        const error = new Error('Face Landmarker initialization timed out.');
        this.onStatus({ state: 'error', message: error.message });
        finish(error);
        this.stop();
      }, this.config.initTimeoutMs);

      if (!handWorker) startFaceInitialization();
    });
    return this.startPromise;
  }

  async _captureFrame() {
    if (!this.ready || this.inFlight || !this.worker || !this.video || this.video.readyState < 2) return;
    const timestampMs = Math.round(Number(this.video.currentTime || 0) * 1000);
    if (timestampMs <= this.lastVideoTimestampMs) return;
    this.lastVideoTimestampMs = timestampMs;
    this.inFlight = true;
    const requestId = ++this.requestId;
    try {
      const bitmap = await this._createFrameBitmap();
      if (!this.worker || !this.ready) {
        bitmap.close?.();
        this.inFlight = false;
        return;
      }
      this.worker.postMessage({
        type: 'infer',
        requestId,
        bitmap,
        timestampMs,
        frameWidth: this.video.videoWidth || bitmap.width,
        frameHeight: this.video.videoHeight || bitmap.height,
        geometryConfig: this.config.geometry,
      }, [bitmap]);
    } catch (error) {
      this.inFlight = false;
      this.onStatus({ state: 'degraded', message: error?.message || 'Unable to capture a face frame.' });
    }
  }

  async _captureHandFrame() {
    if (!this.ready || !this.handReady || this.handInFlight || !this.handWorker || !this.video || this.video.readyState < 2) return;
    const timestampMs = Math.round(Number(this.video.currentTime || 0) * 1000);
    if (timestampMs <= this.lastHandVideoTimestampMs) return;
    this.lastHandVideoTimestampMs = timestampMs;
    this.handInFlight = true;
    const requestId = ++this.handRequestId;
    try {
      const bitmap = await this._createFrameBitmap();
      if (!this.handWorker || !this.handReady) {
        bitmap.close?.();
        this.handInFlight = false;
        return;
      }
      this.handWorker.postMessage({ type: 'infer', requestId, bitmap, timestampMs }, [bitmap]);
    } catch (error) {
      this.handInFlight = false;
      this._disableHandTracking(error?.message || 'Unable to capture a hand-tracking frame.');
    }
  }

  _disableHandTracking(message) {
    if (!this.handReady && !this.handWorker) return;
    this.handReady = false;
    this.handInFlight = false;
    this.lastHandCount = null;
    if (this.handTimer) clearInterval(this.handTimer);
    this.handTimer = null;
    if (this.handWorker) {
      try { this.handWorker.postMessage({ type: 'close' }); } catch (_) {}
      this.handWorker.terminate();
    }
    this.handWorker = null;
    this.onStatus({ state: 'hand-unavailable', message });
  }

  stop() {
    const cancelInitialization = this.cancelInitialization;
    this.cancelInitialization = null;
    this.generation += 1;
    if (this.timer) clearInterval(this.timer);
    if (this.handTimer) clearInterval(this.handTimer);
    if (this.initTimer) clearTimeout(this.initTimer);
    if (this.handInitTimer) clearTimeout(this.handInitTimer);
    this.timer = null;
    this.handTimer = null;
    this.initTimer = null;
    this.handInitTimer = null;
    if (this.worker) {
      try { this.worker.postMessage({ type: 'close' }); } catch (_) {}
      this.worker.terminate();
    }
    if (this.handWorker) {
      try { this.handWorker.postMessage({ type: 'close' }); } catch (_) {}
      this.handWorker.terminate();
    }
    this.worker = null;
    this.handWorker = null;
    this.ready = false;
    this.handReady = false;
    this.inFlight = false;
    this.handInFlight = false;
    this.lastVideoTimestampMs = -1;
    this.lastHandVideoTimestampMs = -1;
    this.lastHandCount = null;
    cancelInitialization?.();
  }
}

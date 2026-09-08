import { resolveFaceMonitoringConfig } from './faceMonitoringConfig.js';

export class FaceLandmarkerRuntime {
  constructor(options = {}) {
    this.video = options.video || null;
    this.config = resolveFaceMonitoringConfig(options.config);
    this.onObservation = typeof options.onObservation === 'function' ? options.onObservation : () => {};
    this.onStatus = typeof options.onStatus === 'function' ? options.onStatus : () => {};
    this.worker = null;
    this.timer = null;
    this.initTimer = null;
    this.ready = false;
    this.inFlight = false;
    this.requestId = 0;
    this.lastVideoTimestampMs = -1;
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
      let settled = false;
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
      this.cancelInitialization = () => finish(new Error('Face Landmarker initialization was cancelled.'));

      worker.addEventListener('message', event => {
        if (generation !== this.generation) return;
        const message = event.data || {};
        if (message.type === 'ready') {
          this.ready = true;
          this.onStatus({ state: 'ready', backend: message.backend || '' });
          const intervalMs = Math.round(1000 / this.config.inferenceFps);
          this.timer = setInterval(() => this._captureFrame(), intervalMs);
          this._captureFrame();
          finish();
        } else if (message.type === 'fallback') {
          this.onStatus({ state: 'fallback', message: message.message || 'GPU unavailable; using CPU.' });
        } else if (message.type === 'result') {
          this.inFlight = false;
          this.onObservation({ ...message.observation, wallClockMs: Date.now() });
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

      this.initTimer = setTimeout(() => {
        const error = new Error('Face Landmarker initialization timed out.');
        this.onStatus({ state: 'error', message: error.message });
        finish(error);
        this.stop();
      }, this.config.initTimeoutMs);

      worker.postMessage({
        type: 'init',
        modelUrl: this.config.modelUrl,
        wasmRoot: this.config.wasmRoot,
        options: this.config,
      });
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

  stop() {
    const cancelInitialization = this.cancelInitialization;
    this.cancelInitialization = null;
    this.generation += 1;
    if (this.timer) clearInterval(this.timer);
    if (this.initTimer) clearTimeout(this.initTimer);
    this.timer = null;
    this.initTimer = null;
    if (this.worker) {
      try { this.worker.postMessage({ type: 'close' }); } catch (_) {}
      this.worker.terminate();
    }
    this.worker = null;
    this.ready = false;
    this.inFlight = false;
    this.lastVideoTimestampMs = -1;
    cancelInitialization?.();
  }
}

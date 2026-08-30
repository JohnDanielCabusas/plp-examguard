const DEFAULT_MANIFEST_URL = '/models/yolo-proctor-v1.json';
const modelAssetPromises = new Map();

async function verifyModelChecksum(manifest, modelBuffer) {
  const expected = String(manifest?.sha256 || '').trim().toLowerCase();
  if (!expected || !globalThis.crypto?.subtle) return;
  const digest = await globalThis.crypto.subtle.digest('SHA-256', modelBuffer);
  const actual = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
  if (actual !== expected) throw new Error('YOLO model checksum verification failed.');
}

function loadModelAssets(manifestUrl = DEFAULT_MANIFEST_URL) {
  if (modelAssetPromises.has(manifestUrl)) return modelAssetPromises.get(manifestUrl);

  const promise = (async () => {
    const response = await fetch(manifestUrl, { cache: 'no-cache' });
    if (!response.ok) throw new Error(`YOLO manifest failed to load (${response.status}).`);
    const manifest = await response.json();
    const modelResponse = await fetch(manifest.modelUrl, { cache: 'force-cache' });
    if (!modelResponse.ok) throw new Error(`YOLO model failed to load (${modelResponse.status}).`);
    const modelBuffer = await modelResponse.arrayBuffer();
    await verifyModelChecksum(manifest, modelBuffer);
    return { manifest, modelBuffer };
  })().catch(error => {
    modelAssetPromises.delete(manifestUrl);
    throw error;
  });

  modelAssetPromises.set(manifestUrl, promise);
  return promise;
}

export async function preloadYoloModel(manifestUrl = DEFAULT_MANIFEST_URL) {
  const { manifest } = await loadModelAssets(manifestUrl);
  return {
    version: manifest.version || '',
    modelUrl: manifest.modelUrl || '',
    modelProfile: manifest.modelProfile || '',
    detectorRole: manifest.detectorRole || 'primary',
  };
}

export class YoloMonitor {
  constructor(options = {}) {
    this.video = options.video || null;
    this.manifestUrl = options.manifestUrl || DEFAULT_MANIFEST_URL;
    this.onResult = typeof options.onResult === 'function' ? options.onResult : () => {};
    this.onStatus = typeof options.onStatus === 'function' ? options.onStatus : () => {};
    this.worker = null;
    this.timer = null;
    this.ready = false;
    this.inFlight = false;
    this.requestId = 0;
    this.frameIntervalMs = 1000;
    this.manifest = null;
    this.backend = '';
    this.modelVersion = '';
    this.modelProfile = '';
    this.detectorRole = 'primary';
    this.startGeneration = 0;
  }

  async start() {
    if (this.worker || !this.video) return;
    const generation = ++this.startGeneration;
    this.onStatus({ state: 'loading' });
    const assets = await loadModelAssets(this.manifestUrl);
    if (generation !== this.startGeneration) return;
    this.manifest = assets.manifest;
    this.frameIntervalMs = Math.max(250, Number(this.manifest.frameIntervalMs || 1000));
    const modelBuffer = assets.modelBuffer.slice(0);

    this.worker = new Worker(new URL('./yoloWorker.js', import.meta.url), { type: 'module' });
    this.worker.addEventListener('message', event => this._handleWorkerMessage(event.data || {}));
    this.worker.addEventListener('error', event => {
      this.onStatus({ state: 'error', message: event.message || 'YOLO worker failed.' });
      this.stop();
    });
    this.worker.postMessage({ type: 'init', manifest: this.manifest, modelBuffer }, [modelBuffer]);
  }

  _handleWorkerMessage(message) {
    if (message.type === 'ready') {
      this.ready = true;
      this.backend = message.backend || '';
      this.modelVersion = message.modelVersion || this.manifest?.version || '';
      this.modelProfile = message.modelProfile || this.manifest?.modelProfile || '';
      this.detectorRole = message.detectorRole || this.manifest?.detectorRole || 'primary';
      this.onStatus({
        state: 'ready',
        backend: this.backend,
        modelVersion: this.modelVersion,
        modelProfile: this.modelProfile,
        detectorRole: this.detectorRole,
      });
      this.timer = setInterval(() => this._captureFrame(), this.frameIntervalMs);
      this._captureFrame();
      return;
    }

    if (message.type === 'result') {
      this.inFlight = false;
      this.onResult({
        detections: Array.isArray(message.detections) ? message.detections : [],
        backend: message.backend || this.backend,
        modelVersion: message.modelVersion || this.modelVersion,
        modelProfile: message.modelProfile || this.modelProfile,
        detectorRole: message.detectorRole || this.detectorRole,
        inferenceMs: Number(message.inferenceMs || 0),
        capturedAt: new Date().toISOString(),
      });
      return;
    }

    if (message.type === 'inference-error') {
      this.inFlight = false;
      this.onStatus({ state: 'degraded', message: message.message || 'YOLO inference failed.' });
      return;
    }

    if (message.type === 'init-error') {
      this.onStatus({ state: 'error', message: message.message || 'YOLO model failed to initialize.' });
      this.stop();
    }
  }

  async _captureFrame() {
    if (!this.ready || this.inFlight || !this.worker || !this.video || this.video.readyState < 2) return;
    this.inFlight = true;
    const requestId = ++this.requestId;
    try {
      const bitmap = await createImageBitmap(this.video);
      if (!this.worker || !this.ready) {
        bitmap.close?.();
        this.inFlight = false;
        return;
      }
      this.worker.postMessage({ type: 'infer', requestId, bitmap }, [bitmap]);
    } catch (error) {
      this.inFlight = false;
      this.onStatus({ state: 'degraded', message: error?.message || 'Unable to capture a YOLO frame.' });
    }
  }

  stop() {
    this.startGeneration += 1;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.worker?.terminate();
    this.worker = null;
    this.ready = false;
    this.inFlight = false;
  }
}

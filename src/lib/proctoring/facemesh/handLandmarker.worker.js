import { HandLandmarker } from '@mediapipe/tasks-vision';
import simdLoaderUrl from '@mediapipe/tasks-vision/vision_wasm_module_internal.js?url';
import simdBinaryUrl from '@mediapipe/tasks-vision/vision_wasm_module_internal.wasm?url';
import noSimdLoaderUrl from '@mediapipe/tasks-vision/vision_wasm_nosimd_internal.js?url';
import noSimdBinaryUrl from '@mediapipe/tasks-vision/vision_wasm_nosimd_internal.wasm?url';

let landmarker = null;
let backend = '';

async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, '0')).join('');
}

async function createLandmarker(fileset, message, modelBytes) {
  const options = message.options || {};
  return HandLandmarker.createFromOptions(fileset, {
    baseOptions: { modelAssetBuffer: modelBytes.slice(), delegate: 'CPU' },
    runningMode: 'VIDEO',
    numHands: Number(options.maximumHands || 3),
    minHandDetectionConfidence: Number(options.minHandDetectionConfidence || 0.5),
    minHandPresenceConfidence: Number(options.minHandPresenceConfidence || 0.5),
    minTrackingConfidence: Number(options.minHandTrackingConfidence || 0.5),
  });
}

async function initialize(message) {
  try {
    const response = await fetch(message.modelUrl, { cache: 'force-cache' });
    if (!response.ok) {
      throw new Error(`Hand Landmarker model request failed (${response.status}).`);
    }
    const modelBytes = new Uint8Array(await response.arrayBuffer());
    if (!modelBytes.byteLength) throw new Error('Hand Landmarker model is empty.');
    const expectedHash = String(message.options?.handModelSha256 || '').trim().toLowerCase();
    if (expectedHash && await sha256Hex(modelBytes) !== expectedHash) {
      throw new Error('Hand Landmarker model checksum does not match the configured asset.');
    }
    const simdFileset = { wasmLoaderPath: simdLoaderUrl, wasmBinaryPath: simdBinaryUrl };
    const noSimdFileset = { wasmLoaderPath: noSimdLoaderUrl, wasmBinaryPath: noSimdBinaryUrl };
    try {
      landmarker = await createLandmarker(simdFileset, message, modelBytes);
      backend = 'cpu';
    } catch (simdError) {
      landmarker?.close?.();
      landmarker = await createLandmarker(noSimdFileset, message, modelBytes);
      backend = 'cpu-nosimd';
      self.postMessage({ type: 'fallback', message: String(simdError?.message || simdError) });
    }
    self.postMessage({ type: 'ready', backend });
  } catch (error) {
    self.postMessage({ type: 'init-error', message: String(error?.message || error) });
  }
}

function infer(message) {
  const bitmap = message.bitmap;
  const startedAt = performance.now();
  try {
    if (!landmarker) throw new Error('Hand Landmarker is not initialized.');
    const result = landmarker.detectForVideo(bitmap, message.timestampMs);
    self.postMessage({
      type: 'result',
      requestId: message.requestId,
      handCount: Math.min(3, Math.max(0, Number(result?.landmarks?.length || 0))),
      inferenceMs: performance.now() - startedAt,
      backend,
    });
  } catch (error) {
    self.postMessage({
      type: 'inference-error',
      requestId: message.requestId,
      message: String(error?.message || error),
    });
  } finally {
    bitmap?.close?.();
  }
}

self.addEventListener('message', event => {
  const message = event.data || {};
  if (message.type === 'init') initialize(message);
  else if (message.type === 'infer') infer(message);
  else if (message.type === 'close') {
    landmarker?.close?.();
    landmarker = null;
    self.close?.();
  }
});

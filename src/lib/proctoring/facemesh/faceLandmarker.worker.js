import { FaceLandmarker } from '@mediapipe/tasks-vision';
import simdLoaderUrl from '@mediapipe/tasks-vision/vision_wasm_module_internal.js?url';
import simdBinaryUrl from '@mediapipe/tasks-vision/vision_wasm_module_internal.wasm?url';
import noSimdLoaderUrl from '@mediapipe/tasks-vision/vision_wasm_nosimd_internal.js?url';
import noSimdBinaryUrl from '@mediapipe/tasks-vision/vision_wasm_nosimd_internal.wasm?url';
import { estimateHeadPose, smoothHeadPose } from './headPoseEstimator.js';

const TRACKED_LANDMARKS = [1, 10, 33, 61, 152, 263, 291];
const FACE_OVAL_LANDMARKS = [10, 21, 54, 58, 67, 93, 103, 109, 127, 132, 136, 148, 149, 150, 152, 162, 172, 176, 234, 251, 284, 288, 297, 323, 332, 338, 356, 361, 365, 377, 378, 379, 389, 397, 400, 454];

let landmarker = null;
let backend = '';
let lastTrackedPoints = null;
let lastSmoothedPose = null;
let poseSmoothingAlpha = 0.5;

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function geometryFromLandmarks(landmarks, geometryConfig) {
  const oval = FACE_OVAL_LANDMARKS.map(index => landmarks[index]).filter(Boolean);
  if (!oval.length) return null;
  const xs = oval.map(item => item.x);
  const ys = oval.map(item => item.y);
  const left = Math.min(...xs);
  const top = Math.min(...ys);
  const right = Math.max(...xs);
  const bottom = Math.max(...ys);
  const width = Math.max(0, right - left);
  const height = Math.max(0, bottom - top);
  const margin = geometryConfig.partialMarginRatio;
  const edgeMargin = geometryConfig.edgeMarginRatio;

  return {
    x: left,
    y: top,
    width,
    height,
    centerX: left + (width / 2),
    centerY: top + (height / 2),
    partiallyVisible: left <= margin || top <= margin || right >= 1 - margin || bottom >= 1 - margin,
    nearFrameEdge: left <= edgeMargin || top <= edgeMargin || right >= 1 - edgeMargin || bottom >= 1 - edgeMargin,
    tooClose: width >= geometryConfig.tooCloseWidthRatio || height >= geometryConfig.tooCloseHeightRatio,
    tooFar: width <= geometryConfig.tooFarWidthRatio || height <= geometryConfig.tooFarHeightRatio,
  };
}

function calculateTrackingQuality(landmarks, geometry) {
  const points = TRACKED_LANDMARKS.map(index => landmarks[index]).filter(Boolean);
  if (points.length !== TRACKED_LANDMARKS.length || !geometry?.width || !geometry?.height) {
    lastTrackedPoints = null;
    return 0;
  }
  const normalized = points.map(value => ({
    x: (value.x - geometry.centerX) / geometry.width,
    y: (value.y - geometry.centerY) / geometry.height,
  }));
  if (!lastTrackedPoints) {
    lastTrackedPoints = normalized;
    return 1;
  }
  const meanSquared = normalized.reduce((sum, value, index) => {
    const previous = lastTrackedPoints[index];
    return sum + ((value.x - previous.x) ** 2) + ((value.y - previous.y) ** 2);
  }, 0) / normalized.length;
  lastTrackedPoints = normalized;
  return clamp(Math.exp(-Math.sqrt(meanSquared) * 18), 0, 1);
}

async function createLandmarker(fileset, modelUrl, options, delegate) {
  return FaceLandmarker.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: modelUrl, delegate },
    runningMode: 'VIDEO',
    numFaces: 1,
    minFaceDetectionConfidence: options.minFaceDetectionConfidence,
    minFacePresenceConfidence: options.minFacePresenceConfidence,
    minTrackingConfidence: options.minTrackingConfidence,
    // Blendshapes are not consumed by the monitoring policy. Avoiding that
    // extra output keeps each scan focused on landmarks and head pose.
    outputFaceBlendshapes: false,
    outputFacialTransformationMatrixes: true,
  });
}

async function initialize(message) {
  try {
    poseSmoothingAlpha = Number(message.options?.pose?.smoothingAlpha || 0.5);
    lastSmoothedPose = null;
    const simdFileset = { wasmLoaderPath: simdLoaderUrl, wasmBinaryPath: simdBinaryUrl };
    const noSimdFileset = { wasmLoaderPath: noSimdLoaderUrl, wasmBinaryPath: noSimdBinaryUrl };
    try {
      landmarker = await createLandmarker(simdFileset, message.modelUrl, message.options, 'GPU');
      backend = 'gpu';
    } catch (gpuError) {
      landmarker?.close?.();
      self.postMessage({ type: 'fallback', message: String(gpuError?.message || gpuError) });
      try {
        landmarker = await createLandmarker(simdFileset, message.modelUrl, message.options, 'CPU');
        backend = 'cpu';
      } catch (simdError) {
        landmarker?.close?.();
        landmarker = await createLandmarker(noSimdFileset, message.modelUrl, message.options, 'CPU');
        backend = 'cpu-nosimd';
        self.postMessage({ type: 'fallback', message: String(simdError?.message || simdError) });
      }
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
    if (!landmarker) throw new Error('Face Landmarker is not initialized.');
    const result = landmarker.detectForVideo(bitmap, message.timestampMs);
    const landmarks = result.faceLandmarks?.[0] || null;
    if (!landmarks) {
      lastTrackedPoints = null;
      lastSmoothedPose = null;
      self.postMessage({
        type: 'result',
        requestId: message.requestId,
        observation: {
          timestampMs: message.timestampMs,
          facePresent: false,
          trackingQuality: 0,
          geometry: null,
          pose: null,
          backend,
          inferenceMs: performance.now() - startedAt,
          frameWidth: message.frameWidth,
          frameHeight: message.frameHeight,
        },
      });
      return;
    }

    const geometry = geometryFromLandmarks(landmarks, message.geometryConfig);
    const trackingQuality = calculateTrackingQuality(landmarks, geometry);
    const pose = smoothHeadPose(
      lastSmoothedPose,
      estimateHeadPose(result),
      poseSmoothingAlpha,
    );
    lastSmoothedPose = pose;
    self.postMessage({
      type: 'result',
      requestId: message.requestId,
      observation: {
        timestampMs: message.timestampMs,
        facePresent: true,
        trackingQuality,
        geometry,
        pose,
        partiallyVisible: geometry?.partiallyVisible === true,
        nearFrameEdge: geometry?.nearFrameEdge === true,
        tooClose: geometry?.tooClose === true,
        tooFar: geometry?.tooFar === true,
        trackingUnstable: trackingQuality < message.geometryConfig.unstableTrackingQuality,
        backend,
        inferenceMs: performance.now() - startedAt,
        frameWidth: message.frameWidth,
        frameHeight: message.frameHeight,
      },
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
    lastTrackedPoints = null;
    lastSmoothedPose = null;
    self.close?.();
  }
});

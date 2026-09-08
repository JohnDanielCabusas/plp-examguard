import { FaceLandmarker, FilesetResolver } from '@mediapipe/tasks-vision';
import { FaceLandmarkerRuntime } from './faceLandmarkerRuntime.js';

export async function smokeTestFaceLandmarker() {
  const fileset = await FilesetResolver.forVisionTasks('/vendor/mediapipe/wasm');
  const landmarker = await FaceLandmarker.createFromOptions(fileset, {
    baseOptions: {
      modelAssetPath: '/models/face_landmarker.task',
      delegate: 'CPU',
    },
    runningMode: 'VIDEO',
    numFaces: 1,
    minFaceDetectionConfidence: 0.5,
    minFacePresenceConfidence: 0.5,
    minTrackingConfidence: 0.5,
    outputFaceBlendshapes: true,
    outputFacialTransformationMatrixes: true,
  });
  try {
    const canvas = document.createElement('canvas');
    canvas.width = 320;
    canvas.height = 240;
    const result = landmarker.detectForVideo(canvas, 1);
    return {
      initialized: true,
      faceCount: result.faceLandmarks.length,
      matrixOutputAvailable: Array.isArray(result.facialTransformationMatrixes),
    };
  } finally {
    landmarker.close();
  }
}

export async function smokeTestFaceLandmarkerWorker() {
  const canvas = document.createElement('canvas');
  // Exercise the runtime's downscaled inference path used by the 960x720
  // student camera request.
  canvas.width = 800;
  canvas.height = 600;
  const context = canvas.getContext('2d');
  context.fillStyle = '#111827';
  context.fillRect(0, 0, canvas.width, canvas.height);
  const stream = canvas.captureStream(12);
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.srcObject = stream;
  document.body.appendChild(video);
  await video.play();

  let resolveObservation;
  const observationPromise = new Promise(resolve => { resolveObservation = resolve; });
  const runtime = new FaceLandmarkerRuntime({
    video,
    config: { initTimeoutMs: 20000, inferenceFps: 10 },
    onObservation: observation => resolveObservation(observation),
  });
  try {
    await runtime.start();
    const observation = await Promise.race([
      observationPromise,
      new Promise((_, reject) => setTimeout(() => reject(new Error('Worker did not return an observation.')), 10000)),
    ]);
    return {
      workerInitialized: true,
      facePresent: observation.facePresent,
      inferenceMs: observation.inferenceMs,
      backend: observation.backend,
    };
  } finally {
    runtime.stop();
    stream.getTracks().forEach(track => track.stop());
    video.remove();
  }
}

export async function smokeTestMissingFaceLandmarkerModel() {
  const canvas = document.createElement('canvas');
  canvas.width = 160;
  canvas.height = 120;
  const context = canvas.getContext('2d');
  context.fillStyle = '#111827';
  context.fillRect(0, 0, canvas.width, canvas.height);
  const stream = canvas.captureStream(5);
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.srcObject = stream;
  document.body.appendChild(video);
  await video.play();

  const runtime = new FaceLandmarkerRuntime({
    video,
    config: {
      modelUrl: '/models/face_landmarker-intentionally-missing.task',
      initTimeoutMs: 20000,
      inferenceFps: 5,
    },
  });
  let rejected = false;
  try {
    await runtime.start();
  } catch (_) {
    rejected = true;
  } finally {
    runtime.stop();
    stream.getTracks().forEach(track => track.stop());
    video.remove();
  }

  return {
    missingModelRejected: rejected,
    failedRuntimeStopped: runtime.worker === null && runtime.ready === false,
  };
}

export async function smokeTestFaceLandmarkerCleanupDuringInitialization() {
  const runtime = new FaceLandmarkerRuntime({
    video: { readyState: 0 },
    config: { initTimeoutMs: 20000 },
  });
  const pendingStart = runtime.start();
  const duplicateStart = runtime.start();
  runtime.stop();
  let cancellationRejected = false;
  try {
    await pendingStart;
  } catch (error) {
    cancellationRejected = /cancelled/i.test(error?.message || '');
  }
  return {
    duplicateStartShared: pendingStart === duplicateStart,
    cancellationRejected,
    cancelledRuntimeStopped: runtime.worker === null && runtime.ready === false,
  };
}

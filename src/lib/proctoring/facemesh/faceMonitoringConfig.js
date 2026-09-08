const BASE_CONFIG = Object.freeze({
  modelUrl: '/models/face_landmarker.task',
  wasmRoot: '/vendor/mediapipe/wasm',
  // Ten frames per second is sufficient for the multi-second violation rules
  // while leaving CPU/GPU time available for typing, rendering, and YOLO.
  inferenceFps: 10,
  maximumInferenceDimension: 480,
  initTimeoutMs: 30000,
  minFaceDetectionConfidence: 0.5,
  minFacePresenceConfidence: 0.45,
  minTrackingConfidence: 0.45,
  calibration: Object.freeze({
    durationMs: 5000,
    maximumSampleGapMs: 600,
    minimumTrackingQuality: 0.62,
    minimumFaceWidthRatio: 0.18,
    maximumFaceWidthRatio: 0.58,
    maximumCenterOffset: 0.16,
    maximumYawRange: 12,
    maximumPitchRange: 12,
  }),
  pose: Object.freeze({
    leftYawDegrees: -25,
    rightYawDegrees: 25,
    upPitchDegrees: -18,
    downPitchDegrees: 18,
    yawDirectionMultiplier: 1,
    // MediaPipe's camera-space pitch is positive when the student looks up.
    // Normalize it so negative means up and positive means down in the UI.
    pitchDirectionMultiplier: -1,
    smoothingAlpha: 0.5,
  }),
  geometry: Object.freeze({
    partialMarginRatio: 0.018,
    edgeMarginRatio: 0.055,
    tooCloseWidthRatio: 0.62,
    tooCloseHeightRatio: 0.78,
    tooFarWidthRatio: 0.16,
    tooFarHeightRatio: 0.20,
    unstableTrackingQuality: 0.42,
  }),
  temporal: Object.freeze({
    trackingLossGraceMs: 2000,
    positioningWarningMs: 3000,
    // Match the established TUKLAS camera countdowns. The three-second value
    // above is only an early positioning prompt; formal review incidents wait
    // for the full continuous countdown.
    faceAbsentIncidentMs: 10000,
    headTurnIncidentMs: 10000,
    lookingDownIncidentMs: 10000,
    positioningIncidentMs: 4000,
    occlusionIncidentMs: 4000,
    unstableTrackingIncidentMs: 4000,
    recoveryMs: 1000,
    incidentUpdateMs: 5000,
    cooldownMs: 5000,
    repeatedAwayWindowMs: 60000,
    repeatedAwayCount: 4,
    repeatedAwayCooldownMs: 60000,
  }),
  correlation: Object.freeze({
    overlapWindowMs: 4000,
    faceBoxExpansionRatio: 0.18,
  }),
  randomForest: Object.freeze({
    featureContractVersion: 'rf-session-summary-v1',
    handModelUrl: '/models/hand_landmarker.task',
    handModelSha256: 'fbc2a30080c3c557093b5ddfc334698132eb341044ccee322ccf8bcf3607cde1',
    handInferenceIntervalMs: 300,
    maximumHands: 3,
    minHandDetectionConfidence: 0.5,
    minHandPresenceConfidence: 0.5,
    minHandTrackingConfidence: 0.5,
  }),
  captureEvidence: false,
  enableIrisDirection: false,
});

function mergeSection(base, value) {
  return Object.freeze({ ...base, ...(value && typeof value === 'object' ? value : {}) });
}

export function resolveFaceMonitoringConfig(value = {}) {
  const raw = value && typeof value === 'object' ? value : {};
  return Object.freeze({
    ...BASE_CONFIG,
    ...raw,
    calibration: mergeSection(BASE_CONFIG.calibration, raw.calibration),
    pose: mergeSection(BASE_CONFIG.pose, raw.pose),
    geometry: mergeSection(BASE_CONFIG.geometry, raw.geometry),
    temporal: mergeSection(BASE_CONFIG.temporal, raw.temporal),
    correlation: mergeSection(BASE_CONFIG.correlation, raw.correlation),
    randomForest: mergeSection(BASE_CONFIG.randomForest, raw.randomForest),
    inferenceFps: Math.min(15, Math.max(5, Number(raw.inferenceFps || BASE_CONFIG.inferenceFps))),
    maximumInferenceDimension: Math.min(
      960,
      Math.max(320, Number(raw.maximumInferenceDimension || BASE_CONFIG.maximumInferenceDimension)),
    ),
    captureEvidence: raw.captureEvidence === true,
    enableIrisDirection: raw.enableIrisDirection === true,
  });
}

export { BASE_CONFIG as DEFAULT_FACE_MONITORING_CONFIG };

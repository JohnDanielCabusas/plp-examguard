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
    // Calibration runs on real webcams where an occasional delayed or noisy
    // frame is normal. Brief invalid frames pause progress; they do not erase
    // an otherwise stable five-second sample window.
    maximumSampleGapMs: 1500,
    transientInvalidToleranceMs: 900,
    minimumSamples: 15,
    minimumTrackingQuality: 0.45,
    minimumFaceWidthRatio: 0.15,
    maximumFaceWidthRatio: 0.58,
    maximumCenterOffset: 0.2,
    // Webcams sit above the screen, so a seated student's face lands high in the
    // frame far more often than it lands off to one side. One tolerance for both
    // axes rejected faces that were plainly inside the on-screen guide.
    maximumCenterOffsetX: 0.22,
    maximumCenterOffsetY: 0.3,
    maximumYawRange: 18,
    maximumPitchRange: 18,
    // A scan that cannot finish blocks the student out of the exam entirely, so
    // after this long the bar comes down rather than leaving them stuck. What was
    // relaxed is recorded with the baseline so the professor can see it.
    assist: Object.freeze({
      afterMs: 12000,
      durationMs: 3000,
      minimumSamples: 8,
      minimumTrackingQuality: 0.28,
      minimumFaceWidthRatio: 0.09,
      maximumFaceWidthRatio: 0.72,
      maximumCenterOffsetX: 0.34,
      maximumCenterOffsetY: 0.4,
      maximumYawRange: 30,
      maximumPitchRange: 30,
      transientInvalidToleranceMs: 1600,
      maximumSampleGapMs: 2500,
    }),
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
    // Down is the direction that misreads most. A webcam above the screen already
    // sees a neutral gaze as slightly downward, and euler pitch on its own drifts
    // with head roll and with a turned head. So a second, independent signal —
    // how the face's own proportions foreshorten when the chin tucks — has to
    // agree, which in turn lets the gate sit lower than the euler-only one and
    // catches a real look down sooner.
    confirmedDownPitchDegrees: 13,
    confirmedUpPitchDegrees: -13,
    // How far the nose has to sit down the face's eye-to-chin axis, compared with
    // the position calibration measured for this student on this camera, before
    // the geometry agrees the head really pitched.
    downNoseFractionDelta: 0.03,
    upNoseFractionDelta: -0.03,
    // Foreshortening this pronounced is conclusive on its own, which keeps the
    // detection working on cameras where the euler estimate is unreliable.
    decisiveNoseFractionDelta: 0.085,
    // Pitch extraction mixes with roll once the head is turned away, so a turned
    // head has to pitch further before it counts and geometry alone is not
    // trusted: turning also moves the nose along that axis.
    yawCouplingDegrees: 20,
    yawCoupledPitchScale: 1.4,
    // A rotation this far past the gate is unmistakable, so it stands even when
    // the geometric cue disagrees. It stops a badly calibrated cue from hiding a
    // student who is plainly looking down.
    decisivePitchScale: 1.8,
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
    // Was 4000, which left one second between the positioning notice appearing
    // and the violation being recorded. Matched to the other correctable
    // conditions so the student has a usable window to move (#40).
    positioningIncidentMs: 10000,
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

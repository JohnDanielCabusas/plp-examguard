const BASE_CONFIG = Object.freeze({
  modelUrl: '/models/face_landmarker.task',
  wasmRoot: '/vendor/mediapipe/wasm',
  // Ten frames per second is sufficient for the multi-second violation rules
  // while leaving CPU/GPU time available for typing, rendering, and YOLO.
  inferenceFps: 10,
  maximumInferenceDimension: 480,
  initTimeoutMs: 30000,
  minFaceDetectionConfidence: 0.5,
  // Presence and tracking decide whether MediaPipe keeps following a face it
  // has already found. At 0.45 a dim or low-contrast webcam kept dropping the
  // student's face between frames, which the scan reported as "no face".
  // Detection itself stays at 0.5 so reflections and posters are not picked up
  // as a second person.
  minFacePresenceConfidence: 0.35,
  minTrackingConfidence: 0.35,
  calibration: Object.freeze({
    durationMs: 5000,
    // Calibration runs on real webcams where an occasional delayed or noisy
    // frame is normal. Brief invalid frames pause progress; they do not erase
    // an otherwise stable five-second sample window.
    //
    // A valid frame that arrives late is credited up to this much of the gap.
    // It used to be credited nothing, so a laptop on the CPU model, where every
    // gap was long, could hold a centred face forever and never fill the bar.
    maximumSampleGapMs: 1500,
    // The tolerance below is a floor. The session measures how far apart frames
    // actually arrive and widens it to this many frame intervals (capped), so a
    // single dropped frame at a slow rate no longer wipes the progress.
    transientInvalidToleranceMs: 900,
    cadenceToleranceMultiplier: 2.5,
    maximumTransientInvalidToleranceMs: 4000,
    minimumSamples: 15,
    // The baseline is an average of at least fifteen frames, so per-frame
    // jitter mostly cancels out; 0.45 rejected ordinary cheap webcams with the
    // prompt about lighting while the student sat perfectly still.
    minimumTrackingQuality: 0.35,
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
  // Is the face on camera alive, or a picture of one? See livenessMonitor.js.
  // Everything here is set so that a real student is almost never asked, and
  // when they are, a blink clears it with nothing recorded.
  liveness: Object.freeze({
    enabled: true,
    // Clean viewing with no sign of life before the student is asked to show
    // one. People blink several times a minute even while reading; a minute
    // with no blink, no expression and no change of shape is long enough to
    // ask, and short enough that a picture cannot hide for long.
    passiveWindowMs: 60000,
    // Each answered check lengthens the next window, up to this.
    passiveWindowGrowthMs: 30000,
    maximumPassiveWindowMs: 150000,
    // Frames further apart than this are a stall or a lost face, not quiet time.
    maximumFrameGapMs: 1500,
    // Only steady, frontal, well-tracked single faces are judged.
    minimumTrackingQuality: 0.4,
    maximumYawDegrees: 25,
    // Open-eye level learned from the first clean frames when calibration did
    // not supply one.
    restSampleCount: 20,
    // Eyes that never read as open (narrow eyes, glare, or a picture with the
    // eyes shut) make blinks unreadable: they stop counting, the mouth is asked
    // for instead, and the quiet window is scaled up to compensate.
    maximumRestingEyeBlink: 0.4,
    unreliableBlinkWindowScale: 2,
    // A blink is the eye score rising this far above rest (and past the floor),
    // then dropping back within the blink's own duration.
    blinkThreshold: 0.5,
    blinkRiseAboveRest: 0.3,
    blinkRecoveryAboveRest: 0.15,
    maximumBlinkMs: 1500,
    // Any expression score ranging this much over the window is a change of
    // face no picture can make.
    expressionRangeThreshold: 0.2,
    // Non-rigid landmark motion, in inter-ocular distances, above which the
    // face has changed shape rather than merely moved (see livenessCues.js).
    nonRigidMotionThreshold: 0.035,
    // The on-screen check.
    challengeDurationMs: 15000,
    challengeBlinkCount: 2,
    blinkChallengeProbability: 0.7,
    mouthOpenThreshold: 0.3,
    mouthOpenRiseAboveRest: 0.25,
    mouthClosedAboveRest: 0.1,
    // A face gone this long mid-check cancels it; silence only counts while the
    // face stayed cleanly in view for most of the prompt.
    challengeAbsenceCancelMs: 3000,
    challengeMinimumCleanRatio: 0.5,
    // Quiet time after any check before another can begin.
    challengeCooldownMs: 120000,
    cancelledCooldownMs: 15000,
    // An unanswered check is a review incident for the professor. It is not a
    // strike unless this is turned on.
    failureCountsAsWarning: false,
  }),
  // A face that sits inside a detected phone is being shown on its screen. See
  // faceOnScreenDetector.js.
  faceOnScreen: Object.freeze({
    enabled: true,
    // Face boxes older than this say nothing about the current scan.
    faceContextMs: 1500,
    minimumPhoneConfidence: 0.3,
    // How much of the face box the phone box has to cover.
    minimumContainment: 0.85,
    // The phone has to be larger than the face it shows, and cannot be most of
    // the frame (that is a monitor, or a phone against the lens).
    minimumPhoneToFaceAreaRatio: 1.15,
    maximumPhoneFrameAreaRatio: 0.7,
    // YOLO scans every 400-600 ms; the incident needs this much continuous
    // containment with at least this many scans agreeing.
    incidentMs: 4000,
    minimumHits: 4,
    gapToleranceMs: 2000,
    recoveryMs: 3000,
    incidentUpdateMs: 5000,
    cooldownMs: 10000,
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
    liveness: mergeSection(BASE_CONFIG.liveness, raw.liveness),
    faceOnScreen: mergeSection(BASE_CONFIG.faceOnScreen, raw.faceOnScreen),
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

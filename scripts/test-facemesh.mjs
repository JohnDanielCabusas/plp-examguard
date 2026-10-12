import assert from 'node:assert/strict';
import { FaceCalibrationSession } from '../src/lib/proctoring/facemesh/calibrationService.js';
import { createTrackingQualityMeter } from '../src/lib/proctoring/facemesh/trackingQuality.js';
import { requestCameraStream } from '../src/lib/proctoring/facemesh/cameraAccess.js';
import { FaceEventCorrelator } from '../src/lib/proctoring/facemesh/faceEventCorrelator.js';
import { resolveFaceMonitoringConfig } from '../src/lib/proctoring/facemesh/faceMonitoringConfig.js';
import { FaceSessionAggregator } from '../src/lib/proctoring/facemesh/faceSessionAggregator.js';
import {
  classifyFaceObservation,
  classifyHeadDirection,
  eulerFromTransformationMatrix,
  estimateEulerFromLandmarks,
  poseCueDeltas,
  relativePose,
  smoothHeadPose,
} from '../src/lib/proctoring/facemesh/headPoseEstimator.js';
import { FaceTemporalRuleEngine } from '../src/lib/proctoring/facemesh/temporalRuleEngine.js';
import {
  createNonRigidMotionMeter,
  extractBlendshapes,
  nonRigidResidual,
} from '../src/lib/proctoring/facemesh/livenessCues.js';
import { FaceLivenessMonitor } from '../src/lib/proctoring/facemesh/livenessMonitor.js';
import { FaceOnScreenDetector, findContainingPhone } from '../src/lib/proctoring/facemesh/faceOnScreenDetector.js';

function matrixFor({ yaw = 0, pitch = 0, roll = 0 } = {}) {
  const x = pitch * Math.PI / 180;
  const y = yaw * Math.PI / 180;
  const z = roll * Math.PI / 180;
  const cx = Math.cos(x); const sx = Math.sin(x);
  const cy = Math.cos(y); const sy = Math.sin(y);
  const cz = Math.cos(z); const sz = Math.sin(z);
  return {
    rows: 4,
    columns: 4,
    data: [
      cz * cy, (cz * sy * sx) - (sz * cx), (cz * sy * cx) + (sz * sx), 0,
      sz * cy, (sz * sy * sx) + (cz * cx), (sz * sy * cx) - (cz * sx), 0,
      -sy, cy * sx, cy * cx, 0,
      0, 0, 0, 1,
    ],
  };
}

const yawPose = eulerFromTransformationMatrix(matrixFor({ yaw: 30 }));
assert.ok(Math.abs(yawPose.yaw - 30) < 0.01);
const pitchPose = eulerFromTransformationMatrix(matrixFor({ pitch: 25 }));
assert.ok(Math.abs(pitchPose.pitch - 25) < 0.01);
const rollPose = eulerFromTransformationMatrix(matrixFor({ roll: -15 }));
assert.ok(Math.abs(rollPose.roll + 15) < 0.01);

const downwardLandmarks = [];
downwardLandmarks[33] = { x: 0.4, y: 0.4 };
downwardLandmarks[263] = { x: 0.6, y: 0.4 };
downwardLandmarks[1] = { x: 0.5, y: 0.56 };
downwardLandmarks[10] = { x: 0.5, y: 0.2 };
downwardLandmarks[152] = { x: 0.5, y: 0.8 };
assert.ok(estimateEulerFromLandmarks(downwardLandmarks).pitch < 0);

const config = resolveFaceMonitoringConfig();
assert.equal(config.temporal.faceAbsentIncidentMs, 10000);
assert.equal(config.temporal.headTurnIncidentMs, 10000);
assert.equal(config.temporal.lookingDownIncidentMs, 10000);
assert.equal(config.inferenceFps, 10);
assert.equal(config.maximumInferenceDimension, 480);
assert.equal(config.randomForest.handInferenceIntervalMs, 300);
assert.equal(config.minFaceDetectionConfidence, 0.5);
assert.equal(config.minFacePresenceConfidence, 0.35);
assert.equal(config.minTrackingConfidence, 0.35);
assert.equal(config.pose.pitchDirectionMultiplier, -1);
const relative = relativePose(
  { yaw: 35, pitch: 3, roll: 2 },
  { baselineYaw: 5, baselinePitch: 3, baselineRoll: 1 },
  config.pose,
);
assert.equal(classifyHeadDirection(relative, config.pose), 'HEAD_RIGHT');

const physicalUp = relativePose(
  { yaw: 0, pitch: 24, roll: 0 },
  { baselineYaw: 0, baselinePitch: 0, baselineRoll: 0 },
  config.pose,
);
assert.equal(classifyHeadDirection(physicalUp, config.pose), 'HEAD_UP');
const physicalDown = relativePose(
  { yaw: 0, pitch: -20, roll: 0 },
  { baselineYaw: 0, baselinePitch: 0, baselineRoll: 0 },
  config.pose,
);
assert.equal(classifyHeadDirection(physicalDown, config.pose), 'HEAD_DOWN');
assert.equal(
  classifyHeadDirection({ yaw: 27, pitch: 30 }, config.pose),
  'HEAD_DOWN',
);

// ── Head direction with a second, independent signal ────────────────────────
// Euler pitch alone misreads downward looks: a camera above the screen, a head
// that rolls, or plain landmark jitter can all push it past the gate while the
// face has not actually pitched at all. The face's own proportions settle it —
// tucking the chin slides the nose down the eye-to-chin axis, whatever the
// camera angle, because the comparison is against this student's own baseline.
const down = (pitch, noseFractionDelta, yaw = 0) => classifyHeadDirection(
  { yaw, pitch },
  config.pose,
  { noseFractionDelta },
);

// Pitch over the old gate, but the face never foreshortened: noise, not a look
// down. This is the case that used to raise a warning on its own.
assert.equal(down(20, 0), 'HEAD_CENTER');
assert.equal(down(20, -0.01), 'HEAD_CENTER');
// Both signals agree, so it is caught earlier than the euler-only gate allowed.
assert.equal(down(15, 0.05), 'HEAD_DOWN');
assert.equal(down(20, 0.05), 'HEAD_DOWN');
// Foreshortening this strong is conclusive even where euler pitch is unreliable.
assert.equal(down(4, 0.12), 'HEAD_DOWN');
// So is a rotation far past the gate, so a poorly captured cue cannot hide a
// student who is plainly looking down.
assert.equal(down(40, 0), 'HEAD_DOWN');
// A turned head makes pitch unreliable and moves the nose along the same axis,
// so it is reported as the turn it is rather than as a look downward.
assert.equal(down(20, 0.05, 30), 'HEAD_RIGHT');
// No cue (an older baseline, or a camera giving no usable landmarks) keeps the
// original euler-only rule.
assert.equal(classifyHeadDirection({ yaw: 0, pitch: 20 }, config.pose, null), 'HEAD_DOWN');
assert.equal(classifyHeadDirection({ yaw: 0, pitch: 20 }, config.pose), 'HEAD_DOWN');
// Upward looks are judged the same way, in the opposite direction.
assert.equal(down(-15, -0.05), 'HEAD_UP');
assert.equal(down(-20, 0), 'HEAD_CENTER');

// The cue is read off the same landmark geometry the worker measures, and is
// null unless both this frame and the baseline carry it.
assert.equal(poseCueDeltas({ poseCues: { noseFraction: 0.5 } }, { baselineNoseFraction: 0.45 })
  .noseFractionDelta.toFixed(2), '0.05');
assert.equal(poseCueDeltas({ poseCues: { noseFraction: 0.5 } }, {}), null);
assert.equal(poseCueDeltas({}, { baselineNoseFraction: 0.45 }), null);

// End to end: the same frame is judged differently depending on whether the face
// actually foreshortened, which is the whole point of the second signal.
const pitchedObservation = (noseFraction) => ({
  facePresent: true,
  pose: { yaw: 0, pitch: -20, roll: 0 },
  poseCues: { noseFraction, faceSpanRatio: 1.5 },
});
const baselineForCues = {
  baselineYaw: 0, baselinePitch: 0, baselineRoll: 0,
  baselineNoseFraction: 0.45, baselineFaceSpanRatio: 1.6,
};
assert.equal(
  classifyFaceObservation(pitchedObservation(0.52), baselineForCues, config).headDirection,
  'HEAD_DOWN',
);
assert.equal(
  classifyFaceObservation(pitchedObservation(0.45), baselineForCues, config).headDirection,
  'HEAD_CENTER',
);

const cueCalibration = new FaceCalibrationSession(config.calibration);
let cueBaseline = null;
for (let t = 0; t <= 9000; t += 150) {
  const result = cueCalibration.addObservation({
    timestampMs: t,
    facePresent: true,
    trackingQuality: 0.6,
    pose: { yaw: 0, pitch: 0, roll: 0 },
    geometry: { width: 0.24, height: 0.3, centerX: 0.5, centerY: 0.5 },
    poseCues: { noseFraction: 0.46, faceSpanRatio: 1.62 },
  });
  if (result.complete) { cueBaseline = result.baseline; break; }
}
assert.ok(cueBaseline, 'calibration with cues must complete');
assert.ok(Math.abs(cueBaseline.baselineNoseFraction - 0.46) < 0.001);
assert.ok(Math.abs(cueBaseline.baselineFaceSpanRatio - 1.62) < 0.001);

// A camera that never yields the cue leaves it null rather than inventing one.
const cuelessCalibration = new FaceCalibrationSession(config.calibration);
let cuelessBaseline = null;
for (let t = 0; t <= 9000; t += 150) {
  const result = cuelessCalibration.addObservation({
    timestampMs: t,
    facePresent: true,
    trackingQuality: 0.6,
    pose: { yaw: 0, pitch: 0, roll: 0 },
    geometry: { width: 0.24, height: 0.3, centerX: 0.5, centerY: 0.5 },
  });
  if (result.complete) { cuelessBaseline = result.baseline; break; }
}
assert.ok(cuelessBaseline, 'calibration without cues must still complete');
assert.equal(cuelessBaseline.baselineNoseFraction, null);

const smoothedSmallMove = smoothHeadPose(
  { yaw: 0, pitch: 0, roll: 0 },
  { yaw: 2, pitch: -2, roll: 1, method: 'test' },
  config.pose.smoothingAlpha,
);
assert.ok(smoothedSmallMove.yaw > 1 && smoothedSmallMove.yaw < 2);
const smoothedIntentionalMove = smoothHeadPose(
  { yaw: 0, pitch: 0, roll: 0 },
  { yaw: 0, pitch: -30, roll: 0, method: 'test' },
  config.pose.smoothingAlpha,
);
assert.ok(smoothedIntentionalMove.pitch < -24);

const calibration = new FaceCalibrationSession({ ...config.calibration, durationMs: 1000 });
const rejectedCalibration = calibration.addObservation({
  timestampMs: 0,
  facePresent: true,
  partiallyVisible: true,
  trackingQuality: 0.9,
  geometry: { width: 0.35, height: 0.45, centerX: 0.5, centerY: 0.5 },
  pose: { yaw: 2, pitch: -1, roll: 0 },
});
assert.equal(rejectedCalibration.complete, false);
assert.equal(calibration.samples.length, 0);
let calibrationResult = null;
for (let time = 0; time <= 1500; time += 100) {
  calibrationResult = calibration.addObservation({
    timestampMs: time,
    facePresent: true,
    trackingQuality: 0.9,
    geometry: { width: 0.35, height: 0.45, centerX: 0.5, centerY: 0.5 },
    pose: { yaw: 2, pitch: -1, roll: 0 },
  });
}
assert.equal(calibrationResult.complete, true);
assert.equal(calibrationResult.baseline.baselineYaw, 2);

const tolerantCalibration = new FaceCalibrationSession({
  ...config.calibration,
  durationMs: 1000,
  minimumSamples: 8,
});
const stableObservation = timestampMs => ({
  timestampMs,
  facePresent: true,
  trackingQuality: 0.82,
  geometry: { width: 0.3, height: 0.42, centerX: 0.5, centerY: 0.5 },
  pose: { yaw: 1, pitch: -1, roll: 0 },
});
for (let time = 0; time <= 500; time += 100) {
  tolerantCalibration.addObservation(stableObservation(time));
}
const pausedCalibration = tolerantCalibration.addObservation({
  ...stableObservation(600),
  facePresent: false,
  geometry: null,
  pose: null,
});
assert.ok(pausedCalibration.progress >= 0.5, 'One noisy frame should pause instead of erasing calibration progress.');
for (let time = 700; time <= 1300; time += 100) {
  calibrationResult = tolerantCalibration.addObservation(stableObservation(time));
}
assert.equal(calibrationResult.complete, true, 'Calibration should recover after a brief invalid frame.');

const lostFaceCalibration = new FaceCalibrationSession({ ...config.calibration, durationMs: 1000 });
for (let time = 0; time <= 500; time += 100) {
  lostFaceCalibration.addObservation(stableObservation(time));
}
for (const time of [600, 1000, 1600]) {
  calibrationResult = lostFaceCalibration.addObservation({
    ...stableObservation(time),
    facePresent: false,
    geometry: null,
    pose: null,
  });
}
assert.equal(calibrationResult.progress, 0, 'A persistently missing face must reset calibration.');
assert.equal(lostFaceCalibration.samples.length, 0);

// A laptop on the CPU model delivers a frame every two seconds or so. Every gap
// used to be discarded as "too long", so the bar never moved for a student who
// was doing everything right. Late frames are now credited up to the cap and
// the scan finishes once enough of them have been collected.
const slowCalibration = new FaceCalibrationSession(config.calibration);
let slowResult = null;
let slowProgressMoved = false;
for (let time = 0; time <= 60000; time += 2000) {
  const previousProgress = slowResult?.progress || 0;
  slowResult = slowCalibration.addObservation(stableObservation(time));
  if (slowResult.progress > previousProgress) slowProgressMoved = true;
  if (slowResult.complete) break;
}
assert.ok(slowProgressMoved, 'The bar must move on a slow device.');
assert.equal(slowResult.complete, true, 'A slow but steady device must finish the scan.');
assert.equal(slowResult.baseline.sampleCount, config.calibration.minimumSamples);

// At that rate one dropped frame is a two-second hole. The fixed 900 ms tolerance
// treated that as the face being gone and started over.
const slowDropCalibration = new FaceCalibrationSession(config.calibration);
for (let time = 0; time <= 10000; time += 2000) {
  slowDropCalibration.addObservation(stableObservation(time));
}
const earnedSamples = slowDropCalibration.samples.length;
assert.ok(earnedSamples >= 5);
const droppedFrame = slowDropCalibration.addObservation({
  ...stableObservation(12000),
  facePresent: false,
  geometry: null,
  pose: null,
});
assert.equal(droppedFrame.reason, 'No face detected yet. Face the camera directly and make sure your face is well lit.');
assert.equal(slowDropCalibration.samples.length, earnedSamples, 'One missed frame at a slow rate must not erase progress.');
const resumedFrame = slowDropCalibration.addObservation(stableObservation(14000));
assert.equal(slowDropCalibration.samples.length, earnedSamples + 1);
assert.ok(resumedFrame.progress > 0);

// The tolerance does not grow without bound: a face that stays missing still
// resets, even on a slow device.
for (const time of [16000, 18000, 20000, 22000]) {
  calibrationResult = slowDropCalibration.addObservation({
    ...stableObservation(time),
    facePresent: false,
    geometry: null,
    pose: null,
  });
}
assert.equal(calibrationResult.progress, 0, 'A face missing for many frames must still reset.');

// The bar tracks whichever requirement is still outstanding. Time alone used
// to fill it while the sample count was still short, which looked stuck.
const sampleBoundCalibration = new FaceCalibrationSession({ ...config.calibration, durationMs: 1000, minimumSamples: 10 });
let sampleBoundResult = null;
for (const time of [0, 1500, 3000]) {
  sampleBoundResult = sampleBoundCalibration.addObservation(stableObservation(time));
}
assert.ok(sampleBoundCalibration.stableDurationMs >= 1000, 'Stable time is complete here.');
assert.ok(sampleBoundResult.progress <= 0.3, 'Progress must not read as full while samples are still short.');
assert.equal(sampleBoundResult.complete, false);

// Landmark jitter is scored against the cadence the thresholds were tuned for.
// The same small movement over a long frame gap is a still face, not an
// unstable one.
const jitterLandmarks = shift => {
  const points = [];
  for (let index = 0; index < 300; index += 1) points.push({ x: 0.5, y: 0.5 });
  [1, 10, 33, 61, 152, 263, 291].forEach(index => { points[index] = { x: 0.5 + shift, y: 0.5 + shift }; });
  return points;
};
const meterGeometry = { width: 0.3, height: 0.4, centerX: 0.5, centerY: 0.5 };
const fastMeter = createTrackingQualityMeter();
fastMeter.measure(jitterLandmarks(0), meterGeometry, 0, 100);
const fastQuality = fastMeter.measure(jitterLandmarks(0.016), meterGeometry, 100, 100);
const slowMeter = createTrackingQualityMeter();
slowMeter.measure(jitterLandmarks(0), meterGeometry, 0, 100);
const slowQuality = slowMeter.measure(jitterLandmarks(0.016), meterGeometry, 400, 100);
assert.ok(fastQuality < config.calibration.minimumTrackingQuality, 'That much movement in one tenth of a second is unstable.');
assert.ok(slowQuality > fastQuality, 'Spread over four tenths of a second it scores steadier.');
assert.ok(slowQuality >= config.calibration.minimumTrackingQuality, 'A still face on a slow device must pass the gate.');
const stalledMeter = createTrackingQualityMeter();
stalledMeter.measure(jitterLandmarks(0), meterGeometry, 0, 100);
const stalledQuality = stalledMeter.measure(jitterLandmarks(0.016), meterGeometry, 5000, 100);
assert.ok(Math.abs(stalledQuality - slowQuality) < 1e-9, 'Credit for a long gap stops at four intervals.');
const untimedMeter = createTrackingQualityMeter();
untimedMeter.measure(jitterLandmarks(0), meterGeometry);
assert.ok(Math.abs(untimedMeter.measure(jitterLandmarks(0.016), meterGeometry) - fastQuality) < 1e-9, 'Without timestamps the score is unchanged.');

const briefEvents = [];
const briefEngine = new FaceTemporalRuleEngine({
  ...config.temporal,
  headTurnIncidentMs: 400,
  recoveryMs: 100,
}, event => briefEvents.push(event));
for (let time = 0; time <= 300; time += 100) {
  briefEngine.update({
    timestampMs: time,
    wallClockMs: 50000 + time,
    facePresent: true,
    headDirection: 'HEAD_LEFT',
    relativePose: { yaw: -35, pitch: 1 },
    trackingQuality: 0.9,
  });
}
briefEngine.update({ timestampMs: 400, wallClockMs: 50400, facePresent: true, headDirection: 'HEAD_CENTER', trackingQuality: 0.9 });
briefEngine.update({ timestampMs: 500, wallClockMs: 50500, facePresent: true, headDirection: 'HEAD_CENTER', trackingQuality: 0.9 });
assert.equal(briefEvents.filter(event => event.kind === 'incident').length, 0);

const events = [];
const engine = new FaceTemporalRuleEngine({
  ...config.temporal,
  headTurnIncidentMs: 400,
  recoveryMs: 100,
  incidentUpdateMs: 10000,
}, event => events.push(event));
for (let time = 1000; time <= 1500; time += 100) {
  engine.update({
    timestampMs: time,
    wallClockMs: 100000 + time,
    facePresent: true,
    headDirection: 'HEAD_RIGHT',
    relativePose: { yaw: 32, pitch: 2 },
    trackingQuality: 0.85,
  });
}
engine.update({ timestampMs: 1600, wallClockMs: 101600, facePresent: true, headDirection: 'HEAD_CENTER', trackingQuality: 0.9 });
engine.update({ timestampMs: 1700, wallClockMs: 101700, facePresent: true, headDirection: 'HEAD_CENTER', trackingQuality: 0.9 });
assert.deepEqual(events.filter(event => event.kind === 'incident').map(event => event.phase), ['start', 'end']);
const incidentEvents = events.filter(event => event.kind === 'incident');
assert.equal(incidentEvents[0].eventType, 'SUSTAINED_HEAD_TURN');
assert.equal(incidentEvents[0].incidentId, incidentEvents[1].incidentId);
assert.deepEqual(
  events.filter(event => event.kind === 'condition-progress').map(event => event.remainingSeconds),
  [1, 0],
);

const absenceEvents = [];
const absenceEngine = new FaceTemporalRuleEngine({
  ...config.temporal,
  positioningWarningMs: 200,
  faceAbsentIncidentMs: 400,
  recoveryMs: 100,
}, event => absenceEvents.push(event));
for (let time = 1000; time <= 1500; time += 100) {
  absenceEngine.update({ timestampMs: time, wallClockMs: 200000 + time, facePresent: false });
}
assert.ok(absenceEvents.some(event => event.kind === 'positioning-warning'));
assert.ok(absenceEvents.some(event => event.kind === 'incident' && event.eventType === 'FACE_ABSENT'));

for (const [direction, expectedType, expectedDirection] of [
  ['HEAD_LEFT', 'SUSTAINED_HEAD_TURN', 'LEFT'],
  ['HEAD_RIGHT', 'SUSTAINED_HEAD_TURN', 'RIGHT'],
  ['HEAD_UP', 'SUSTAINED_HEAD_TURN', 'UP'],
  ['HEAD_DOWN', 'SUSTAINED_LOOKING_DOWN', 'DOWN'],
]) {
  const directionEvents = [];
  const directionEngine = new FaceTemporalRuleEngine({
    ...config.temporal,
    headTurnIncidentMs: 200,
    lookingDownIncidentMs: 200,
  }, event => directionEvents.push(event));
  for (let time = 0; time <= 200; time += 100) {
    directionEngine.update({
      timestampMs: time,
      wallClockMs: 250000 + time,
      facePresent: true,
      personPresent: true,
      headDirection: direction,
      relativePose: { yaw: direction === 'HEAD_LEFT' ? -32 : direction === 'HEAD_RIGHT' ? 32 : 0, pitch: direction === 'HEAD_DOWN' ? 30 : direction === 'HEAD_UP' ? -24 : 0 },
      trackingQuality: 0.9,
    });
  }
  const started = directionEvents.find(event => event.kind === 'incident' && event.phase === 'start');
  assert.equal(started?.eventType, expectedType);
  assert.equal(started?.direction, expectedDirection);
}

const bodyPresenceEvents = [];
const bodyPresenceEngine = new FaceTemporalRuleEngine({
  ...config.temporal,
  faceAbsentIncidentMs: 200,
}, event => bodyPresenceEvents.push(event));
for (let time = 0; time <= 400; time += 100) {
  bodyPresenceEngine.update({ timestampMs: time, wallClockMs: 275000 + time, facePresent: false, personPresent: true });
}
assert.equal(bodyPresenceEvents.some(event => event.eventType === 'FACE_ABSENT'), false);

const repeatedEvents = [];
const repeatedEngine = new FaceTemporalRuleEngine({
  ...config.temporal,
  headTurnIncidentMs: 200,
  recoveryMs: 100,
  cooldownMs: 50,
  incidentUpdateMs: 10000,
  repeatedAwayCount: 4,
  repeatedAwayWindowMs: 60000,
  repeatedAwayCooldownMs: 60000,
}, event => repeatedEvents.push(event));
let repeatedTime = 1000;
for (let attempt = 0; attempt < 4; attempt += 1) {
  for (let offset = 0; offset <= 200; offset += 100) {
    repeatedEngine.update({
      timestampMs: repeatedTime + offset,
      wallClockMs: 300000 + repeatedTime + offset,
      facePresent: true,
      headDirection: attempt % 2 ? 'HEAD_LEFT' : 'HEAD_RIGHT',
      relativePose: { yaw: attempt % 2 ? -32 : 32, pitch: 2 },
      trackingQuality: 0.88,
    });
  }
  repeatedEngine.update({ timestampMs: repeatedTime + 300, wallClockMs: 300000 + repeatedTime + 300, facePresent: true, headDirection: 'HEAD_CENTER', trackingQuality: 0.9 });
  repeatedEngine.update({ timestampMs: repeatedTime + 400, wallClockMs: 300000 + repeatedTime + 400, facePresent: true, headDirection: 'HEAD_CENTER', trackingQuality: 0.9 });
  repeatedTime += 500;
}
const repeatedPatternEvents = repeatedEvents.filter(event => event.eventType === 'REPEATED_LOOKING_AWAY');
assert.deepEqual(repeatedPatternEvents.map(event => event.phase), ['start', 'end']);
assert.equal(repeatedPatternEvents[0].relatedIncidentIds.length, 4);
assert.equal(new Set(repeatedEvents.filter(event => event.phase === 'start').map(event => event.incidentId)).size, 5);

const correlator = new FaceEventCorrelator(config.correlation);
correlator.handleFaceEvent({
  eventType: 'FACE_OCCLUDED', phase: 'start', incidentId: 'face-1', startedAt: new Date().toISOString(), durationMs: 4000,
}, { x: 100, y: 100, width: 200, height: 200 }, 5000);
const correlation = correlator.handleYoloEvent({
  objectClass: 'mobile_phone', confidence: 0.8, boundingBox: { x: 180, y: 160, width: 80, height: 120 },
}, 6000);
assert.equal(correlation.eventType, 'PHONE_NEAR_OR_COVERING_FACE');
assert.equal(correlator.handleYoloEvent({ objectClass: 'mobile_phone' }, 6100), null);

const aggregator = new FaceSessionAggregator();
aggregator.observe({
  facePresent: true,
  faceCount: 2,
  handCount: 2,
  handTrackingAvailable: true,
  trackingQuality: 0.8,
  relativePose: { yaw: -31, pitch: 6, roll: 1 },
});
aggregator.consume({ kind: 'incident', phase: 'end', incidentId: 'a', eventType: 'SUSTAINED_HEAD_TURN', durationMs: 5000 });
aggregator.consume({ kind: 'incident', phase: 'end', incidentId: 'a', eventType: 'SUSTAINED_HEAD_TURN', durationMs: 5000 });
assert.equal(aggregator.snapshot().head_turn_count, 1);
assert.equal(aggregator.snapshot().head_turn_total_seconds, 5);
assert.equal(aggregator.snapshot().maximum_absolute_yaw, 31);
assert.equal(aggregator.snapshot().maximum_face_count, 2);
assert.equal(aggregator.snapshot().maximum_hand_count, 2);
assert.equal(aggregator.snapshot().random_forest_compatible, true);

const incompleteAggregator = new FaceSessionAggregator();
incompleteAggregator.observe({
  facePresent: true,
  faceCount: 1,
  handCount: null,
  handTrackingAvailable: true,
  trackingQuality: null,
  relativePose: { yaw: 2, pitch: null, roll: 0 },
});
assert.equal(incompleteAggregator.snapshot().tracking_sample_count, 0);
assert.equal(incompleteAggregator.snapshot().pose_sample_count, 0);
assert.equal(incompleteAggregator.snapshot().hand_sample_count, 0);
assert.equal(incompleteAggregator.snapshot().random_forest_compatible, false);

const permissionError = new DOMException('Permission blocked', 'NotAllowedError');
await assert.rejects(
  requestCameraStream({ getUserMedia: () => Promise.reject(permissionError) }, { video: true }),
  error => error?.code === 'PERMISSION_DENIED' && /permission was denied/i.test(error.message),
);
await assert.rejects(
  requestCameraStream(null, { video: true }),
  error => error?.code === 'UNAVAILABLE',
);

// ── Liveness cues ────────────────────────────────────────────────────────────
// A flat picture can shift, turn, tilt and come closer, and every landmark
// moves together under one affine map. The residual after fitting that map out
// is what a picture cannot produce: the face changing shape.
assert.equal(config.liveness.passiveWindowMs, 60000);
assert.equal(config.liveness.failureCountsAsWarning, false);
assert.equal(config.faceOnScreen.minimumContainment, 0.85);

function meshPoints(deform = () => null) {
  const points = [];
  for (let index = 0; index < 478; index += 1) {
    const column = index % 22;
    const row = Math.floor(index / 22);
    points.push({ x: 0.3 + (column * 0.02), y: 0.2 + (row * 0.025) });
  }
  // Eye corners the residual is normalised by, 0.2 apart.
  points[33] = { x: 0.4, y: 0.4 };
  points[263] = { x: 0.6, y: 0.4 };
  return points.map((point, index) => deform(point, index) || point);
}
const flatReference = meshPoints();
const flatMoved = flatReference.map(point => ({
  x: (1.1 * point.x) + (0.05 * point.y) + 0.02,
  y: (-0.03 * point.x) + (0.95 * point.y) - 0.01,
}));
assert.ok(nonRigidResidual(flatReference, flatMoved) < 1e-9, 'A picture tilted and moved leaves no non-rigid residual.');
// A blink-sized change on thirty landmarks, on top of the same movement.
const blinkMoved = flatMoved.map((point, index) => (index >= 100 && index < 130 ? { x: point.x, y: point.y + 0.02 } : point));
assert.ok(
  nonRigidResidual(flatReference, blinkMoved) >= config.liveness.nonRigidMotionThreshold,
  'Thirty landmarks moving on their own is a change of shape.',
);
assert.equal(nonRigidResidual(flatReference.slice(0, 4), flatMoved.slice(0, 4)), null);

const motionMeter = createNonRigidMotionMeter({ referenceAgeMs: 700 });
assert.equal(motionMeter.measure(flatReference, 0), null, 'Nothing to compare with on the first frame.');
assert.equal(motionMeter.measure(flatMoved, 300), null, 'No frame is old enough to be a reference yet.');
assert.ok(motionMeter.measure(blinkMoved, 800) >= config.liveness.nonRigidMotionThreshold);
assert.ok(motionMeter.measure(flatMoved, 1500) < 1e-6, 'Compared with the 800 ms frame, the shape is back to flat.');
motionMeter.reset();
assert.equal(motionMeter.measure(flatMoved, 2000), null);

assert.deepEqual(
  extractBlendshapes({ categories: [
    { categoryName: 'eyeBlinkLeft', score: 0.1234 },
    { categoryName: 'eyeBlinkRight', score: 0.2 },
    { categoryName: 'cheekPuff', score: 0.9 },
    { categoryName: 'jawOpen', score: 0.05 },
  ] }),
  { eyeBlinkLeft: 0.123, eyeBlinkRight: 0.2, jawOpen: 0.05 },
);
assert.equal(extractBlendshapes(null), null);
assert.equal(extractBlendshapes({ categories: [{ categoryName: 'cheekPuff', score: 1 }] }), null);

// ── Liveness monitor ─────────────────────────────────────────────────────────
const quietBlendshapes = {
  eyeBlinkLeft: 0.05, eyeBlinkRight: 0.05, jawOpen: 0.02,
  mouthSmileLeft: 0.1, mouthSmileRight: 0.1, mouthPucker: 0.05, mouthFunnel: 0.03, browInnerUp: 0.1,
};
const livingBaseline = { baselineEyeBlink: 0.05, baselineJawOpen: 0.02 };
const frame = (timestampMs, overrides = {}) => ({
  timestampMs,
  wallClockMs: 500000 + timestampMs,
  facePresent: true,
  trackingQuality: 0.8,
  faceCount: 1,
  relativePose: { yaw: 0, pitch: 0 },
  blendshapes: quietBlendshapes,
  nonRigidMotion: 0.005,
  ...overrides,
});
const blinkFrames = timestampMs => [
  frame(timestampMs, { blendshapes: { ...quietBlendshapes, eyeBlinkLeft: 0.7, eyeBlinkRight: 0.7 } }),
  frame(timestampMs + 100),
];
const quickLiveness = {
  ...config.liveness,
  passiveWindowMs: 2000,
  passiveWindowGrowthMs: 500,
  maximumPassiveWindowMs: 4000,
  challengeDurationMs: 1000,
  challengeCooldownMs: 1000,
  cancelledCooldownMs: 300,
  challengeAbsenceCancelMs: 300,
};
const livenessMonitor = (overrides = {}, baseline = livingBaseline, random = () => 0) => {
  const events = [];
  const monitor = new FaceLivenessMonitor({ ...quickLiveness, ...overrides }, baseline, event => events.push(event), { random });
  return { monitor, events };
};

// A picture: nothing ever changes. It is asked, cannot answer, and becomes one
// review incident — then the monitor waits before asking again.
{
  const { monitor, events } = livenessMonitor();
  for (let time = 0; time <= 3200; time += 100) monitor.observe(frame(time));
  const challenge = events.find(event => event.kind === 'liveness-challenge');
  assert.ok(challenge, 'A whole quiet window brings the on-screen check.');
  assert.equal(challenge.challenge, 'blink');
  assert.ok(events.some(event => event.kind === 'liveness-challenge-progress' && event.remainingSeconds === 1));
  const incidents = events.filter(event => event.kind === 'incident');
  assert.deepEqual(incidents.map(event => event.phase), ['start', 'end']);
  assert.equal(incidents[0].eventType, 'FACE_LIVENESS_UNCONFIRMED');
  assert.equal(incidents[0].incidentId, incidents[1].incidentId);
  assert.equal(incidents[0].source, 'FACEMESH');
  assert.equal(incidents[0].challenge, 'blink');
  assert.ok(events.some(event => event.kind === 'liveness-challenge-failed'));
  assert.equal(monitor.snapshot().state, 'cooldown');
  const challengesSoFar = events.filter(event => event.kind === 'liveness-challenge').length;
  for (let time = 3300; time <= 4500; time += 100) monitor.observe(frame(time));
  assert.equal(events.filter(event => event.kind === 'liveness-challenge').length, challengesSoFar, 'No second ask inside the cooldown.');
  for (let time = 4600; time <= 7000; time += 100) monitor.observe(frame(time));
  assert.equal(events.filter(event => event.kind === 'liveness-challenge').length, challengesSoFar + 1, 'The picture is asked again once a fresh window passes.');
}

// A living student blinks now and then; nothing is ever asked of them.
{
  const { monitor, events } = livenessMonitor();
  for (let time = 0; time <= 12000; time += 100) {
    if (time % 1500 === 0) blinkFrames(time).forEach(item => monitor.observe(item));
    else monitor.observe(frame(time));
  }
  assert.equal(events.length, 0, 'Regular blinks keep the monitor silent.');
  assert.equal(monitor.snapshot().lastLifeSign.kind, 'blink');
}

// Other signs of life count just as well: an expression, or the face changing shape.
{
  const { monitor, events } = livenessMonitor();
  for (let time = 0; time <= 6000; time += 100) {
    monitor.observe(frame(time, {
      blendshapes: { ...quietBlendshapes, mouthSmileLeft: time % 1000 === 0 ? 0.5 : 0.1, mouthSmileRight: time % 1000 === 0 ? 0.5 : 0.1 },
    }));
  }
  assert.equal(events.length, 0);
  assert.equal(monitor.snapshot().lastLifeSign.kind, 'expression');
}
{
  const { monitor, events } = livenessMonitor();
  for (let time = 0; time <= 6000; time += 100) {
    monitor.observe(frame(time, { nonRigidMotion: time % 1000 === 0 ? 0.06 : 0.004 }));
  }
  assert.equal(events.length, 0);
  assert.equal(monitor.snapshot().lastLifeSign.kind, 'motion');
}

// Eyes that stay shut and then open are not a blink; a picture swapped for a
// face would read as one otherwise.
{
  const { monitor } = livenessMonitor();
  for (let time = 0; time <= 2000; time += 100) {
    monitor.observe(frame(time, { blendshapes: { ...quietBlendshapes, eyeBlinkLeft: 0.8, eyeBlinkRight: 0.8 } }));
  }
  monitor.observe(frame(2100));
  assert.equal(monitor.snapshot().blinkCount, 0);
}

// Time turned away, badly tracked or with the face gone is not quiet time.
{
  const { monitor, events } = livenessMonitor();
  for (let time = 0; time <= 8000; time += 100) monitor.observe(frame(time, { relativePose: { yaw: 40, pitch: 0 } }));
  for (let time = 8100; time <= 16000; time += 100) monitor.observe(frame(time, { trackingQuality: 0.2 }));
  for (let time = 16100; time <= 24000; time += 100) monitor.observe(frame(time, { facePresent: false, blendshapes: null }));
  for (let time = 24100; time <= 32000; time += 100) monitor.observe(frame(time, { faceCount: 2 }));
  assert.equal(events.length, 0, 'Only clean frontal frames count towards the window.');
  assert.equal(monitor.snapshot().quietMs, 0);
}

// The student answers the ask with two blinks: nothing recorded, and the next
// quiet window is longer.
{
  const { monitor, events } = livenessMonitor();
  for (let time = 0; time <= 2000; time += 100) monitor.observe(frame(time));
  assert.ok(events.some(event => event.kind === 'liveness-challenge'));
  blinkFrames(2100).forEach(item => monitor.observe(item));
  assert.ok(!events.some(event => event.kind === 'liveness-challenge-passed'), 'One blink is not the two that were asked for.');
  blinkFrames(2400).forEach(item => monitor.observe(item));
  assert.ok(events.some(event => event.kind === 'liveness-challenge-passed'));
  assert.equal(events.filter(event => event.kind === 'incident').length, 0);
  assert.equal(monitor.snapshot().windowMs, 2500);
  assert.equal(monitor.snapshot().state, 'cooldown');
}

// A mouth answer is a movement. Opening it passes; a picture of an open mouth
// holds still and does not.
{
  const { monitor, events } = livenessMonitor({}, livingBaseline, () => 0.99);
  for (let time = 0; time <= 2000; time += 100) monitor.observe(frame(time));
  assert.equal(events.find(event => event.kind === 'liveness-challenge').challenge, 'mouth');
  monitor.observe(frame(2100, { blendshapes: { ...quietBlendshapes, jawOpen: 0.5 } }));
  assert.ok(events.some(event => event.kind === 'liveness-challenge-passed'));
}
{
  const openMouth = { ...quietBlendshapes, jawOpen: 0.5 };
  const { monitor, events } = livenessMonitor({}, livingBaseline, () => 0.99);
  for (let time = 0; time <= 3200; time += 100) monitor.observe(frame(time, { blendshapes: openMouth }));
  assert.ok(events.some(event => event.kind === 'liveness-challenge-failed'), 'A mouth that never moves does not answer.');
}

// The face leaves during the ask: cancelled, nothing recorded, no cooldown to
// speak of.
{
  const { monitor, events } = livenessMonitor();
  for (let time = 0; time <= 2000; time += 100) monitor.observe(frame(time));
  for (let time = 2100; time <= 2600; time += 100) monitor.observe(frame(time, { facePresent: false, blendshapes: null }));
  const cancelled = events.find(event => event.kind === 'liveness-challenge-cancelled');
  assert.equal(cancelled?.reason, 'face-not-visible');
  assert.equal(events.filter(event => event.kind === 'incident').length, 0);
}

// Eyes that never read as open make blinks unreadable. Blinks stop counting,
// the window is scaled up and the ask is for the mouth.
{
  const { monitor, events } = livenessMonitor({}, { baselineEyeBlink: 0.6, baselineJawOpen: 0.02 }, () => 0);
  for (let time = 0; time <= 2500; time += 100) monitor.observe(frame(time));
  assert.ok(events.some(event => event.kind === 'liveness-blink-unreliable'));
  assert.equal(monitor.snapshot().blinkReliable, false);
  assert.equal(monitor.snapshot().windowMs, 4000);
  assert.ok(!events.some(event => event.kind === 'liveness-challenge'), 'The doubled window has not passed.');
  for (let time = 2600; time <= 4200; time += 100) monitor.observe(frame(time));
  assert.equal(events.find(event => event.kind === 'liveness-challenge')?.challenge, 'mouth');
}

// Without calibration the open-eye level is learned from the first frames.
{
  const { monitor } = livenessMonitor({}, null);
  for (let time = 0; time <= 2500; time += 100) monitor.observe(frame(time));
  assert.ok(Math.abs(monitor.snapshot().restEyeBlink - 0.05) < 0.01);
  assert.equal(monitor.snapshot().blinkReliable, true);
}

// A camera whose model gives no expression scores switches the check off.
{
  const { monitor, events } = livenessMonitor();
  monitor.observe(frame(0, { blendshapes: { jawOpen: 0.1 } }));
  assert.deepEqual(events.map(event => event.kind), ['liveness-unavailable']);
  for (let time = 100; time <= 5000; time += 100) monitor.observe(frame(time));
  assert.equal(events.length, 1);
  assert.equal(monitor.snapshot().state, 'disabled');
}
{
  const { monitor, events } = livenessMonitor({ enabled: false });
  for (let time = 0; time <= 5000; time += 100) monitor.observe(frame(time));
  assert.equal(events.length, 0);
}

// Stopping mid-ask cancels it rather than failing it.
{
  const { monitor, events } = livenessMonitor();
  for (let time = 0; time <= 2000; time += 100) monitor.observe(frame(time));
  monitor.stop();
  assert.equal(events.find(event => event.kind === 'liveness-challenge-cancelled')?.reason, 'monitoring-stopped');
  assert.equal(events.filter(event => event.kind === 'incident').length, 0);
}

// Calibration records the open-eye and closed-mouth levels, ignoring a blink.
{
  const blinkCalibration = new FaceCalibrationSession(config.calibration);
  let blinkBaseline = null;
  for (let t = 0; t <= 9000; t += 150) {
    const result = blinkCalibration.addObservation({
      timestampMs: t,
      facePresent: true,
      trackingQuality: 0.6,
      pose: { yaw: 0, pitch: 0, roll: 0 },
      geometry: { width: 0.24, height: 0.3, centerX: 0.5, centerY: 0.5 },
      blendshapes: t === 1500 || t === 1650
        ? { eyeBlinkLeft: 0.8, eyeBlinkRight: 0.8, jawOpen: 0.02 }
        : { eyeBlinkLeft: 0.06, eyeBlinkRight: 0.04, jawOpen: 0.02 },
    });
    if (result.complete) { blinkBaseline = result.baseline; break; }
  }
  assert.ok(Math.abs(blinkBaseline.baselineEyeBlink - 0.05) < 0.001);
  assert.equal(blinkBaseline.baselineJawOpen, 0.02);
  assert.equal(cuelessBaseline.baselineEyeBlink, null);
}

// ── Face shown on a phone screen ─────────────────────────────────────────────
const screenConfig = { ...config.faceOnScreen, incidentMs: 1000, minimumHits: 3, gapToleranceMs: 500, recoveryMs: 500 };
const faceOnPhone = { x: 200, y: 150, width: 100, height: 120, frameWidth: 640, frameHeight: 480 };
const phoneAround = confidence => ({ confidence, boundingBox: { x: 150, y: 100, width: 200, height: 300, frameWidth: 640, frameHeight: 480 } });
assert.ok(findContainingPhone(faceOnPhone, [phoneAround(0.6)], screenConfig));
assert.equal(findContainingPhone(faceOnPhone, [phoneAround(0.2)], screenConfig), null, 'Below the phone confidence floor.');
assert.equal(findContainingPhone(faceOnPhone, [{ confidence: 0.9, boundingBox: { x: 0, y: 0, width: 620, height: 470, frameWidth: 640, frameHeight: 480 } }], screenConfig), null, 'A box that is most of the frame is a monitor, not a phone.');
assert.equal(findContainingPhone(faceOnPhone, [{ confidence: 0.9, boundingBox: { x: 210, y: 160, width: 80, height: 100, frameWidth: 640, frameHeight: 480 } }], screenConfig), null, 'A phone smaller than the face is in front of it, not showing it.');
assert.equal(findContainingPhone(faceOnPhone, [{ confidence: 0.9, boundingBox: { x: 400, y: 100, width: 200, height: 300, frameWidth: 640, frameHeight: 480 } }], screenConfig), null, 'A phone beside the face does not contain it.');
// Boxes from frames of different sizes are compared in frame fractions.
assert.ok(findContainingPhone(faceOnPhone, [{ confidence: 0.6, boundingBox: { x: 75, y: 50, width: 100, height: 150, frameWidth: 320, frameHeight: 240 } }], screenConfig));

{
  const events = [];
  const detector = new FaceOnScreenDetector(screenConfig, event => events.push(event));
  for (const time of [0, 400, 800]) {
    detector.observeFace(faceOnPhone, time);
    detector.observePhones([phoneAround(0.6)], time, 700000 + time);
  }
  assert.equal(events.length, 0, 'Three scans inside one second is not yet sustained.');
  detector.observeFace(faceOnPhone, 1200);
  detector.observePhones([phoneAround(0.7)], 1200, 701200);
  assert.equal(events.length, 1);
  assert.equal(events[0].eventType, 'FACE_ON_PHONE_SCREEN');
  assert.equal(events[0].phase, 'start');
  assert.equal(events[0].source, 'FACEMESH_YOLO');
  assert.equal(events[0].phoneConfidence, 0.7);
  assert.equal(events[0].frameHits, 4);
  detector.observeFace(faceOnPhone, 1600);
  detector.observePhones([], 1600, 701600);
  assert.equal(events.length, 1, 'One empty scan is not the end of it.');
  detector.observeFace(faceOnPhone, 2200);
  detector.observePhones([], 2200, 702200);
  assert.deepEqual(events.map(event => event.phase), ['start', 'end']);
  assert.equal(events[1].incidentId, events[0].incidentId);
}
{
  const events = [];
  const detector = new FaceOnScreenDetector(screenConfig, event => events.push(event));
  // Scattered single sightings with gaps longer than the tolerance never add up.
  for (const time of [0, 1000, 2000, 3000, 4000]) {
    detector.observeFace(faceOnPhone, time);
    detector.observePhones([phoneAround(0.9)], time, 700000 + time);
  }
  assert.equal(events.length, 0);
  // A stale face box says nothing about the current scan.
  detector.observeFace(faceOnPhone, 5000);
  for (const time of [8000, 8400, 8800, 9200]) detector.observePhones([phoneAround(0.9)], time, 700000 + time);
  assert.equal(events.length, 0);
}
{
  const events = [];
  const detector = new FaceOnScreenDetector(screenConfig, event => events.push(event));
  for (const time of [0, 400, 800, 1200]) {
    detector.observeFace(faceOnPhone, time);
    detector.observePhones([phoneAround(0.6)], time, 700000 + time);
  }
  detector.stop(1300, 701300);
  assert.deepEqual(events.map(event => event.phase), ['start', 'end']);
}

console.log('FaceMesh pose, calibration, temporal, correlation, aggregation, liveness, face-on-screen, and camera error tests passed.');

import assert from 'node:assert/strict';
import { FaceCalibrationSession } from '../src/lib/proctoring/facemesh/calibrationService.js';
import { requestCameraStream } from '../src/lib/proctoring/facemesh/cameraAccess.js';
import { FaceEventCorrelator } from '../src/lib/proctoring/facemesh/faceEventCorrelator.js';
import { resolveFaceMonitoringConfig } from '../src/lib/proctoring/facemesh/faceMonitoringConfig.js';
import { FaceSessionAggregator } from '../src/lib/proctoring/facemesh/faceSessionAggregator.js';
import {
  classifyHeadDirection,
  eulerFromTransformationMatrix,
  estimateEulerFromLandmarks,
  relativePose,
  smoothHeadPose,
} from '../src/lib/proctoring/facemesh/headPoseEstimator.js';
import { FaceTemporalRuleEngine } from '../src/lib/proctoring/facemesh/temporalRuleEngine.js';

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
assert.equal(config.inferenceFps, 15);
assert.equal(config.maximumInferenceDimension, 640);
assert.equal(config.minFacePresenceConfidence, 0.45);
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
for (let time = 0; time <= 1100; time += 100) {
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
aggregator.observe({ trackingQuality: 0.8, relativePose: { yaw: -31, pitch: 6 } });
aggregator.consume({ kind: 'incident', phase: 'end', incidentId: 'a', eventType: 'SUSTAINED_HEAD_TURN', durationMs: 5000 });
aggregator.consume({ kind: 'incident', phase: 'end', incidentId: 'a', eventType: 'SUSTAINED_HEAD_TURN', durationMs: 5000 });
assert.equal(aggregator.snapshot().head_turn_count, 1);
assert.equal(aggregator.snapshot().head_turn_total_seconds, 5);
assert.equal(aggregator.snapshot().maximum_absolute_yaw, 31);

const permissionError = new DOMException('Permission blocked', 'NotAllowedError');
await assert.rejects(
  requestCameraStream({ getUserMedia: () => Promise.reject(permissionError) }, { video: true }),
  error => error?.code === 'PERMISSION_DENIED' && /permission was denied/i.test(error.message),
);
await assert.rejects(
  requestCameraStream(null, { video: true }),
  error => error?.code === 'UNAVAILABLE',
);

console.log('FaceMesh pose, calibration, temporal, correlation, aggregation, and camera error tests passed.');

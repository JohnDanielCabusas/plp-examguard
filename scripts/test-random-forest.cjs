const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  FEATURE_COLUMNS,
  NEUTRAL_FEATURE_DEFAULTS,
  PredictionUnavailableError,
  aggregateSessionFeatureSnapshot,
  aggregateSessionFeatures,
  aggregateViolationFeatureSnapshot,
} = require('../server/random-forest-aggregation.cjs');

const mlRoot = path.resolve(__dirname, '..', 'ml', 'random_forest');
const contract = JSON.parse(fs.readFileSync(path.join(mlRoot, 'feature_contract.json'), 'utf8'));
const metadata = JSON.parse(fs.readFileSync(
  path.join(mlRoot, 'artifacts', 'random_forest_metadata.json'),
  'utf8',
));
assert.deepEqual(contract.features.map(feature => feature.name), FEATURE_COLUMNS);
assert.deepEqual(metadata.feature_columns, FEATURE_COLUMNS);

const examSource = fs.readFileSync(path.resolve(__dirname, '..', 'public', 'js', 'exam.js'), 'utf8');
const markerStart = examSource.indexOf('_buildRefreshAutoSubmitMarker()');
const markerEnd = examSource.indexOf('_applyRefreshAutoSubmitMarker(marker)', markerStart);
const applyEnd = examSource.indexOf('_enableRefreshProtection()', markerEnd);
assert.ok(markerStart >= 0 && markerEnd > markerStart && applyEnd > markerEnd);
const markerSource = examSource.slice(markerStart, markerEnd);
const refreshSubmitSource = examSource.slice(markerEnd, applyEnd);
assert.ok(
  markerSource.indexOf('this._persistFaceMonitoringSummary()') < markerSource.indexOf('DB.getSession'),
  'Reload submission must snapshot webcam behavior before capturing the session marker.',
);
assert.match(refreshSubmitSource, /type:\s*'browser_exam_end'/, 'Reload submission must preserve the browser end feature.');
assert.match(refreshSubmitSource, /featureContractVersion:\s*'rf-session-summary-v1'/);

const session = {
  submitted: true,
  start_time: '2026-09-08T01:00:00.000Z',
  end_time: '2026-09-08T01:20:00.000Z',
  activities: [
    { type: 'browser_exam_start' },
    { type: 'tab_switch' },
    { type: 'tab_switch' },
    { type: 'screenshot' },
    { type: 'browser_exam_end' },
    { type: 'copy_attempt' },
    { type: 'fullscreen_exit' },
  ],
  ai_detections: {
    faceMonitoring: {
      feature_contract_version: 'rf-session-summary-v1',
      randomForestCompatible: true,
      final_face_present: 1,
      maximum_face_count: 2,
      average_tracking_confidence: 0.875,
      maximum_hand_count: 2,
      average_head_pitch_degrees: 5,
      average_head_yaw_degrees: 10,
      average_head_roll_degrees: -0.1,
    },
  },
};

const features = aggregateSessionFeatures(session);
assert.deepEqual(Object.keys(features), FEATURE_COLUMNS);
assert.equal(features.browser_start_count, 1);
assert.equal(features.browser_end_count, 1);
assert.equal(features.browser_tab_switched_count, 2);
assert.equal(features.browser_screenshot_count, 1);
assert.equal(features.browser_exam_duration_minutes, 20);
assert.equal(features.webcam_face_conf, 87.5);
assert.equal(features.webcam_no_of_face, 2);
assert.equal(features.webcam_hand_count, 2);
assert.equal(features.webcam_head_yaw, 0.174533);
assert.equal('fullscreen_exit' in features, false);
assert.equal('copy_attempt' in features, false);

const missingBrowser = aggregateSessionFeatureSnapshot({ ...session, activities: [] });
assert.equal(missingBrowser.features.browser_start_count, NEUTRAL_FEATURE_DEFAULTS.browser_start_count);
assert.equal(missingBrowser.features.browser_end_count, NEUTRAL_FEATURE_DEFAULTS.browser_end_count);
assert.ok(missingBrowser.imputedFeatures.includes('browser_start_count'));
assert.ok(missingBrowser.imputedFeatures.includes('browser_end_count'));

const missingWebcam = aggregateSessionFeatureSnapshot({ ...session, ai_detections: {} });
assert.equal(missingWebcam.features.webcam_face_present, NEUTRAL_FEATURE_DEFAULTS.webcam_face_present);
assert.equal(missingWebcam.features.webcam_face_conf, NEUTRAL_FEATURE_DEFAULTS.webcam_face_conf);
assert.ok(missingWebcam.imputedFeatures.includes('webcam_face_present'));
assert.ok(missingWebcam.imputedFeatures.includes('webcam_head_roll'));

const partialWebcam = aggregateSessionFeatureSnapshot({
  ...session,
  ai_detections: {
    faceMonitoring: {
      observation_count: 20,
      tracking_sample_count: 0,
      pose_sample_count: 20,
      hand_sample_count: 0,
      final_face_present: 0,
      maximum_face_count: 2,
      average_tracking_confidence: 0,
      maximum_hand_count: 0,
      average_head_pitch_degrees: 5,
      average_head_yaw_degrees: 10,
      average_head_roll_degrees: -0.1,
    },
  },
});
assert.equal(partialWebcam.features.webcam_face_present, 0, 'Recorded face behavior must be preserved.');
assert.equal(partialWebcam.features.webcam_head_yaw, 0.174533, 'Recorded pose behavior must be preserved.');
assert.equal(partialWebcam.features.webcam_face_conf, NEUTRAL_FEATURE_DEFAULTS.webcam_face_conf);
assert.equal(partialWebcam.features.webcam_hand_count, NEUTRAL_FEATURE_DEFAULTS.webcam_hand_count);
assert.ok(partialWebcam.imputedFeatures.includes('webcam_face_conf'));
assert.ok(!partialWebcam.imputedFeatures.includes('webcam_head_yaw'));
assert.throws(
  () => aggregateSessionFeatures({ ...session, submitted: false }),
  (error) => error instanceof PredictionUnavailableError && error.code === 'SESSION_NOT_COMPLETED',
);

const timeoutOnly = aggregateViolationFeatureSnapshot({
  ...session,
  start_time: '2026-09-08T01:00:00.000Z',
  end_time: '2026-09-08T02:30:00.000Z',
  activities: [
    { type: 'browser_exam_start' },
    { type: 'brightness_check_passed' },
    { type: 'browser_exam_end', metadata: { trigger: 'timeout' } },
    { type: 'timeout' },
  ],
});
assert.equal(timeoutOnly.violationCount, 0, 'Timeout and pre-exam checks are not rule violations.');
assert.deepEqual(timeoutOnly.features, NEUTRAL_FEATURE_DEFAULTS, 'Lifecycle records must leave every model feature neutral.');

const recordedRuleViolations = aggregateViolationFeatureSnapshot(session, [
  { violation_type: 'tab_switch', warning_count: 1, dismissed: false },
  { violation_type: 'screenshot', warning_count: 2, dismissed: false },
  { violation_type: 'no_person', warning_count: 3, dismissed: true },
]);
assert.equal(recordedRuleViolations.violationCount, 2, 'Dismissed violations must not contribute.');
assert.equal(recordedRuleViolations.features.browser_tab_switched_count, 1);
assert.equal(recordedRuleViolations.features.browser_screenshot_count, 1);
assert.equal(recordedRuleViolations.features.browser_exam_duration_minutes, NEUTRAL_FEATURE_DEFAULTS.browser_exam_duration_minutes);
assert.equal(recordedRuleViolations.features.webcam_face_present, NEUTRAL_FEATURE_DEFAULTS.webcam_face_present);

console.log('Random Forest aggregation tests passed.');

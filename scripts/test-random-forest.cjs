const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  FEATURE_COLUMNS,
  PredictionUnavailableError,
  aggregateSessionFeatures,
} = require('../server/random-forest-aggregation.cjs');

const mlRoot = path.resolve(__dirname, '..', 'ml', 'random_forest');
const contract = JSON.parse(fs.readFileSync(path.join(mlRoot, 'feature_contract.json'), 'utf8'));
const metadata = JSON.parse(fs.readFileSync(
  path.join(mlRoot, 'artifacts', 'random_forest_metadata.json'),
  'utf8',
));
assert.deepEqual(contract.features.map(feature => feature.name), FEATURE_COLUMNS);
assert.deepEqual(metadata.feature_columns, FEATURE_COLUMNS);

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

assert.throws(
  () => aggregateSessionFeatures({ ...session, activities: [] }),
  (error) => error instanceof PredictionUnavailableError && error.code === 'BROWSER_SUMMARY_UNAVAILABLE',
);
assert.throws(
  () => aggregateSessionFeatures({ ...session, ai_detections: {} }),
  (error) => error instanceof PredictionUnavailableError && error.code === 'WEBCAM_SUMMARY_UNAVAILABLE',
);
assert.throws(
  () => aggregateSessionFeatures({ ...session, submitted: false }),
  (error) => error instanceof PredictionUnavailableError && error.code === 'SESSION_NOT_COMPLETED',
);

console.log('Random Forest aggregation tests passed.');

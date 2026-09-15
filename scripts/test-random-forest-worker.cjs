const assert = require('node:assert/strict');
const path = require('node:path');
const { forwardEnvironment } = require('../server/environment.cjs');
const { aggregateSessionFeatureSnapshot } = require('../server/random-forest-aggregation.cjs');
const worker = require('../server/random-forest-worker.cjs');

async function run() {
  const targetEnvironment = {
    RF_PYTHON_PATH: 'undefined',
    RF_MODEL_PATH: ' null ',
    RF_METADATA_PATH: 'undefined',
  };
  forwardEnvironment({}, Object.keys(targetEnvironment), targetEnvironment);
  assert.deepEqual(targetEnvironment, {});

  // Retain compatibility with a development process that was started before
  // the Vite environment fix and already contains these literal sentinels.
  process.env.RF_PYTHON_PATH = 'undefined';
  process.env.RF_MODEL_PATH = ' null ';
  process.env.RF_METADATA_PATH = 'undefined';
  const projectRoot = path.resolve(__dirname, '..');
  assert.equal(
    worker.resolveModelPath(),
    path.join(projectRoot, 'ml', 'random_forest', 'artifacts', 'random_forest_model.joblib'),
  );
  assert.equal(
    worker.resolveMetadataPath(),
    path.join(projectRoot, 'ml', 'random_forest', 'artifacts', 'random_forest_metadata.json'),
  );
  assert.notEqual(worker.resolvePythonPath(), 'undefined');

  const metadata = worker.getModelMetadata();
  assert.equal(metadata.feature_contract_version, 'rf-session-summary-v1');

  const ordinaryBehavior = {
    browser_start_count: 1,
    browser_end_count: 1,
    browser_tab_switched_count: 0,
    browser_screenshot_count: 0,
    browser_exam_duration_minutes: 24.17,
    webcam_face_present: 1,
    webcam_no_of_face: 1,
    webcam_face_conf: 90.7339,
    webcam_hand_count: 2,
    webcam_head_pitch: 0.004707,
    webcam_head_yaw: -0.013718,
    webcam_head_roll: 0.00032,
  };
  const suspiciousBehavior = {
    browser_start_count: 1,
    browser_end_count: 1,
    browser_tab_switched_count: 0,
    browser_screenshot_count: 0,
    browser_exam_duration_minutes: 18.65,
    webcam_face_present: 0,
    webcam_no_of_face: 0,
    webcam_face_conf: 0,
    webcam_hand_count: 0,
    webcam_head_pitch: 0,
    webcam_head_yaw: 0,
    webcam_head_roll: 0,
  };
  const browserFlaggedBehavior = {
    ...ordinaryBehavior,
    browser_tab_switched_count: 5,
    browser_screenshot_count: 1,
  };

  const ordinaryPrediction = await worker.predict(ordinaryBehavior);
  const repeatPrediction = await worker.predict(ordinaryBehavior);
  const browserFlaggedPrediction = await worker.predict(browserFlaggedBehavior);
  const suspiciousPrediction = await worker.predict(suspiciousBehavior);
  assert.ok(ordinaryPrediction.suspiciousProbability >= 0 && ordinaryPrediction.suspiciousProbability <= 1);
  assert.equal(ordinaryPrediction.riskLevel, 'normal');
  assert.equal(repeatPrediction.suspiciousProbability, ordinaryPrediction.suspiciousProbability, 'Identical behavior must produce a deterministic percentage.');
  assert.ok(browserFlaggedPrediction.suspiciousProbability > ordinaryPrediction.suspiciousProbability, 'Browser violations must affect the suspicious percentage.');
  assert.equal(browserFlaggedPrediction.requiresProfessorReview, true);
  assert.equal(suspiciousPrediction.riskLevel, 'suspicious');
  assert.ok(suspiciousPrediction.suspiciousProbability > ordinaryPrediction.suspiciousProbability, 'Webcam anomalies must affect the suspicious percentage.');
  assert.equal(ordinaryPrediction.modelVersion, metadata.model_version);
  assert.ok(ordinaryPrediction.predictedAt);

  const missingSensorSnapshot = aggregateSessionFeatureSnapshot({
    submitted: true,
    activities: [],
    ai_detections: {},
  }, metadata.missing_feature_defaults);
  const missingSensorPrediction = await worker.predict(missingSensorSnapshot.features);
  assert.ok(Number.isFinite(missingSensorPrediction.suspiciousProbability));
  assert.equal(missingSensorPrediction.riskLevel, 'normal', 'Missing sensors alone must not flag a student.');
  assert.equal(missingSensorSnapshot.imputedFeatures.length, 10);

  const partialBrowserSnapshot = aggregateSessionFeatureSnapshot({
    submitted: true,
    activities: [{ type: 'tab_switch' }],
    ai_detections: {},
  }, metadata.missing_feature_defaults);
  const partialBrowserPrediction = await worker.predict(partialBrowserSnapshot.features);
  assert.ok(
    partialBrowserPrediction.suspiciousProbability > missingSensorPrediction.suspiciousProbability,
    'Recorded browser behavior must still influence a prediction when webcam readings are absent.',
  );

  // A replacement worker must produce the same result after a process recycle.
  worker.stopWorker();
  const recoveredPrediction = await worker.predict(ordinaryBehavior);
  assert.equal(recoveredPrediction.suspiciousProbability, ordinaryPrediction.suspiciousProbability);
  console.log('Persistent, deterministic, behavior-sensitive, and restartable Random Forest worker tests passed.');
}

run()
  .catch(error => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => worker.stopWorker());

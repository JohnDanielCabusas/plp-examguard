const assert = require('node:assert/strict');
const path = require('node:path');
const { forwardEnvironment } = require('../server/environment.cjs');
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
  const features = Object.fromEntries(metadata.feature_columns.map(column => [column, 0]));
  const prediction = await worker.predict(features);
  assert.ok(prediction.suspiciousProbability >= 0 && prediction.suspiciousProbability <= 1);
  assert.ok(['normal', 'needs_monitoring', 'suspicious'].includes(prediction.riskLevel));
  assert.equal(prediction.modelVersion, metadata.model_version);
  assert.ok(prediction.predictedAt);
  console.log('Persistent Random Forest worker test passed.');
}

run()
  .catch(error => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => worker.stopWorker());

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { spawn } = require('child_process');
const { optionalEnvironmentValue } = require('./environment.cjs');
const {
  FEATURE_COLUMNS,
  FEATURE_CONTRACT_VERSION,
} = require('./random-forest-aggregation.cjs');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const ML_ROOT = path.join(PROJECT_ROOT, 'ml', 'random_forest');
const WORKER_PATH = path.join(ML_ROOT, 'prediction_worker.py');
const REQUEST_TIMEOUT_MS = 15_000;

let worker = null;
const pending = new Map();

function resolvePythonPath() {
  const configured = optionalEnvironmentValue('RF_PYTHON_PATH');
  if (configured) return configured;
  const local = process.platform === 'win32'
    ? path.join(PROJECT_ROOT, '.venv', 'Scripts', 'python.exe')
    : path.join(PROJECT_ROOT, '.venv', 'bin', 'python');
  return fs.existsSync(local) ? local : (process.platform === 'win32' ? 'python' : 'python3');
}

function resolveModelPath() {
  return path.resolve(
    optionalEnvironmentValue('RF_MODEL_PATH')
      || path.join(ML_ROOT, 'artifacts', 'random_forest_model.joblib'),
  );
}

function resolveMetadataPath() {
  return path.resolve(
    optionalEnvironmentValue('RF_METADATA_PATH')
      || path.join(ML_ROOT, 'artifacts', 'random_forest_metadata.json'),
  );
}

function getModelMetadata() {
  const metadata = JSON.parse(fs.readFileSync(resolveMetadataPath(), 'utf8'));
  const columnsMatch = Array.isArray(metadata.feature_columns)
    && metadata.feature_columns.length === FEATURE_COLUMNS.length
    && metadata.feature_columns.every((column, index) => column === FEATURE_COLUMNS[index]);
  const missingDefaultsMatch = metadata.missing_feature_defaults
    && FEATURE_COLUMNS.every(column => Number.isFinite(Number(metadata.missing_feature_defaults[column])));
  if (
    !metadata.model_version
    || metadata.feature_contract_version !== FEATURE_CONTRACT_VERSION
    || !columnsMatch
    || !missingDefaultsMatch
  ) {
    throw new Error('Random Forest metadata is invalid. Retrain the model artifact.');
  }
  return metadata;
}

function workerFailure(message, cause = null) {
  const error = new Error(message);
  error.randomForestWorkerFailure = true;
  if (cause) error.cause = cause;
  return error;
}

function rejectPendingForWorker(activeWorker, error) {
  for (const [id, request] of pending.entries()) {
    if (request.worker !== activeWorker) continue;
    pending.delete(id);
    clearTimeout(request.timeout);
    request.reject(error);
  }
}

function disposeWorker(activeWorker, error, intentional = false) {
  if (!activeWorker) return;
  activeWorker._rfIntentionalStop = intentional;
  activeWorker._rfLineReader?.close?.();
  if (worker === activeWorker) worker = null;
  if (!activeWorker.killed && activeWorker.exitCode === null) activeWorker.kill();
  rejectPendingForWorker(activeWorker, error);
}

function stopWorker() {
  const activeWorker = worker;
  if (!activeWorker) return;
  disposeWorker(activeWorker, new Error('Random Forest prediction worker stopped.'), true);
}

function ensureWorker() {
  if (worker && !worker.killed && worker.exitCode === null) return worker;
  getModelMetadata();
  const activeWorker = spawn(resolvePythonPath(), [
    WORKER_PATH,
    '--model', resolveModelPath(),
    '--metadata', resolveMetadataPath(),
  ], {
    cwd: PROJECT_ROOT,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  worker = activeWorker;

  const activeLineReader = readline.createInterface({ input: activeWorker.stdout });
  activeWorker._rfLineReader = activeLineReader;
  activeLineReader.on('line', (line) => {
    let response;
    try {
      response = JSON.parse(line);
    } catch (_) {
      return;
    }
    const request = pending.get(response.id);
    if (!request || request.worker !== activeWorker) return;
    pending.delete(response.id);
    clearTimeout(request.timeout);
    if (response.success) request.resolve(response.prediction);
    else request.reject(new Error(response.message || 'Random Forest prediction failed.'));
  });
  activeWorker.stderr.on('data', (chunk) => {
    const message = String(chunk || '').trim();
    if (message) console.warn('[Random Forest worker]', message);
  });
  activeWorker.on('error', (error) => {
    if (worker === activeWorker) worker = null;
    rejectPendingForWorker(
      activeWorker,
      workerFailure('Random Forest prediction worker could not start.', error),
    );
  });
  activeWorker.on('exit', (code) => {
    if (worker === activeWorker) worker = null;
    if (!activeWorker._rfIntentionalStop) {
      rejectPendingForWorker(
        activeWorker,
        workerFailure(`Random Forest prediction worker exited (${code ?? 'unknown'}).`),
      );
    }
  });
  return activeWorker;
}

function predictOnce(features) {
  const activeWorker = ensureWorker();
  const id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      if (!pending.has(id)) return;
      disposeWorker(
        activeWorker,
        workerFailure('Random Forest prediction timed out.'),
      );
    }, REQUEST_TIMEOUT_MS);
    pending.set(id, { resolve, reject, timeout, worker: activeWorker });
    activeWorker.stdin.write(`${JSON.stringify({ id, features })}\n`, (error) => {
      if (!error) return;
      const request = pending.get(id);
      if (!request || request.worker !== activeWorker) return;
      disposeWorker(
        activeWorker,
        workerFailure('Unable to send features to the Random Forest prediction worker.', error),
      );
    });
  });
}

async function predict(features) {
  let lastError = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await predictOnce(features);
    } catch (error) {
      lastError = error;
      if (error?.randomForestWorkerFailure !== true || attempt > 0) throw error;
    }
  }
  throw lastError || new Error('Random Forest prediction failed.');
}

process.once('exit', stopWorker);

module.exports = {
  getModelMetadata,
  predict,
  resolveMetadataPath,
  resolveModelPath,
  resolvePythonPath,
  stopWorker,
};

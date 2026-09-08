const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { spawn } = require('child_process');
const { optionalEnvironmentValue } = require('./environment.cjs');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const ML_ROOT = path.join(PROJECT_ROOT, 'ml', 'random_forest');
const WORKER_PATH = path.join(ML_ROOT, 'prediction_worker.py');
const REQUEST_TIMEOUT_MS = 15_000;

let worker = null;
let lineReader = null;
let shuttingDown = false;
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
  if (!metadata.model_version || !Array.isArray(metadata.feature_columns)) {
    throw new Error('Random Forest metadata is invalid. Retrain the model artifact.');
  }
  return metadata;
}

function rejectPending(error) {
  for (const request of pending.values()) {
    clearTimeout(request.timeout);
    request.reject(error);
  }
  pending.clear();
}

function stopWorker() {
  shuttingDown = true;
  lineReader?.close?.();
  lineReader = null;
  if (worker && !worker.killed) worker.kill();
  worker = null;
  rejectPending(new Error('Random Forest prediction worker stopped.'));
}

function ensureWorker() {
  if (worker && !worker.killed) return worker;
  getModelMetadata();
  shuttingDown = false;
  worker = spawn(resolvePythonPath(), [
    WORKER_PATH,
    '--model', resolveModelPath(),
    '--metadata', resolveMetadataPath(),
  ], {
    cwd: PROJECT_ROOT,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });

  lineReader = readline.createInterface({ input: worker.stdout });
  lineReader.on('line', (line) => {
    let response;
    try {
      response = JSON.parse(line);
    } catch (_) {
      return;
    }
    const request = pending.get(response.id);
    if (!request) return;
    pending.delete(response.id);
    clearTimeout(request.timeout);
    if (response.success) request.resolve(response.prediction);
    else request.reject(new Error(response.message || 'Random Forest prediction failed.'));
  });
  worker.stderr.on('data', (chunk) => {
    const message = String(chunk || '').trim();
    if (message) console.warn('[Random Forest worker]', message);
  });
  worker.on('error', (error) => {
    rejectPending(error);
    worker = null;
  });
  worker.on('exit', (code) => {
    const unexpected = !shuttingDown;
    worker = null;
    lineReader = null;
    if (unexpected) rejectPending(new Error(`Random Forest prediction worker exited (${code ?? 'unknown'}).`));
  });
  return worker;
}

function predict(features) {
  const activeWorker = ensureWorker();
  const id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pending.delete(id);
      reject(new Error('Random Forest prediction timed out.'));
    }, REQUEST_TIMEOUT_MS);
    pending.set(id, { resolve, reject, timeout });
    activeWorker.stdin.write(`${JSON.stringify({ id, features })}\n`, (error) => {
      if (!error) return;
      const request = pending.get(id);
      if (!request) return;
      pending.delete(id);
      clearTimeout(request.timeout);
      reject(error);
    });
  });
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

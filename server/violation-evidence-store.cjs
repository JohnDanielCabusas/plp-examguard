const fs = require('fs/promises');
const path = require('path');

const BASE_DIR = path.join(process.cwd(), '.data', 'violation-evidence');

async function ensureBaseDir() {
  await fs.mkdir(BASE_DIR, { recursive: true });
  return BASE_DIR;
}

function resolveRelativePath(relativePath) {
  const normalized = String(relativePath || '').replace(/\\/g, '/').replace(/^\/+/, '');
  const absolutePath = path.resolve(BASE_DIR, normalized);
  if (!absolutePath.startsWith(BASE_DIR)) {
    const error = new Error('Invalid evidence path.');
    error.code = 'INVALID_EVIDENCE_PATH';
    throw error;
  }
  return { normalized, absolutePath };
}

async function writeEvidenceFile(relativePath, buffer) {
  await ensureBaseDir();
  const { normalized, absolutePath } = resolveRelativePath(relativePath);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, buffer);
  return { relativePath: normalized, absolutePath };
}

async function readEvidenceFile(relativePath) {
  await ensureBaseDir();
  const { absolutePath } = resolveRelativePath(relativePath);
  const data = await fs.readFile(absolutePath);
  return { absolutePath, data };
}

async function deleteEvidenceFile(relativePath) {
  await ensureBaseDir();
  const { absolutePath } = resolveRelativePath(relativePath);
  await fs.unlink(absolutePath).catch(() => {});
}

module.exports = {
  ensureBaseDir,
  writeEvidenceFile,
  readEvidenceFile,
  deleteEvidenceFile,
};

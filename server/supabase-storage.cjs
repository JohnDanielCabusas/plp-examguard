function getStorageConfig() {
  const url = String(process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
  const key = String(
    process.env.SUPABASE_SERVICE_ROLE_KEY
    || process.env.VITE_SUPABASE_PUBLISHABLE_KEY
    || process.env.SUPABASE_PUBLISHABLE_KEY
    || '',
  ).trim();

  if (!url || !key) {
    const error = new Error('Supabase Storage is not configured on the server.');
    error.code = 'SUPABASE_STORAGE_CONFIG_MISSING';
    throw error;
  }

  return { url, key };
}

function encodeObjectPath(bucket, objectPath) {
  const encodedBucket = encodeURIComponent(String(bucket || '').trim());
  const encodedPath = String(objectPath || '')
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .split('/')
    .map(segment => encodeURIComponent(segment))
    .join('/');
  return `${encodedBucket}/${encodedPath}`;
}

function storageHeaders(key, extra = {}) {
  return {
    apikey: key,
    Authorization: `Bearer ${key}`,
    ...extra,
  };
}

async function readStorageError(response) {
  const payload = await response.json().catch(() => null);
  return payload?.message || payload?.error || `Supabase Storage request failed (${response.status}).`;
}

async function uploadStorageObject(bucket, objectPath, data, mimeType) {
  const { url, key } = getStorageConfig();
  const response = await fetch(`${url}/storage/v1/object/${encodeObjectPath(bucket, objectPath)}`, {
    method: 'POST',
    headers: storageHeaders(key, {
      'Content-Type': mimeType || 'application/octet-stream',
      'x-upsert': 'true',
    }),
    body: data,
  });

  if (!response.ok) {
    const error = new Error(await readStorageError(response));
    error.code = 'SUPABASE_STORAGE_UPLOAD_FAILED';
    error.status = response.status;
    throw error;
  }
}

async function downloadStorageObject(bucket, objectPath, range = '') {
  const { url, key } = getStorageConfig();
  const headers = storageHeaders(key);
  if (range) headers.Range = range;

  const response = await fetch(`${url}/storage/v1/object/${encodeObjectPath(bucket, objectPath)}`, {
    method: 'GET',
    headers,
  });

  if (!response.ok && response.status !== 206) {
    const error = new Error(await readStorageError(response));
    error.code = response.status === 404 ? 'SUPABASE_STORAGE_NOT_FOUND' : 'SUPABASE_STORAGE_DOWNLOAD_FAILED';
    error.status = response.status;
    throw error;
  }

  return {
    status: response.status,
    data: Buffer.from(await response.arrayBuffer()),
    contentLength: response.headers.get('content-length'),
    contentRange: response.headers.get('content-range'),
    acceptRanges: response.headers.get('accept-ranges'),
  };
}

module.exports = {
  downloadStorageObject,
  uploadStorageObject,
};

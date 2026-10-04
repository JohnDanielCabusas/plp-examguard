const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { decodeSnapshot, storeSnapshot } = require('../server/snapshot-assets.cjs');

const PIXEL = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==';
const cache = new Map();
let studentId = 'student-1';
let imageFailure = false;
const errors = [];
const requests = [];
const imageRequests = [];
const window = {
  DB: { _read: key => cache.get(key), _write: (key, value) => cache.set(key, value) },
  Auth: { getStudentSession: () => ({ studentId }), getAdminSession: () => null, getSysAdminSession: () => null },
};
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/js/supabase-sync.js'), 'utf8'), {
  window, console, AbortController, setTimeout, clearTimeout,
  fetch: async (url, options) => {
    imageRequests.push(JSON.parse(options.body));
    if (imageFailure) throw new Error('storage unavailable');
    return { ok: true, json: async () => ({ success: true, snapshot: { assetId: 'a'.repeat(64), imageData: `/api/monitor/snapshots/${'a'.repeat(64)}/file`, storageBucket: 'camera-snapshots', storagePath: 'content-hash' } }) };
  },
});
const sync = window.SupabaseSync;
sync._emitSyncError = (table, error) => errors.push({ table, message: error.message });
let missingRow = false;
sync._client = { from(table) {
  let method, payload, id;
  const builder = {
    update(value) { method = 'update'; payload = value; return this; },
    upsert(value) { method = 'upsert'; payload = value; return this; },
    eq(key, value) { if (key === 'id') id = value; return this; },
    select() { return this; },
    then(resolve, reject) {
      requests.push({ table, method, id, payload: structuredClone(payload) });
      return Promise.resolve({ error: null, data: method === 'update' && missingRow ? [] : [{ id: id || payload.id }] }).then(resolve, reject);
    },
  };
  return builder;
} };

(async () => {
  assert.equal(decodeSnapshot(PIXEL).mimeType, 'image/gif');
  assert.throws(() => decodeSnapshot('data:image/jpeg;base64,YWJj'), /does not match/);
  assert.throws(() => decodeSnapshot('data:text/html;base64,YWJj'), /Invalid/);
  const stored = new Set();
  let uploads = 0;
  const dependencies = {
    query: async (sql, values) => {
      if (sql.startsWith('select')) return { rows: stored.has(values[0]) ? [{ id: values[0] }] : [] };
      stored.add(values[0]); return { rows: [] };
    },
    uploadStorageObject: async () => { uploads++; },
  };
  const asset = await storeSnapshot('session-1', PIXEL, dependencies);
  assert.match(asset.imageData, /^\/api\/monitor\/snapshots\/[a-f0-9]{64}\/file$/);
  assert.equal((await storeSnapshot('session-1', PIXEL, dependencies)).assetId, asset.assetId);
  assert.equal(uploads, 1, 'retrying the same image does not create another object');
  let published = false;
  await assert.rejects(storeSnapshot('session-failed', PIXEL, {
    query: async sql => { if (sql.startsWith('insert')) published = true; return { rows: [] }; },
    uploadStorageObject: async () => { throw new Error('upload failed'); },
  }), /upload failed/);
  assert.equal(published, false, 'failed uploads cannot publish a missing image reference');

  const full = { id: 'session-1', examId: 'exam-1', studentId, studentName: 'Student', ownerAdminId: 'prof-1',
    answers: { q1: 'A' }, warnings: 0, activities: [], cameraSnapshots: [{ timestamp: 'now', imageData: PIXEL }],
    attemptHistory: [{ answers: { old: 'B' }, cameraSnapshots: [{ imageData: PIXEL }] }] };
  await sync.syncDoc('sessions', full);
  assert.equal(requests[0].method, 'upsert', 'new sessions still create complete records');
  assert.ok(!JSON.stringify(requests[0].payload).includes('data:image/'));
  assert.equal(requests[0].payload.attempt_history[0].answers.old, 'B');
  assert.equal(imageRequests.length, 1, 'current and archived identical evidence reuse an upload');
  await sync.syncDoc('sessions', { ...full, answers: { q1: 'B' } }, { fields: ['answers'] });
  assert.equal(requests.at(-1).method, 'update');
  assert.deepEqual(Object.keys(requests.at(-1).payload).sort(), ['answers', 'id']);
  assert.equal(imageRequests.length, 1, 'answer patches do not upload images');
  await sync.syncDoc('sessions', { ...full, warnings: 2 }, { fields: ['warnings'] });
  assert.deepEqual(Object.keys(requests.at(-1).payload).sort(), ['id', 'warnings']);

  imageFailure = true;
  const failedImage = { ...full, id: 'session-failed-image' };
  await sync.syncDoc('sessions', failedImage, { fields: ['cameraSnapshots'] });
  assert.equal(requests.at(-1).payload.camera_snapshots[0].imageData, PIXEL, 'storage failure retains original evidence');
  assert.ok(errors.some(error => error.table === 'snapshots'));
  imageFailure = false;
  await sync.syncDoc('sessions', failedImage, { fields: ['cameraSnapshots'] });
  assert.ok(requests.at(-1).payload.camera_snapshots[0].assetId, 'a later write retries failed storage');
  missingRow = true;
  await sync.syncDoc('sessions', full, { fields: ['answers'] });
  assert.equal(requests.at(-1).method, 'upsert');
  assert.equal(requests.at(-1).payload.student_id, studentId, 'missing-row recovery uses a complete record');
  const before = requests.length;
  await sync.syncDoc('sessions', { ...full, detailsLoaded: false }, { fields: ['warnings'] });
  assert.equal(requests.length, before + 1, 'an unloaded summary cannot recreate an incomplete attempt');
  assert.ok(errors.some(error => /Reload the saved attempt/.test(error.message)));

  let reads = 0;
  await sync._cachedRefresh('courses', async () => { reads++; });
  await sync._cachedRefresh('courses', async () => { reads++; });
  assert.equal(reads, 1);
  await sync._cachedRefresh('courses', async () => { reads++; }, true);
  assert.equal(reads, 2, 'forced refresh bypasses the cache');
  studentId = 'student-2';
  await sync._cachedRefresh('courses', async () => { reads++; });
  assert.equal(reads, 3, 'cached reads are isolated per user');
  sync._notifyDataChanged('subjects');
  await sync._cachedRefresh('courses', async () => { reads++; });
  assert.equal(reads, 4, 'realtime changes invalidate cached course data');
  await assert.rejects(sync._cachedRefresh('failed', async () => { throw new Error('offline'); }), /offline/);
  await sync._cachedRefresh('failed', async () => { reads++; });
  assert.equal(reads, 5, 'failed reads are not cached');

  const rows = Array.from({ length: 1237 }, (_, id) => ({ id }));
  let pages = 0;
  const factory = () => ({
    order() { return this; },
    range(start, end) { this.start = start; this.end = end; return this; },
    then(resolve, reject) { pages++; return Promise.resolve({ data: rows.slice(this.start, this.end + 1) }).then(resolve, reject); },
  });
  const loaded = await sync._readAllPages(factory);
  assert.equal(loaded.data.length, 1237, 'all records beyond the API row cap remain available');
  assert.equal(new Set(loaded.data.map(row => row.id)).size, 1237);
  assert.equal(pages, 7);
  let pageNumber = 0;
  await assert.rejects(sync._readAllPages(() => ({
    order() { return this; }, range() { return this; },
    then(resolve, reject) { pageNumber++; return Promise.resolve(pageNumber === 2 ? { error: new Error('page failed') } : { data: rows.slice(0, 200) }).then(resolve, reject); },
  })), /page failed/);

  const adminSource = fs.readFileSync(path.join(__dirname, '../public/js/admin.js'), 'utf8');
  const start = adminSource.indexOf('function pageWindow(');
  const end = adminSource.indexOf('\nfunction getReportPageRows', start);
  const sandbox = {};
  vm.runInNewContext(`${adminSource.slice(start, end)}; this.pageWindow=pageWindow;`, sandbox);
  const allPages = [];
  for (let page = 0; page < 50; page++) allPages.push(...sandbox.pageWindow(rows, page).rows);
  assert.equal(new Set(allPages.map(row => row.id)).size, 1237, 'every record is reachable through pagination');
  assert.equal(sandbox.pageWindow(rows.slice(0, 1), 49).page, 0, 'shrinking filters clamp the current page');
  assert.equal(sandbox.pageWindow([], 0).pages, 1);
  console.log('Bandwidth optimization tests passed: private asset conversion, idempotent uploads, failure fallback, field patches, cache invalidation, complete paged reads and report pagination.');
})().catch(error => { console.error(error); process.exitCode = 1; });

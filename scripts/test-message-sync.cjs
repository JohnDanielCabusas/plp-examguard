const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const cache = new Map();
let studentId = 'student-1';
let rows = Array.from({ length: 1237 }, (_, i) => ({ id: String(i).padStart(5, '0'), student_id: studentId, body: `message ${i}`, created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z' }));
let failPage = false;
let returned = 0;
const window = { DB: { _read: k => cache.get(k), _write: (k, v) => cache.set(k, v) }, Auth: { getStudentSession: () => ({ studentId }), getAdminSession: () => null, getSysAdminSession: () => null } };
vm.runInNewContext(fs.readFileSync(require('node:path').join(__dirname, '../public/js/supabase-sync.js'), 'utf8'), { window, console, setTimeout, clearTimeout });
const sync = window.SupabaseSync;
sync._client = { from() {
  const filters = []; let start = 0; let end = 199;
  return {
    select() { return this; }, eq(k, v) { filters.push(r => r[k] === v); return this; },
    gte(k, v) { filters.push(r => r[k] >= v); return this; }, order() { return this; },
    range(a, b) { start = a; end = b; return this; },
    then(resolve, reject) {
      const data = rows.filter(r => filters.every(f => f(r))).sort((a, b) => a.id.localeCompare(b.id)).slice(start, end + 1);
      returned += data.length;
      return Promise.resolve(failPage && start > 0 ? { data: null, error: { message: 'page unavailable' } } : { data, error: null }).then(resolve, reject);
    },
  };
} };
(async () => {
  await sync._pullMessages();
  assert.equal(cache.get('acs_messages').length, 1237, 'all pages load');
  rows.forEach(r => { r.updated_at = '2026-10-02T00:00:00Z'; });
  await sync._pullMessages();
  rows[0].body = 'edited old message'; rows[0].read_at = '2026-10-03T00:00:00Z'; rows[0].updated_at = '2026-10-03T00:00:00Z';
  await sync._pullMessages();
  returned = 0;
  await sync._pullMessages();
  assert.equal(returned, 1, 'only changed rows downloaded');
  assert.equal(cache.get('acs_messages')[0].body, 'edited old message');
  assert.equal(cache.get('acs_messages')[0].readAt, rows[0].read_at);
  assert.equal(cache.get('acs_messages').length, 1237);
  rows.push({ ...rows[0], id: 'new', body: 'same timestamp insert' });
  await sync._pullMessages();
  assert.equal(cache.get('acs_messages').length, 1238, 'inclusive cursor preserves same timestamp insert');
  rows = rows.filter(r => r.id !== 'new');
  sync._messageRefreshState.get('student:student-1').lastFull = 0;
  failPage = true;
  const before = JSON.stringify(cache.get('acs_messages'));
  const cursor = JSON.stringify(sync._messageRefreshState.get('student:student-1'));
  await sync._pullMessages();
  assert.equal(JSON.stringify(cache.get('acs_messages')), before, 'failed page preserves complete cache');
  assert.equal(JSON.stringify(sync._messageRefreshState.get('student:student-1')), cursor, 'failed page preserves cursor');
  failPage = false;
  await sync._pullMessages();
  assert.equal(cache.get('acs_messages').length, 1237, 'full reconciliation detects deletes');
  studentId = 'student-2'; rows.push({ ...rows[0], id: 'other', student_id: studentId });
  await sync._pullMessages();
  assert.equal(cache.get('acs_messages').length, 1, 'scope switch does not retain other user messages');
  console.log('Message pagination, incremental edits, cursor boundaries, deletions, failure recovery and user isolation passed.');
})().catch(error => { console.error(error); process.exitCode = 1; });

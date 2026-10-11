const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../public/js/supabase-sync.js'), 'utf8');
const LOGO = 'data:image/png;base64,' + 'a'.repeat(50000);

function createHarness(role) {
  const cache = new Map();
  const window = {
    DB: { _read: (key, fallback) => (cache.has(key) ? cache.get(key) : fallback), _write: (key, value) => cache.set(key, value) },
    Auth: {
      getStudentSession: () => role.student || null,
      getAdminSession: () => role.admin || null,
      getSysAdminSession: () => role.sysadmin || null,
    },
  };
  const context = { window, document: { dispatchEvent() {} }, CustomEvent: class {} };
  vm.runInNewContext(source, context);
  const sync = window.SupabaseSync;
  const channels = [];
  const removed = [];
  const requests = [];
  const tables = { settings: [{ id: 'main', school_name: 'PLP', logo_url: LOGO, claude_api_key: 'key' }], logs: [] };
  sync._client = {
    channel(name) {
      const channel = { name, subscriptions: [], on(type, config, handler) { this.subscriptions.push({ ...config, handler }); return this; }, subscribe() { return this; } };
      channels.push(channel);
      return channel;
    },
    removeChannel(channel) { removed.push(channel); },
    from(table) {
      const request = { table, columns: null, filters: [], action: 'select' };
      const builder = {
        select(columns) { if (request.action === 'select') request.columns = columns; return this; },
        delete() { request.action = 'delete'; return this; },
        update(values) { request.action = 'update'; request.values = values; return this; },
        eq(key, value) { request.filters.push(['eq', key, value]); return this; },
        in(key, values) { request.filters.push(['in', key, values]); return this; },
        or(value) { request.filters.push(['or', value]); return this; },
        order() { return this; },
        range(from, to) { request.range = [from, to]; return this; },
        maybeSingle() { request.single = true; return this; },
        then(resolve, reject) {
          requests.push(request);
          let rows = (tables[table] || []).map(row => (request.columns && request.columns !== '*'
            ? Object.fromEntries(request.columns.split(',').map(column => column.trim()).filter(column => column in row).map(column => [column, row[column]]))
            : { ...row }));
          return Promise.resolve({ data: request.single ? rows[0] || null : rows, error: null }).then(resolve, reject);
        },
      };
      return builder;
    },
  };
  return { sync, cache, channels, removed, requests, tables };
}

const subscriptionMap = channel => Object.fromEntries(channel.subscriptions.map(entry => [entry.table, entry.filter || null]));

(async () => {
  // Students subscribe only to their own rows and enrolled courses.
  {
    const role = { student: { studentId: '23-00001' } };
    const h = createHarness(role);
    h.cache.set('acs_students', [{ studentId: '23-00001', enrolledSubjects: ['c1', 'c2'] }]);
    h.sync._setupListeners();
    const subscriptions = subscriptionMap(h.channels[0]);
    assert.deepEqual(subscriptions, {
      sessions: 'student_id=eq.23-00001',
      students: 'student_id=eq.23-00001',
      messages: 'student_id=eq.23-00001',
      subjects: 'id=in.(c1,c2)',
      exams: 'subject_id=in.(c1,c2)',
    }, 'a student never subscribes to unfiltered tables');

    // Another student's session that still reaches the handler is not cached.
    const sessionHandler = h.channels[0].subscriptions.find(entry => entry.table === 'sessions').handler;
    sessionHandler({ eventType: 'UPDATE', new: { id: 'other', student_id: '23-00002', exam_id: 'e1', answers: { q1: 'A' } } });
    assert.equal((h.cache.get('acs_sessions') || []).length, 0, "another student's session is ignored");
    sessionHandler({ eventType: 'UPDATE', new: { id: 'own', student_id: '23-00001', exam_id: 'e1', answers: {} } });
    assert.equal(h.cache.get('acs_sessions').length, 1, "the student's own session is applied");

    // Enrolling in a course replaces the channel with one that covers it.
    h.sync._refreshRealtimeScope();
    assert.equal(h.channels.length, 1, 'an unchanged course list keeps the channel');
    h.cache.set('acs_students', [{ studentId: '23-00001', enrolledSubjects: ['c1', 'c2', 'c3'] }]);
    h.sync._notifyDataChanged('students');
    assert.equal(h.removed.length, 1, 'the old channel is removed');
    assert.equal(subscriptionMap(h.channels[1]).exams, 'subject_id=in.(c1,c2,c3)');

    // Students do not download logs at all.
    await h.sync._hydrateDeferredTables();
    assert.ok(!h.requests.some(request => request.table === 'logs'), 'students skip the logs table');
  }

  // A student with no courses yet has no course subscriptions.
  {
    const h = createHarness({ student: { studentId: '23-00003' } });
    h.cache.set('acs_students', [{ studentId: '23-00003', enrolledSubjects: [] }]);
    h.sync._setupListeners();
    const subscriptions = subscriptionMap(h.channels[0]);
    assert.ok(!('exams' in subscriptions) && !('subjects' in subscriptions));
  }

  // Professors: owner-scoped, no logs stream, settings without the logo.
  {
    const h = createHarness({ admin: { id: 'prof-1' } });
    h.sync._setupListeners();
    const subscriptions = subscriptionMap(h.channels[0]);
    assert.equal(subscriptions.sessions, 'owner_admin_id=eq.prof-1');
    assert.equal(subscriptions.exams, 'owner_admin_id=eq.prof-1');
    assert.ok(!('logs' in subscriptions), 'professors do not stream every proctoring log');
    assert.ok(!('professor_activity_log' in subscriptions));

    await h.sync._pullFromSupabase();
    const settingsRequest = h.requests.find(request => request.table === 'settings');
    assert.ok(!settingsRequest.columns.includes('logo_url') && settingsRequest.columns !== '*', 'professors do not download the logo');
    const settings = h.cache.get('acs_settings');
    assert.equal(settings.logoUrl, '/api/branding/logo');
    assert.equal(settings.claudeApiKey, 'key');
    assert.ok(!('logo_url' in h.sync._jsToDbSettings(settings)), 'saving professor settings keeps the stored logo');

    const settingsHandler = h.channels[0].subscriptions.find(entry => entry.table === 'settings').handler;
    settingsHandler({ eventType: 'UPDATE', new: { id: 'main', school_name: 'PLP 2', claude_api_key: 'key', logo_url: LOGO } });
    assert.equal(h.cache.get('acs_settings').logoUrl, '/api/branding/logo', 'a realtime echo does not put the logo in the cache');

    h.requests.length = 0;
    h.sync._deferredHydrationPromise = null;
    await h.sync._hydrateDeferredTables();
    const logsRequest = h.requests.find(request => request.table === 'logs');
    assert.deepEqual([...logsRequest.filters.find(([, key]) => key === 'type')[2]], ['force_submit', 'timeout', 'refresh_submit', 'auto_submit']);
    assert.ok(logsRequest.filters.some(([op, key, value]) => op === 'eq' && key === 'owner_admin_id' && value === 'prof-1'));
  }

  // System admin: a realtime update that omits the unchanged logo keeps it.
  {
    const h = createHarness({ sysadmin: { id: 'main' } });
    h.cache.set('acs_settings', { schoolName: 'PLP', logoUrl: LOGO });
    h.sync._setupListeners();
    const settingsHandler = h.channels[0].subscriptions.find(entry => entry.table === 'settings').handler;
    settingsHandler({ eventType: 'UPDATE', new: { id: 'main', school_name: 'PLP 2' } });
    assert.equal(h.cache.get('acs_settings').logoUrl, LOGO, 'an omitted logo column does not erase the logo');
    assert.equal(h.cache.get('acs_settings').schoolName, 'PLP 2');
  }

  // Log cleanup and student id corrections are filtered server-side.
  {
    const h = createHarness({ admin: { id: 'prof-1' } });
    const sessionIds = Array.from({ length: 150 }, (_, index) => `s${index}`);
    await h.sync.deleteLogs({ ownerAdminId: 'prof-1', studentId: '23-00001', sessionIds });
    const deletes = h.requests.filter(request => request.action === 'delete');
    assert.equal(deletes.length, 3, 'one student delete plus two batches of session ids');
    assert.ok(deletes.every(request => request.filters.some(([op, key, value]) => op === 'eq' && key === 'owner_admin_id' && value === 'prof-1')));
    assert.deepEqual(deletes.flatMap(request => request.filters.filter(([, key]) => key === 'session_id').flatMap(([, , value]) => [...value])), sessionIds);

    h.requests.length = 0;
    await h.sync.deleteLogs({ examId: 'e1' });
    assert.deepEqual(h.requests[0].filters, [['eq', 'exam_id', 'e1']]);

    h.requests.length = 0;
    await h.sync.reassignStudentLogs('23-00001', '23-00009', 'prof-1');
    assert.deepEqual({ ...h.requests[0].values }, { student_id: '23-00009' });
    assert.deepEqual(h.requests[0].filters, [['eq', 'student_id', '23-00001'], ['eq', 'owner_admin_id', 'prof-1']]);
  }

  console.log('Realtime scope tests passed: student filters, course rescoping, foreign-session rejection, logo-free settings, narrowed log reads and filtered log cleanup.');
})().catch(error => {
  console.error(error);
  process.exit(1);
});

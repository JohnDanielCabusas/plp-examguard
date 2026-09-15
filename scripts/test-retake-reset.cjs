const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..');
const adminSource = fs.readFileSync(path.join(projectRoot, 'public', 'js', 'admin.js'), 'utf8');

assert.match(adminSource, /onclick="allowStudentRetake\('\$\{s\.id\}', this\)"/);
assert.match(adminSource, /window\.allowStudentRetake = allowStudentRetake/);
assert.match(adminSource, /Retake Ready/);
assert.match(adminSource, /SupabaseSync\?\.refreshSessions\?\.\(\)/);
assert.match(adminSource, /updatedSession\.submitted \|\| updatedSession\.startTime/);

const serverRoot = path.resolve(__dirname, '..', 'server');
const dbPath = require.resolve(path.join(serverRoot, 'db.cjs'));
const authPath = require.resolve(path.join(serverRoot, 'auth-route.cjs'));
const errorPath = require.resolve(path.join(serverRoot, 'error-utils.cjs'));
const websocketPath = require.resolve(path.join(serverRoot, 'monitor-websocket.cjs'));
const evidenceStorePath = require.resolve(path.join(serverRoot, 'violation-evidence-store.cjs'));
const storagePath = require.resolve(path.join(serverRoot, 'supabase-storage.cjs'));

let currentAdmin = { id: 'professor-a' };
let routeMode = 'single';
const events = [];
const localDeletes = [];
const remoteDeletes = [];

function cleanSession(id) {
  return {
    id,
    exam_id: 'exam-a',
    student_id: id === 'session-b' ? 'STUDENT-2' : 'STUDENT-1',
    submitted: false,
    auto_submitted: false,
    submit_reason: null,
    start_time: null,
    end_time: null,
    answers: {},
    essay_grades: {},
    ai_detections: {},
    warnings: 0,
    activities: [],
    camera_snapshots: [],
    score: null,
    score_released: false,
  };
}

function makeClient() {
  return {
    async query(sql, values = []) {
      const normalized = String(sql).replace(/\s+/g, ' ').trim();
      events.push({ type: 'sql', sql: normalized, values });

      if (/^(begin|commit|rollback)$/i.test(normalized)) return { rows: [], rowCount: 0 };
      if (/select s\.id from public\.sessions s/i.test(normalized) && /where s\.id = \$1/i.test(normalized)) {
        return { rows: routeMode === 'missing' ? [] : [{ id: 'session-a' }], rowCount: routeMode === 'missing' ? 0 : 1 };
      }
      if (/select id from public\.exams/i.test(normalized)) {
        return { rows: routeMode === 'missing' ? [] : [{ id: 'exam-a' }], rowCount: routeMode === 'missing' ? 0 : 1 };
      }
      if (/select s\.id from public\.sessions s/i.test(normalized) && /where s\.exam_id = \$1/i.test(normalized)) {
        return { rows: [{ id: 'session-a' }, { id: 'session-b' }], rowCount: 2 };
      }
      if (/delete from public\.violation_evidence/i.test(normalized)) {
        const ids = values[0] || [];
        const rows = ids.flatMap(id => [
          { storage_bucket: 'local-server', storage_path: `${id}/clip.webm` },
          { storage_bucket: 'exam-violation-evidence', storage_path: `${id}/clip.webm` },
        ]);
        return { rows, rowCount: rows.length };
      }
      if (/delete from public\.violation_events/i.test(normalized)) return { rows: [], rowCount: 3 };
      if (/delete from public\.logs/i.test(normalized)) return { rows: [], rowCount: 4 };
      if (/delete from public\.random_forest_predictions/i.test(normalized)) return { rows: [], rowCount: 1 };
      if (/update public\.sessions/i.test(normalized)) {
        return { rows: (values[0] || []).map(cleanSession), rowCount: (values[0] || []).length };
      }

      throw new Error(`Unexpected SQL in retake route test: ${normalized}`);
    },
    release() {
      events.push({ type: 'release' });
    },
  };
}

require.cache[dbPath] = {
  id: dbPath,
  filename: dbPath,
  loaded: true,
  exports: {
    connect: async () => makeClient(),
    query: async () => { throw new Error('The retake route must use a transaction client.'); },
  },
};

require.cache[authPath] = {
  id: authPath,
  filename: authPath,
  loaded: true,
  exports: {
    getCurrentProfessorSession: async () => currentAdmin,
    getCurrentStudentSession: async () => null,
    readJsonBody: async () => ({}),
    forbid: res => {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false }));
    },
    jsonResponse: (res, status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    },
  },
};

require.cache[errorPath] = {
  id: errorPath,
  filename: errorPath,
  loaded: true,
  exports: {
    isConnectivityIssue: () => false,
    toUserMessage: error => error.message,
  },
};

require.cache[websocketPath] = {
  id: websocketPath,
  filename: websocketPath,
  loaded: true,
  exports: {
    broadcastViolation: () => {},
    broadcastViolationEvidence: () => {},
  },
};

require.cache[evidenceStorePath] = {
  id: evidenceStorePath,
  filename: evidenceStorePath,
  loaded: true,
  exports: {
    readEvidenceFile: async () => ({ data: Buffer.alloc(0) }),
    deleteEvidenceFile: async objectPath => {
      events.push({ type: 'local-delete', objectPath });
      localDeletes.push(objectPath);
    },
  },
};

require.cache[storagePath] = {
  id: storagePath,
  filename: storagePath,
  loaded: true,
  exports: {
    uploadStorageObject: async () => {},
    downloadStorageObject: async () => ({ data: Buffer.alloc(0) }),
    deleteStorageObject: async (bucket, objectPath) => {
      events.push({ type: 'remote-delete', bucket, objectPath });
      remoteDeletes.push({ bucket, objectPath });
    },
  },
};

const { handleMonitorRoute } = require('../server/monitor-route.cjs');

function responseCapture() {
  return {
    status: null,
    body: null,
    writeHead(status) { this.status = status; },
    end(body) { this.body = body ? JSON.parse(body) : null; },
  };
}

function request(method, url) {
  return { method, url, headers: { host: 'localhost' } };
}

function sqlEventsSince(startIndex) {
  return events.slice(startIndex).filter(event => event.type === 'sql');
}

function assertCleanResetSql(sqlEvents, expectedIds) {
  const update = sqlEvents.find(event => /update public\.sessions/i.test(event.sql));
  assert.ok(update, 'The session must be reset inside the transaction.');
  assert.deepEqual(update.values[0], expectedIds);
  for (const clause of [
    'submitted = false',
    'auto_submitted = false',
    'submit_reason = null',
    'start_time = null',
    'end_time = null',
    "answers = '{}'::jsonb",
    "essay_grades = '{}'::jsonb",
    "ai_detections = '{}'::jsonb",
    'warnings = 0',
    "activities = '[]'::jsonb",
    "camera_snapshots = '[]'::jsonb",
    'score = null',
    'score_released = false',
  ]) {
    assert.match(update.sql, new RegExp(clause.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));
  }
  assert.ok(sqlEvents.some(event => /delete from public\.logs/i.test(event.sql)));
  assert.ok(sqlEvents.some(event => /delete from public\.violation_events/i.test(event.sql)));
  assert.ok(sqlEvents.some(event => /delete from public\.violation_evidence/i.test(event.sql)));
  assert.ok(sqlEvents.some(event => /delete from public\.random_forest_predictions/i.test(event.sql)));

  const commitIndex = events.findIndex(event => event.type === 'sql' && /^commit$/i.test(event.sql));
  const firstFileDeleteIndex = events.findIndex(event => event.type === 'local-delete' || event.type === 'remote-delete');
  assert.ok(commitIndex >= 0 && firstFileDeleteIndex > commitIndex, 'Evidence files should only be removed after the database commit.');
}

async function run() {
  let startIndex = events.length;
  const individual = responseCapture();
  await handleMonitorRoute(request('POST', '/api/monitor/sessions/session-a/retake'), individual);
  assert.equal(individual.status, 200);
  assert.equal(individual.body.success, true);
  assert.equal(individual.body.session.id, 'session-a');
  assert.equal(individual.body.session.warnings, 0);
  assert.equal(individual.body.cleared.logs, 4);
  assert.equal(individual.body.cleared.violations, 3);
  assert.equal(individual.body.cleared.evidence, 2);
  assert.equal(individual.body.cleared.predictions, 1);
  assertCleanResetSql(sqlEventsSince(startIndex), ['session-a']);
  assert.deepEqual(localDeletes, ['session-a/clip.webm']);
  assert.deepEqual(remoteDeletes, [{ bucket: 'exam-violation-evidence', objectPath: 'session-a/clip.webm' }]);

  events.length = 0;
  localDeletes.length = 0;
  remoteDeletes.length = 0;
  startIndex = 0;
  routeMode = 'bulk';
  const allStudents = responseCapture();
  await handleMonitorRoute(request('POST', '/api/monitor/exams/exam-a/retake-sessions'), allStudents);
  assert.equal(allStudents.status, 200);
  assert.deepEqual(allStudents.body.sessions.map(session => session.id), ['session-a', 'session-b']);
  assertCleanResetSql(sqlEventsSince(startIndex), ['session-a', 'session-b']);
  assert.deepEqual(localDeletes, ['session-a/clip.webm', 'session-b/clip.webm']);
  assert.equal(remoteDeletes.length, 2);

  events.length = 0;
  routeMode = 'missing';
  const missing = responseCapture();
  await handleMonitorRoute(request('POST', '/api/monitor/sessions/missing/retake'), missing);
  assert.equal(missing.status, 404);
  assert.ok(events.some(event => event.type === 'sql' && /^rollback$/i.test(event.sql)));
  assert.ok(!events.some(event => event.type === 'sql' && /delete from public\./i.test(event.sql)));

  currentAdmin = null;
  const denied = responseCapture();
  await handleMonitorRoute(request('POST', '/api/monitor/sessions/session-a/retake'), denied);
  assert.equal(denied.status, 403);

  const wrongMethod = responseCapture();
  await handleMonitorRoute(request('GET', '/api/monitor/sessions/session-a/retake'), wrongMethod);
  assert.equal(wrongMethod.status, 405);

  console.log('Retake reset route checks passed.');
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});

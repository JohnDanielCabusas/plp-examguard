const assert = require('node:assert/strict');
const path = require('node:path');

const serverRoot = path.resolve(__dirname, '..', 'server');
const dbPath = require.resolve(path.join(serverRoot, 'db.cjs'));
const authPath = require.resolve(path.join(serverRoot, 'auth-route.cjs'));
const errorPath = require.resolve(path.join(serverRoot, 'error-utils.cjs'));
const workerPath = require.resolve(path.join(serverRoot, 'random-forest-worker.cjs'));

let currentAdmin = { id: 'professor-a' };
let forcedDatabaseError = null;
const executedSql = [];
const completeSession = {
  id: 'session-a',
  submitted: true,
  student_id: 'STUDENT-1',
  exam_id: 'exam-a',
  course_id: 'course-a',
  resolved_owner_admin_id: 'professor-a',
  owner_admin_id: 'professor-a',
  start_time: '2026-09-08T01:00:00.000Z',
  end_time: '2026-09-08T01:20:00.000Z',
  activities: [{ type: 'browser_exam_start' }, { type: 'browser_exam_end' }],
  ai_detections: {
    faceMonitoring: {
      feature_contract_version: 'rf-session-summary-v1',
      randomForestCompatible: true,
      final_face_present: 1,
      maximum_face_count: 1,
      average_tracking_confidence: 0.9,
      maximum_hand_count: 2,
      average_head_pitch_degrees: 0,
      average_head_yaw_degrees: 0,
      average_head_roll_degrees: 0,
    },
  },
};

require.cache[dbPath] = {
  id: dbPath,
  filename: dbPath,
  loaded: true,
  exports: {
    query: async (sql, values) => {
      if (forcedDatabaseError) throw forcedDatabaseError;
      executedSql.push({ sql, values });
      if (/select s\.\*,/i.test(sql) && /where s\.id = \$1/i.test(sql)) {
        return { rows: values[1] === 'professor-a' ? [completeSession] : [] };
      }
      if (/select e\.id, e\.subject_id as course_id/i.test(sql)) {
        return {
          rows: values[1] === 'professor-a'
            ? [{ id: 'exam-a', course_id: 'course-a', owner_admin_id: 'professor-a' }]
            : [],
        };
      }
      if (/count\(\*\)::integer as total_sessions/i.test(sql)) {
        return {
          rows: [{
            total_sessions: 7,
            analyzed_sessions: 4,
            pending_sessions: 1,
            unavailable_sessions: 1,
            failed_sessions: 1,
            normal_count: 2,
            needs_monitoring_count: 1,
            suspicious_count: 1,
            average_probability: '0.45000000',
            last_updated: '2026-09-08T02:00:00.000Z',
          }],
        };
      }
      if (/insert into public\.random_forest_predictions/i.test(sql)) {
        return {
          rows: [{
            id: values[0],
            owner_admin_id: values[1],
            exam_session_id: values[2],
            status: values[6],
            suspicious_probability: values[7],
            risk_level: values[8],
            requires_professor_review: values[9],
            model_version: values[10],
            predicted_at: values[13],
            updated_at: values[13],
          }],
        };
      }
      throw new Error(`Unexpected SQL in route test: ${sql}`);
    },
  },
};
require.cache[authPath] = {
  id: authPath,
  filename: authPath,
  loaded: true,
  exports: {
    getCurrentProfessorSession: async () => currentAdmin,
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
  exports: { isConnectivityIssue: () => false, toUserMessage: error => error.message },
};
require.cache[workerPath] = {
  id: workerPath,
  filename: workerPath,
  loaded: true,
  exports: {
    getModelMetadata: () => ({ model_version: '1.0.0' }),
    predict: async () => ({
      suspiciousProbability: 0.73,
      riskLevel: 'needs_monitoring',
      requiresProfessorReview: true,
      modelVersion: '1.0.0',
      predictedAt: '2026-09-08T02:00:00.000Z',
    }),
  },
};

const { handleRandomForestRoute } = require('../server/random-forest-route.cjs');

function responseCapture() {
  return {
    status: null,
    body: null,
    writeHead(status) { this.status = status; },
    end(body) { this.body = body ? JSON.parse(body) : null; },
  };
}

async function run() {
  const allowed = responseCapture();
  await handleRandomForestRoute({
    method: 'POST',
    url: '/api/exam-sessions/session-a/random-forest-prediction',
    headers: { host: 'localhost' },
  }, allowed);
  assert.equal(allowed.status, 200);
  assert.equal(allowed.body.prediction.riskLevel, 'needs_monitoring');
  assert.equal(allowed.body.prediction.suspiciousProbability, 0.73);
  assert.ok(executedSql.some(entry => /on conflict \(exam_session_id, model_version\)/i.test(entry.sql)));
  assert.ok(executedSql.every(entry => !/update\s+public\.sessions/i.test(entry.sql)), 'Prediction must not update grades or session state.');

  const summary = responseCapture();
  await handleRandomForestRoute({
    method: 'GET',
    url: '/api/statistics/random-forest?examId=exam-a',
    headers: { host: 'localhost' },
  }, summary);
  assert.equal(summary.status, 200);
  assert.equal(summary.body.summary.totalSessions, 7);
  assert.equal(summary.body.summary.analyzedSessions, 4);
  assert.equal(summary.body.summary.pendingSessions, 1);
  assert.equal(summary.body.summary.unavailableSessions, 1);
  assert.deepEqual(summary.body.distribution.map(item => item.count), [2, 1, 1]);
  assert.equal(summary.body.summary.averageSuspiciousProbability, 0.45);

  forcedDatabaseError = new Error("ENOENT: no such file or directory, open 'C:\\private\\artifact.json'");
  const internalFailure = responseCapture();
  const originalConsoleError = console.error;
  console.error = () => {};
  try {
    await handleRandomForestRoute({
      method: 'GET',
      url: '/api/statistics/random-forest?examId=exam-a',
      headers: { host: 'localhost' },
    }, internalFailure);
  } finally {
    console.error = originalConsoleError;
    forcedDatabaseError = null;
  }
  assert.equal(internalFailure.status, 500);
  assert.equal(internalFailure.body.message, 'Unable to process Random Forest predictions right now.');
  assert.doesNotMatch(internalFailure.body.message, /private|artifact\.json|ENOENT/i);

  currentAdmin = null;
  const denied = responseCapture();
  await handleRandomForestRoute({
    method: 'POST',
    url: '/api/exam-sessions/session-a/random-forest-prediction',
    headers: { host: 'localhost' },
  }, denied);
  assert.equal(denied.status, 403);

  currentAdmin = { id: 'professor-b' };
  const unrelated = responseCapture();
  await handleRandomForestRoute({
    method: 'POST',
    url: '/api/exam-sessions/session-a/random-forest-prediction',
    headers: { host: 'localhost' },
  }, unrelated);
  assert.equal(unrelated.status, 404);

  console.log('Random Forest authorization, ownership, idempotency, statistics, partial-state, and grade-isolation route tests passed.');
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});

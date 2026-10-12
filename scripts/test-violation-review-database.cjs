// Exercises the single violation-review route against the real database: every
// violation type can be confirmed or dismissed, a warning is only ever given back
// for a violation that cost one, it is given back once, and changing the
// decision back restores it. Every row it creates belongs to a throwaway
// professor and is removed at the end.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const { Readable } = require('node:stream');

// The project's env file wins over machine-wide variables (see server.js).
require('dotenv').config({ path: path.resolve(__dirname, '../.env.local'), override: true, quiet: true });

const { query } = require('../server/db.cjs');
const { handleMonitorRoute } = require('../server/monitor-route.cjs');

const run = crypto.randomUUID().slice(0, 8);
const professorId = `review-test-prof-${run}`;
const otherProfessorId = `review-test-other-${run}`;
const subjectId = `review-test-subject-${run}`;
const examId = `review-test-exam-${run}`;
const sessionId = `review-test-session-${run}`;
const eventId = `review-test-event-${run}`;
const evidenceId = `review-test-evidence-${run}`;

function cookieFor(id) {
  const secret = String(process.env.AUTH_SESSION_SECRET || process.env.SUPABASE_DB_PASSWORD || 'replace-this-auth-session-secret');
  const encoded = Buffer.from(JSON.stringify({ role: 'professor', professorId: id, expiresAt: Date.now() + 600000 }))
    .toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  return `acs_admin_auth=${encodeURIComponent(`${encoded}.${crypto.createHmac('sha256', secret).update(encoded).digest('hex')}`)}`;
}

async function review(index, reviewStatus, { asProfessor = professorId, evidence = '' } = {}) {
  const req = Readable.from([Buffer.from(JSON.stringify({ reviewStatus, evidenceId: evidence, reviewNotes: `test ${reviewStatus}` }))]);
  Object.assign(req, {
    method: 'PATCH',
    url: `/api/monitor/sessions/${encodeURIComponent(sessionId)}/activities/${index}/review`,
    headers: { host: 'localhost', cookie: cookieFor(asProfessor), 'content-type': 'application/json' },
    socket: {},
  });
  return new Promise((resolve) => {
    const res = {
      statusCode: 0,
      writeHead(status) { this.statusCode = status; },
      setHeader() {},
      end(body) { resolve({ status: this.statusCode, body: JSON.parse(String(body || '{}')) }); },
    };
    handleMonitorRoute(req, res);
  });
}

const sessionRow = async () => (await query(
  'select warnings, submitted, auto_submitted, activities from public.sessions where id = $1', [sessionId],
)).rows[0];

const activities = [
  { type: 'tab_switch', timestamp: '2026-10-12T01:00:00Z', detail: 'Switched tabs' },                                  // 0 counted
  { type: 'restricted_phone', timestamp: '2026-10-12T01:01:00Z', detail: 'Phone', metadata: { policyMode: 'alert' } }, // 1 alert: no warning
  { type: 'FACE_ABSENT', timestamp: '2026-10-12T01:02:00Z', detail: 'No person', metadata: { source: 'FACEMESH', countsAsWarning: true } }, // 2 counted
  { type: 'FACE_LIVENESS_UNCONFIRMED', timestamp: '2026-10-12T01:03:00Z', detail: 'Liveness', metadata: { source: 'FACEMESH', countsAsWarning: false } }, // 3 review-only
  { type: 'screen_record', timestamp: '2026-10-12T01:04:00Z', detail: 'Recording' },                                  // 4 terminal: no strike
  { type: 'browser_exam_start', timestamp: '2026-10-12T00:59:00Z', detail: 'Started' },                               // 5 not a violation
  { type: 'no_person', timestamp: '2026-10-12T01:05:00Z', detail: 'No person' },                                      // 6 legacy evidence-dismissed
  { type: 'window_blur', timestamp: '2026-10-12T01:06:00Z', detail: 'Blur', metadata: { offlineHold: true, countsAsWarning: false } }, // 7 held
];

async function main() {
  await query('insert into public.professors (id, name) values ($1, $2), ($3, $4)',
    [professorId, 'Review Test Professor', otherProfessorId, 'Other Test Professor']);
  await query(`insert into public.subjects (id, code, name, owner_admin_id) values ($1, $2, 'Review test subject', $3)`,
    [subjectId, `RT-${run}`, professorId]);
  await query(`insert into public.exams (id, subject_id, title, time_limit, status, owner_admin_id)
    values ($1, $2, 'Review test', 60, 'active', $3)`, [examId, subjectId, professorId]);
  // Three warnings were issued (activities 0, 2, 6); the legacy replay review of
  // activity 6 already took one off through its evidence row.
  await query(`insert into public.sessions (id, exam_id, student_id, student_name, owner_admin_id, warnings,
      start_time, end_time, submitted, auto_submitted, submit_reason, answers, activities)
    values ($1, $2, 'TEST-0001', 'Review Test Student', $3, 2, now() - interval '20 minutes', now() - interval '1 minute',
      true, true, 'violations', '{"q1":"A"}'::jsonb, $4::jsonb)`,
  [sessionId, examId, professorId, JSON.stringify(activities)]);
  await query(`insert into public.violation_events (id, owner_admin_id, exam_id, session_id, student_id, violation_type, detail)
    values ($1, $2, $3, $4, 'TEST-0001', 'no_person', 'No person')`, [eventId, professorId, examId, sessionId]);
  await query(`insert into public.violation_evidence (id, violation_event_id, owner_admin_id, exam_id, session_id, student_id,
      violation_type, storage_path, clip_started_at, clip_ended_at, triggered_at, duration_ms,
      review_status, warning_adjustment, warning_applied)
    values ($1, $2, $3, $4, $5, 'TEST-0001', 'no_person', 'replays/none.webm',
      '2026-10-12T01:04:48Z', '2026-10-12T01:05:00Z', '2026-10-12T01:05:00Z', 12000, 'dismissed', -1, true)`,
  [evidenceId, eventId, professorId, examId, sessionId]);

  // A browser violation that cost a warning: dismissing gives it back, once.
  let result = await review(0, 'dismissed');
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.warningDelta, -1);
  // 2 -> 1 is below the limit on an attempt submitted for violations: reopened.
  assert.equal(result.body.reopened, true);
  let row = await sessionRow();
  assert.equal(row.warnings, 1);
  assert.equal(row.submitted, false);
  assert.equal(row.activities[0].metadata.warningDismissed, true);
  assert.equal(row.activities[0].metadata.reviewStatus, 'dismissed');
  assert.equal(row.activities[0].metadata.reviewedBy, professorId);
  assert.equal(row.activities.length, activities.length + 2, 'one audit entry for the deduction, one for the reopen');
  assert.ok(!('answers' in result.body.session) && !('camera_snapshots' in result.body.session),
    'the response leaves out the bulky columns');
  assert.equal(result.body.session.student_name, 'Review Test Student', 'but keeps what the monitor shows');

  result = await review(0, 'dismissed');
  assert.equal(result.body.warningDelta, 0, 'dismissing twice never deducts twice');
  assert.equal((await sessionRow()).warnings, 1);

  // Changing the decision restores exactly that warning.
  result = await review(0, 'confirmed');
  assert.equal(result.body.warningDelta, 1);
  row = await sessionRow();
  assert.equal(row.warnings, 2);
  assert.equal(row.activities[0].metadata.warningDismissed, false);
  assert.equal(row.activities[0].metadata.reviewStatus, 'confirmed');

  // Violations that never cost a warning can be reviewed, but leave the count alone.
  for (const index of [1, 3, 4, 7]) {
    result = await review(index, 'dismissed');
    assert.equal(result.status, 200, `activity ${index}: ${JSON.stringify(result.body)}`);
    assert.equal(result.body.warningDelta, 0, `activity ${index} must not give back a warning it never cost`);
    assert.equal((await sessionRow()).activities[index].metadata.reviewStatus, 'dismissed');
  }
  assert.equal((await sessionRow()).warnings, 2);

  // A FaceMesh incident that cost a warning behaves like any other.
  result = await review(2, 'dismissed');
  assert.equal(result.body.warningDelta, -1);
  assert.equal((await sessionRow()).warnings, 1);
  result = await review(2, 'confirmed');
  assert.equal(result.body.warningDelta, 1);

  // A replay dismissed under the old evidence-only review already took its
  // warning off. Reviewing it again must not take a second one, and the
  // deduction moves from the evidence row onto the activity.
  result = await review(6, 'dismissed', { evidence: evidenceId });
  assert.equal(result.body.warningDelta, 0);
  assert.equal(result.body.evidence.reviewStatus, 'dismissed');
  const evidence = (await query('select warning_adjustment, review_status from public.violation_evidence where id = $1', [evidenceId])).rows[0];
  assert.equal(evidence.warning_adjustment, 0);
  row = await sessionRow();
  assert.equal(row.warnings, 2);
  assert.equal(row.activities[6].metadata.warningDismissed, true);
  result = await review(6, 'confirmed', { evidence: evidenceId });
  assert.equal(result.body.warningDelta, 1, 'confirming it restores that warning');
  assert.equal((await sessionRow()).warnings, 3);

  // Not a violation, out of range, another professor's session, a bad decision.
  assert.equal((await review(5, 'dismissed')).status, 400);
  assert.equal((await review(99, 'dismissed')).status, 400);
  assert.equal((await review(0, 'dismissed', { asProfessor: otherProfessorId })).status, 404);
  assert.equal((await review(0, 'maybe')).status, 400);
  assert.equal((await review(0, 'dismissed', { evidence: 'not-this-sessions-evidence' })).status, 404);

  console.log('Violation review database tests passed: every type reviewable, deductions once and only for counted warnings, legacy replay reviews, reopen, ownership.');
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await query('delete from public.violation_evidence where id = $1', [evidenceId]).catch(() => {});
    await query('delete from public.violation_events where id = $1', [eventId]).catch(() => {});
    await query('delete from public.sessions where id = $1', [sessionId]).catch(() => {});
    await query('delete from public.exams where id = $1', [examId]).catch(() => {});
    await query('delete from public.subjects where id = $1', [subjectId]).catch(() => {});
    await query('delete from public.professors where id in ($1, $2)', [professorId, otherProfessorId]).catch(() => {});
    process.exit(process.exitCode || 0);
  });

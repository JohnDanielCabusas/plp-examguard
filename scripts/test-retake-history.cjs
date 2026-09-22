// Issue #6: authorising a retake must preserve the previous attempt instead of
// overwriting it. Guards both the archive contents and the call site that uses it.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
// Normalised so the source slicing below survives a CRLF checkout.
const admin = fs.readFileSync(path.join(root, 'public', 'js', 'admin.js'), 'utf8').split(String.fromCharCode(13)).join('');

// Pull the helper out of the bundle and run it for real, rather than asserting
// on its source text.
const start = admin.indexOf('function buildArchivedAttempt(');
assert.ok(start >= 0, 'buildArchivedAttempt must exist');
const end = admin.indexOf('\n}\n', start);
assert.ok(end > start, 'buildArchivedAttempt must be a complete declaration');
const source = admin.slice(start, end + 2);

const sandbox = {};
vm.runInNewContext(`${source}\nthis.buildArchivedAttempt = buildArchivedAttempt;`, sandbox);
const buildArchivedAttempt = sandbox.buildArchivedAttempt;

const submittedSession = {
  submitted: true,
  autoSubmitted: false,
  submitReason: 'manual',
  startTime: '2026-09-17T01:00:00.000Z',
  endTime: '2026-09-17T01:45:00.000Z',
  score: 25,
  maxScore: 30,
  answers: { q1: 'A', q2: 'B' },
  essayGrades: { q3: 8 },
  aiDetections: { q3: { flagged: true } },
  warnings: 2,
  activities: [{ type: 'tab_switch' }],
  cameraSnapshots: [{ id: 'snap-1' }],
};

const archived = buildArchivedAttempt(submittedSession, 1, 'Prof. Santos');

// Nothing the professor needs for auditing may be dropped.
assert.equal(archived.attempt, 1);
assert.equal(archived.type, 'ORIGINAL');
assert.equal(archived.reason, 'SUBMITTED');
assert.deepEqual(archived.answers, { q1: 'A', q2: 'B' }, 'answers must survive a retake');
assert.equal(archived.score, 25, 'score must survive a retake');
assert.equal(archived.maxScore, 30);
assert.deepEqual(archived.essayGrades, { q3: 8 }, 'essay grades must survive a retake');
assert.equal(archived.warnings, 2, 'warnings must survive a retake');
assert.deepEqual(archived.activities, [{ type: 'tab_switch' }], 'activity log must survive a retake');
assert.deepEqual(archived.cameraSnapshots, [{ id: 'snap-1' }], 'camera evidence must survive a retake');
assert.equal(archived.startTime, '2026-09-17T01:00:00.000Z');
assert.equal(archived.endTime, '2026-09-17T01:45:00.000Z');

// The authorisation is traceable to a person and a reason.
assert.equal(archived.retakeAuthorization.status, 'AUTHORIZED');
assert.equal(archived.retakeAuthorization.attempt, 2, 'authorisation points at the next attempt');
assert.equal(archived.retakeAuthorization.authorizedBy, 'Prof. Santos');
assert.equal(archived.retakeAuthorization.reason, 'SUBMITTED');
assert.ok(archived.retakeAuthorization.authorizedAt, 'authorisation is timestamped');

// An absent student has no submission, and that distinction drives eligibility.
const absentArchive = buildArchivedAttempt({ submitted: false }, 1, '');
assert.equal(absentArchive.reason, 'ABSENT');
assert.equal(absentArchive.score, null);
assert.equal(absentArchive.warnings, 0);
assert.equal(Object.keys(absentArchive.answers).length, 0, 'an absent attempt has no answers');
assert.equal(absentArchive.retakeAuthorization.authorizedBy, 'Professor', 'falls back to a generic grantor');

// A second retake stacks as attempt #2 rather than pretending to be the first.
const secondArchive = buildArchivedAttempt(submittedSession, 2, 'Prof. Santos');
assert.equal(secondArchive.type, 'RETAKE');
assert.equal(secondArchive.retakeAuthorization.attempt, 3);

// The call site must append to the existing history, never replace it, and must
// still clear the live fields so the student gets a clean attempt.
const fnStart = admin.indexOf('async function allowStudentRetake(');
const fnEnd = admin.indexOf('\n}\n', fnStart);
const retakeFn = admin.slice(fnStart, fnEnd);
assert.match(retakeFn, /\[\.\.\.entryPriors,\s*buildArchivedAttempt\(/,
  'history must be appended, not overwritten');
assert.match(retakeFn, /answers:\s*\{\}/, 'the new attempt still starts clean');
// Every row the student holds for this exam is reset, not just the one whose
// button was pressed. A single leftover row kept them in the report list as if
// no retake had been granted, and sent a finished student back into the exam.
assert.match(retakeFn, /DB\.getSessionsByExam\(session\.examId\)/,
  'the reset must cover every session row for this student');
assert.match(retakeFn, /targets\.forEach/, 'and apply to each of them');
assert.doesNotMatch(retakeFn, /previous submission, answers, and score will be cleared/,
  'the prompt must no longer promise to destroy the attempt');

console.log('Retake attempt-history preservation tests passed.');

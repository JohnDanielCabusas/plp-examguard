// Regression tests for the second batch of reported issues:
//   #35 authorized late students visible in Monitoring
//   #37 archiving asks first
//   #38 the shake is a one-shot reaction, not a permanent state
//   #39 unanswered questions are not called "skipped"
//   #40 correctable face-position conditions count down before they count
//   #41 / #42 retake resets every row; a blank row is not an attempt
//   #43 assorted interface fixes
//   #44 the product has a visible name
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');
const adminSource = read('public/js/admin.js');
const examSource = read('public/js/exam.js');
const dataSource = read('public/js/data.js');
const styleSource = read('public/css/style.css');
const examPage = read('src/pages/ExamPage.jsx');
const adminPage = read('src/pages/AdminPage.jsx');
const loginPage = read('src/pages/LoginPage.jsx');
const ruleEngine = read('src/lib/proctoring/facemesh/temporalRuleEngine.js');
const faceConfig = read('src/lib/proctoring/facemesh/faceMonitoringConfig.js');

// ── #42: a row that was never started is not an attempt ────────────────────
const start = dataSource.indexOf('  getStudentSession(examId, studentId) {');
assert.ok(start >= 0, 'getStudentSession must exist');
const end = dataSource.indexOf('\n  addSession(data) {', start);
const box = {};
vm.runInNewContext(
  `const DB = { _sessions: [], getSessions() { return this._sessions; },\n${dataSource.slice(start, end)}\n};\nthis.DB = DB;`,
  box,
);
const DB = box.DB;

const finished = { id: 'done', examId: 'e1', studentId: 's1', submitted: true, endTime: '2026-09-19T08:00:00.000Z', answers: { q1: 'A' } };
const blank = { id: 'blank', examId: 'e1', studentId: 's1', submitted: false, startTime: null, answers: {} };
DB._sessions = [finished, blank];
assert.equal(
  DB.getStudentSession('e1', 's1').id,
  'done',
  'a blank row must not send a student who already finished back into the exam',
);

// A retake clears the finished row, and only then does the blank one win.
DB._sessions = [{ ...finished, submitted: false, answers: {}, endTime: null }, blank];
assert.notEqual(DB.getStudentSession('e1', 's1'), undefined, 'a granted retake still resolves to a usable row');

// An attempt genuinely in progress still outranks a finished one.
DB._sessions = [finished, { id: 'live', examId: 'e1', studentId: 's1', submitted: false, startTime: '2026-09-19T09:00:00.000Z', answers: {} }];
assert.equal(DB.getStudentSession('e1', 's1').id, 'live', 'an attempt in progress still wins');

// ── #41: Allow Retake must clear every row the student holds ───────────────
const retakeFn = adminSource.slice(
  adminSource.indexOf('async function allowStudentRetake('),
  adminSource.indexOf('\n}\n', adminSource.indexOf('async function allowStudentRetake(')),
);
assert.match(retakeFn, /DB\.getSessionsByExam\(session\.examId\)/, 'every row for the student is gathered');
assert.match(retakeFn, /targets\.forEach/, 'and every one of them is reset');

// ── #37: archiving an exam asks first ──────────────────────────────────────
const statusFn = adminSource.slice(
  adminSource.indexOf('async function setExamStatus('),
  adminSource.indexOf('\n}\n', adminSource.indexOf('async function setExamStatus(')),
);
const archiveBranch = statusFn.slice(statusFn.indexOf("status === 'archived'"));
assert.match(archiveBranch, /showConfirm\(/, 'archiving must confirm');
assert.match(archiveBranch, /if \(!ok\) return;/, 'and must stop when declined');

// ── #38: the shake is one-shot, the outline is not ─────────────────────────
const missingRule = styleSource.slice(styleSource.indexOf('.question-card.q-required-missing {'));
assert.doesNotMatch(
  missingRule.slice(0, missingRule.indexOf('}')),
  /animation/,
  'the persistent class must not carry the animation, or it replays on every visit',
);
assert.match(styleSource, /\.question-card\.q-shake \{[^}]*animation: shake-card/, 'the shake lives on its own class');
assert.match(examSource, /classList\.remove\('q-shake'\)/, 'and is taken off again once it has played');

// ── #39 / #44: wording ─────────────────────────────────────────────────────
assert.doesNotMatch(examPage, /examv2-stat-label">Skipped</, 'unanswered questions were never deliberately skipped');
assert.match(examPage, /examv2-stat-label">Unanswered</);
assert.match(loginPage, /login-system-name">TUKLAS</, 'the product name is visible to the people using it');

// ── #40: positioning conditions count down before they count ───────────────
['FACE_TOO_FAR', 'FACE_TOO_CLOSE', 'FACE_PARTIALLY_VISIBLE', 'FACE_NEAR_FRAME_EDGE'].forEach((type) => {
  const countdownSet = ruleEngine.slice(
    ruleEngine.indexOf('const COUNTDOWN_EVENT_TYPES'),
    ruleEngine.indexOf(']);', ruleEngine.indexOf('const COUNTDOWN_EVENT_TYPES')),
  );
  assert.ok(countdownSet.includes(type), `${type} must show the student a countdown`);
});
const positioningMs = Number(/positioningIncidentMs:\s*(\d+)/.exec(faceConfig)?.[1]);
const warningMs = Number(/positioningWarningMs:\s*(\d+)/.exec(faceConfig)?.[1]);
assert.ok(
  positioningMs - warningMs >= 5000,
  `a student needs longer than ${(positioningMs - warningMs) / 1000}s between the notice and the violation`,
);

// ── #43: interface fixes ───────────────────────────────────────────────────
assert.match(styleSource, /\[data-theme="dark"\] \.log-type\.force_submit/, 'Force Submitted must be readable in dark mode');
assert.match(adminSource, /ROUTINE_ACTIVITY_TYPES/, 'routine milestones are kept out of the activity counter');
assert.doesNotMatch(adminPage, /exam-policies-title">Examination Policies and Rules/, 'the heading is not repeated');
assert.doesNotMatch(adminPage, /<select className="form-control" id="share-mode">/, 'a one-option dropdown is not a choice');
assert.match(adminPage, /id="share-mode"/, 'but the value is still submitted');
assert.match(adminSource, /function isExamTitleTakenInSubject/, 'duplicates are blocked by title, not by course');
assert.match(adminSource, /choice === 'absent'/, 'reopening can let the absentees in');
assert.match(adminSource, /disabled title="\$\{escAttr\(recoverBlockedReason\)\}"/, 'archive actions stay in one column');

// ── #35: a cleared late student is watchable ───────────────────────────────
assert.match(adminSource, /monitorLateAuthorized/, 'monitoring knows who is sitting late');
assert.match(adminSource, /In Progress &middot; Late Sitting/, 'and says so while they are working');

console.log('Second-batch issue fix tests passed (#35, #37, #38, #39, #40, #41, #42, #43, #44).');

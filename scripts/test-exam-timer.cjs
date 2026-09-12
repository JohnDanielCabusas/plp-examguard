const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'public', 'js', 'exam.js'), 'utf8');
const elements = new Map();
const element = id => {
  if (!elements.has(id)) {
    elements.set(id, {
      id,
      style: {},
      classList: { add() {}, remove() {}, toggle() {}, contains() { return true; } },
      textContent: '',
      querySelector(selector) { return element(selector); },
    });
  }
  return elements.get(id);
};

let updatedSessions = 0;
const sandbox = {
  clearInterval,
  clearTimeout,
  console: { ...console, warn() {}, error() {} },
  CustomEvent: class CustomEvent {},
  document: {
    addEventListener() {},
    getElementById: element,
  },
  setInterval,
  setTimeout,
  window: {
    addEventListener() {},
  },
};
sandbox.DB = {
  getExam: () => sandbox.window.ExamApp.exam,
  getSession: () => sandbox.window.ExamApp.session,
  getStudentSession: () => sandbox.window.ExamApp.session,
  updateSession: () => { updatedSessions += 1; },
};

vm.runInNewContext(source, sandbox, { filename: 'public/js/exam.js' });
const app = sandbox.window.ExamApp;

const now = Date.now();
const startedAt = new Date(now - 10 * 60 * 1000).toISOString();
const deadline = app._getExamDeadlineMs({ timeLimit: 60, startedAt });
assert.equal(deadline, new Date(startedAt).getTime() + 60 * 60 * 1000);
assert.equal(app._getExamDeadlineMs({ timeLimit: 0, startedAt }), null);
assert.equal(app._getExamDeadlineMs({ timeLimit: 60 }, { startTime: startedAt }), deadline);

// The short focus reminder shown in the warning overlay must never submit the exam.
let reminderOptions = null;
let submitCalls = 0;
const realStartDeadlineCountdown = app._startDeadlineCountdown;
const realSubmitExam = app.submitExam;
app._startDeadlineCountdown = options => { reminderOptions = options; };
app.submitExam = () => { submitCalls += 1; };
app.warnings = 2;
app._warningCountdownMode = null;
app.startCountdown(10);
assert.ok(reminderOptions?.onExpire, 'Focus reminder must provide an expiry handler.');
reminderOptions.onExpire();
assert.equal(submitCalls, 0, 'Focus reminder expiry must not submit an exam.');
assert.equal(app._warningCountdownMode, 'focus_expired');
assert.match(element('warning-overlay-sub').textContent, /timer expires/i);

// Returning early may show a short read notice, but it must stay inside the
// focus warning's original deadline instead of adding time to it.
let readCountdownSeconds = null;
app._startReadCountdown = seconds => { readCountdownSeconds = seconds; };
app._warningCountdownMode = 'focus';
app._warningCountdownDeadline = Date.now() + 8000;
app.cancelCountdown();
assert.equal(readCountdownSeconds, 3);

// A return event must never cancel camera/object warning timers. This was the
// freeze that could leave a warning overlay open indefinitely.
let stopWarningCalls = 0;
const realStopWarningCountdown = app._stopWarningCountdown;
app._stopWarningCountdown = () => { stopWarningCalls += 1; };
app._warningCountdownMode = 'info';
app.cancelCountdown();
assert.equal(stopWarningCalls, 0, 'Focus recovery must not cancel an info-warning countdown.');
app._stopWarningCountdown = realStopWarningCountdown;

// A fullscreen strike must be issued immediately even after a recent click.
// Previously the trusted-interaction grace path swallowed the visible warning.
let shownWarningType = null;
let focusCountdownSeconds = null;
const realShowWarningOverlay = app.showWarningOverlay;
const realStartCountdown = app.startCountdown;
const realRunAfterNextPaint = app._runAfterNextPaint;
app.session = { id: 'fullscreen-test', studentId: 'student-test' };
app.warnings = 0;
app._lastWarningTime = 0;
app._cameraPrompting = false;
app._intentionalFullscreenExit = false;
app._hasRecentTrustedInteraction = () => true;
app.showWarningOverlay = type => { shownWarningType = type; };
app.startCountdown = seconds => { focusCountdownSeconds = seconds; };
app._runAfterNextPaint = () => {};
assert.equal(app.issueWarning('fullscreen_exit', 'Fullscreen mode exited'), true);
assert.equal(app.warnings, 1);
assert.equal(shownWarningType, 'fullscreen_exit');
assert.equal(focusCountdownSeconds, 10);

// Focus events must not dismiss that strike while fullscreen is still absent.
let fullscreenActive = false;
let fullscreenReadSeconds = null;
app._activeWarningType = 'fullscreen_exit';
app._warningCountdownMode = 'focus';
app._warningCountdownDeadline = Date.now() + 8000;
app._isFullscreenActive = () => fullscreenActive;
app._startReadCountdown = seconds => { fullscreenReadSeconds = seconds; };
app.cancelCountdown();
assert.equal(fullscreenReadSeconds, null);
assert.equal(app._warningCountdownMode, 'focus');

fullscreenActive = true;
app.cancelCountdown();
assert.equal(fullscreenReadSeconds, 3);
app.showWarningOverlay = realShowWarningOverlay;
app.startCountdown = realStartCountdown;
app._runAfterNextPaint = realRunAfterNextPaint;

// The final strike uses the same visible deadline as its submission callback.
let finalWarningOptions = null;
app._startDeadlineCountdown = options => { finalWarningOptions = options; };
app.warnings = 3;
app.showWarningOverlay('restricted_phone', 'Phone detected');
assert.equal(app._warningCountdownMode, 'final');
assert.equal(finalWarningOptions?.totalSeconds, 3);
finalWarningOptions.onExpire();
assert.equal(submitCalls, 1, 'Final warning must submit exactly when its visible countdown expires.');

// The submission boundary independently rejects a timeout with 50 minutes left.
app._startDeadlineCountdown = realStartDeadlineCountdown;
app.submitExam = realSubmitExam;
app.exam = { id: 'exam-1', status: 'active', timeLimit: 60, startedAt };
app.session = { id: 'session-1', studentId: 'student-1', warnings: 2, startTime: startedAt };
app.warnings = 2;
app.timerInterval = null;
let timerRestarts = 0;
app.startTimer = () => { timerRestarts += 1; };
assert.equal(app.submitExam('timeout'), false);
assert.equal(updatedSessions, 0, 'Premature timeout must not update submission state.');
assert.equal(timerRestarts, 1, 'A stale timeout callback must restore the live timer.');
assert.ok(app.timeRemaining >= 49 * 60, 'Approximately 50 minutes should remain.');

// Violation auto-submit is valid only at the documented three-warning limit.
assert.equal(app.submitExam('auto'), false);
assert.equal(updatedSessions, 0, 'Two warnings must never auto-submit an exam.');

assert.doesNotMatch(source, /Time expired\. Submitting your exam now/);
assert.doesNotMatch(source, /const COUNTDOWN_SECS = 7/);
assert.equal(
  (source.match(/submitExam\('auto'\)/g) || []).length,
  2,
  'Only the two three-warning enforcement paths may request violation auto-submit.',
);
console.log('Exam timer expiry guard tests passed.');

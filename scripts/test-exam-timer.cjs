const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'public', 'js', 'exam.js'), 'utf8');
const elements = new Map();
const element = id => {
  if (!elements.has(id)) {
    const classes = new Set();
    const item = {
      id,
      style: {},
      classList: {
        add(...names) { names.forEach(name => classes.add(name)); },
        remove(...names) { names.forEach(name => classes.delete(name)); },
        toggle(name, force) {
          const enabled = force === undefined ? !classes.has(name) : !!force;
          if (enabled) classes.add(name); else classes.delete(name);
          return enabled;
        },
        contains(name) { return classes.has(name); },
      },
      dataset: {},
      textContent: '',
      setAttribute(name, value) { this[name] = String(value); },
      querySelector(selector) { return element(selector); },
    };
    Object.defineProperty(item, 'className', {
      get() { return [...classes].join(' '); },
      set(value) {
        classes.clear();
        String(value || '').split(/\s+/).filter(Boolean).forEach(name => classes.add(name));
      },
    });
    elements.set(id, item);
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

// A dragged webcam preview must always remain inside the visible viewport.
sandbox.window.innerWidth = 1000;
sandbox.window.innerHeight = 700;
assert.equal(JSON.stringify(app._constrainCameraPosition(-200, -100, 200, 180)), JSON.stringify({ left: 8, top: 8 }));
assert.equal(JSON.stringify(app._constrainCameraPosition(950, 680, 200, 180)), JSON.stringify({ left: 792, top: 512 }));

// A current one-person result must clear that detector's stale multiple-face
// state immediately, while the short internal recovery window prevents the
// already-issued incident from flapping on a single noisy frame.
const realIssueWarning = app.issueWarning;
app.issueWarning = () => true;
app._resetMultiplePeopleTracking();
const multipleFaceCandidate = app._updateMultiplePeopleTracking('facemesh', true, { now: 0, holdMs: 500 });
const oneFaceAgain = app._updateMultiplePeopleTracking('facemesh', false, { now: 100, holdMs: 500 });
assert.equal(multipleFaceCandidate.detected, true);
assert.equal(oneFaceAgain.detected, false);
assert.equal(element('camera-status-text').textContent, 'Camera scan active');
assert.equal(element('camera-status-text').dataset.faceCountdown, undefined);
app._resetMultiplePeopleTracking();
app.issueWarning = realIssueWarning;

// Every supported answer shape must use the same immediate completion rule.
assert.equal(app._isQuestionAnswered({ type: 'mcq' }, 'Option A'), true);
assert.equal(app._isQuestionAnswered({ type: 'identification' }, '   '), false);
assert.equal(app._isQuestionAnswered({ type: 'essay' }, 'First word'), true);
assert.equal(app._isQuestionAnswered({ type: 'coding' }, 'const answer = 1;'), true);
assert.equal(app._isQuestionAnswered({ type: 'checkbox' }, '[1]'), true);
assert.equal(app._isQuestionAnswered({ type: 'checkbox' }, '[]'), false);
assert.equal(app._isQuestionAnswered({ type: 'enumeration' }, '\nSecond item\n'), true);
assert.equal(app._isQuestionAnswered({ type: 'enumeration' }, '\n\n'), false);
assert.equal(app._isQuestionAnswered({ type: 'matching' }, '{"0":"Match"}'), true);
assert.equal(app._isQuestionAnswered({ type: 'matching' }, '{"0":"","1":""}'), false);

// selectAnswer must refresh the navigator in the same input event, before the
// delayed persistence write runs.
let immediateAnswerRefreshes = 0;
const realAutoSave = app.autoSave;
const realUpdateAnsweredStatus = app._updateAnsweredStatus;
app.questionOrder = [{ id: 'live-answer', type: 'essay' }];
app.answers = {};
app.autoSave = () => {};
app._updateAnsweredStatus = () => { immediateAnswerRefreshes += 1; };
app.selectAnswer('live-answer', 'Typed now');
assert.equal(immediateAnswerRefreshes, 1);
assert.equal(app.answers['live-answer'], 'Typed now');
app.autoSave = realAutoSave;
app._updateAnsweredStatus = realUpdateAnsweredStatus;
app.questionOrder = [];
app.answers = {};

// The real navigator renderer must add the green `answered` class for every
// question type, including questions that are also marked for review.
const answerCases = [
  ['mcq', 'Option A'],
  ['tf', 'True'],
  ['identification', 'ANSWER'],
  ['essay', 'An essay response'],
  ['coding', 'return 1;'],
  ['checkbox', '[0]'],
  ['enumeration', 'First item\n'],
  ['matching', '{"0":"Match"}'],
];
app.questionOrder = answerCases.map(([type], index) => ({ id: `answer-${index}`, type }));
app.answers = Object.fromEntries(answerCases.map(([, value], index) => [`answer-${index}`, value]));
app.currentQuestionIndex = 0;
app.markedForReview = new Set([1]);
app._updateNavGrid();
answerCases.forEach((_, index) => {
  assert.equal(element(`nav-q-${index}`).classList.contains('answered'), true, `Question type ${answerCases[index][0]} must be highlighted as answered.`);
});
assert.equal(element('nav-q-1').classList.contains('review'), true);
app.questionOrder = [];
app.answers = {};
app.markedForReview = new Set();

// Free-text handlers and the submission snapshot must preserve the student's
// exact case, spelling, leading/trailing spaces, and enumeration line values.
app.questionOrder = [
  { id: 'exact-id', type: 'identification' },
  { id: 'exact-enum', type: 'enumeration', answers: ['one', 'two'] },
  { id: 'exact-essay', type: 'essay' },
  { id: 'exact-code', type: 'coding' },
];
element('id-input-exact-id').value = 'McArthur  ';
element('enum-exact-enum-0').value = '  First Item';
element('enum-exact-enum-1').value = 'second itme  ';
element('essay-input-exact-essay').value = 'My exact Speling.  ';
element('coding-textarea-exact-code').value = 'print("Exact")\n';
app.handleIdentificationInput({ target: element('id-input-exact-id') }, 'exact-id');
app.handleEnumInput({}, 'exact-enum', 2);
assert.equal(app.answers['exact-id'], 'McArthur  ');
assert.equal(app.answers['exact-enum'], '  First Item\nsecond itme  ');
const exactSnapshot = app._collectFinalAnswersFromControls();
assert.equal(exactSnapshot['exact-id'], 'McArthur  ');
assert.equal(exactSnapshot['exact-enum'], '  First Item\nsecond itme  ');
assert.equal(exactSnapshot['exact-essay'], 'My exact Speling.  ');
assert.equal(exactSnapshot['exact-code'], 'print("Exact")\n');
app.questionOrder = [];
app.answers = {};

// Final collection reads the last visible value for every supported question
// type. In particular, a changed choice must replace the earlier saved choice.
const finalQuestions = [
  { id: 'final-mcq', type: 'mcq' },
  { id: 'final-checkbox', type: 'checkbox' },
  { id: 'final-tf', type: 'tf' },
  { id: 'final-id', type: 'identification' },
  { id: 'final-enum', type: 'enumeration', answers: ['a', 'b'] },
  { id: 'final-match', type: 'matching', pairs: [{}, {}] },
  { id: 'final-essay', type: 'essay' },
  { id: 'final-code', type: 'coding' },
];
app.questionOrder = finalQuestions;
app.answers = { 'final-mcq': 'Previous choice' };
element('mcq-final-mcq').querySelector = () => ({ dataset: { val: 'Latest Choice — exact' } });
const checkboxOptions = [
  { dataset: { idx: '2' }, querySelector: () => ({ checked: true }) },
  { dataset: { idx: '0' }, querySelector: () => ({ checked: true }) },
  { dataset: { idx: '1' }, querySelector: () => ({ checked: false }) },
];
element('checkbox-final-checkbox').querySelectorAll = () => checkboxOptions;
element('tf-final-tf').querySelector = () => ({ classList: { contains: name => name === 'tf-false' } });
element('id-input-final-id').value = 'iPhone eSIM';
element('enum-final-enum-0').value = ' First ';
element('enum-final-enum-1').value = 'SecOnd';
element('match-final-match-0').value = 'Exact Match A';
element('match-final-match-1').value = 'Exact Match B';
element('essay-input-final-essay').value = 'Essay Case & punctuation!  ';
element('coding-cm-final-code')._cm = { getValue: () => 'const Value = "Exact";\n' };
const allTypesSnapshot = app._collectFinalAnswersFromControls();
assert.equal(allTypesSnapshot['final-mcq'], 'Latest Choice — exact');
assert.equal(allTypesSnapshot['final-checkbox'], '[0,2]');
assert.equal(allTypesSnapshot['final-tf'], 'False');
assert.equal(allTypesSnapshot['final-id'], 'iPhone eSIM');
assert.equal(allTypesSnapshot['final-enum'], ' First \nSecOnd');
assert.equal(allTypesSnapshot['final-match'], '{"0":"Exact Match A","1":"Exact Match B"}');
assert.equal(allTypesSnapshot['final-essay'], 'Essay Case & punctuation!  ');
assert.equal(allTypesSnapshot['final-code'], 'const Value = "Exact";\n');
app.questionOrder = [];
app.answers = {};

// A stale session poll must not erase an answer while autosave is in flight.
app._pendingLocalAnswers = new Map([['race-answer', 'Newest choice']]);
app.answers = { 'race-answer': 'Newest choice' };
assert.equal(
  JSON.stringify(app._reconcileLiveAnswers({})),
  JSON.stringify({ 'race-answer': 'Newest choice' }),
);
assert.equal(app._pendingLocalAnswers.has('race-answer'), true);

// Once the server echoes the exact edit, the temporary local protection ends.
assert.equal(
  JSON.stringify(app._reconcileLiveAnswers({ 'race-answer': 'Newest choice' })),
  JSON.stringify({ 'race-answer': 'Newest choice' }),
);
assert.equal(app._pendingLocalAnswers.has('race-answer'), false);
app.answers = {};

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
const realNotifyProfessorViolation = app._notifyProfessorViolation;
let deferredWarningWork = null;
let immediateProfessorNotifications = 0;
app.session = { id: 'fullscreen-test', studentId: 'student-test' };
app.exam = { id: 'fullscreen-exam' };
app.warnings = 0;
app._lastWarningTime = 0;
app._cameraPrompting = false;
app._intentionalFullscreenExit = false;
app._hasRecentTrustedInteraction = () => true;
app.showWarningOverlay = type => { shownWarningType = type; };
app.startCountdown = seconds => { focusCountdownSeconds = seconds; };
app._notifyProfessorViolation = () => {
  immediateProfessorNotifications += 1;
  return Promise.resolve(null);
};
app._runAfterNextPaint = callback => { deferredWarningWork = callback; };
assert.equal(app.issueWarning('fullscreen_exit', 'Fullscreen mode exited'), true);
assert.equal(app.warnings, 1);
assert.equal(shownWarningType, 'fullscreen_exit');
assert.equal(focusCountdownSeconds, 10);
assert.equal(immediateProfessorNotifications, 1, 'Professor notification must start before deferred warning work.');
assert.equal(typeof deferredWarningWork, 'function');

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
app._notifyProfessorViolation = realNotifyProfessorViolation;

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

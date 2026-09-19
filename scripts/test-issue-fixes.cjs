// Regression tests for the issues fixed in this pass:
//   #23 screen recording already running before the exam opened
//   #24 paste landing in the coding editor despite the warning
//   #26 / #29 the same student listed twice after a retake
//   #27 "AI detection failed" shouting on every Review
//   #28 no deadline on the return-to-fullscreen screen
//   #30 discrimination index stretched across the card
//   #31 absent students needing the whole exam reopened
//   #32 class performance guidance for the next exam
//   #34 blurry camera evidence
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const examSource = fs.readFileSync(path.join(root, 'public', 'js', 'exam.js'), 'utf8');
const adminSource = fs.readFileSync(path.join(root, 'public', 'js', 'admin.js'), 'utf8');
const styleSource = fs.readFileSync(path.join(root, 'public', 'css', 'style.css'), 'utf8');

// Slice a contiguous block out of a bundle and run it for real, so these tests
// exercise behaviour rather than asserting on source text.
function extract(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.ok(start >= 0, `missing block start: ${startMarker}`);
  const end = source.indexOf(endMarker, start);
  assert.ok(end > start, `missing block end: ${endMarker}`);
  return source.slice(start, end);
}

const elements = new Map();
const element = id => {
  if (!elements.has(id)) {
    const classes = new Set();
    elements.set(id, {
      id,
      style: { display: '' },
      dataset: {},
      textContent: '',
      innerHTML: '',
      title: '',
      className: '',
      classList: {
        add(...n) { n.forEach(x => classes.add(x)); },
        remove(...n) { n.forEach(x => classes.delete(x)); },
        contains(n) { return classes.has(n); },
        toggle() {},
      },
      setAttribute() {},
      querySelector: () => null,
    });
  }
  return elements.get(id);
};

const timers = [];
const documentListeners = [];
const sandbox = {
  clearInterval() {},
  clearTimeout(id) { const t = timers.find(x => x.id === id); if (t) t.cancelled = true; },
  console: { ...console, warn() {}, error() {} },
  CustomEvent: class CustomEvent {},
  document: {
    addEventListener(type, fn, capture) { documentListeners.push({ type, fn, capture }); },
    getElementById: element,
    createElement: () => ({ style: {}, dataset: {}, classList: { add() {}, remove() {} }, appendChild() {} }),
    body: { appendChild() {} },
  },
  navigator: {},
  setInterval() { return 1; },
  setTimeout(fn, delay) {
    const id = timers.length + 1;
    timers.push({ id, fn, delay, cancelled: false });
    return id;
  },
  window: {
    addEventListener() {},
    getComputedStyle: el => ({ display: el.style.display || 'none' }),
  },
};
sandbox.DB = {
  getExam: () => sandbox.window.ExamApp.exam,
  getSession: () => sandbox.window.ExamApp.session,
  getStudentSession: () => sandbox.window.ExamApp._testStudentSession || null,
  getExams: () => [],
  updateSession() {},
  addLog() {},
};

vm.runInNewContext(
  `${examSource}\nthis.__examConsts = { EXAM_CAMERA_CONSTRAINTS, SCREEN_RECORDER_DEVICE_SIGNATURES, EXAM_WARNING_TIMINGS, VIOLATION_SNAPSHOT_WIDTH, VIOLATION_SNAPSHOT_HEIGHT };`,
  sandbox,
  { filename: 'public/js/exam.js' },
);
const app = sandbox.window.ExamApp;
const consts = sandbox.__examConsts;

const runPending = () => {
  const pending = timers.filter(t => !t.cancelled && !t.done);
  pending.forEach(t => { t.done = true; t.fn(); });
  return pending.length;
};

// ── #34: the professor has to be able to see what the camera saw ────────────
assert.equal(consts.EXAM_CAMERA_CONSTRAINTS.width.ideal, 1280, 'camera asks for 720p, not VGA');
assert.equal(consts.EXAM_CAMERA_CONSTRAINTS.height.ideal, 720);
assert.equal(consts.EXAM_CAMERA_CONSTRAINTS.width.min, 640, 'weaker webcams are still allowed in');
assert.ok(consts.VIOLATION_SNAPSHOT_WIDTH >= 640, 'violation evidence is captured above thumbnail size');
assert.ok(consts.VIOLATION_SNAPSHOT_HEIGHT >= 480);

// ── #23: a recorder already running is found by scanning the devices ────────
assert.ok(
  consts.SCREEN_RECORDER_DEVICE_SIGNATURES.includes('obs virtual'),
  'the most common recorder signature is covered',
);

sandbox.navigator.mediaDevices = {
  enumerateDevices: async () => ([
    { kind: 'videoinput', label: 'Integrated Webcam' },
    { kind: 'videoinput', label: 'OBS Virtual Camera' },
    { kind: 'audioinput', label: 'Microphone' },
  ]),
};

(async () => {
  const found = await app._scanForScreenRecorders();
  assert.equal(found.length, 1, 'exactly the recorder device is flagged');
  assert.equal(found[0].label, 'OBS Virtual Camera');

  const raised = [];
  app.session = { id: 's1' };
  app._reportedRecorderLabels = null;
  app.issueWarning = (type, detail) => { raised.push({ type, detail }); return true; };

  await app._checkScreenRecordingEnvironment('pre-exam');
  assert.equal(raised.length, 1, 'a recorder running before the exam is caught');
  assert.equal(raised[0].type, 'screen_record');
  assert.match(raised[0].detail, /already running/, 'the detail says it predated the exam');

  // The scan repeats on a loop; the same device must not be charged twice.
  await app._checkScreenRecordingEnvironment('during');
  assert.equal(raised.length, 1, 'the same recorder is only reported once');

  // No recorder present, nothing reported.
  sandbox.navigator.mediaDevices.enumerateDevices = async () => ([
    { kind: 'videoinput', label: 'Integrated Webcam' },
  ]);
  app._reportedRecorderLabels = null;
  raised.length = 0;
  await app._checkScreenRecordingEnvironment('pre-exam');
  assert.equal(raised.length, 0, 'an ordinary webcam is not a recorder');

  // Hardware that merely could capture must never cost a strike: Stereo Mix
  // ships enabled on a great many machines and says nothing about cheating.
  const logged = [];
  app._recordActivity = (type, detail) => { logged.push({ type, detail }); };
  sandbox.navigator.mediaDevices.enumerateDevices = async () => ([
    { kind: 'audioinput', label: 'Stereo Mix (Realtek Audio)' },
    { kind: 'videoinput', label: 'Generic Virtual Camera' },
  ]);
  app._reportedRecorderLabels = null;
  await app._checkScreenRecordingEnvironment('pre-exam');
  assert.equal(raised.length, 0, 'a loopback device alone is not a violation');
  assert.equal(logged.length, 1, 'but the professor is still told it is there');
  assert.equal(logged[0].type, 'screen_record_possible');

  // Device labels stay blank until the page holds a camera permission. Reading
  // them too early returned a meaningless all-clear, which is how a recorder
  // that was plainly running went unreported.
  sandbox.navigator.mediaDevices.enumerateDevices = async () => ([
    { kind: 'videoinput', label: '' },
    { kind: 'audioinput', label: '' },
  ]);
  app._reportedRecorderLabels = null;
  app._recorderRescanAttempts = 0;
  app._recorderRescanPending = null;
  timers.length = 0;
  const early = await app._readCaptureDeviceState();
  assert.equal(early.labelsVisible, false, 'blank labels are reported as unreadable');
  await app._checkScreenRecordingEnvironment('pre-exam');
  assert.ok(
    timers.some(t => !t.cancelled),
    'an unreadable scan schedules a retry instead of concluding the machine is clean',
  );

  // Once the permission lands and the labels appear, the retry finds it.
  sandbox.navigator.mediaDevices.enumerateDevices = async () => ([
    { kind: 'videoinput', label: 'OBS Virtual Camera' },
  ]);
  raised.length = 0;
  app._reportedRecorderLabels = null;
  await app._checkScreenRecordingEnvironment('pre-exam');
  assert.equal(raised.length, 1, 'the recorder is caught once the labels become readable');

  runExamRuntimeTests();
  runAdminTests();
  runAdminReviewTests();
  runClassPerformanceTests();
  console.log('Issue fix regression tests passed (#23, #24, #26, #27, #28, #29, #30, #31, #32, #34).');
})().catch(error => {
  console.error(error);
  process.exit(1);
});

function runExamRuntimeTests() {
  // ── #28: the return-to-fullscreen screen now carries a deadline ───────────
  assert.ok(
    consts.EXAM_WARNING_TIMINGS.fullscreenLockSeconds > 0,
    'the fullscreen lock has a time limit at all',
  );

  const raised = [];
  app.session = { id: 's1' };
  app.warnings = 1;
  app._examRuntimeStarted = true;
  app._isFullscreenActive = () => false;
  app.issueWarning = (type, detail) => { raised.push({ type, detail }); return true; };

  timers.length = 0;
  app._startFullscreenReturnCountdown();
  assert.equal(raised.length, 0, 'the student gets the full window before a strike');
  // Run the countdown out.
  app._warningCountdownDeadline = Date.now() - 1;
  runPending();
  assert.equal(raised.length, 1, 'staying outside fullscreen costs another warning');
  assert.equal(raised[0].type, 'fullscreen_exit');

  // Returning to fullscreen inside the window costs nothing.
  raised.length = 0;
  app._isFullscreenActive = () => true;
  timers.length = 0;
  app._startFullscreenReturnCountdown();
  app._warningCountdownDeadline = Date.now() - 1;
  runPending();
  assert.equal(raised.length, 0, 'returning to fullscreen in time is not a violation');

  // A finished exam must never keep charging strikes.
  raised.length = 0;
  app._isFullscreenActive = () => false;
  app._examRuntimeStarted = false;
  timers.length = 0;
  app._startFullscreenReturnCountdown();
  app._warningCountdownDeadline = Date.now() - 1;
  runPending();
  assert.equal(raised.length, 0, 'a finished exam raises no fullscreen strike');

  // ── #24: paste into an answer must be stopped before the editor sees it ───
  documentListeners.length = 0;
  app.anticheatListeners = [];
  app._examRuntimeStarted = true;
  app.destroyAntiCheat = () => {};
  app._recordActivity = () => {};
  app._consumeRecentClipboardShortcut = () => false;
  app._isEditableTarget = () => true;
  app.initAntiCheat();

  const pasteEntry = documentListeners.filter(l => l.type === 'paste').pop();
  assert.ok(pasteEntry, 'a paste handler is registered');
  assert.equal(
    pasteEntry.capture,
    true,
    'paste is captured before CodeMirror handles it, or the text is already inserted',
  );

  const registered = app.anticheatListeners.find(entry => entry[0] === 'paste');
  assert.ok(registered, 'the paste listener is tracked for teardown');
  assert.equal(registered[3], true, 'teardown remembers the capture flag, or removal silently fails');
  assert.ok(
    app.anticheatListeners.some(entry => entry[0] === 'drop' && entry[3] === true),
    'dragged text into an answer is blocked too',
  );

  app.issueWarning = () => true;
  app._isAnswerFieldTarget = () => true;
  let prevented = false;
  let stopped = false;
  pasteEntry.fn({
    target: {},
    preventDefault() { prevented = true; },
    stopImmediatePropagation() { stopped = true; },
  });
  assert.equal(prevented, true, 'the paste itself is cancelled');
  assert.equal(stopped, true, 'the event never reaches the code editor handler');
}

function runExamLateAccessTests() {
  // ── #31: an absent student cleared to sit the exam afterwards ─────────────
  const student = { id: 'stu-1' };
  const closedExam = {
    id: 'e1',
    status: 'closed',
    timeLimit: 60,
    startedAt: '2026-09-01T01:00:00.000Z',
    excludedStudentIds: ['stu-1'],
    lateExamStudentIds: ['stu-1'],
  };

  assert.equal(
    app._isStudentAbsentForExam(student, { ...closedExam, lateExamStudentIds: [] }),
    true,
    'without a clearance the student stays blocked',
  );
  assert.equal(
    app._isStudentAbsentForExam(student, closedExam),
    false,
    'a cleared student is no longer turned away at the door',
  );
  assert.deepEqual(
    closedExam.excludedStudentIds,
    ['stu-1'],
    'the attendance record is left untouched - they were still absent on the day',
  );

  app._testStudentSession = null;
  const forStudent = app._examForStudent(closedExam, student);
  assert.equal(forStudent.status, 'active', 'the exam reads as open to this student alone');
  assert.equal(forStudent.lateExamForStudent, true);

  app._testStudentSession = { submitted: true };
  assert.equal(
    app._examForStudent(closedExam, student).status,
    'closed',
    'once they have submitted the exam closes again',
  );
  app._testStudentSession = null;

  // The class window expired weeks ago; a late sitting is timed from its own
  // start or the student would be submitted the moment they open it.
  app._lateExamAttempt = true;
  const lateDeadline = app._getExamDeadlineMs(forStudent, { startTime: '2026-09-19T02:00:00.000Z' });
  assert.equal(
    lateDeadline,
    new Date('2026-09-19T03:00:00.000Z').getTime(),
    'a late sitting gets the full duration from when it actually starts',
  );
  app._lateExamAttempt = false;
  assert.equal(
    app._getExamDeadlineMs(closedExam, { startTime: '2026-09-19T02:00:00.000Z' }),
    new Date('2026-09-01T02:00:00.000Z').getTime(),
    'everyone else still runs on the exam-wide clock',
  );
}

function runAdminTests() {
  runExamLateAccessTests();

  // ── #26 / #29: one student, one row ──────────────────────────────────────
  const dedupeBlock = extract(
    adminSource,
    'function sessionRecencyValue(session)',
    'function renderAttemptBadge(session)',
  );
  const dedupeBox = {};
  vm.runInNewContext(
    `${dedupeBlock}\nthis.dedupeSessionsByStudent = dedupeSessionsByStudent;`,
    dedupeBox,
  );
  const dedupeSessionsByStudent = dedupeBox.dedupeSessionsByStudent;

  const duplicated = dedupeSessionsByStudent([
    { id: 'a', studentId: '23-00181', submitted: true, score: 0, endTime: '2026-09-19T08:52:00.000Z' },
    { id: 'b', studentId: '23-00181', submitted: true, score: 3, endTime: '2026-09-19T08:58:00.000Z' },
    { id: 'c', studentId: '23-00218', submitted: true, score: 7, endTime: '2026-09-19T08:40:00.000Z' },
  ]);
  assert.equal(duplicated.length, 2, 'a retake does not put the student in the list twice');
  const collapsed = duplicated.find(s => s.studentId === '23-00181');
  assert.equal(collapsed.id, 'b', 'the latest attempt is the one that counts');
  assert.equal(collapsed.attemptCount, 2, 'the row still says how many attempts it stands for');
  // Rebuilt with Array.from: the helper runs in its own vm context, so its
  // arrays do not share this realm Array.prototype.
  assert.deepEqual(Array.from(collapsed.supersededSessionIds), ['a'], 'the earlier attempt is not lost');
  const single = duplicated.find(s => s.studentId === '23-00218');
  assert.equal(single.attemptCount, undefined, 'a single attempt carries no badge');

  // An attempt still in progress outranks a finished one.
  const live = dedupeSessionsByStudent([
    { id: 'old', studentId: 'x', submitted: true, endTime: '2026-09-19T08:00:00.000Z' },
    { id: 'now', studentId: 'x', submitted: false, startTime: '2026-09-19T07:00:00.000Z' },
  ]);
  assert.equal(live[0].id, 'now', 'the attempt being sat right now wins');

  // Archived retakes count towards the badge too.
  const withHistory = dedupeSessionsByStudent([
    { id: 'z', studentId: 'y', submitted: true, attemptHistory: [{ attempt: 1 }] },
  ]);
  assert.equal(withHistory[0].attemptCount, 2, 'an archived attempt is counted');

  const rfBlock = extract(
    adminSource,
    'function dedupeRandomForestPredictions(predictions)',
    'function renderRandomForestStudentRows(predictions)',
  );
  const rfBox = {};
  vm.runInNewContext(
    `${rfBlock}\nthis.dedupeRandomForestPredictions = dedupeRandomForestPredictions;`,
    rfBox,
  );
  const rfRows = rfBox.dedupeRandomForestPredictions([
    { studentId: 's1', examSessionId: 'a', submittedAt: '2026-09-19T08:52:00.000Z', suspiciousProbability: 0.9 },
    { studentId: 's1', examSessionId: 'b', submittedAt: '2026-09-19T08:58:00.000Z', suspiciousProbability: 0.2 },
    { studentId: 's2', examSessionId: 'c', submittedAt: '2026-09-19T08:40:00.000Z', suspiciousProbability: 0.4 },
  ]);
  assert.equal(rfRows.length, 2, 'the suspicion list holds one entry per student');
  assert.equal(
    rfRows.find(r => r.studentId === 's1').examSessionId,
    'b',
    'the retake, not the abandoned attempt, is the one scored',
  );

  // The server query behind that list must collapse retakes as well, or an
  // out-of-date panel is the only thing standing between the professor and a
  // duplicate.
  const routeSource = fs.readFileSync(path.join(root, 'server', 'random-forest-route.cjs'), 'utf8');
  assert.match(
    routeSource,
    /with latest_sessions as \(\s*select distinct on/,
    'the statistics query keeps one session per student',
  );
}

function runAdminReviewTests() {
  // ── #27: an unscannable essay is a state, not an error ───────────────────
  const aiBlock = extract(
    adminSource,
    'const AI_DETECTION_MIN_CHARS =',
    'async function analyzeAIContent(text)',
  );
  const aiBox = { DB: { getSettings: () => aiBox.__settings } };
  vm.runInNewContext(
    `${aiBlock}\nthis.getAIDetectionAvailability = getAIDetectionAvailability;`,
    aiBox,
  );
  const getAIDetectionAvailability = aiBox.getAIDetectionAvailability;
  const longEssay = 'x'.repeat(200);

  aiBox.__settings = {};
  const noKey = getAIDetectionAvailability(longEssay);
  assert.equal(noKey.ok, false);
  assert.equal(noKey.code, 'no_key');
  assert.match(noKey.reason, /Settings/, 'the professor is told where to fix it');

  aiBox.__settings = { claudeApiKey: 'k' };
  const tooShort = getAIDetectionAvailability('too short');
  assert.equal(tooShort.ok, false);
  assert.equal(tooShort.code, 'too_short');

  assert.equal(getAIDetectionAvailability(longEssay).ok, true, 'a real essay with a key scans');

  // A background scan must never reach the toast channel.
  assert.match(
    adminSource,
    /if \(!isAutoScan\) showToast\('AI detection failed: ' \+ e\.message, 'error'\);/,
    'only a scan the professor asked for may raise an error toast',
  );
  const autoCallSites = adminSource.match(/detectAIContentDetailed\(job\.text[^)]*\)/g) || [];
  assert.equal(autoCallSites.length, 2, 'both Review renderers dispatch auto scans');
  autoCallSites.forEach((call) => {
    assert.match(call, /auto: true/, 'Review auto-scans identify themselves as background work');
  });

  // ── #30: the discrimination list is columns, not one endless strip ───────
  assert.match(adminSource, /stats-analysis-list stats-disc-grid/, 'the list opts into the grid');
  assert.match(styleSource, /\.stats-disc-grid \{[^}]*grid-template-columns: repeat\(auto-fill/, 'the grid is responsive');
  assert.match(
    adminSource,
    /tone-neutral">Provisional/,
    'a two-submission sample is called provisional, not "60 questions to review"',
  );
}

function runClassPerformanceTests() {
  // ── #32: the numbers are put in front of the professor, nothing is retuned ─
  const perfBlock = extract(
    adminSource,
    'const CLASS_PERFORMANCE_LOW_AVG =',
    'function renderClassPerformanceCard(exam, sessions)',
  );
  const perfBox = {};
  vm.runInNewContext(
    `${perfBlock}\nthis.buildDifficultyRecommendation = buildDifficultyRecommendation;\nthis.shiftDifficulty = shiftDifficulty;`,
    perfBox,
  );
  const buildDifficultyRecommendation = perfBox.buildDifficultyRecommendation;

  const struggled = buildDifficultyRecommendation({ average: 41, passRate: 10, difficulty: 'hard' });
  assert.equal(struggled.tone, 'danger');
  assert.match(struggled.headline, /Hard to Medium/, 'a hard exam the class failed points at Medium');

  const breezed = buildDifficultyRecommendation({ average: 93, passRate: 100, difficulty: 'medium' });
  assert.equal(breezed.tone, 'positive');
  assert.match(breezed.headline, /Medium to Hard/, 'a medium exam everyone aced points at Hard');

  const wellPitched = buildDifficultyRecommendation({ average: 74, passRate: 60, difficulty: 'medium' });
  assert.equal(wellPitched.tone, 'neutral');
  assert.match(wellPitched.headline, /Hold the next exam at Medium/);

  // The ladder must not run off either end.
  assert.equal(perfBox.shiftDifficulty('easy', -1), 'easy');
  assert.equal(perfBox.shiftDifficulty('hard', 1), 'hard');
  assert.equal(perfBox.shiftDifficulty(null, -1), null);

  const easiestAlready = buildDifficultyRecommendation({ average: 30, passRate: 0, difficulty: 'easy' });
  assert.match(
    easiestAlready.headline,
    /Consider easing the next exam/,
    'an easy exam the class still failed says so plainly rather than naming a lower level',
  );
}

// Regression tests for the clipboard, fullscreen and review-gating anti-cheat
// rules reported in issues #16, #17 and #19.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'public', 'js', 'exam.js'), 'utf8');

// A target that knows which selectors it sits inside, so closest() can answer
// the same question the real DOM would.
const target = (...matching) => ({
  matches: () => true,
  closest(query) {
    const wanted = query.split(',').map(part => part.trim());
    return wanted.some(sel => matching.includes(sel)) ? { tagName: 'DIV' } : null;
  },
});

const elements = new Map();
const element = id => {
  if (!elements.has(id)) {
    const classes = new Set();
    elements.set(id, {
      id,
      style: { display: '' },
      dataset: {},
      textContent: '',
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
const sandbox = {
  clearInterval,
  clearTimeout(id) { const t = timers.find(x => x.id === id); if (t) t.cancelled = true; },
  console: { ...console, warn() {}, error() {} },
  CustomEvent: class CustomEvent {},
  document: { addEventListener() {}, getElementById: element },
  setInterval,
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
  getStudentSession: () => sandbox.window.ExamApp.session,
  updateSession() {},
  addLog() {},
};

vm.runInNewContext(source, sandbox, { filename: 'public/js/exam.js' });
const app = sandbox.window.ExamApp;

// ── #17: answer fields are violations, the professor chat box is not ────────
assert.equal(app._isAnswerFieldTarget(target('.essay-textarea')), true, 'essay box is an answer field');
assert.equal(app._isAnswerFieldTarget(target('.coding-cm-wrap')), true, 'code editor is an answer field');
assert.equal(app._isAnswerFieldTarget(target('.id-input')), true, 'identification input is an answer field');
assert.equal(
  app._isAnswerFieldTarget(target('#exam-chat-input')),
  false,
  'reporting a problem to the professor must never count as a violation',
);
assert.equal(app._isAnswerFieldTarget(null), false, 'a missing target is not an answer field');

// ── #19: withheld scores keep the questionnaire closed ──────────────────────
let shownState = null;
app.showState = state => { shownState = state; };
app._showToast = () => {};
app.session = { id: 's1', scoreReleased: false, studentName: 'A', studentId: '1' };
app.exam = { id: 'e1', title: 'Quiz', allowReview: true, questions: [] };

app.showReview();
assert.equal(shownState, null, 'review must not open while scores are withheld');

app.session.scoreReleased = true;
app.exam.allowReview = false;
app.showReview();
assert.equal(shownState, null, 'review must not open when the exam disallows review');

// ── #16: fullscreen enforcement keeps watching instead of checking once ─────
const runPending = () => {
  const pending = timers.filter(t => !t.cancelled && !t.done);
  pending.forEach(t => { t.done = true; t.fn(); });
  return pending.length;
};

let lockShown = 0;
app._showFullscreenLock = () => { lockShown += 1; };
app._isFullscreenActive = () => false;
app._examRuntimeStarted = true;
element('warning-overlay').style.display = 'none'; // no strike overlay visible

timers.length = 0;
app._scheduleFullscreenEnforcement();
runPending();
assert.equal(lockShown, 1, 'a missing fullscreen must raise the lock');
assert.ok(
  timers.some(t => !t.cancelled && !t.done),
  'enforcement must re-arm so fullscreen stays required for the whole exam',
);

// While the strike overlay is up the lock must not bury it, but the watchdog
// must keep running so the lock still appears once that overlay goes away.
lockShown = 0;
element('warning-overlay').style.display = 'flex';
timers.length = 0;
app._scheduleFullscreenEnforcement();
runPending();
assert.equal(lockShown, 0, 'the lock must not cover the strike overlay');
assert.ok(timers.some(t => !t.cancelled && !t.done), 'watchdog keeps running behind the strike overlay');

// Teardown must stop the watchdog so it cannot surface after submission.
app._examRuntimeStarted = false;
lockShown = 0;
element('warning-overlay').style.display = 'none';
timers.length = 0;
app._scheduleFullscreenEnforcement();
runPending();
assert.equal(lockShown, 0, 'a finished exam must not raise the fullscreen lock');
assert.equal(
  timers.filter(t => !t.cancelled && !t.done).length,
  0,
  'a finished exam must not keep re-arming the watchdog',
);

// ── #20: capture hotkeys that actually reach the page are violations ───────
// The handler is registered on document, so grab it as initAntiCheat attaches it.
const keyHandlers = [];
sandbox.document.addEventListener = (type, fn) => {
  if (type === 'keydown') keyHandlers.push(fn);
};
app.anticheatListeners = [];
app.session = { id: 's1' };
app._isEditableTarget = () => false;
app._markClipboardShortcut = () => {};
app._consumeRecentClipboardShortcut = () => false;
app._recordActivity = () => {};
app.destroyAntiCheat = () => {};
app.initAntiCheat();
assert.ok(keyHandlers.length, 'a keydown handler must be registered');
const onKeyDown = keyHandlers[keyHandlers.length - 1];

const pressKey = init => {
  let prevented = false;
  onKeyDown({
    key: init.key,
    metaKey: !!init.metaKey,
    altKey: !!init.altKey,
    shiftKey: !!init.shiftKey,
    ctrlKey: !!init.ctrlKey,
    target: {},
    preventDefault() { prevented = true; },
  });
  return prevented;
};

const raised = [];
app.issueWarning = type => { raised.push(type); return true; };

raised.length = 0;
assert.equal(pressKey({ key: 'R', metaKey: true, altKey: true }), true, 'Win+Alt+R is blocked');
assert.deepEqual(raised, ['screen_record'], 'Win+Alt+R warns about screen recording');

// Win+G only opens the capture overlay. It is still a strike, but it is not
// proof that anything is being recorded, and screen_record now ends the attempt
// outright — a stray Windows-key combination must not cost a whole exam.
raised.length = 0;
pressKey({ key: 'g', metaKey: true });
assert.deepEqual(raised, ['screen_record_panel'], 'Win+G warns about the capture overlay');

raised.length = 0;
pressKey({ key: 's', metaKey: true, shiftKey: true });
assert.deepEqual(raised, ['screenshot'], 'Win+Shift+S warns about screen capture');

raised.length = 0;
pressKey({ key: '5', metaKey: true, shiftKey: true });
assert.deepEqual(raised, ['screenshot'], 'Cmd+Shift+5 warns about screen capture');

// Ordinary typing and the normal clipboard path must not be mistaken for capture.
raised.length = 0;
pressKey({ key: 'r' });
pressKey({ key: 'g' });
assert.deepEqual(raised, [], 'plain letters are not capture attempts');

raised.length = 0;
pressKey({ key: 'v', ctrlKey: true });
assert.deepEqual(raised, [], 'Ctrl+V is handled by the paste rule, not the capture rule');

console.log('Anti-cheat clipboard, fullscreen, review-gating and capture-hotkey tests passed.');

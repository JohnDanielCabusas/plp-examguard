const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// The waiting room used to query Supabase every 3 seconds per student. It now
// starts the exam from the realtime push and only probes as a fallback: slowly
// while realtime is connected, quickly while it is not.

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'public', 'js', 'exam.js'), 'utf8');

const timers = new Map();
let nextTimerId = 1;
const fakeSetTimeout = (callback, delay) => {
  const id = nextTimerId++;
  timers.set(id, { callback, delay });
  return id;
};
const fakeClearTimeout = id => { timers.delete(id); };
const pendingDelays = () => [...timers.values()].map(timer => timer.delay);
async function fireTimers() {
  const due = [...timers.entries()];
  timers.clear();
  for (const [, timer] of due) await timer.callback();
}
const flush = () => new Promise(resolve => setImmediate(resolve));

const documentListeners = new Map();
const windowListeners = new Map();
const addListener = store => (type, handler) => {
  if (!store.has(type)) store.set(type, new Set());
  store.get(type).add(handler);
};
const removeListener = store => (type, handler) => store.get(type)?.delete(handler);
const dispatch = (store, type, event = {}) => [...(store.get(type) || [])].forEach(handler => handler(event));

let localExam = { id: 'exam-1', status: 'ready' };
const sync = {
  connected: true,
  remoteStatus: 'ready',
  statusFetches: 0,
  fullRefreshes: 0,
  isRealtimeConnected() { return this.connected; },
  async fetchExamStatus() { this.statusFetches += 1; return this.remoteStatus; },
  async refreshExam() { this.fullRefreshes += 1; localExam = { ...localExam, status: this.remoteStatus }; },
  async refreshSessions() {},
};

const sandbox = {
  clearInterval,
  clearTimeout: fakeClearTimeout,
  setInterval,
  setTimeout: fakeSetTimeout,
  console: { ...console, warn() {}, error() {} },
  CustomEvent: class CustomEvent {},
  Date,
  document: {
    hidden: false,
    addEventListener: addListener(documentListeners),
    removeEventListener: removeListener(documentListeners),
    getElementById: () => null,
  },
  window: {
    SupabaseSync: sync,
    addEventListener: addListener(windowListeners),
    removeEventListener: removeListener(windowListeners),
  },
  Auth: { getStudentSession: () => ({ studentId: 'S1' }) },
};
sandbox.DB = {
  getExam: () => localExam,
  getStudentSession: () => null,
};

vm.runInNewContext(source, sandbox, { filename: 'public/js/exam.js' });
const app = sandbox.window.ExamApp;

let started = 0;
let returned = 0;
let absent = 0;
let markedAbsent = false;
Object.assign(app, {
  _stopSessionSyncPolling() {},
  _preloadYoloObjectModel() {},
  _getPortalStudent: () => ({ studentId: 'S1' }),
  _isStudentAbsentForExam: () => markedAbsent,
  _showMarkedAbsentState() { absent += 1; },
  _startExamFlow() { started += 1; },
  returnToLogin() { returned += 1; },
});

function startWaiting() {
  timers.clear();
  sync.statusFetches = 0;
  sync.fullRefreshes = 0;
  app.exam = localExam;
  app.startWaitingPoll();
}

(async () => {
  // With realtime connected the fallback probe waits 30 s, not 3 s.
  startWaiting();
  assert.deepEqual(pendingDelays(), [30000]);
  assert.equal(sync.statusFetches, 0, 'Nothing is queried on entry; the exam row is already fresh.');

  // One probe is one tiny status query. Without a status change it does not
  // re-pull the exam row or sessions.
  await fireTimers();
  assert.equal(sync.statusFetches, 1);
  assert.equal(sync.fullRefreshes, 0);
  assert.deepEqual(pendingDelays(), [30000]);

  // With the socket down it falls back to a quick probe.
  sync.connected = false;
  await fireTimers();
  assert.deepEqual(pendingDelays(), [5000]);
  sync.connected = true;

  // The realtime push that starts the exam is acted on immediately, without a
  // query, and the poll and its listeners are torn down.
  const fetchesBefore = sync.statusFetches;
  localExam = { ...localExam, status: 'active' };
  dispatch(documentListeners, 'acsDataChanged', { detail: { table: 'exams' } });
  assert.equal(started, 1);
  assert.equal(sync.statusFetches, fetchesBefore);
  assert.equal(timers.size, 0);
  assert.equal(app._waitingPoll, null);
  assert.equal(documentListeners.get('visibilitychange')?.size || 0, 0);
  assert.equal(windowListeners.get('online')?.size || 0, 0);
  // Later pushes no longer reach the stopped waiting room.
  dispatch(documentListeners, 'acsDataChanged', { detail: { table: 'exams' } });
  assert.equal(started, 1);

  // A dropped socket: the probe sees the status change and starts the exam.
  localExam = { id: 'exam-1', status: 'ready' };
  sync.remoteStatus = 'active';
  startWaiting();
  await fireTimers();
  assert.equal(sync.fullRefreshes, 1, 'A changed status pulls the full row once.');
  assert.equal(started, 2);
  assert.equal(timers.size, 0);
  sync.remoteStatus = 'ready';

  // A hidden tab does not query; it probes as soon as it is shown again.
  localExam = { id: 'exam-1', status: 'ready' };
  startWaiting();
  sandbox.document.hidden = true;
  await fireTimers();
  assert.equal(sync.statusFetches, 0);
  assert.deepEqual(pendingDelays(), [30000]);
  sandbox.document.hidden = false;
  dispatch(documentListeners, 'visibilitychange');
  await flush();
  assert.equal(sync.statusFetches, 1);
  assert.deepEqual(pendingDelays(), [30000], 'Showing the tab replaces the pending probe instead of adding one.');

  // Reconnecting to the network probes immediately.
  dispatch(windowListeners, 'online');
  await flush();
  assert.equal(sync.statusFetches, 2);

  // Attendance and sessions are still re-pulled, but every two minutes.
  const realNow = Date.now;
  let clock = realNow();
  sandbox.Date.now = () => clock;
  try {
    startWaiting();
    clock += 60000;
    await fireTimers();
    assert.equal(sync.fullRefreshes, 0);
    clock += 61000;
    await fireTimers();
    assert.equal(sync.fullRefreshes, 1);
  } finally {
    sandbox.Date.now = realNow;
  }

  // Being marked absent, or the exam closing, still leave the waiting room.
  markedAbsent = true;
  dispatch(documentListeners, 'acsDataChanged', { detail: { table: 'students' } });
  assert.equal(absent, 1);
  assert.equal(app._waitingPoll, null);
  markedAbsent = false;

  localExam = { id: 'exam-1', status: 'ready' };
  startWaiting();
  localExam = { ...localExam, status: 'closed' };
  dispatch(documentListeners, 'acsDataChanged', { detail: { table: 'exams' } });
  assert.equal(returned, 1);

  // Unrelated tables do not trigger a check.
  localExam = { id: 'exam-1', status: 'ready' };
  startWaiting();
  localExam = { ...localExam, status: 'active' };
  dispatch(documentListeners, 'acsDataChanged', { detail: { table: 'messages' } });
  assert.equal(started, 2);
  app.stopPoll();

  console.log('Waiting room realtime-first polling tests passed.');
})().catch(error => {
  console.error(error);
  process.exit(1);
});

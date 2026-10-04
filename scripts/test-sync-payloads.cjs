const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const cache = new Map();
let role = { student: { studentId: 'student-1' }, admin: null, sysadmin: null };
const window = {
  DB: { _read: key => cache.get(key), _write: (key, value) => cache.set(key, value) },
  Auth: {
    getStudentSession: () => role.student,
    getAdminSession: () => role.admin,
    getSysAdminSession: () => role.sysadmin,
  },
};
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/js/supabase-sync.js'), 'utf8'), { window });
const sync = window.SupabaseSync;
const image = 'data:image/jpeg;base64,' + 'a'.repeat(100000);
let sessions = [
  { id: 's1', exam_id: 'e1', student_id: 'student-1', owner_admin_id: 'prof-1', start_time: '2026-10-01', submitted: true, warnings: 3, answers: { q1: 'A' }, activities: [{ type: 'tab_switch' }], camera_snapshots: [{ imageData: image }], attempt_history: [{ answers: { old: 'B' }, cameraSnapshots: [{ imageData: image }] }] },
  { id: 's2', exam_id: 'e2', student_id: 'student-1', owner_admin_id: 'prof-1', answers: {} },
  { id: 'other', exam_id: 'e1', student_id: 'student-2', owner_admin_id: 'prof-2', answers: {} },
];
const exams = [{ id: 'e1', subject_id: 'course-1', owner_admin_id: 'prof-1', title: 'Exam', status: 'ready', questions: [{ id: 'q1', text: 'a'.repeat(10000) }], exam_sections: [{ id: 'section' }], exam_policies: ['No copying'] }];
const requests = [];
let failure = null;
sync._client = { from(table) {
  let columns = '*';
  const filters = [];
  const builder = {
    select(value) { columns = value; return this; },
    eq(key, value) { filters.push([key, value]); return this; },
    in(key, values) { filters.push([key, values]); return this; },
    maybeSingle() { this.single = true; return this; },
    then(resolve, reject) {
      requests.push({ table, columns, filters });
      const rows = (table === 'sessions' ? sessions : exams).filter(row => filters.every(([key, value]) => Array.isArray(value) ? value.includes(row[key]) : row[key] === value));
      const projected = rows.map(row => columns === '*' ? { ...row } : Object.fromEntries(columns.split(',').map(column => column.trim()).filter(column => column in row).map(column => [column, row[column]])));
      return Promise.resolve({ data: failure ? null : this.single ? projected[0] : projected, error: failure }).then(resolve, reject);
    },
  };
  return builder;
} };

(async () => {
  cache.set('acs_students', [{ studentId: 'student-1', enrolledSubjects: ['course-1'] }]);
  await Promise.all([sync.refreshSessions(), sync.refreshSessions()]);
  assert.equal(requests.length, 1, 'overlapping refreshes share one network request');
  const summary = cache.get('acs_sessions');
  assert.equal(summary.length, 2, 'students fetch only their own sessions');
  assert.equal(summary[0].detailsLoaded, false);
  assert.ok(!requests[0].columns.includes('camera_snapshots'));
  assert.ok(!requests[0].columns.includes('attempt_history'));
  assert.ok(JSON.stringify(summary).length < JSON.stringify(sessions).length / 10, 'summary payload is substantially smaller');
  assert.ok(!('answers' in sync._jsToDbSession(summary[0])), 'writing an unloaded summary cannot erase saved answers');
  assert.ok(!('camera_snapshots' in sync._jsToDbSession(summary[0])));

  await sync.refreshExams();
  const examSummary = cache.get('acs_exams')[0];
  assert.equal(examSummary.detailsLoaded, false);
  assert.ok(!('questions' in sync._jsToDbExam(examSummary)), 'summary saves cannot erase questions');
  await sync.refreshExam('e1', { requireDetails: true });
  await sync.refreshSessionDetails('e1');
  const detailed = cache.get('acs_sessions').find(row => row.id === 's1');
  assert.equal(detailed.answers.q1, 'A');
  assert.equal(detailed.cameraSnapshots[0].imageData, image);
  assert.equal(detailed.attemptHistory.length, 1);
  assert.ok(cache.get('acs_sessions').some(row => row.id === 's2'), 'selected-exam hydration preserves other exams');

  sessions[0] = { ...sessions[0], warnings: 1 };
  await sync.refreshSessions();
  const refreshed = cache.get('acs_sessions')[0];
  assert.equal(refreshed.warnings, 1, 'a professor warning deduction is authoritative');
  assert.equal(refreshed.answers.q1, 'A', 'partial polls preserve answers');
  assert.equal(refreshed.cameraSnapshots[0].imageData, image, 'partial polls preserve evidence');
  await sync.refreshExams();
  assert.equal(cache.get('acs_exams')[0].questions[0].id, 'q1', 'exam summaries preserve loaded questions');
  assert.equal(cache.get('acs_exams')[0].examSections.length, 1);

  sessions[0] = { ...sessions[0], submitted: false, start_time: null, end_time: null, warnings: 0, score: null, answers: {}, activities: [], camera_snapshots: [], attempt_history: [{ answers: { q1: 'A' } }] };
  await sync.refreshSessionDetails('e1');
  const reset = cache.get('acs_sessions').find(row => row.id === 's1');
  assert.equal(Object.keys(reset.answers).length, 0, 'explicit retake reset clears prior answers');
  assert.equal(reset.cameraSnapshots.length, 0, 'explicit retake reset clears current evidence');
  assert.equal(reset.attemptHistory[0].answers.q1, 'A', 'retake archive survives hydration');

  failure = new Error('offline');
  await assert.rejects(sync.refreshSessionDetails('e1'), /offline/);
  await assert.rejects(sync.refreshExam('e1', { requireDetails: true }), /offline/);
  failure = null;
  await sync.refreshSessionDetails('e1');

  role = { student: null, admin: { id: 'prof-1' }, sysadmin: null };
  await sync.refreshSessions({ examId: 'e1', summary: true });
  assert.equal(requests.at(-1).filters.find(([key]) => key === 'exam_id')[1], 'e1');
  assert.equal(requests.at(-1).filters.find(([key]) => key === 'owner_admin_id')[1], 'prof-1');
  assert.ok(!requests.at(-1).columns.includes('camera_snapshots'));
  assert.ok(cache.get('acs_sessions').some(row => row.id === 's2'));
  await sync.refreshSessions({ examId: 'e1', report: true });
  assert.ok(requests.at(-1).columns.includes('answers'), 'reports still load answers for grading');
  assert.ok(requests.at(-1).columns.includes('attempt_history'), 'reports retain retake auditing');
  assert.ok(!requests.at(-1).columns.includes('camera_snapshots'), 'report polling does not download current camera images');

  // Exercise the real entry flow: summaries must hydrate before results/resume,
  // and an unavailable detailed read must never launch an empty attempt.
  role = { student: { studentId: 'student-1' }, admin: null, sysadmin: null };
  sessions[0] = { ...sessions[0], submitted: true, answers: { q1: 'saved-answer' } };
  const examSource = fs.readFileSync(path.join(__dirname, '../public/js/exam.js'), 'utf8');
  const start = examSource.indexOf('  async _startExamFlow(studentSession) {');
  const end = examSource.indexOf('\n  },', start) + 5;
  const flowContext = { window, DB: {
    getExam: id => cache.get('acs_exams').find(exam => exam.id === id),
    getStudentSession: examId => cache.get('acs_sessions').find(session => session.examId === examId),
  }, clearInterval, sessionStorage: { setItem() {} } };
  vm.runInNewContext(`this.app = { ${examSource.slice(start, end)} };`, flowContext);
  const app = flowContext.app;
  Object.assign(app, {
    _resolveExamFromSession: () => flowContext.DB.getExam('e1'),
    _consumePendingRefreshAutoSubmit: () => null,
    _getPortalStudent: () => ({ id: 'student-1' }),
    _examForStudent: exam => exam,
    _preloadYoloObjectModel() {},
    _showSubmitted() { this.resultShown = true; },
    _showError(message) { this.error = message; },
  });
  sync.refreshStudents = async () => {};
  sync.refreshSubjects = async () => {};
  await app._startExamFlow(role.student);
  assert.equal(app.resultShown, true);
  assert.equal(app.session.answers.q1, 'saved-answer');
  assert.equal(app.exam.questions[0].id, 'q1');
  app.resultShown = false;
  failure = new Error('offline');
  await app._startExamFlow(role.student);
  assert.equal(app.resultShown, false);
  assert.match(app.error, /Unable to load/);
  console.log('Sync payload tests passed: scoping, smaller payloads, shared requests, lazy details, reset preservation and failed-read recovery.');
})().catch(error => { console.error(error); process.exitCode = 1; });

// Report filters must narrow the table AND every export. A filter that only
// affects what is on screen would hand the professor a report that silently
// disagrees with it.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const admin = fs.readFileSync(path.join(root, 'public', 'js', 'admin.js'), 'utf8');

// Pull the filter block out and run it against stubbed helpers.
const start = admin.indexOf('const reportFilters = {');
const end = admin.indexOf('function getReportYearSectionOptions');
assert.ok(start >= 0 && end > start, 'report filter block must exist');
const source = admin.slice(start, end);

const sandbox = {
  window: {},
  document: { getElementById: () => null },
  DB: { getSessionsByExam: () => [] },
  escHtml: v => String(v),
  renderReportTable() {},
  getStudentYearSectionSummary: (rec) => rec.yearSection || '',
  getEffectiveSessionWarningCount: (s) => s.warnings || 0,
  getSubmissionStatusText: (s) => {
    if (!s.submitted) return 'Pending';
    if (!s.autoSubmitted) return 'Submitted';
    if (s.submitReason === 'force_submit') return 'Force-Submitted (Professor)';
    return 'Auto-Submitted (Warnings)';
  },
};
vm.runInNewContext(`${source}
this.filterReportSessions = filterReportSessions;
this.filterReportAbsentStudents = filterReportAbsentStudents;
this.setFilter = (k, v) => { reportFilters[k] = v; };
this.resetFilters = () => { reportFilters.search = ''; reportFilters.yearSection = ''; reportFilters.status = ''; reportFilters.warnings = ''; };
this.isReportFilterActive = isReportFilterActive;
`, sandbox);

const { filterReportSessions, filterReportAbsentStudents, setFilter, resetFilters } = sandbox;

const sessions = [
  { studentName: 'John Daniel Cabusas', studentId: '23-00218', yearSection: '3rd Year / B', submitted: true, autoSubmitted: true, submitReason: 'violations', warnings: 3 },
  { studentName: 'Hermoso, Lyriko Jewel D.', studentId: '23-00181', yearSection: '3rd Year / B', submitted: true, autoSubmitted: true, submitReason: 'timeout', warnings: 0 },
  { studentName: 'Ana Reyes', studentId: '23-00500', yearSection: '2nd Year / A', submitted: true, autoSubmitted: false, warnings: 0 },
  { studentName: 'Mark Cruz', studentId: '23-00777', yearSection: '2nd Year / A', submitted: true, autoSubmitted: true, submitReason: 'force_submit', warnings: 1 },
];
const absentees = [
  { studentName: 'Absent Student', studentId: '23-00999', yearSection: '3rd Year / B' },
];

const names = list => list.map(s => s.studentId).sort();

// No filters: everything passes through.
resetFilters();
assert.equal(filterReportSessions(sessions).length, 4);
assert.equal(filterReportAbsentStudents(absentees).length, 1);
assert.equal(sandbox.isReportFilterActive(), false);

// Search matches name or student ID, case-insensitively.
resetFilters();
setFilter('search', 'lyriko');
assert.deepEqual(names(filterReportSessions(sessions)), ['23-00181']);
resetFilters();
setFilter('search', '23-00777');
assert.deepEqual(names(filterReportSessions(sessions)), ['23-00777']);
resetFilters();
setFilter('search', 'CABUSAS');
assert.deepEqual(names(filterReportSessions(sessions)), ['23-00218'], 'search is case-insensitive');

// Section filter covers submitted rows and absentees alike.
resetFilters();
setFilter('yearSection', '2nd Year / A');
assert.deepEqual(names(filterReportSessions(sessions)), ['23-00500', '23-00777']);
assert.equal(filterReportAbsentStudents(absentees).length, 0, 'a 3rd-year absentee is out of a 2nd-year view');

resetFilters();
setFilter('yearSection', '3rd Year / B');
assert.equal(filterReportAbsentStudents(absentees).length, 1);

// Status filter.
resetFilters();
setFilter('status', 'submitted');
assert.deepEqual(names(filterReportSessions(sessions)), ['23-00500']);
resetFilters();
setFilter('status', 'auto');
assert.deepEqual(names(filterReportSessions(sessions)), ['23-00181', '23-00218']);
resetFilters();
setFilter('status', 'force');
assert.deepEqual(names(filterReportSessions(sessions)), ['23-00777']);

// "Absent only" is a row type, so no submitted session may satisfy it.
resetFilters();
setFilter('status', 'absent');
assert.equal(filterReportSessions(sessions).length, 0, 'absent-only hides every submission');
assert.equal(filterReportAbsentStudents(absentees).length, 1, 'absent-only keeps absentees');

// Any other status filter hides absentees, since they never submitted.
resetFilters();
setFilter('status', 'submitted');
assert.equal(filterReportAbsentStudents(absentees).length, 0);

// Warning filters.
resetFilters();
setFilter('warnings', 'any');
assert.deepEqual(names(filterReportSessions(sessions)), ['23-00218', '23-00777']);
assert.equal(filterReportAbsentStudents(absentees).length, 0, 'an absentee has no warnings to have');
resetFilters();
setFilter('warnings', 'none');
assert.deepEqual(names(filterReportSessions(sessions)), ['23-00181', '23-00500']);
assert.equal(filterReportAbsentStudents(absentees).length, 1, 'no-warnings keeps absentees');

// Filters combine rather than replace each other.
resetFilters();
setFilter('yearSection', '3rd Year / B');
setFilter('warnings', 'any');
assert.deepEqual(names(filterReportSessions(sessions)), ['23-00218']);

// ── The export path must read the same filters ─────────────────────────────
const modelStart = admin.indexOf('function buildExamReportModel');
const modelEnd = admin.indexOf('\n}\n', modelStart);
const modelFn = admin.slice(modelStart, modelEnd);
assert.match(modelFn, /filterReportSessions\(/, 'the export model must filter submitted rows');
assert.match(modelFn, /filterReportAbsentStudents\(/, 'the export model must filter absentees');

// All three exporters build on that model, so none of them can bypass it.
for (const fn of ['exportExamReportPdf', 'exportExamReportWord', 'exportExamReportExcel']) {
  const i = admin.indexOf(`function ${fn}`);
  assert.ok(i >= 0, `${fn} must exist`);
  const body = admin.slice(i, admin.indexOf('\n}\n', i));
  assert.match(body, /buildExamReportModel\(examId\)/, `${fn} must use the shared filtered model`);
}

console.log('Report filter and filtered-export tests passed.');

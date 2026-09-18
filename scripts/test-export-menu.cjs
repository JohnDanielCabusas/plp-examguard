// The Export menu crosses a scope (results / answers / both) with a format, and
// every path must respect the table's filters and tick-selection. A path that
// quietly exported everything would hand out other students' answers.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const admin = fs.readFileSync(path.join(root, 'public', 'js', 'admin.js'), 'utf8');
const jsx = fs.readFileSync(path.join(root, 'src', 'pages', 'AdminPage.jsx'), 'utf8');
const css = fs.readFileSync(path.join(root, 'public', 'css', 'style.css'), 'utf8');

// ── Selection narrows the export, and an empty selection means "all in view" ──
const selSrc = admin.slice(
  admin.indexOf('const reportSelectedIds = new Set()'),
  admin.indexOf('function syncReportSelectionUI'),
);
const rows = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
const box = { getOrderedSubmittedReportSessions: () => rows };
vm.runInNewContext(`${selSrc}
this.getSelectedReportSessions = getSelectedReportSessions;
this.reportSelectedIds = reportSelectedIds;
`, box);

assert.deepEqual(
  box.getSelectedReportSessions('e1').map(r => r.id), ['a', 'b', 'c'],
  'no ticks means the whole filtered view',
);
box.reportSelectedIds.add('b');
assert.deepEqual(
  box.getSelectedReportSessions('e1').map(r => r.id), ['b'],
  'ticking narrows the export to that student',
);
box.reportSelectedIds.add('zzz');
assert.deepEqual(
  box.getSelectedReportSessions('e1').map(r => r.id), ['b'],
  'a selected row that the filters removed must not come back',
);
box.reportSelectedIds.clear();
assert.equal(box.getSelectedReportSessions('e1').length, 3);

// ── Dispatch covers all nine scope x format combinations ────────────────────
const dispatch = admin.slice(
  admin.indexOf('async function runReportExport'),
  admin.indexOf('window.runReportExport'),
);
for (const fn of ['exportExamReportWord', 'exportExamReportExcel', 'exportExamReportPdf']) {
  assert.ok(dispatch.includes(fn), `results scope must reuse ${fn}`);
}
assert.match(dispatch, /getAnswerSheetSessions\(\)/, 'answer scopes must resolve the selected sessions');
assert.match(dispatch, /appendAnswersSheet\(/, 'excel answers must add an Answers sheet');
assert.match(dispatch, /exportAnswerSheetsPdf\(/, 'pdf answers must download a real file, not open a print dialog');
assert.match(dispatch, /buildReportDocumentBody\(resultsModel\)/, '"both" must include the results body');

// The answer paths must go through the filtered/selected set, never the raw list.
const sheetSessions = admin.slice(
  admin.indexOf('function getAnswerSheetSessions'),
  admin.indexOf('function buildAnswerSheetsBody'),
);
assert.match(sheetSessions, /getSelectedReportSessions\(examId\)/,
  'answer sheets must honour the filters and the tick-selection');
assert.doesNotMatch(sheetSessions, /DB\.getSessionsByExam/,
  'answer sheets must not bypass the filters by reading sessions directly');

// ── Results and answers share one source of truth for scoring ───────────────
const excelRows = admin.slice(
  admin.indexOf('function buildAnswerExcelRows'),
  admin.indexOf('async function appendAnswersSheet'),
);
assert.match(excelRows, /calculateSessionScoreBreakdown\(exam, session\)/);
assert.match(excelRows, /getAnswerSheetVerdict\(/,
  'the Excel grid must take verdicts from the same helper as the printed sheet');
assert.match(excelRows, /getStudentAnswerDisplay\(/);
assert.match(excelRows, /getCorrectAnswerDisplay\(/);

// ── Format first, then scope for Word and PDF only ──────────────────────────
for (const fmt of ['word', 'pdf', 'excel']) {
  assert.ok(jsx.includes(`window.chooseExportFormat('${fmt}')`), `the fan must offer ${fmt}`);
}
for (const scope of ['results', 'answers', 'both']) {
  assert.ok(jsx.includes(`window.runChosenExport('${scope}')`), `the scope step must offer ${scope}`);
}

const chooser = admin.slice(
  admin.indexOf('function chooseExportFormat'),
  admin.indexOf('window.chooseExportFormat'),
);
assert.match(chooser, /format === 'excel'/, 'Excel must be handled without a scope step');
assert.match(chooser, /runReportExport\('excel', 'results'\)/,
  'Excel goes straight to the results workbook');
assert.match(chooser, /is-choosing/, 'Word and PDF must open the scope popover');

// The fan must stay expanded while the scope popover is open, or the cards
// would collapse out from under the pointer.
assert.match(css, /\.export-fan\.is-choosing \.export-fan-card/,
  'the fan stays expanded while choosing a scope');
assert.ok(jsx.includes('id="report-select-all"'), 'the table needs a select-all checkbox');
assert.ok(admin.includes('window.toggleReportRowSelection'), 'rows need a selection handler');
assert.ok(admin.includes('window.toggleReportSelectAll'), 'select-all needs a handler');

// The intermediate plain-button menu must be fully gone from the styles.
assert.ok(!css.includes('export-menu-trigger'), 'the replaced plain export menu must not linger in the styles');
assert.ok(!css.includes('export-menu-panel'), 'the replaced plain export panel must not linger in the styles');

// renderReportTable must not reference controls the export UI no longer has —
// a stale getElementById here threw and aborted the whole Reports render.
const renderFn = admin.slice(
  admin.indexOf('function renderReportTable'),
  admin.indexOf('function generatePDF'),
);
for (const id of ['btn-generate-pdf', 'btn-generate-word', 'btn-generate-excel']) {
  assert.ok(!renderFn.includes(id), `renderReportTable must not reference the removed ${id}`);
}

console.log('Export menu and row-selection tests passed.');

// The answer sheet prints a student's answers next to the key, so each question
// type has to be read back in the same shape the grader uses. A wrong reading
// here means a printed sheet that disagrees with the recorded score.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const admin = fs.readFileSync(path.join(root, 'public', 'js', 'admin.js'), 'utf8');

const start = admin.indexOf('function formatAnswerSheetValue');
const end = admin.indexOf('function buildAnswerSheetHtml');
assert.ok(start >= 0 && end > start, 'answer sheet helpers must exist');

const sandbox = {
  escHtml: v => String(v),
  getIdentificationAcceptedAnswers: q => q.acceptedAnswers || [q.correctAnswer].filter(Boolean),
};
vm.runInNewContext(`${admin.slice(start, end)}
this.getStudentAnswerDisplay = getStudentAnswerDisplay;
this.getCorrectAnswerDisplay = getCorrectAnswerDisplay;
this.formatAnswerSheetValue = formatAnswerSheetValue;
`, sandbox);
const { getStudentAnswerDisplay, getCorrectAnswerDisplay, formatAnswerSheetValue } = sandbox;

// ── Multiple choice ────────────────────────────────────────────────────────
const mcq = { type: 'mcq', options: ['Alpha', 'Beta', 'Gamma'], correctAnswer: 'Beta' };
assert.equal(getStudentAnswerDisplay(mcq, 'Gamma'), 'Gamma');
assert.equal(getCorrectAnswerDisplay(mcq), 'Beta');

// ── True / false ───────────────────────────────────────────────────────────
const tf = { type: 'tf', correctAnswer: 'True' };
assert.equal(getStudentAnswerDisplay(tf, 'False'), 'False');
assert.equal(getCorrectAnswerDisplay(tf), 'True');

// ── Checkbox: indices resolve to lettered option text ──────────────────────
const checkbox = {
  type: 'checkbox',
  options: ['Red', 'Green', 'Blue', 'Yellow'],
  correctAnswerIndices: [0, 2],
};
assert.equal(getStudentAnswerDisplay(checkbox, JSON.stringify([1, 2])), 'B. Green; C. Blue');
assert.equal(getCorrectAnswerDisplay(checkbox), 'A. Red; C. Blue');
assert.equal(getStudentAnswerDisplay(checkbox, '[]'), '', 'an empty selection is no answer');
assert.equal(getStudentAnswerDisplay(checkbox, 'not json'), '', 'corrupt stored answers must not throw');

// ── Matching: term → chosen match, keyed by pair index ─────────────────────
const matching = {
  type: 'matching',
  pairs: [{ term: 'CPU', match: 'Processor' }, { term: 'RAM', match: 'Memory' }],
};
assert.equal(
  getStudentAnswerDisplay(matching, JSON.stringify({ 0: 'Memory', 1: 'Memory' })),
  '1. CPU → Memory\n2. RAM → Memory',
);
assert.equal(getCorrectAnswerDisplay(matching), '1. CPU → Processor\n2. RAM → Memory');
assert.equal(
  getStudentAnswerDisplay(matching, JSON.stringify({ 0: 'Processor' })),
  '1. CPU → Processor\n2. RAM → —',
  'an unanswered pair is shown as a dash, not dropped',
);

// ── Enumeration: the key is the full expected list ─────────────────────────
const enumeration = { type: 'enumeration', answers: ['One', 'Two', 'Three'] };
assert.equal(getStudentAnswerDisplay(enumeration, 'One\nThree'), 'One\nThree');
assert.equal(getCorrectAnswerDisplay(enumeration), 'One\nTwo\nThree');

// ── Identification: every accepted spelling is shown ───────────────────────
const identification = {
  type: 'identification',
  correctAnswer: 'DNS Attack',
  acceptedAnswers: ['DNS Attack', 'DNS Replay Attack'],
};
assert.equal(getStudentAnswerDisplay(identification, ' dns attack '), ' dns attack ');
assert.equal(getCorrectAnswerDisplay(identification), 'DNS Attack / DNS Replay Attack');

// ── Essay has no key, so none is printed ───────────────────────────────────
assert.equal(getCorrectAnswerDisplay({ type: 'essay' }), '', 'an essay must not claim a correct answer');

// ── Coding falls back to the stored reference answer ───────────────────────
assert.equal(getCorrectAnswerDisplay({ type: 'coding', correctAnswer: 'SELECT *' }), 'SELECT *');

// ── Missing answers are called out rather than printed blank ───────────────
for (const empty of [null, undefined, '']) {
  assert.equal(getStudentAnswerDisplay(mcq, empty), '', 'no answer resolves to empty');
}
assert.match(formatAnswerSheetValue(''), /no answer/, 'a blank answer is labelled');
assert.equal(formatAnswerSheetValue('Beta'), 'Beta');

// ── The sheet must be reachable and use the shared grading helpers ─────────
const sheet = admin.slice(admin.indexOf('function buildAnswerSheetHtml'), admin.indexOf('const ANSWER_SHEET_STYLES'));
assert.match(sheet, /calculateSessionScoreBreakdown\(exam, session\)/,
  'the sheet must score with the same helper the Reports screen uses');
assert.match(sheet, /getSessionQuestionGrades\(session\)/,
  'professor overrides must be reflected on the sheet');
assert.match(sheet, /getAnswerSheetVerdict\(/,
  'the sheet must take its verdict from the shared helper');

// The verdict helper is what both the printable sheet and the Excel grid read,
// so exercise it directly rather than trusting either caller.
const verdictSrc = admin.slice(
  admin.indexOf('function getAnswerSheetVerdict'),
  admin.indexOf('function buildAnswerSheetHtml'),
);
const vbox = {};
vm.runInNewContext(`${verdictSrc}
this.getAnswerSheetVerdict = getAnswerSheetVerdict;`, vbox);
const verdictOf = (q, raw, earned, graded) => vbox.getAnswerSheetVerdict(q, raw, earned, graded).label;

assert.equal(verdictOf({ type: 'essay', points: 3 }, 'some prose', 0, false), 'Pending review',
  'an ungraded essay must read as pending, never as wrong');
assert.equal(verdictOf({ type: 'essay', points: 3 }, 'some prose', 3, true), 'Correct',
  'a graded essay takes the professor score');
assert.equal(verdictOf({ type: 'mcq', points: 0 }, 'A', 0, false), 'Not scored',
  'a zero-point question must not be reported as incorrect');
assert.equal(verdictOf({ type: 'mcq', points: 2 }, '', 0, false), 'No answer');
assert.equal(verdictOf({ type: 'mcq', points: 2 }, 'A', 2, false), 'Correct');
assert.equal(verdictOf({ type: 'mcq', points: 2 }, 'A', 0, false), 'Incorrect');
assert.equal(verdictOf({ type: 'enumeration', points: 3 }, 'One', 1, false), 'Partial credit');

// The per-student modal buttons were replaced by the Reports Export control.
assert.ok(admin.includes('window.runReportExport = runReportExport'),
  'the export dispatcher must be exposed');

// ── The PDF sheet must actually draw, not open a print dialog ───────────────
// A stand-in jsPDF document records what gets drawn, so the layout code is
// exercised for every question type without needing a browser.
const pdfSrc = admin.slice(
  admin.indexOf('const ANSWER_PDF_TONES'),
  admin.indexOf('async function exportAnswerSheetsPdf'),
);

const drawn = { pages: 1, text: [] };
const fakeDoc = {
  internal: {
    pageSize: { getWidth: () => 210, getHeight: () => 297 },
    getCurrentPageInfo: () => ({ pageNumber: drawn.pages }),
  },
  addPage() { drawn.pages += 1; },
  setFont() {}, setFontSize() {}, setTextColor() {}, setDrawColor() {}, setLineWidth() {}, line() {},
  text(t) { drawn.text.push(...(Array.isArray(t) ? t : [t])); },
  splitTextToSize: (t, w) => String(t).match(new RegExp(`.{1,${Math.max(20, Math.floor(w * 2))}}`, 'g')) || [''],
};

const pdfBox = {
  console,
  calculateSessionScoreBreakdown: () => ({ earned: 2, max: 7, byQuestion: { q1: 2, q2: 0, q3: 0, q4: 0 } }),
  getSessionQuestionGrades: () => ({}),
  getStudentYearSectionSummary: () => '3rd Year / B',
  getSubmissionStatusText: () => 'Auto-Submitted (Time Limit)',
  formatPointsValue: v => String(v),
  drawPdfPageHeader: () => 30,
  drawPdfPageFooter: () => {},
  getAnswerSheetVerdict: (q, raw, earned) => ({ label: earned > 0 ? 'Correct' : 'Incorrect', cls: earned > 0 ? 'as-correct' : 'as-wrong' }),
  getStudentAnswerDisplay,
  getCorrectAnswerDisplay,
};
vm.runInNewContext(`${pdfSrc}
this.drawAnswerSheetsIntoPdf = drawAnswerSheetsIntoPdf;`, pdfBox);

const pdfExam = {
  title: 'Midterm Examination',
  questions: [
    { id: 'q1', type: 'mcq', points: 2, content: 'Which layer handles routing?', options: ['Application', 'Network'], correctAnswer: 'Network' },
    { id: 'q2', type: 'identification', points: 2, content: 'Name the replay attack.', correctAnswer: 'DNS Replay Attack', acceptedAnswers: ['DNS Replay Attack'] },
    { id: 'q3', type: 'essay', points: 3, content: 'Explain microservices.' },
    { id: 'q4', type: 'checkbox', points: 2, content: 'Pick the valid addresses.', options: ['10.0.0.1', '999.1.1.1'], correctAnswerIndices: [0] },
  ],
};
const pdfSessions = [
  { id: 'a', studentName: 'Cabusas, John Daniel', studentId: '23-00218', warnings: 3, answers: { q1: 'Network', q2: '', q3: 'Prose.', q4: '[0]' } },
  { id: 'b', studentName: 'Hermoso, Lyriko', studentId: '23-00181', warnings: 0, answers: {} },
];

pdfBox.drawAnswerSheetsIntoPdf(fakeDoc, pdfExam, pdfSessions, { schoolName: 'PLP' }, null);

assert.equal(drawn.pages, 2, 'each student starts on a fresh page');
const joined = drawn.text.join(' | ');
assert.match(joined, /Examination Answer Sheet/, 'the sheet is titled');
assert.match(joined, /23-00218/, 'the student is identified');
assert.match(joined, /Total score/, 'the total is printed');
assert.match(joined, /your answer/, 'the chosen option is marked');
assert.match(joined, /correct/, 'the key is marked');
assert.match(joined, /no answer/, 'a blank answer is called out rather than left empty');
assert.match(joined, /CORRECT|INCORRECT/, 'each question carries a verdict');

// Nothing may route PDF through the browser print dialog any more.
assert.ok(!admin.includes('printHtmlDocument'), 'the PDF print-dialog path must be gone');
assert.ok(!admin.includes('printStudentAnswerSheet'), 'the per-student print helper must be gone');
const dispatchSrc = admin.slice(admin.indexOf('async function runReportExport'), admin.indexOf('window.runReportExport'));
assert.match(dispatchSrc, /exportAnswerSheetsPdf\(/, 'PDF must download a real file');

console.log('Student answer sheet tests passed.');

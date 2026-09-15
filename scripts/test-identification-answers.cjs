const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const adminSource = fs.readFileSync(path.join(root, 'public', 'js', 'admin.js'), 'utf8');

function sourceBetween(startMarker, endMarker) {
  const start = adminSource.indexOf(startMarker);
  const end = adminSource.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(start, -1, `Missing production function: ${startMarker}`);
  assert.notEqual(end, -1, `Missing production boundary: ${endMarker}`);
  return adminSource.slice(start, end);
}

// Exercise the exact professor-side production helpers without bootstrapping
// the complete browser UI.
const productionScoringSource = [
  sourceBetween('function getIdentificationAcceptedAnswers', 'function getQuestionDuplicateKey'),
  sourceBetween('function normalizeEssayGradeValue', 'function buildQuestionReviewControlHtml'),
  sourceBetween('function buildQuestionReviewControlHtml', 'function setQuestionCorrectOverride'),
  sourceBetween('function setQuestionCorrectOverride', 'function renderStudentAnswersFooter'),
  sourceBetween('function saveQuestionReviewGrades', '// Full per-question, per-choice answer breakdown'),
  sourceBetween('function scoreQuestionEarned', 'function computeQuestionPValue'),
].join('\n');

const context = { escHtml: value => String(value) };
vm.runInNewContext(productionScoringSource, context, { filename: 'admin-identification-scoring.js' });

const question = {
  id: 'identification-variants',
  type: 'identification',
  points: 3,
  correctAnswer: 'WARNING',
  acceptedAnswers: ['WARNING', 'warning', 'warnings'],
};

for (const answer of ['WARNING', 'warning', 'Warnings', '  warnings  ']) {
  assert.equal(context.calculateEarnedPointsForQuestion(question, answer), 3, `${answer} must earn full points in reports and forced submissions.`);
  assert.equal(context.scoreQuestionEarned(question, answer), 3, `${answer} must earn full points in statistics.`);
}

for (const answer of ['', 'warn', 'warnings!', 'warning signs']) {
  assert.equal(context.calculateEarnedPointsForQuestion(question, answer), 0, `${answer || '(blank)'} must not be accepted.`);
  assert.equal(context.scoreQuestionEarned(question, answer), 0, `${answer || '(blank)'} must not be accepted in statistics.`);
}

const legacyQuestion = {
  id: 'legacy-identification',
  type: 'identification',
  points: 1,
  correctAnswer: 'Legacy Answer',
};
assert.equal(context.calculateEarnedPointsForQuestion(legacyQuestion, ' legacy answer '), 1);
assert.equal(context.scoreQuestionEarned(legacyQuestion, 'LEGACY ANSWER'), 1);

const acceptedAnswersOnlyQuestion = {
  id: 'accepted-answers-only',
  type: 'identification',
  points: 2,
  acceptedAnswers: ['primary', 'alternate'],
};
assert.equal(context.calculateEarnedPointsForQuestion(acceptedAnswersOnlyQuestion, 'alternate'), 2);
assert.equal(context.scoreQuestionEarned(acceptedAnswersOnlyQuestion, 'PRIMARY'), 2);

// Questions are persisted as JSON; ensure the new array survives a round trip.
const persistedQuestion = JSON.parse(JSON.stringify(question));
assert.deepEqual(persistedQuestion.acceptedAnswers, ['WARNING', 'warning', 'warnings']);
assert.equal(context.calculateEarnedPointsForQuestion(persistedQuestion, 'warnings'), 3);

// A professor override must take precedence over automatic grading for every
// supported category and must roll up into the saved student total.
const allTypesExam = {
  questions: [
    { id: 'mcq', type: 'mcq', points: 2, correctAnswer: 'A' },
    { id: 'checkbox', type: 'checkbox', points: 2, correctAnswerIndices: [0, 1] },
    { id: 'tf', type: 'tf', points: 2, correctAnswer: 'True' },
    { id: 'identification', type: 'identification', points: 2, acceptedAnswers: ['accepted'] },
    { id: 'enumeration', type: 'enumeration', points: 2, answers: ['one', 'two'] },
    { id: 'matching', type: 'matching', points: 2, pairs: [{ term: 'one', match: 'match' }] },
    { id: 'essay', type: 'essay', points: 2 },
    { id: 'coding', type: 'coding', points: 2, correctAnswer: '' },
  ],
};
const allWrongAnswers = {
  mcq: 'B',
  checkbox: '[0]',
  tf: 'False',
  identification: 'rejected',
  enumeration: 'wrong',
  matching: '{"0":"wrong"}',
  essay: 'Student essay',
  coding: 'Student code',
};
const fullCreditOverrides = Object.fromEntries(allTypesExam.questions.map(item => [item.id, item.points]));
const overriddenBreakdown = context.calculateSessionScoreBreakdown(allTypesExam, {
  answers: allWrongAnswers,
  essayGrades: fullCreditOverrides,
});
assert.equal(overriddenBreakdown.earned, 16);
assert.equal(overriddenBreakdown.max, 16);
for (const item of allTypesExam.questions) {
  assert.equal(overriddenBreakdown.byQuestion[item.id], 2, `${item.type} must honor the professor override.`);
  assert.equal(
    context.scoreQuestionEarned(item, allWrongAnswers[item.id], fullCreditOverrides),
    2,
    `${item.type} statistics must honor the professor override.`,
  );
}

const partialOverride = context.calculateSessionScoreBreakdown(allTypesExam, {
  answers: allWrongAnswers,
  essayGrades: { matching: 1.5 },
});
assert.equal(partialOverride.byQuestion.matching, 1.5);
assert.equal(partialOverride.earned, 1.5);

for (const item of allTypesExam.questions) {
  const control = context.buildQuestionReviewControlHtml(item, { id: 'session', answers: allWrongAnswers }, 'reports');
  assert.match(control, /Mark as correct/, `${item.type} must render the professor review control.`);
  assert.match(control, /type="hidden"/, `${item.type} must not render a manual score field.`);
  assert.doesNotMatch(control, /type="number"/, `${item.type} must use the points configured on the question.`);
  assert.match(control, new RegExp(`question-grade-input-session-${item.id}`));
}

const correctAnswerControl = context.buildQuestionReviewControlHtml(
  allTypesExam.questions[0],
  { id: 'session', answers: { mcq: 'A' } },
  'reports',
);
assert.match(correctAnswerControl, /Mark as wrong/, 'A correct answer must offer the opposite grading action.');
assert.match(correctAnswerControl, /data-override-points="0"/, 'Mark as wrong must override the configured question score to zero.');
assert.match(correctAnswerControl, /prof-review-mark-wrong/, 'The deducting action must use its warning treatment.');

const markedControl = context.buildQuestionReviewControlHtml(
  allTypesExam.questions[0],
  { id: 'session', answers: allWrongAnswers, essayGrades: { mcq: 2 } },
  'reports',
);
assert.match(markedControl, />Undo</, 'A saved correct override must always provide an Undo action.');
assert.match(markedControl, /question-grade-mark-session-mcq[^>]+display:none/, 'Mark as correct must be hidden while full credit is overridden.');

const toggleElements = {
  'question-grade-input-session-mcq': { value: '', dataset: { automaticPoints: '0', maxPoints: '2' } },
  'question-review-session-mcq': { classList: { toggle(_name, active) { this.active = active; } } },
  'question-grade-status-session-mcq': { textContent: '' },
  'question-grade-mark-session-mcq': { style: {} },
  'question-grade-undo-session-mcq': { style: {} },
};
context.document = { getElementById: id => toggleElements[id] || null };
context.setQuestionCorrectOverride('session', 'mcq', true);
assert.equal(toggleElements['question-grade-input-session-mcq'].value, '2');
assert.match(toggleElements['question-grade-status-session-mcq'].textContent, /Marked correct/);
assert.equal(toggleElements['question-grade-mark-session-mcq'].style.display, 'none');
assert.equal(toggleElements['question-grade-undo-session-mcq'].style.display, '');
context.setQuestionCorrectOverride('session', 'mcq', false);
assert.equal(toggleElements['question-grade-input-session-mcq'].value, '');
assert.match(toggleElements['question-grade-status-session-mcq'].textContent, /Automatic/);
assert.equal(toggleElements['question-grade-mark-session-mcq'].style.display, '');
assert.equal(toggleElements['question-grade-undo-session-mcq'].style.display, 'none');

const wrongOverrideElements = {
  'question-grade-input-session-mcq': { value: '', dataset: { automaticPoints: '2', maxPoints: '2', overridePoints: '0' } },
  'question-review-session-mcq': { classList: { toggle(_name, active) { this.active = active; } } },
  'question-grade-status-session-mcq': { textContent: '' },
  'question-grade-mark-session-mcq': { style: {} },
  'question-grade-undo-session-mcq': { style: {} },
};
context.document = { getElementById: id => wrongOverrideElements[id] || null };
context.setQuestionCorrectOverride('session', 'mcq', true);
assert.equal(wrongOverrideElements['question-grade-input-session-mcq'].value, '0');
assert.match(wrongOverrideElements['question-grade-status-session-mcq'].textContent, /Marked wrong/);
assert.equal(wrongOverrideElements['question-grade-mark-session-mcq'].style.display, 'none');
assert.equal(wrongOverrideElements['question-grade-undo-session-mcq'].style.display, '');

const deductedBreakdown = context.calculateSessionScoreBreakdown(
  { questions: [allTypesExam.questions[0]] },
  { answers: { mcq: 'A' }, essayGrades: { mcq: 0 } },
);
assert.equal(deductedBreakdown.earned, 0, 'Mark as wrong must deduct all points configured for the question.');
assert.equal(deductedBreakdown.max, 2);

let savedSessionUpdates = null;
const reviewInputs = Object.fromEntries(allTypesExam.questions.map(item => [
  `question-grade-input-session-${item.id}`,
  { value: String(item.points), focus() {} },
]));
const sessionForReview = { id: 'session', examId: 'exam', answers: allWrongAnswers, essayGrades: {} };
context.document = { getElementById: id => reviewInputs[id] || null };
context.DB = {
  getSession: () => sessionForReview,
  getExam: () => allTypesExam,
  updateSession: (_id, updates) => { savedSessionUpdates = updates; },
};
context.currentSection = 'reports';
context.renderReportTable = () => {};
context.renderExamStats = () => {};
context.showToast = () => {};
context.viewStudentAnswers = () => {};
context.saveQuestionReviewGrades('session');
assert.equal(savedSessionUpdates.score, 16);
assert.equal(savedSessionUpdates.maxScore, 16);
assert.deepEqual(
  JSON.parse(JSON.stringify(savedSessionUpdates.essayGrades)),
  fullCreditOverrides,
  'Saving the review must persist overrides for every question type.',
);

console.log('Identification and professor grading-override tests passed.');

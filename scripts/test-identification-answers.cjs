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
  sourceBetween('function calculateEarnedPointsForQuestion', 'function calculateSessionScoreBreakdown'),
  sourceBetween('function scoreQuestionEarned', 'function computeQuestionPValue'),
].join('\n');

const context = {};
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

console.log('Identification accepted-answer tests passed.');

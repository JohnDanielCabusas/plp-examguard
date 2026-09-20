const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'public', 'js', 'exam.js'), 'utf8');
const adminSource = fs.readFileSync(path.join(root, 'public', 'js', 'admin.js'), 'utf8');
const elements = new Map();

function element(id) {
  if (!elements.has(id)) {
    const classes = new Set();
    elements.set(id, {
      id,
      innerHTML: '',
      textContent: '',
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
      setAttribute() {},
    });
  }
  return elements.get(id);
}

const sandbox = {
  clearInterval,
  clearTimeout,
  console,
  CustomEvent: class CustomEvent {},
  document: {
    addEventListener() {},
    getElementById: element,
    querySelector(selector) {
      if (selector === '.examv2-nav-header') return element('examv2-nav-header');
      return null;
    },
  },
  setInterval,
  setTimeout,
  window: { addEventListener() {} },
};
sandbox.DB = {};

vm.runInNewContext(source, sandbox, { filename: 'public/js/exam.js' });
const app = sandbox.window.ExamApp;

assert.ok(adminSource.includes("oninput=\"updateExamSectionDescription("), 'professor description input should update the draft while typing');
assert.ok(adminSource.includes('examSections: cloneExamEditorData(draftExam?.examSections || [])'), 'saving an exam should persist its section descriptions');

app.exam = {
  examSections: [
    { id: 'truth', title: 'Foundations', description: 'Read each statement carefully before choosing.', type: 'tf' },
    { id: 'choice', title: 'Applied concepts', type: 'mcq' },
  ],
};
const questions = [
  { id: 'choice-1', type: 'mcq', sectionId: 'choice' },
  { id: 'choice-2', type: 'mcq', sectionId: 'choice' },
  { id: 'truth-1', type: 'tf', sectionId: 'truth' },
  { id: 'other-1', type: 'essay', sectionId: '' },
];

assert.deepEqual(
  [...app._orderQuestionsForAttempt(questions, false)].map(question => question.id),
  ['truth-1', 'choice-1', 'choice-2', 'other-1'],
  'section order must control the order seen by students',
);

app.shuffle = array => array.reverse();
assert.deepEqual(
  [...app._orderQuestionsForAttempt(questions, true)].map(question => question.id),
  ['truth-1', 'choice-2', 'choice-1', 'other-1'],
  'shuffle must randomize within a section without changing section order',
);

app.questionOrder = app._orderQuestionsForAttempt(questions, false);
app._updateNavGrid = () => {};
app._buildNavGrid();
const navHtml = element('question-nav-grid').innerHTML;
assert.ok(navHtml.includes('Foundations'), 'student navigation should show the first section title');
assert.ok(navHtml.includes('Applied concepts'), 'student navigation should show the second section title');
assert.ok(navHtml.includes('Read each statement carefully before choosing.'), 'student navigation should show the saved section description');
assert.ok(navHtml.indexOf('Foundations') < navHtml.indexOf('Applied concepts'), 'student navigation should preserve professor section order');
assert.ok(navHtml.includes('Other questions'), 'unsectioned questions should remain visible');

const renderedQuestion = app._renderQuestion({
  id: 'truth-1',
  type: 'tf',
  sectionId: 'truth',
  content: 'A section description is visible.',
  correctAnswer: 'True',
  points: 1,
  required: true,
}, 0);
assert.ok(!renderedQuestion.includes('Section 1 of 2'), 'question card should not repeat section numbering');
assert.ok(renderedQuestion.includes('Foundations'), 'the section title should appear above the question card');
assert.ok(renderedQuestion.includes('Read each statement carefully before choosing.'), 'the saved section description should appear above the question card');

console.log('Exam section behavior checks passed.');

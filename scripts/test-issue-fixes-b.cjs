// Regression tests for the second batch of reported issues:
//   #35 authorized late students visible in Monitoring
//   #37 archiving asks first
//   #38 the shake is a one-shot reaction, not a permanent state
//   #39 unanswered questions are not called "skipped"
//   #40 correctable face-position conditions count down before they count
//   #41 / #42 retake resets every row; a blank row is not an attempt
//   #43 assorted interface fixes
//   #44 the product has a visible name
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');
const adminSource = read('public/js/admin.js');
const examSource = read('public/js/exam.js');
const dataSource = read('public/js/data.js');
const styleSource = read('public/css/style.css');
const examPage = read('src/pages/ExamPage.jsx');
const adminPage = read('src/pages/AdminPage.jsx');
const loginPage = read('src/pages/LoginPage.jsx');
const ruleEngine = read('src/lib/proctoring/facemesh/temporalRuleEngine.js');
const faceConfig = read('src/lib/proctoring/facemesh/faceMonitoringConfig.js');

// ── #42: a row that was never started is not an attempt ────────────────────
const start = dataSource.indexOf('  getStudentSession(examId, studentId) {');
assert.ok(start >= 0, 'getStudentSession must exist');
const end = dataSource.indexOf('\n  addSession(data) {', start);
const box = {};
vm.runInNewContext(
  `const DB = { _sessions: [], getSessions() { return this._sessions; },\n${dataSource.slice(start, end)}\n};\nthis.DB = DB;`,
  box,
);
const DB = box.DB;

const finished = { id: 'done', examId: 'e1', studentId: 's1', submitted: true, endTime: '2026-09-19T08:00:00.000Z', answers: { q1: 'A' } };
const blank = { id: 'blank', examId: 'e1', studentId: 's1', submitted: false, startTime: null, answers: {} };
DB._sessions = [finished, blank];
assert.equal(
  DB.getStudentSession('e1', 's1').id,
  'done',
  'a blank row must not send a student who already finished back into the exam',
);

// A retake clears the finished row, and only then does the blank one win.
DB._sessions = [{ ...finished, submitted: false, answers: {}, endTime: null }, blank];
assert.notEqual(DB.getStudentSession('e1', 's1'), undefined, 'a granted retake still resolves to a usable row');

// An attempt genuinely in progress still outranks a finished one.
DB._sessions = [finished, { id: 'live', examId: 'e1', studentId: 's1', submitted: false, startTime: '2026-09-19T09:00:00.000Z', answers: {} }];
assert.equal(DB.getStudentSession('e1', 's1').id, 'live', 'an attempt in progress still wins');

// ── #41: Allow Retake must clear every row the student holds ───────────────
const retakeFn = adminSource.slice(
  adminSource.indexOf('async function allowStudentRetake('),
  adminSource.indexOf('\n}\n', adminSource.indexOf('async function allowStudentRetake(')),
);
assert.match(retakeFn, /DB\.getSessionsByExam\(session\.examId\)/, 'every row for the student is gathered');
assert.match(retakeFn, /targets\.forEach/, 'and every one of them is reset');

// ── #37: archiving an exam asks first ──────────────────────────────────────
const statusFn = adminSource.slice(
  adminSource.indexOf('async function setExamStatus('),
  adminSource.indexOf('\n}\n', adminSource.indexOf('async function setExamStatus(')),
);
const archiveBranch = statusFn.slice(statusFn.indexOf("status === 'archived'"));
assert.match(archiveBranch, /showConfirm\(/, 'archiving must confirm');
assert.match(archiveBranch, /if \(!ok\) return;/, 'and must stop when declined');

// ── #38: the shake is one-shot, the outline is not ─────────────────────────
const missingRule = styleSource.slice(styleSource.indexOf('.question-card.q-required-missing {'));
assert.doesNotMatch(
  missingRule.slice(0, missingRule.indexOf('}')),
  /animation/,
  'the persistent class must not carry the animation, or it replays on every visit',
);
assert.match(styleSource, /\.question-card\.q-shake \{[^}]*animation: shake-card/, 'the shake lives on its own class');
assert.match(examSource, /classList\.remove\('q-shake'\)/, 'and is taken off again once it has played');

// ── #39 / #44: wording ─────────────────────────────────────────────────────
assert.doesNotMatch(examPage, /examv2-stat-label">Skipped</, 'unanswered questions were never deliberately skipped');
assert.match(examPage, /examv2-stat-label">Unanswered</);
assert.match(loginPage, /login-system-name">TUKLAS</, 'the product name is visible to the people using it');
// And in the professor panel, as a wordmark above Sign Out rather than
// competing with the school name at the top.
assert.match(adminPage, /sidebar-wordmark-name">TUKLAS</, 'the sidebar carries the product name');
const footer = adminPage.slice(adminPage.indexOf('className="sidebar-footer"'));
assert.ok(
  footer.indexOf('sidebar-wordmark') < footer.indexOf('sidebar-signout-btn'),
  'the wordmark sits above Sign Out',
);
// Students use the system too, and saw its name nowhere.
assert.match(examPage, /portal-wordmark-name">TUKLAS</, 'the student portal carries the product name');
const portalFooter = examPage.slice(examPage.indexOf('className="portal-sidebar-footer"'));
assert.ok(
  portalFooter.indexOf('portal-wordmark') < portalFooter.indexOf('portal-signout-btn'),
  'and puts it in the same place as the professor panel',
);
assert.ok(styleSource.includes('.portal-wordmark-name'), 'the student wordmark is styled');

// "Archived" named a state where the nav names a place, and the professor side
// already said "Archive".
assert.doesNotMatch(examPage, /portal-nav-label">Archived</, 'the nav item is a place, not a state');
assert.match(examPage, /portal-nav-label">Archive</);

// ── #40: positioning conditions count down before they count ───────────────
['FACE_TOO_FAR', 'FACE_TOO_CLOSE', 'FACE_PARTIALLY_VISIBLE', 'FACE_NEAR_FRAME_EDGE'].forEach((type) => {
  const countdownSet = ruleEngine.slice(
    ruleEngine.indexOf('const COUNTDOWN_EVENT_TYPES'),
    ruleEngine.indexOf(']);', ruleEngine.indexOf('const COUNTDOWN_EVENT_TYPES')),
  );
  assert.ok(countdownSet.includes(type), `${type} must show the student a countdown`);
});
const positioningMs = Number(/positioningIncidentMs:\s*(\d+)/.exec(faceConfig)?.[1]);
const warningMs = Number(/positioningWarningMs:\s*(\d+)/.exec(faceConfig)?.[1]);
assert.ok(
  positioningMs - warningMs >= 5000,
  `a student needs longer than ${(positioningMs - warningMs) / 1000}s between the notice and the violation`,
);

// ── #43: interface fixes ───────────────────────────────────────────────────
assert.match(styleSource, /\[data-theme="dark"\] \.log-type\.force_submit/, 'Force Submitted must be readable in dark mode');
assert.match(adminSource, /ROUTINE_ACTIVITY_TYPES/, 'routine milestones are kept out of the activity counter');
assert.doesNotMatch(adminPage, /exam-policies-title">Examination Policies and Rules/, 'the heading is not repeated');
assert.doesNotMatch(adminPage, /<select className="form-control" id="share-mode">/, 'a one-option dropdown is not a choice');
assert.match(adminPage, /id="share-mode"/, 'but the value is still submitted');
assert.match(adminSource, /function isExamTitleTakenInSubject/, 'duplicates are blocked by title, not by course');
assert.match(adminSource, /choice === 'absent'/, 'reopening can let the absentees in');
assert.match(adminSource, /disabled title="\$\{escAttr\(recoverBlockedReason\)\}"/, 'archive actions stay in one column');

// ── The two sidebars are one design ───────────────────────────────────────
// They were built separately and the current-tab state had drifted: the
// professor panel filled it solid green with a gold bar, the student portal
// used a translucent green. Keep the rules identical.
const ruleFor = (selector) => {
  const at = styleSource.indexOf(selector);
  assert.ok(at >= 0, `missing rule: ${selector}`);
  return styleSource.slice(at + selector.length, styleSource.indexOf('}', at))
    .split(';').map(d => d.trim()).filter(Boolean).sort().join('; ');
};
assert.equal(
  ruleFor('[data-theme="dark"] .portal-nav-item.active,\n[data-theme="dark"] .portal-subject-item.active {'),
  ruleFor('[data-theme="dark"] .nav-item.active {'),
  'the current tab must look the same on both sides of the system',
);
// Section labels and the wordmark share their values too.
assert.match(styleSource, /\[data-theme="dark"\] \.nav-item\.active/);
assert.ok(
  styleSource.includes('[data-theme="dark"] .nav-section-label,\n[data-theme="dark"] .portal-nav-section-label'),
  'both section labels take the same muted colour in dark mode',
);
assert.equal(ruleFor('.portal-wordmark-name {'), ruleFor('.sidebar-wordmark-name {'), 'one product, one wordmark');
// Course rows use the same padding and gap as the nav rows, with the course's
// colour chip in the slot the others use for an icon, so every label starts at
// the same x and no blank indent stands in for a missing icon.
assert.match(styleSource, /\.portal-subject-item \{[\s\S]{0,400}?padding: 10px 12px;/, 'course rows share the nav padding');
// Courses carry no icon, so their label sits at the row padding, level with the
// left edge of the nav icons rather than behind a blank indent.
assert.ok(
  styleSource.includes('.portal-subject-item .portal-subject-chip { display: none; }'),
  'course rows show no chip while the sidebar is expanded',
);
assert.ok(
  styleSource.includes('.portal-sidebar.collapsed .portal-subject-item .portal-subject-chip'),
  'but the chip returns on the collapsed rail, where it is the only identifier',
);

// The sidebar list is rebuilt on every dashboard refresh, which used to throw
// away the highlight on the course the student had open.
assert.match(examSource, /const isOpen = this\._currentCourseId === s\.id;/, 'the open course survives a re-render');
assert.match(examSource, /portal-subject-item\$\{isOpen \? ' active' : ''\}/);

// Light text on a dark panel gains weight without explicit smoothing.
['width: var(--sidebar-width);', 'width: var(--sidebar-w);'].forEach((anchor) => {
  const at = styleSource.indexOf(anchor);
  assert.ok(at > 0, `missing sidebar rule anchored at ${anchor}`);
  const block = styleSource.slice(at, styleSource.indexOf('}', at));
  assert.ok(
    block.includes('-webkit-font-smoothing: antialiased'),
    `the sidebar declaring "${anchor}" needs matching font smoothing`,
  );
});
assert.equal(ruleFor('.portal-wordmark-sub {'), ruleFor('.sidebar-wordmark-sub {'));

// Archive is the last nav entry, after the enrolled courses, so enrolling in a
// new course cannot push it out of last place.
const navBlock = examPage.slice(examPage.indexOf('className="portal-nav"'), examPage.indexOf('</nav>'));
assert.ok(navBlock.includes('portal-nav-courses'), 'the courses list is in the nav');
assert.ok(
  navBlock.indexOf('portal-nav-courses') < navBlock.indexOf('pnav-archived'),
  'Archive comes after the courses',
);
assert.ok(navBlock.includes('pnav-archived'), 'and is part of the nav, not stranded in the footer');

// ── AI composer toolbar ────────────────────────────────────────────────────
// "Free-form Instructions" used to sit beside the mode buttons as a bare grey
// caption that described neither of them and changed with neither.
assert.doesNotMatch(adminPage, />Free-form Instructions</, 'the orphaned caption is gone');
assert.match(adminPage, /Free-form — describe the exam you want/, 'the caption follows the selected mode');
assert.match(adminPage, /Guided form — set the count, types and difficulty/);
assert.match(adminPage, /role="group" aria-label="Generation mode"/, 'Quick and Custom are one control');
// The prompt line sits centred in its row. Uneven vertical padding left it
// riding high against the attachment chips above it.
assert.match(adminPage, /padding:'14px 16px', fontSize:'14px'/, 'the composer padding is symmetrical');
assert.match(adminPage, /aria-pressed=\{aiMode===m\}/, 'and announce which of them is on');

// ── #35: a cleared late student is watchable ───────────────────────────────
assert.match(adminSource, /monitorLateAuthorized/, 'monitoring knows who is sitting late');
assert.match(adminSource, /In Progress &middot; Late Sitting/, 'and says so while they are working');

// ── Question metadata badges: one system, two non-overlapping scales ───────
const sliceOut = (from, to) => adminSource.slice(adminSource.indexOf(from), adminSource.indexOf(to));
const metaBox = {};
vm.runInNewContext(
  `${sliceOut('const DIFFICULTY_META = {', 'const DIFFICULTY_SOURCE_LABEL')}
   ${sliceOut('function difficultyBadge(', '\n// Horizontal 3-band gauge')}
   ${sliceOut('const BLOOM_META = {', 'function setQuestionBloom')}
   this.out = { DIFFICULTY_META, BLOOM_META, bloomBadge, difficultyBadge };`,
  metaBox,
);
const { DIFFICULTY_META, BLOOM_META, bloomBadge, difficultyBadge } = metaBox.out;

// Both families render the same component, so they read as one system.
assert.match(difficultyBadge('easy'), /class="qmeta-badge qmeta-tone-green"/);
assert.match(bloomBadge('remember'), /class="qmeta-badge qmeta-tone-blue"/);
assert.match(difficultyBadge('nonsense'), /qmeta-tone-slate/, 'an unrated question still gets a badge');

// The emoji circles are gone: they could not be recoloured for dark mode.
['easy', 'medium', 'hard'].forEach((level) => {
  assert.doesNotMatch(difficultyBadge(level), /[\u{1F7E0}-\u{1F7EB}]/u, 'no emoji in a difficulty badge');
});

// Difficulty owns green/amber/red. Bloom must not borrow any of them, or the
// two dimensions become indistinguishable on a question that shows both.
const difficultyTones = new Set(Object.values(DIFFICULTY_META).map(m => m.tone));
const bloomTones = Object.values(BLOOM_META).map(m => m.tone);
assert.deepEqual([...difficultyTones].sort(), ['amber', 'green', 'red']);
bloomTones.forEach((tone) => {
  assert.equal(difficultyTones.has(tone), false, `Bloom must not reuse the difficulty tone "${tone}"`);
});
assert.equal(new Set(bloomTones).size, 6, 'each Bloom level is its own step on the ladder');

// Every tone used must actually be defined, in both themes.
[...difficultyTones, ...bloomTones, 'slate'].forEach((tone) => {
  assert.ok(styleSource.includes(`.qmeta-tone-${tone}`), `.qmeta-tone-${tone} must exist`);
  assert.ok(
    styleSource.includes(`[data-theme="dark"] .qmeta-tone-${tone}`),
    `.qmeta-tone-${tone} needs a dark-mode value or it is unreadable`,
  );
});

// ── The AI preview must not hardcode light-mode colours ───────────────────
const previewFn = adminSource.slice(
  adminSource.indexOf('function renderAIPreview('),
  adminSource.indexOf('\n}\n', adminSource.indexOf('function renderAIPreview(')),
);
assert.doesNotMatch(previewFn, /#0f2d1a/, 'the type heading was invisible on the dark panel');
assert.doesNotMatch(previewFn, /background:#e5e7eb/, 'and its rule was a light-grey line');
assert.doesNotMatch(previewFn, /color:#6b7280/, 'and the answer options were too dim to read');
assert.match(previewFn, /class="ai-type-heading"/, 'the heading is themed through CSS instead');
assert.match(previewFn, /class="ai-q-options"/, 'and so are the options');

console.log('Second-batch issue fix tests passed (#35, #37, #38, #39, #40, #41, #42, #43, #44).');

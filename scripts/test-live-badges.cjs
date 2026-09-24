// The LIVE badges must describe the exam, not the polling loop. Both pollers
// run for as long as their section is open, so a badge tied to the poller
// claims an exam is under way when none is.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const admin = fs.readFileSync(path.join(root, 'public', 'js', 'admin.js'), 'utf8');

// A stand-in badge that records whether it is hidden.
const makeBadge = () => {
  let hidden = true;
  return {
    classList: {
      toggle(name, force) { if (name === 'hidden') hidden = force; },
      add(name) { if (name === 'hidden') hidden = true; },
      remove(name) { if (name === 'hidden') hidden = false; },
    },
    get isHidden() { return hidden; },
  };
};

const run = (src, expose, { exam, monitorExamId, selectId }) => {
  const badge = makeBadge();
  const sandbox = {
    monitorExamId,
    DB: { getExam: () => exam },
    document: {
      getElementById: (id) => (id === 'report-live-badge' || id === 'monitor-live-badge')
        ? badge
        : { value: selectId || '' },
    },
  };
  vm.runInNewContext(`${src}\nthis.fn = ${expose};`, sandbox);
  return { badge, sandbox };
};

// ── Monitoring ─────────────────────────────────────────────────────────────
const monitorSrc = admin.slice(
  admin.indexOf('function syncMonitorLiveBadge'),
  admin.indexOf('function onMonitorExamChange'),
);

for (const [status, shouldShow] of [['active', true], ['closed', false], ['ready', false], ['archived', false]]) {
  const { badge, sandbox } = run(monitorSrc, 'syncMonitorLiveBadge', {
    exam: { status }, monitorExamId: 'e1',
  });
  sandbox.fn();
  assert.equal(badge.isHidden, !shouldShow, `monitor badge with a ${status} exam`);
}

// No exam chosen at all — the case in the screenshot.
{
  const { badge, sandbox } = run(monitorSrc, 'syncMonitorLiveBadge', { exam: null, monitorExamId: null });
  sandbox.fn();
  assert.equal(badge.isHidden, true, 'monitor badge must be hidden with no exam selected');
}

// ── Reports ────────────────────────────────────────────────────────────────
const reportSrc = admin.slice(
  admin.indexOf('function syncReportLiveBadge'),
  admin.indexOf('function getOrderedSubmittedReportSessions'),
);

for (const [status, shouldShow] of [['active', true], ['closed', false], ['ready', false]]) {
  const { badge, sandbox } = run(reportSrc, 'syncReportLiveBadge', { exam: null, selectId: 'e1' });
  sandbox.fn({ status });
  assert.equal(badge.isHidden, !shouldShow, `report badge with a ${status} exam`);
}
{
  const { badge, sandbox } = run(reportSrc, 'syncReportLiveBadge', { exam: null, selectId: '' });
  sandbox.fn(null);
  assert.equal(badge.isHidden, true, 'report badge must be hidden with no exam selected');
}

// ── Neither poller may force the badge on ──────────────────────────────────
for (const id of ['monitor-live-badge', 'report-live-badge']) {
  assert.ok(
    !admin.includes(`getElementById('${id}').classList.remove('hidden')`)
    && !admin.includes(`getElementById('${id}')?.classList.remove('hidden')`),
    `${id} must not be unconditionally shown when its poller starts`,
  );
}

// Both must be re-checked as the section refreshes, so a badge clears when an
// exam closes underneath the professor.
assert.match(
  admin.slice(admin.indexOf('function renderMonitoringSectionLive'), admin.indexOf('function renderReportsSectionLive')),
  /syncMonitorLiveBadge\(\)/,
  'monitoring must re-check the badge on every refresh',
);

// Camera Grid receives compact session polls and WebSocket replay events in
// parallel. Neither an older one-item snapshot nor a stale empty evidence
// response may erase richer data that is already visible.
const monitorSnapshotState = {};
const monitorSnapshotHelpers = admin.slice(
  admin.indexOf('function getMonitorSnapshotKey('),
  admin.indexOf('function applyMonitorSessionsSnapshot('),
);
vm.runInNewContext(
  `${monitorSnapshotHelpers}\nthis.mergeSnapshots = mergeMonitorCameraSnapshots;`,
  monitorSnapshotState,
);
const storedViolationSnapshot = {
  timestamp: '2026-09-24T06:00:00.000Z',
  kind: 'violation',
  violationType: 'camera_off',
  imageData: 'data:image/jpeg;base64,violation',
};
const compactPollSnapshot = {
  timestamp: '2026-09-24T05:59:00.000Z',
  kind: 'periodic',
  imageData: 'data:image/jpeg;base64,periodic',
};
const mergedSnapshots = monitorSnapshotState.mergeSnapshots(
  [storedViolationSnapshot],
  [compactPollSnapshot],
);
assert.equal(mergedSnapshots.length, 2, 'a compact poll must preserve existing violation snapshots');
assert.ok(mergedSnapshots.some(snapshot => snapshot.kind === 'violation'));
assert.equal(
  monitorSnapshotState.mergeSnapshots([storedViolationSnapshot], []).length,
  1,
  'an empty partial poll must not clear Camera Grid snapshots',
);

const monitorEvidenceState = {};
const monitorEvidenceHelper = admin.slice(
  admin.indexOf('function mergeMonitorEvidenceRecords('),
  admin.indexOf('async function refreshViolationEvidence('),
);
vm.runInNewContext(
  `${monitorEvidenceHelper}\nthis.mergeEvidence = mergeMonitorEvidenceRecords;`,
  monitorEvidenceState,
);
const websocketReplay = {
  id: 'replay-1',
  examId: 'exam-1',
  reviewStatus: 'pending',
  createdAt: '2026-09-24T06:00:00.000Z',
};
assert.equal(
  monitorEvidenceState.mergeEvidence([websocketReplay], []).length,
  1,
  'a stale empty HTTP response must not erase WebSocket replay evidence',
);
const reviewedReplay = monitorEvidenceState.mergeEvidence(
  [websocketReplay],
  [{ id: 'replay-1', reviewStatus: 'confirmed' }],
);
assert.equal(reviewedReplay[0].reviewStatus, 'confirmed', 'fresh evidence fields must still update cached replay records');
assert.equal(reviewedReplay[0].examId, 'exam-1', 'partial evidence updates must retain existing replay metadata');

console.log('LIVE badge tests passed.');

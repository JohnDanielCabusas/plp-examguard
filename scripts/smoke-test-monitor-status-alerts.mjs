// Two things a professor watching a live exam has to be able to trust:
//
// 1. The Status column. A student who is answering questions must read as In
//    Progress, even when the one field that used to decide it — their start time,
//    written by their own browser — has not reached the panel, and even when their
//    student ID differs from the roster's only in case or spacing.
// 2. Alerts are about now. A violation that arrives late, or a backlog queued
//    while the exam was live, must not keep interrupting the professor after the
//    attempt was submitted or the exam was closed.
import { access } from 'node:fs/promises';
import net from 'node:net';
import { resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { createServer } from 'vite';

async function availablePort() {
  return new Promise((resolvePort, reject) => {
    const listener = net.createServer();
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', () => {
      const port = listener.address().port;
      listener.close(() => resolvePort(port));
    });
  });
}

const candidates = process.platform === 'win32'
  ? [
      resolve(process.env['PROGRAMFILES(X86)'] || 'C:/Program Files (x86)', 'Microsoft/Edge/Application/msedge.exe'),
      resolve(process.env.PROGRAMFILES || 'C:/Program Files', 'Google/Chrome/Application/chrome.exe'),
    ]
  : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/microsoft-edge'];

let executablePath = '';
for (const candidate of candidates) {
  try {
    await access(candidate);
    executablePath = candidate;
    break;
  } catch (_) {}
}
if (!executablePath) throw new Error('Chrome or Edge is required for the monitor status test.');

const failures = [];
const check = (ok, message) => { if (!ok) failures.push(message); };

const port = await availablePort();
const server = await createServer({ server: { host: '127.0.0.1', port, strictPort: true, hmr: false } });
let browser;
try {
  await server.listen();
  browser = await chromium.launch({ executablePath, headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${port}/css/style.css`, { waitUntil: 'domcontentloaded' });
  await page.setContent('<!doctype html><html><head></head><body><main id="test-root"></main></body></html>');
  await page.addStyleTag({ url: `http://127.0.0.1:${port}/css/style.css` });
  for (const src of ['/js/supabase-sync.js', '/js/data.js', '/js/auth.js', '/js/admin.js']) {
    await page.addScriptTag({ url: `http://127.0.0.1:${port}${src}` });
  }
  await page.evaluate(() => {
    window.addEventListener('dbReady', e => e.stopImmediatePropagation(), true);
  });

  await page.evaluate(() => {
    window.__exam = {
      id: 'e1', title: 'Midterm', status: 'active', subjectId: 'sub-1',
      requireCamera: false, questions: [{ id: 'q1' }, { id: 'q2' }],
      excludedStudentIds: [], lateExamStudentIds: [],
    };
    // Four students on the roster, and the awkward session rows a real exam
    // produces underneath them.
    window.__students = [
      { id: 'st-1', studentId: '24-0001', name: 'Alice Cruz', enrolledSubjects: ['sub-1'], yearSection: '3-A' },
      { id: 'st-2', studentId: '24-0002', name: 'Bob Diaz', enrolledSubjects: ['sub-1'], yearSection: '3-A' },
      { id: 'st-3', studentId: '24-0003', name: 'Carla Reyes', enrolledSubjects: ['sub-1'], yearSection: '3-A' },
      { id: 'st-4', studentId: '24-0004', name: 'Dan Cruz', enrolledSubjects: ['sub-1'], yearSection: '3-A' },
    ];
    window.__sessions = [
      // Answering questions, but the start time never reached the panel.
      {
        id: 's1', examId: 'e1', studentId: '24-0001', studentName: 'Alice Cruz',
        startTime: null, submitted: false, answers: { q1: 'A' }, warnings: 0,
        activities: [{ type: 'browser_exam_start', timestamp: '2026-09-24T01:00:00.000Z', detail: 'started' }],
        cameraSnapshots: [],
      },
      // Same, and the student ID differs from the roster only in case/spacing.
      {
        id: 's2', examId: 'e1', studentId: ' 24-0002 ', studentName: 'Bob Diaz',
        startTime: '2026-09-24T01:00:00.000Z', submitted: false, answers: {}, warnings: 1,
        activities: [{ type: 'tab_switch', timestamp: '2026-09-24T01:02:00.000Z', detail: 'switched' }],
        cameraSnapshots: [],
      },
      // Genuinely has not begun.
      {
        id: 's3', examId: 'e1', studentId: '24-0003', studentName: 'Carla Reyes',
        startTime: null, submitted: false, answers: {}, warnings: 0, activities: [], cameraSnapshots: [],
      },
      // Finished.
      {
        id: 's4', examId: 'e1', studentId: '24-0004', studentName: 'Dan Cruz',
        startTime: '2026-09-24T01:00:00.000Z', endTime: '2026-09-24T01:40:00.000Z',
        submitted: true, answers: { q1: 'B' }, warnings: 0,
        activities: [{ type: 'browser_exam_start', timestamp: '2026-09-24T01:00:00.000Z', detail: 'started' }],
        cameraSnapshots: [],
      },
    ];
    Object.assign(window.DB, {
      getExam: id => (id === 'e1' ? window.__exam : null),
      getExams: () => [window.__exam],
      getSubject: () => ({ id: 'sub-1', name: 'Course', code: 'C1' }),
      getStudents: () => window.__students,
      getAllStudentsRaw: () => window.__students,
      getStudent: id => window.__students.find(s => s.studentId === id) || null,
      getSessions: () => window.__sessions,
      getSessionsByExam: () => window.__sessions,
      getSession: id => window.__sessions.find(s => s.id === id) || null,
      getMessagesForExamStudent: () => [],
      getLogs: () => [],
      addLog: () => {},
      updateSession: () => {},
      updateExam: (id, patch) => { Object.assign(window.__exam, patch); },
    });
    Object.assign(window.Auth, { getAdminSession: () => ({ id: 'admin-1', name: 'Prof. Santos' }) });
    window.SupabaseSync = null;
    window.showToast = () => {};
    window.playViolationSound = () => Promise.resolve();
    window.addBellNotification = () => {};
    window.readDismissedNotificationIds = () => new Set();
    window.rememberDismissedNotificationIds = () => {};
    window.monitorApiRequest = () => Promise.resolve({ success: true });

    document.getElementById('test-root').innerHTML = `
      <select id="monitor-exam-select"><option value="e1" selected>Midterm</option></select>
      <span id="monitor-count"></span><span id="monitor-sort-btn-label"></span>
      <input id="monitor-filter-search" /><button id="monitor-filter-clear" hidden></button>
      <div id="monitoring-grid"><table><tbody id="monitor-tbody"></tbody></table></div>
      <div id="modal-violation-alert" class="modal-backdrop hidden">
        <span id="violation-alert-avatar"></span><span id="violation-alert-student-name"></span>
        <span id="violation-alert-student-meta"></span><span id="violation-alert-exam-name"></span>
        <span id="violation-alert-type"></span><span id="violation-alert-time"></span>
        <span id="violation-alert-warning-count"></span><span id="violation-alert-title"></span>
        <span id="violation-alert-flag-label"></span><span id="violation-alert-warning-label"></span>
        <span id="violation-alert-icon"></span><span id="violation-alert-severity"></span>
        <span id="violation-alert-queue-indicator"></span>
        <button id="violation-alert-dismiss-all-btn"></button>
      </div>`;
    renderMonitoringTable('e1');
  });

  const rows = await page.evaluate(() => [...document.querySelectorAll('#monitor-tbody tr')].map(tr => ({
    text: tr.textContent.replace(/\s+/g, ' ').trim(),
    status: tr.querySelector('.ms-badge')?.textContent?.trim() || '',
    forceSubmit: !!tr.querySelector('.tbl-btn-archive'),
  })));
  const rowFor = name => rows.filter(row => row.text.includes(name));

  check(rows.length === 4, `Each roster student gets exactly one row: ${JSON.stringify(rows.map(r => r.text.slice(0, 24)))}`);
  check(
    rowFor('Alice Cruz')[0]?.status === 'In Progress',
    `A student answering questions must read as In Progress even with no start time: ${JSON.stringify(rowFor('Alice Cruz'))}`,
  );
  check(
    rowFor('Bob Diaz').length === 1 && rowFor('Bob Diaz')[0]?.status === 'In Progress',
    `A student ID differing only in case or spacing must still pair with its attempt: ${JSON.stringify(rowFor('Bob Diaz'))}`,
  );
  check(
    rowFor('Carla Reyes')[0]?.status === 'Not Started',
    `A student who has not begun must still read as Not Started: ${JSON.stringify(rowFor('Carla Reyes'))}`,
  );
  check(
    rowFor('Dan Cruz')[0]?.status === 'Submitted',
    `A finished attempt must read as Submitted: ${JSON.stringify(rowFor('Dan Cruz'))}`,
  );
  check(
    rowFor('Alice Cruz')[0]?.forceSubmit === true,
    'A student who is in the exam must be force-submittable.',
  );
  check(
    rowFor('Carla Reyes')[0]?.forceSubmit === false,
    'A student who has not begun has nothing to force-submit.',
  );

  const strip = await page.evaluate(() => {
    const cards = [...document.querySelectorAll('#monitor-stats-strip .stat-card')];
    return cards.map(card => `${card.querySelector('.stat-label')?.textContent}:${card.querySelector('.stat-value')?.textContent}`);
  });
  check(
    strip.includes('In Progress:2'),
    `The strip must count the same students the rows show: ${JSON.stringify(strip)}`,
  );

  // ── Alerts belong to a live attempt ───────────────────────────────────────
  const liveAlert = await page.evaluate(() => {
    refreshViolationAlerts({ seedOnly: true });
    // A violation on a live attempt, which the professor does need to see.
    processIncomingViolationEvent({
      sessionId: 's1', examId: 'e1', studentId: '24-0001', studentName: 'Alice Cruz',
      violationType: 'tab_switch', detail: 'Tab or window switched',
      warningCount: 1, createdAt: new Date().toISOString(),
    });
    const modal = document.getElementById('modal-violation-alert');
    return {
      shown: !modal.classList.contains('hidden'),
      name: document.getElementById('violation-alert-student-name').textContent,
    };
  });
  check(liveAlert.shown, `A violation during a live attempt must still alert: ${JSON.stringify(liveAlert)}`);
  check(liveAlert.name === 'Alice Cruz', `The alert must name the student: ${JSON.stringify(liveAlert)}`);

  const afterSubmit = await page.evaluate(() => {
    acknowledgeViolationAlert();
    // The student finishes, and a violation from moments earlier now arrives.
    window.__sessions.find(s => s.id === 's1').submitted = true;
    processIncomingViolationEvent({
      sessionId: 's1', examId: 'e1', studentId: '24-0001', studentName: 'Alice Cruz',
      violationType: 'window_blur', detail: 'Another application was opened',
      warningCount: 2, createdAt: new Date().toISOString(),
    });
    const modal = document.getElementById('modal-violation-alert');
    return { shown: !modal.classList.contains('hidden') };
  });
  check(
    !afterSubmit.shown,
    `A violation arriving after the attempt was submitted must not pop up: ${JSON.stringify(afterSubmit)}`,
  );

  const afterClose = await page.evaluate(() => {
    window.__exam.status = 'closed';
    processIncomingViolationEvent({
      sessionId: 's2', examId: 'e1', studentId: '24-0002', studentName: 'Bob Diaz',
      violationType: 'tab_switch', detail: 'Tab or window switched',
      warningCount: 2, createdAt: new Date().toISOString(),
    });
    const modal = document.getElementById('modal-violation-alert');
    return { shown: !modal.classList.contains('hidden') };
  });
  check(
    !afterClose.shown,
    `Nothing from a closed exam may appear on screen: ${JSON.stringify(afterClose)}`,
  );

  // A backlog queued while the exam was live must not survive it.
  const backlog = await page.evaluate(() => {
    window.__exam.status = 'active';
    const queued = [];
    for (let index = 0; index < 4; index += 1) {
      processIncomingViolationEvent({
        sessionId: 's2', examId: 'e1', studentId: '24-0002', studentName: 'Bob Diaz',
        violationType: 'tab_switch', detail: `Switch ${index}`,
        warningCount: 2, createdAt: new Date().toISOString(),
      });
      queued.push(!document.getElementById('modal-violation-alert').classList.contains('hidden'));
    }
    const shownWhileLive = queued.some(Boolean);
    // Now the exam closes with alerts still stacked up behind the one on screen.
    window.__exam.status = 'closed';
    if (typeof pruneStaleViolationAlerts === 'function') pruneStaleViolationAlerts();
    const modal = document.getElementById('modal-violation-alert');
    return { shownWhileLive, stillShowing: !modal.classList.contains('hidden') };
  });
  check(backlog.shownWhileLive, 'The backlog must have been visible while the exam was live.');
  check(
    !backlog.stillShowing,
    `Closing the exam must clear the alerts still queued behind it: ${JSON.stringify(backlog)}`,
  );

  // A session reaching this professor for the first time must not replay its
  // whole history as popups.
  const lateSession = await page.evaluate(() => {
    window.__exam.status = 'active';
    window.__sessions.push({
      id: 's5', examId: 'e1', studentId: '24-0009', studentName: 'Ellen Park',
      startTime: '2026-09-24T01:00:00.000Z', submitted: false, answers: {}, warnings: 3,
      activities: [
        { type: 'tab_switch', timestamp: '2026-09-24T01:05:00.000Z', detail: 'Old switch 1' },
        { type: 'window_blur', timestamp: '2026-09-24T01:06:00.000Z', detail: 'Old blur' },
        { type: 'tab_switch', timestamp: '2026-09-24T01:07:00.000Z', detail: 'Old switch 2' },
      ],
      cameraSnapshots: [],
    });
    refreshViolationAlerts();
    const modal = document.getElementById('modal-violation-alert');
    const shown = !modal.classList.contains('hidden');

    // But something new on that same session still alerts.
    window.__sessions.find(s => s.id === 's5').activities.push({
      type: 'tab_switch', timestamp: new Date().toISOString(), detail: 'Fresh switch',
    });
    refreshViolationAlerts();
    return {
      historyReplayed: shown,
      freshAlerted: !modal.classList.contains('hidden'),
      freshDetail: document.getElementById('violation-alert-type').textContent,
    };
  });
  check(
    !lateSession.historyReplayed,
    `A session arriving late must not replay its history as popups: ${JSON.stringify(lateSession)}`,
  );
  check(
    lateSession.freshAlerted,
    `A new violation on that session must still alert: ${JSON.stringify(lateSession)}`,
  );

  check(!errors.length, `Page errors: ${errors.join(' | ')}`);
  if (failures.length) {
    throw new Error(`Monitor status and alert failures:\n- ${failures.join('\n- ')}`);
  }
  console.log('Monitor status and alert tests passed.');
} finally {
  if (browser) await browser.close();
  await server.close();
}

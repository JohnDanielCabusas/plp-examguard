// Drives the real admin.js in a browser for two professor-facing additions:
// the Monitoring search box, and the bulk "Allow Retake" offered once rows are
// ticked in Reports. Both are DOM-driven, so source reading cannot prove them.
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
if (!executablePath) throw new Error('Chrome or Edge is required for the monitoring search smoke test.');

const port = await availablePort();
const server = await createServer({ server: { host: '127.0.0.1', port, strictPort: true, hmr: false } });
let browser;
try {
  await server.listen();
  browser = await chromium.launch({ executablePath, headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  // Deliberately NOT the app: loading index.html boots React and Supabase, whose
  // navigation raced this shell and tore the test's execution context down. A
  // static file gives the same origin with nothing running on it, and the app's
  // globals are then loaded in the order admin.html loads them.
  await page.goto(`http://127.0.0.1:${port}/css/style.css`, { waitUntil: 'domcontentloaded' });
  await page.setContent('<!doctype html><html><head></head><body><main id="test-root"></main></body></html>');
  await page.addStyleTag({ url: `http://127.0.0.1:${port}/css/style.css` });
  for (const src of ['/js/supabase-sync.js', '/js/data.js', '/js/auth.js', '/js/admin.js']) {
    await page.addScriptTag({ url: `http://127.0.0.1:${port}${src}` });
  }

  // admin.js boots the whole professor panel on 'dbReady', which the page's
  // leftover SupabaseSync can still emit against this shell. Stop it at the
  // window before it reaches admin.js, or it writes into elements that only the
  // real panel has.
  await page.evaluate(() => {
    window.addEventListener('dbReady', e => e.stopImmediatePropagation(), true);
  });

  // The page's own DB and Auth objects are patched in place rather than replaced:
  // data.js and auth.js hold them in const bindings that a window assignment
  // would not reach. An exam with no subject makes renderMonitoringTable fall
  // back to the exam's own session rows instead of a course roster.
  await page.evaluate(() => {
    const exam = { id: 'e1', title: 'Midterm', status: 'active', questions: [{}, {}], excludedStudentIds: [], requireCamera: false };
    window.__sessions = [
      { id: 's1', examId: 'e1', studentId: '24-0001', studentName: 'Alice Cruz', submitted: true, score: 18, maxScore: 20, startTime: '2026-09-20T01:00:00.000Z', endTime: '2026-09-20T01:40:00.000Z', answers: { q1: 'A' }, warnings: 0, activities: [] },
      { id: 's2', examId: 'e1', studentId: '24-0002', studentName: 'Bob Diaz', submitted: true, score: 15, maxScore: 20, startTime: '2026-09-20T01:00:00.000Z', endTime: '2026-09-20T01:42:00.000Z', answers: { q1: 'B' }, warnings: 1, activities: [] },
      { id: 's3', examId: 'e1', studentId: '24-0003', studentName: 'Carla Reyes', submitted: true, score: 12, maxScore: 20, startTime: '2026-09-20T01:00:00.000Z', endTime: '2026-09-20T01:45:00.000Z', answers: { q1: 'C' }, warnings: 0, activities: [] },
    ];
    window.__updates = [];
    Object.assign(window.DB, {
      getExam: () => exam,
      getExams: () => [exam],
      getSubject: () => null,
      getStudents: () => [],
      getSessionsByExam: () => window.__sessions,
      getSession: id => window.__sessions.find(s => s.id === id),
      getStudentSession: (examId, studentId) => window.__sessions.find(s => s.studentId === studentId),
      getMessagesForExamStudent: () => [],
      getLogs: () => [],
      addLog: () => {},
      setStudentCameraExempt: () => {},
      updateExam: () => {},
      updateSession: (id, patch) => {
        window.__updates.push({ id, patch });
        const row = window.__sessions.find(s => s.id === id);
        if (row) Object.assign(row, patch);
      },
    });
    Object.assign(window.Auth, { getAdminSession: () => ({ name: 'Prof. Santos' }) });
    // No live sync in a test page: the retake grant must not wait on a document
    // that will never be published.
    window.SupabaseSync = null;
  });

  // ── Monitoring: search by name or student ID ──────────────────────────────
  const monitoring = await page.evaluate(() => {
    document.getElementById('test-root').innerHTML = `
      <select id="monitor-exam-select"><option value="e1" selected>Midterm</option></select>
      <div id="log-body"></div><span id="log-student-name"></span>
      <div class="card monitor-sessions-panel">
        <div class="card-header monitor-panel-header">
          <span id="monitor-count" class="monitor-count-chip"></span>
          <button id="monitor-sort-btn"><span id="monitor-sort-btn-label"></span></button>
        </div>
        <div class="report-filter-bar monitor-filter-bar">
          <div class="report-filter-search">
            <input type="search" id="monitor-filter-search" placeholder="Search name or student ID" oninput="setMonitorSearch(this.value)" />
          </div>
          <button type="button" id="monitor-filter-clear" class="report-filter-clear" hidden onclick="clearMonitorSearch()">Clear search</button>
        </div>
        <div id="monitoring-grid"><table><tbody id="monitor-tbody"></tbody></table></div>
      </div>`;
    const read = () => ({
      count: document.getElementById('monitor-count').textContent,
      rows: [...document.querySelectorAll('#monitor-tbody tr')].map(tr => tr.textContent.replace(/\s+/g, ' ').trim()),
      total: document.querySelector('#monitor-stats-strip .stat-value')?.textContent,
      clearHidden: document.getElementById('monitor-filter-clear').hidden,
      inputValue: document.getElementById('monitor-filter-search').value,
    });

    // Only the poller and the surrounding chrome are stubbed. Selecting the exam
    // through the real handler is what puts the table under a live exam, which
    // the search box then has to narrow.
    window.pollMonitorSessions = () => {};
    window.refreshViolationEvidence = () => Promise.resolve();
    window.updateExamDeadlineDisplays = () => {};
    window.syncMonitorLiveBadge = () => {};
    window.setMonitorView = () => {};
    onMonitorExamChange();
    const unfiltered = read();

    const input = document.getElementById('monitor-filter-search');
    input.value = 'diaz';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    const byName = read();

    input.value = '24-0003';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    const byId = read();

    input.value = 'nobody here';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    const noMatch = read();

    document.getElementById('monitor-filter-clear').click();
    const cleared = read();

    return { unfiltered, byName, byId, noMatch, cleared };
  });

  const { unfiltered, byName, byId, noMatch, cleared } = monitoring;
  if (unfiltered.rows.length !== 3 || unfiltered.count !== '3 students' || !unfiltered.clearHidden) {
    throw new Error(`Unfiltered sessions table is wrong: ${JSON.stringify(unfiltered)}`);
  }
  if (byName.rows.length !== 1 || !byName.rows[0].includes('Bob Diaz') || byName.count !== '1 of 3 students') {
    throw new Error(`Searching a name did not narrow the table: ${JSON.stringify(byName)}`);
  }
  if (byName.total !== '3') {
    throw new Error(`The stats strip must keep counting the whole room: ${JSON.stringify(byName)}`);
  }
  if (byName.clearHidden) throw new Error('A live search must offer a way to clear it.');
  if (byId.rows.length !== 1 || !byId.rows[0].includes('Carla Reyes')) {
    throw new Error(`Searching a student ID did not narrow the table: ${JSON.stringify(byId)}`);
  }
  if (noMatch.rows.length !== 1 || !noMatch.rows[0].includes('No students match your search')) {
    throw new Error(`A search with no match must say so: ${JSON.stringify(noMatch)}`);
  }
  if (cleared.rows.length !== 3 || cleared.inputValue !== '' || !cleared.clearHidden) {
    throw new Error(`Clearing the search must restore every row: ${JSON.stringify(cleared)}`);
  }

  // ── Reports: one retake grant for every ticked student ────────────────────
  const reports = await page.evaluate(() => {
    document.getElementById('test-root').innerHTML = `
      <select id="report-exam-select"><option value="e1" selected>Midterm</option></select>
      <div class="card" id="report-card">
        <div class="card-header">
          <div class="report-card-controls">
            <button type="button" id="btn-report-bulk-retake" class="report-bulk-retake-btn" hidden onclick="allowSelectedRetakes()">
              Allow Retake (<span id="report-bulk-retake-count">0</span>)
            </button>
            <div id="report-summary" class="report-summary">
              <span class="report-selected-count" id="report-selected-count" hidden></span>
            </div>
          </div>
        </div>
        <table>
          <thead><tr><th><input type="checkbox" id="report-select-all" onchange="toggleReportSelectAll(this.checked)" /></th></tr></thead>
          <tbody id="report-tbody"></tbody>
        </table>
      </div>`;

    // Only the confirmation and the redraws are stubbed; the grant itself runs.
    window.__toasts = [];
    window.showConfirm = () => Promise.resolve(true);
    window.showToast = message => { window.__toasts.push(message); };
    window.renderReportTable = () => {};
    window.renderMonitoringSectionLive = () => {};
    window.clearViolationAlertsForSession = () => {};

    const read = () => ({
      hidden: document.getElementById('btn-report-bulk-retake').hidden,
      label: document.getElementById('report-bulk-retake-count').textContent,
      selected: document.getElementById('report-selected-count').textContent,
    });

    const idle = read();
    toggleReportRowSelection('s2', true);
    const oneTicked = read();
    toggleReportSelectAll(true);
    const allTicked = read();

    return { idle, oneTicked, allTicked };
  });

  if (!reports.idle.hidden) throw new Error('The bulk retake button must stay hidden until rows are ticked.');
  if (reports.oneTicked.hidden || reports.oneTicked.label !== '1') {
    throw new Error(`One ticked row must offer one retake: ${JSON.stringify(reports.oneTicked)}`);
  }
  if (reports.allTicked.label !== '3' || reports.allTicked.selected !== '3 selected') {
    throw new Error(`Select-all must offer every ticked student: ${JSON.stringify(reports.allTicked)}`);
  }

  const granted = await page.evaluate(async () => {
    const before = window.__sessions.map(s => s.id);
    await allowSelectedRetakes();
    return {
      hidden: document.getElementById('btn-report-bulk-retake').hidden,
      before,
      updated: window.__updates.map(u => u.id),
      submitted: window.__sessions.map(s => s.submitted),
      scores: window.__sessions.map(s => s.score),
      history: window.__sessions.map(s => (s.attemptHistory || []).length),
      archivedScores: window.__sessions.map(s => s.attemptHistory?.[0]?.score ?? null),
      archivedBy: window.__sessions.map(s => s.attemptHistory?.[0]?.retakeAuthorization?.authorizedBy ?? null),
      toasts: window.__toasts,
    };
  });

  if (granted.updated.length !== 3 || new Set(granted.updated).size !== 3) {
    throw new Error(`Every ticked student must be reset exactly once: ${JSON.stringify(granted)}`);
  }
  if (granted.submitted.some(Boolean) || granted.scores.some(score => score !== null)) {
    throw new Error(`A granted retake must clear each submission: ${JSON.stringify(granted)}`);
  }
  if (granted.history.some(length => length !== 1)) {
    throw new Error(`Each finished attempt must be archived, not discarded: ${JSON.stringify(granted)}`);
  }
  if (granted.archivedScores.join(',') !== '18,15,12') {
    throw new Error(`The archived attempts must keep their scores: ${JSON.stringify(granted)}`);
  }
  if (granted.archivedBy.some(name => name !== 'Prof. Santos')) {
    throw new Error(`The grant must be traceable to the professor: ${JSON.stringify(granted)}`);
  }
  if (!granted.hidden) throw new Error('The selection is spent once granted, so the button must hide again.');
  if (!granted.toasts.some(message => /3 students/.test(message))) {
    throw new Error(`The professor must be told how many were granted: ${JSON.stringify(granted.toasts)}`);
  }

  // Nothing to grant must not silently look like success.
  const emptySelection = await page.evaluate(async () => {
    window.__toasts = [];
    await allowSelectedRetakes();
    return { updates: window.__updates.length, toasts: window.__toasts };
  });
  if (emptySelection.updates !== 3 || !emptySelection.toasts.some(m => /Tick the students/.test(m))) {
    throw new Error(`An empty selection must ask for one instead of resetting rows: ${JSON.stringify(emptySelection)}`);
  }

  if (errors.length) throw new Error(`Page errors: ${errors.join(' | ')}`);
  console.log('Monitoring search and bulk retake smoke tests passed.');
} finally {
  if (browser) await browser.close();
  await server.close();
}

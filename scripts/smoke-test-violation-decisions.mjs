// A violation a professor can see is a violation they must be able to act on.
// Camera Grid tiles have to open a review that offers confirm-or-dismiss even
// when no replay clip was stored, and browser-only violations (alt-tab, copy,
// fullscreen exit) have to be dismissible from the Activity Log — including
// after the attempt was submitted, which is when an accident gets noticed.
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
if (!executablePath) throw new Error('Chrome or Edge is required for the violation decision test.');

const PIXEL = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==';

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

  await page.evaluate((pixel) => {
    const exam = { id: 'e1', title: 'Midterm', status: 'active', requireCamera: true, questions: [{}], excludedStudentIds: [] };
    // One camera violation with a snapshot but no stored clip, and one
    // browser-only violation, on an attempt that has already been submitted.
    window.__sessions = [{
      id: 's1', examId: 'e1', studentId: '24-0001', studentName: 'Alice Cruz',
      submitted: true, startTime: '2026-09-24T01:00:00.000Z', endTime: '2026-09-24T01:30:00.000Z',
      answers: {}, warnings: 2,
      activities: [
        { type: 'no_person', timestamp: '2026-09-24T01:05:00.000Z', detail: 'No person detected in camera frame' },
        { type: 'tab_switch', timestamp: '2026-09-24T01:07:00.000Z', detail: 'Student switched tabs' },
      ],
      cameraSnapshots: [{
        kind: 'violation', violationType: 'no_person',
        timestamp: '2026-09-24T01:05:00.000Z', imageData: pixel,
      }],
    }];
    window.__requests = [];
    Object.assign(window.DB, {
      getExam: id => (id === 'e1' ? exam : null),
      getExams: () => [exam],
      getSubject: () => null,
      getStudents: () => [],
      getSessions: () => window.__sessions,
      getSessionsByExam: () => window.__sessions,
      getSession: id => window.__sessions.find(s => s.id === id),
      getStudentSession: () => window.__sessions[0],
      getMessagesForExamStudent: () => [],
      getLogs: () => [],
      addLog: () => {},
      updateSession: () => {},
      updateExam: () => {},
    });
    Object.assign(window.Auth, { getAdminSession: () => ({ id: 'admin-1', name: 'Prof. Santos' }) });
    window.SupabaseSync = null;

    window.showConfirm = () => Promise.resolve(true);
    window.__toasts = [];
    window.showToast = message => { window.__toasts.push(message); };
    window.renderMonitoringSectionLive = () => {};
    window.refreshOpenStudentLog = () => {};
    window.applyMonitorSessionsSnapshot = () => {};
    window.monitorApiRequest = (url, options = {}) => {
      window.__requests.push({ url, options });
      return Promise.resolve({ success: true, session: { id: 's1', exam_id: 'e1', warnings: 1 } });
    };
    window.resolveEvidencePlaybackUrl = () => Promise.resolve('blob:replay-clip');

    document.getElementById('test-root').innerHTML = `
      <select id="monitor-exam-select"><option value="e1" selected>Midterm</option></select>
      <span id="monitor-count"></span><span id="monitor-sort-btn-label"></span>
      <div id="camera-grid-view"><div id="camera-grid-container"></div><div id="camera-grid-empty"></div></div>
      <div id="monitoring-grid"><table><tbody id="monitor-tbody"></tbody></table></div>
      <div id="modal-camera-snap" class="modal-backdrop hidden">
        <span id="modal-cam-title"></span><img id="modal-cam-img" /><div id="modal-cam-time"></div><div id="modal-cam-empty"></div>
      </div>`;
    renderCameraGrid('e1');
  }, PIXEL);

  // ── A tile with no stored clip still has to be decidable ──────────────────
  const noClip = await page.evaluate(async () => {
    const tile = [...document.querySelectorAll('#camera-grid-container > *')]
      .find(el => el.textContent.includes('Alice Cruz'));
    if (!tile) return { error: 'no tile rendered' };
    tile.click();
    await new Promise(res => setTimeout(res, 60));
    const review = document.getElementById('modal-violation-review');
    const still = document.getElementById('violation-review-still');
    return {
      reviewOpen: !!review && !review.classList.contains('hidden'),
      snapshotShown: !!still && still.style.display !== 'none' && !!still.getAttribute('src'),
      emptyNote: document.getElementById('violation-review-empty')?.textContent || '',
      status: document.getElementById('violation-review-status')?.textContent || '',
      actionsShown: document.getElementById('violation-review-actions')?.style.display !== 'none',
      dismissLabel: document.getElementById('violation-review-dismiss-btn')?.textContent || '',
      confirmLabel: document.getElementById('violation-review-confirm-btn')?.textContent || '',
      snapshotModalOpen: !document.getElementById('modal-camera-snap').classList.contains('hidden'),
    };
  });
  check(noClip.reviewOpen, `A Camera Grid tile with no clip did not open a review: ${JSON.stringify(noClip)}`);
  check(!noClip.snapshotModalOpen, `The tile fell back to the plain snapshot viewer, which offers no decision: ${JSON.stringify(noClip)}`);
  check(noClip.snapshotShown, `The captured frame must stand in for the missing clip: ${JSON.stringify(noClip)}`);
  check(/no replay clip was stored/i.test(noClip.emptyNote), `The review must say why there is no video: ${JSON.stringify(noClip.emptyNote)}`);
  check(noClip.actionsShown, `The decision row must be available without a clip: ${JSON.stringify(noClip)}`);
  check(/dismiss warning/i.test(noClip.dismissLabel), `A clipless review must offer to dismiss the warning: ${JSON.stringify(noClip.dismissLabel)}`);
  check(/keep warning/i.test(noClip.confirmLabel), `A clipless review must offer to keep the warning: ${JSON.stringify(noClip.confirmLabel)}`);

  // ── Dismissing from that review reaches the server and closes ─────────────
  const dismissed = await page.evaluate(async () => {
    window.__requests = [];
    const button = document.getElementById('violation-review-dismiss-btn');
    if (!button) return { requests: [], closed: false, toasts: window.__toasts, missing: true };
    button.click();
    await new Promise(res => setTimeout(res, 80));
    const review = document.getElementById('modal-violation-review');
    return {
      requests: window.__requests.map(r => ({ url: r.url, body: r.options?.body || null })),
      closed: review.classList.contains('hidden'),
      toasts: window.__toasts,
    };
  });
  check(!dismissed.missing, 'A clipless review never put a dismiss action on screen.');
  const dismissCall = dismissed.requests.find(r => /warnings\/dismiss$/.test(r.url));
  check(!!dismissCall, `Dismissing from the review must call the warning-dismiss endpoint: ${JSON.stringify(dismissed.requests)}`);
  check(
    dismissCall?.body?.activityIndex === 0,
    `The dismissal must name the activity behind this tile: ${JSON.stringify(dismissCall?.body)}`,
  );
  check(dismissed.closed, `The review should close once the warning is dismissed: ${JSON.stringify(dismissed)}`);

  // ── A stored clip still decides on the evidence itself ────────────────────
  const withClip = await page.evaluate(async () => {
    processIncomingViolationEvidence({
      id: 'ev-1', examId: 'e1', sessionId: 's1', violationType: 'no_person',
      triggeredAt: '2026-09-24T01:05:00.000Z', createdAt: '2026-09-24T01:05:01.000Z',
      storageBucket: 'local-server', storagePath: 'clips/ev-1.webm',
      playbackUrl: '/api/monitor/replay/ev-1', reviewStatus: 'pending',
    });
    await openViolationReview('s1', 0);
    await new Promise(res => setTimeout(res, 60));
    return {
      videoSrc: document.getElementById('violation-review-video')?.getAttribute('src') || '',
      stillHidden: document.getElementById('violation-review-still')?.style.display === 'none',
      dismissLabel: document.getElementById('violation-review-dismiss-btn')?.textContent || '',
      confirmLabel: document.getElementById('violation-review-confirm-btn')?.textContent || '',
    };
  });
  check(withClip.videoSrc === 'blob:replay-clip', `A stored clip must still play: ${JSON.stringify(withClip)}`);
  check(withClip.stillHidden, `The still frame must give way to the replay: ${JSON.stringify(withClip)}`);
  check(/dismiss violation/i.test(withClip.dismissLabel), `With a clip, the decision is on the violation: ${JSON.stringify(withClip.dismissLabel)}`);
  check(/confirm violation/i.test(withClip.confirmLabel), `With a clip, the decision is on the violation: ${JSON.stringify(withClip.confirmLabel)}`);

  // ── Browser-only violations are dismissible from the Activity Log ─────────
  const log = await page.evaluate(() => {
    const session = window.__sessions[0];
    const html = buildStudentLogBody(session);
    const holder = document.createElement('div');
    holder.innerHTML = html;
    const rows = [...holder.querySelectorAll('.activity-log-timeline-card')].map(card => ({
      type: card.querySelector('.log-type')?.textContent?.trim() || '',
      dismiss: !!card.querySelector('.activity-log-dismiss-warning-btn'),
      dismissArgs: card.querySelector('.activity-log-dismiss-warning-btn')?.getAttribute('onclick') || '',
      badge: card.querySelector('.activity-log-review-badge')?.textContent?.trim() || '',
    }));

    // Once dismissed, the row states that instead of offering it again.
    const already = JSON.parse(JSON.stringify(session));
    already.activities[1].metadata = { warningDismissed: true, warningDismissedAt: '2026-09-24T02:00:00.000Z' };
    const holder2 = document.createElement('div');
    holder2.innerHTML = buildStudentLogBody(already);
    const dismissedRow = [...holder2.querySelectorAll('.activity-log-timeline-card')]
      .find(card => /tab/i.test(card.querySelector('.log-type')?.textContent || ''));
    return {
      rows,
      dismissedRowBadge: dismissedRow?.querySelector('.activity-log-review-badge')?.textContent?.trim() || '',
      dismissedRowStillOffers: !!dismissedRow?.querySelector('.activity-log-dismiss-warning-btn'),
    };
  });
  const browserRow = log.rows.find(row => /tab/i.test(row.type));
  check(
    !!browserRow?.dismiss,
    `A browser-activity violation must offer "Dismiss warning" in the Activity Log: ${JSON.stringify(log.rows)}`,
  );
  check(
    browserRow?.dismissArgs.includes('1'),
    `The dismissal must name that activity's own index: ${JSON.stringify(browserRow?.dismissArgs)}`,
  );
  check(
    /warning dismissed/i.test(log.dismissedRowBadge) && !log.dismissedRowStillOffers,
    `An already-dismissed warning must say so instead of offering again: ${JSON.stringify(log)}`,
  );

  check(!errors.length, `Page errors: ${errors.join(' | ')}`);
  if (failures.length) {
    throw new Error(`Violation decision failures:\n- ${failures.join('\n- ')}`);
  }
  console.log('Violation decision tests passed.');
} finally {
  if (browser) await browser.close();
  await server.close();
}

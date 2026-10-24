// A violation a professor can see is a violation they must be able to act on.
// Every type — webcam, FaceMesh, YOLO and browser-only (alt-tab, copy,
// fullscreen exit) — opens the same review with confirm and dismiss, with or
// without a replay clip, including after the attempt was submitted, which is
// when an accident gets noticed. Both decisions go to one endpoint per activity.
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
        { type: 'FACE_LIVENESS_UNCONFIRMED', timestamp: '2026-09-24T01:09:00.000Z', detail: 'Liveness check not answered', metadata: { source: 'FACEMESH', countsAsWarning: false } },
        { type: 'browser_exam_start', timestamp: '2026-09-24T01:00:00.000Z', detail: 'Browser examination session started' },
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
      actionsShown: document.getElementById('violation-review-actions')?.style.display !== 'none',
      dismissLabel: document.getElementById('violation-review-dismiss-btn')?.textContent || '',
      confirmLabel: document.getElementById('violation-review-confirm-btn')?.textContent || '',
      hint: document.getElementById('violation-review-reviewed')?.textContent || '',
      snapshotModalOpen: !document.getElementById('modal-camera-snap').classList.contains('hidden'),
    };
  });
  check(noClip.reviewOpen, `A Camera Grid tile with no clip did not open a review: ${JSON.stringify(noClip)}`);
  check(!noClip.snapshotModalOpen, `The tile fell back to the plain snapshot viewer, which offers no decision: ${JSON.stringify(noClip)}`);
  check(noClip.snapshotShown, `The captured frame must stand in for the missing clip: ${JSON.stringify(noClip)}`);
  check(/no replay clip was stored/i.test(noClip.emptyNote), `The review must say why there is no video: ${JSON.stringify(noClip.emptyNote)}`);
  check(noClip.actionsShown, `The decision row must be available without a clip: ${JSON.stringify(noClip)}`);
  check(/dismiss violation/i.test(noClip.dismissLabel) && /confirm violation/i.test(noClip.confirmLabel),
    `Every review offers both decisions: ${JSON.stringify(noClip)}`);
  check(/removes the warning/i.test(noClip.hint), `The review must say dismissing gives the warning back: ${JSON.stringify(noClip.hint)}`);

  // ── Both decisions reach the one review endpoint for that activity ────────
  const decided = await page.evaluate(async () => {
    window.__requests = [];
    document.getElementById('violation-review-dismiss-btn').click();
    await new Promise(res => setTimeout(res, 80));
    document.getElementById('violation-review-confirm-btn').click();
    await new Promise(res => setTimeout(res, 80));
    return window.__requests.map(r => ({ url: r.url, method: r.options?.method, body: r.options?.body || null }));
  });
  check(decided.length === 2, `Dismiss and confirm must each save: ${JSON.stringify(decided)}`);
  check(decided.every(r => r.url === '/api/monitor/sessions/s1/activities/0/review' && r.method === 'PATCH'),
    `Decisions must name the activity behind the tile: ${JSON.stringify(decided)}`);
  check(decided[0]?.body?.reviewStatus === 'dismissed' && decided[1]?.body?.reviewStatus === 'confirmed',
    `Decisions must carry what was chosen: ${JSON.stringify(decided)}`);

  // ── A stored clip plays, and is named in the decision ─────────────────────
  const withClip = await page.evaluate(async () => {
    processIncomingViolationEvidence({
      id: 'ev-1', examId: 'e1', sessionId: 's1', violationType: 'no_person',
      triggeredAt: '2026-09-24T01:05:00.000Z', createdAt: '2026-09-24T01:05:01.000Z',
      storageBucket: 'local-server', storagePath: 'clips/ev-1.webm', durationMs: 12000,
      playbackUrl: '/api/monitor/replay/ev-1', reviewStatus: 'pending',
    });
    await openViolationReview('s1', 0);
    await new Promise(res => setTimeout(res, 60));
    window.__requests = [];
    document.getElementById('violation-review-dismiss-btn').click();
    await new Promise(res => setTimeout(res, 80));
    return {
      videoSrc: document.getElementById('violation-review-video')?.getAttribute('src') || '',
      stillHidden: document.getElementById('violation-review-still')?.style.display === 'none',
      mediaLabel: document.getElementById('violation-review-media-label')?.textContent || '',
      request: window.__requests[0] ? { url: window.__requests[0].url, body: window.__requests[0].options?.body } : null,
    };
  });
  check(withClip.videoSrc === 'blob:replay-clip', `A stored clip must still play: ${JSON.stringify(withClip)}`);
  check(withClip.stillHidden, `The still frame must give way to the replay: ${JSON.stringify(withClip)}`);
  // A 12 s clip is played as its last ten seconds, and labelled that way.
  check(/last 10 seconds before detection/i.test(withClip.mediaLabel), `The replay length must be stated, capped at ten seconds: ${JSON.stringify(withClip.mediaLabel)}`);
  check(withClip.request?.body?.evidenceId === 'ev-1', `A decision on a replay must name its evidence: ${JSON.stringify(withClip.request)}`);

  // ── Browser-only violations are reviewable from the Activity Log ──────────
  const log = await page.evaluate(async () => {
    const session = window.__sessions[0];
    const holder = document.createElement('div');
    holder.innerHTML = buildStudentLogBody(session);
    const rows = [...holder.querySelectorAll('.activity-log-timeline-card')].map(card => ({
      type: card.querySelector('.log-type')?.textContent?.trim() || '',
      review: card.querySelector('.activity-log-review-btn')?.getAttribute('onclick') || '',
      badges: [...card.querySelectorAll('.activity-log-review-badge')].map(b => b.textContent.trim()),
    }));

    await openViolationReview('s1', 1);
    await new Promise(res => setTimeout(res, 60));
    const browserReview = {
      videoHidden: document.getElementById('violation-review-video')?.style.display === 'none',
      stillHidden: document.getElementById('violation-review-still')?.style.display === 'none',
      labelHidden: document.getElementById('violation-review-media-label')?.style.display === 'none',
      emptyNote: document.getElementById('violation-review-empty')?.textContent || '',
    };
    window.__requests = [];
    document.getElementById('violation-review-confirm-btn').click();
    await new Promise(res => setTimeout(res, 80));
    browserReview.request = window.__requests[0] ? { url: window.__requests[0].url, body: window.__requests[0].options?.body } : null;

    // Once decided, the row states the decision and offers to change it.
    const decided = JSON.parse(JSON.stringify(session));
    decided.activities[1].metadata = { reviewStatus: 'dismissed', warningDismissed: true, warningDismissedAt: '2026-09-24T02:00:00.000Z' };
    decided.activities[2].metadata = { source: 'FACEMESH', countsAsWarning: false };
    const holder2 = document.createElement('div');
    holder2.innerHTML = buildStudentLogBody(decided);
    const cards = [...holder2.querySelectorAll('.activity-log-timeline-card')];
    const card = type => cards.find(c => (c.querySelector('.log-type')?.textContent || '').includes(type));
    return {
      rows,
      browserReview,
      dismissedBadges: [...(card('Tab')?.querySelectorAll('.activity-log-review-badge') || [])].map(b => b.textContent.trim()),
      dismissedButton: card('Tab')?.querySelector('.activity-log-review-btn')?.textContent?.trim() || '',
      reviewOnlyBadges: [...(card('Liveness')?.querySelectorAll('.activity-log-review-badge') || [])].map(b => b.textContent.trim()),
    };
  });
  const browserRow = log.rows.find(row => /tab/i.test(row.type));
  check(/openViolationReview\('s1', 1\)/.test(browserRow?.review || ''),
    `A browser-activity violation must offer a review of its own row: ${JSON.stringify(log.rows)}`);
  check(log.rows.every(row => !/browser exam start/i.test(row.type) || !row.review),
    `Routine activity must not offer a review: ${JSON.stringify(log.rows)}`);
  check(log.browserReview.videoHidden && log.browserReview.stillHidden && log.browserReview.labelHidden,
    `A browser violation has no camera footage to show: ${JSON.stringify(log.browserReview)}`);
  check(/no camera footage/i.test(log.browserReview.emptyNote), `The review must say why: ${JSON.stringify(log.browserReview)}`);
  check(log.browserReview.request?.url === '/api/monitor/sessions/s1/activities/1/review'
    && log.browserReview.request?.body?.reviewStatus === 'confirmed',
  `Confirming a browser violation must save: ${JSON.stringify(log.browserReview.request)}`);
  check(log.dismissedBadges.some(text => /dismissed \(warning removed\)/i.test(text)) && /change decision/i.test(log.dismissedButton),
    `A decided row must say so and offer to change it: ${JSON.stringify(log)}`);
  check(log.reviewOnlyBadges.some(text => /no warning was issued/i.test(text)),
    `A review-only indicator must say it cost no warning: ${JSON.stringify(log.reviewOnlyBadges)}`);

  check(!errors.length, `Page errors: ${errors.join(' | ')}`);
  if (failures.length) {
    throw new Error(`Violation decision failures:\n- ${failures.join('\n- ')}`);
  }
  console.log('Violation decision tests passed.');
} finally {
  if (browser) await browser.close();
  await server.close();
}

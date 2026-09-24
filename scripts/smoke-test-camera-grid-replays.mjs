// Camera Grid replays must survive a live alert burst. Every violation event
// that pops an alert modal also forces a session poll and an evidence refresh,
// and each of those repaints monitoring — so this drives the real admin.js and
// checks that the repaint neither tears the tiles down nor pulls the replay out
// from under a professor who is watching one.
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
if (!executablePath) throw new Error('Chrome or Edge is required for the Camera Grid replay smoke test.');

// A 1x1 GIF stands in for a webcam snapshot: the point is the DOM node holding
// it, not the picture.
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
  // leftover SupabaseSync can still emit. This shell is not that panel, so the
  // boot is stopped at the window before it reaches admin.js.
  await page.evaluate(() => {
    window.addEventListener('dbReady', e => e.stopImmediatePropagation(), true);
  });

  await page.evaluate((pixel) => {
    const exam = {
      id: 'e1',
      title: 'Midterm',
      status: 'active',
      requireCamera: true,
      questions: [{}, {}],
      excludedStudentIds: [],
    };
    const snapshot = (timestamp, violationType) => ({
      kind: 'violation', violationType, timestamp, imageData: pixel,
    });
    window.__sessions = [
      {
        id: 's1', examId: 'e1', studentId: '24-0001', studentName: 'Alice Cruz',
        submitted: false, startTime: '2026-09-24T01:00:00.000Z', answers: {}, warnings: 1,
        activities: [{ type: 'no_person', timestamp: '2026-09-24T01:05:00.000Z', detail: 'No person in frame' }],
        cameraSnapshots: [snapshot('2026-09-24T01:05:00.000Z', 'no_person')],
      },
      {
        id: 's2', examId: 'e1', studentId: '24-0002', studentName: 'Bob Diaz',
        submitted: false, startTime: '2026-09-24T01:00:00.000Z', answers: {}, warnings: 2,
        activities: [{ type: 'multiple_people', timestamp: '2026-09-24T01:06:00.000Z', detail: 'Two faces' }],
        cameraSnapshots: [snapshot('2026-09-24T01:06:00.000Z', 'multiple_people')],
      },
    ];
    Object.assign(window.DB, {
      getExam: id => (id === 'e1' ? exam : null),
      getExams: () => [exam],
      getSubject: () => null,
      getStudents: () => [],
      getSessions: () => window.__sessions,
      getSessionsByExam: () => window.__sessions,
      getSession: id => window.__sessions.find(s => s.id === id),
      getStudentSession: (examId, studentId) => window.__sessions.find(s => s.studentId === studentId),
      getMessagesForExamStudent: () => [],
      getLogs: () => [],
      addLog: () => {},
      updateSession: () => {},
      updateExam: () => {},
    });
    Object.assign(window.Auth, { getAdminSession: () => ({ id: 'admin-1', name: 'Prof. Santos' }) });
    window.SupabaseSync = null;

    // The network is out of scope here: the evidence store is fed directly, the
    // same way the WebSocket push does it.
    window.monitorApiRequest = () => Promise.resolve({ success: true, evidence: [] });
    window.playViolationSound = () => Promise.resolve();
    window.addBellNotification = () => {};
    window.readDismissedNotificationIds = () => new Set();
    window.rememberDismissedNotificationIds = () => {};

    window.__revoked = [];
    const realRevoke = URL.revokeObjectURL.bind(URL);
    URL.revokeObjectURL = (url) => { window.__revoked.push(url); realRevoke(url); };
    window.resolveEvidencePlaybackUrl = () => new Promise(res => setTimeout(() => res('blob:replay-clip'), 10));

    document.getElementById('test-root').innerHTML = `
      <select id="monitor-exam-select"></select>
      <div id="log-body"></div><span id="log-student-name"></span>
      <span id="monitor-count"></span><span id="monitor-sort-btn-label"></span>
      <input id="monitor-filter-search" /><button id="monitor-filter-clear" hidden></button>
      <button id="monitor-view-table"></button><button id="monitor-view-camera"></button>
      <div id="camera-grid-view"><div id="camera-grid-container"></div><div id="camera-grid-empty"></div></div>
      <div id="monitoring-grid"><table><tbody id="monitor-tbody"></tbody></table></div>
      <span id="topbar-title"></span>
      <div id="sidebar"></div><div id="sidebar-overlay"></div>
      <span id="sb-school-name"></span><span id="sb-admin-name"></span>
      <section id="section-monitoring" class="admin-section"></section>`;

    window.updateExamDeadlineDisplays = () => {};
    window.syncMonitorLiveBadge = () => {};
    window.pollMonitorSessions = () => Promise.resolve();
    window.refreshOpenStudentLog = () => {};
    // Real section state, without the pollers: currentSection gates the very
    // repaints this test is about.
    window.startMonitoring = () => {};
    window.stopMonitoring = () => {};
    window.stopSectionPoll = () => {};
    window.closeAIGen = () => {};
    window.writeAdminSectionToUrl = () => {};
    window.__sectionReady = showSection('monitoring');
    processIncomingViolationEvidence({
      id: 'ev-1', examId: 'e1', sessionId: 's1', violationType: 'no_person',
      triggeredAt: '2026-09-24T01:05:00.000Z', createdAt: '2026-09-24T01:05:01.000Z',
      storageBucket: 'local-server', storagePath: 'clips/ev-1.webm',
      playbackUrl: '/api/monitor/replay/ev-1', reviewStatus: 'pending',
    });
    setMonitorView('camera');
  }, PIXEL);

  await page.evaluate(() => window.__sectionReady);
  const section = await page.evaluate(() => ({ camera: document.getElementById('camera-grid-view').style.display }));
  check(section.camera !== 'none', `Camera Grid must be the visible monitoring view: ${JSON.stringify(section)}`);

  const readGrid = () => page.evaluate(() => {
    const container = document.getElementById('camera-grid-container');
    return {
      tiles: container.children.length,
      // A badge counts only when it is actually offered to the professor.
      replayBadges: [...container.querySelectorAll('div')]
        .filter(el => el.textContent.trim() === 'Replay ready' && el.style.display !== 'none').length,
      names: [...container.querySelectorAll('img')].map(img => img.getAttribute('alt')),
      // Tags survive only if the tiles themselves survive the repaint.
      tagged: [...container.querySelectorAll('img')].filter(img => img.__probe === true).length,
      display: container.style.display,
    };
  });

  const initial = await readGrid();
  check(!(initial.tiles !== 2), `Camera Grid should show one tile per violation snapshot: ${JSON.stringify(initial)}`);
  check(!(initial.replayBadges !== 1), `Only the snapshot with stored evidence is replay-ready: ${JSON.stringify(initial)}`);

  // ── An alert burst must not tear the grid down ─────────────────────────────
  const burst = await page.evaluate(async () => {
    document.querySelectorAll('#camera-grid-container img').forEach((img) => { img.__probe = true; });
    const before = document.querySelectorAll('#camera-grid-container img').length;

    // What a live violation does: repaint monitoring, then force an evidence
    // refresh, several times over, exactly as a run of alerts would.
    for (let i = 0; i < 4; i++) {
      renderMonitoringSectionLive();
      await refreshViolationEvidence({ examId: 'e1', force: true, silent: false });
    }

    const imgs = [...document.querySelectorAll('#camera-grid-container img')];
    return { before, after: imgs.length, survived: imgs.filter(img => img.__probe === true).length };
  });
  check(!(burst.after !== burst.before), `An alert burst changed the tile count: ${JSON.stringify(burst)}`);
  check(!(burst.survived !== burst.before), `Camera Grid tiles were destroyed and rebuilt during an alert burst, which is what makes replays blink out: ${JSON.stringify(burst)}`);

  // A genuinely new snapshot still has to appear, without disturbing the rest.
  const grown = await page.evaluate(() => {
    window.__sessions[1].cameraSnapshots.push({
      kind: 'violation', violationType: 'camera_off',
      timestamp: '2026-09-24T01:09:00.000Z',
      imageData: document.querySelector('#camera-grid-container img').getAttribute('src'),
    });
    renderCameraGrid('e1');
    const imgs = [...document.querySelectorAll('#camera-grid-container img')];
    return { tiles: imgs.length, survived: imgs.filter(img => img.__probe === true).length };
  });
  check(!(grown.tiles !== 3 || grown.survived !== 2), `A new snapshot must be added alongside the existing tiles: ${JSON.stringify(grown)}`);

  // ── A replay being watched must survive the same burst ─────────────────────
  const replay = await page.evaluate(async () => {
    const tile = [...document.querySelectorAll('#camera-grid-container > *')]
      .find(el => el.textContent.includes('Alice Cruz'));
    if (!tile) return { opened: '(no tile for this student)', still: '', revoked: [], modalOpen: false, notes: '' };
    tile.click();
    await new Promise(res => setTimeout(res, 60));
    const video = document.getElementById('violation-review-video');
    if (!video) return { opened: '(clicking the tile never opened the replay)', still: '', revoked: [], modalOpen: false, notes: '' };
    const opened = video.getAttribute('src');
    window.__revoked = [];

    // An alert arrives for another student while this replay is on screen.
    processIncomingViolationEvidence({
      id: 'ev-2', examId: 'e1', sessionId: 's2', violationType: 'multiple_people',
      triggeredAt: '2026-09-24T01:06:00.000Z', createdAt: '2026-09-24T01:06:01.000Z',
      storageBucket: 'local-server', storagePath: 'clips/ev-2.webm',
      playbackUrl: '/api/monitor/replay/ev-2', reviewStatus: 'pending',
    });
    // And the refresh that every alerted event forces.
    await refreshViolationEvidence({ examId: 'e1', force: true, silent: false });
    await new Promise(res => setTimeout(res, 40));

    return {
      opened,
      still: video.getAttribute('src'),
      revoked: window.__revoked,
      modalOpen: !document.getElementById('modal-violation-review').classList.contains('hidden'),
    };
  });
  check(!(replay.opened !== 'blob:replay-clip'), `Clicking a replay-ready tile did not load its clip: ${JSON.stringify(replay)}`);
  check(!(!replay.modalOpen), 'The review modal must stay open through an alert burst.');
  check(!(replay.revoked.includes('blob:replay-clip')), `The replay a professor is watching was revoked mid-playback: ${JSON.stringify(replay)}`);
  check(!(replay.still !== 'blob:replay-clip'), `The replay was pulled out of the player during an alert burst: ${JSON.stringify(replay)}`);

  // Repaints and socket pushes both re-enter openViolationReview for the review
  // already on screen. Re-showing the same clip must be a no-op, not a reload:
  // revoking the blob behind a playing <video> is what empties the player.
  const reshow = await page.evaluate(async () => {
    const video = document.getElementById('violation-review-video');
    if (!video) return { afterReopen: { src: '', revoked: [] }, src: '(no player)', revoked: [], status: '', notes: '' };
    window.__revoked = [];
    await openViolationReview('s1', 0);
    const afterReopen = { src: video.getAttribute('src'), revoked: [...window.__revoked] };

    // Half-written review notes are work in progress, not a stale field to be
    // overwritten by the next repaint.
    document.getElementById('violation-review-notes').value = 'Checking with the student';

    // The same student trips another violation, so evidence lands for the very
    // session being reviewed.
    window.__revoked = [];
    processIncomingViolationEvidence({
      id: 'ev-1', examId: 'e1', sessionId: 's1', violationType: 'no_person',
      triggeredAt: '2026-09-24T01:05:00.000Z', createdAt: '2026-09-24T01:05:01.000Z',
      storageBucket: 'local-server', storagePath: 'clips/ev-1.webm',
      playbackUrl: '/api/monitor/replay/ev-1', reviewStatus: 'confirmed',
    });
    await new Promise(res => setTimeout(res, 40));

    return {
      afterReopen,
      src: video.getAttribute('src'),
      revoked: window.__revoked,
      status: document.getElementById('violation-review-status')?.textContent || '',
      notes: document.getElementById('violation-review-notes').value,
    };
  });
  check(
    !(reshow.afterReopen.revoked.includes('blob:replay-clip') || reshow.afterReopen.src !== 'blob:replay-clip'),
    `Re-showing the same review discarded the loaded replay: ${JSON.stringify(reshow.afterReopen)}`,
  );
  check(
    !(reshow.revoked.includes('blob:replay-clip') || reshow.src !== 'blob:replay-clip'),
    `Evidence arriving for the student being watched emptied the player: ${JSON.stringify(reshow)}`,
  );
  check(
    reshow.notes === 'Checking with the student',
    `A repaint overwrote the review notes being typed: ${JSON.stringify(reshow.notes)}`,
  );
  check(
    /reviewed/i.test(reshow.status),
    `The review status must still update in place: ${JSON.stringify(reshow.status)}`,
  );

  const updatedInPlace = await page.evaluate(() => {
    const tile = [...document.querySelectorAll('#camera-grid-container [data-tile-key]')]
      .find(el => el.dataset.tileKey.includes("2026-09-24T01:06:00.000Z") && el.dataset.tileKey.startsWith("s2|"));
    if (!tile) return { sameNode: false, sameImage: false, sameBadgeNode: false, replayOffered: false, warning: '(no addressable tile)' };
    const img = tile?.querySelector('img');
    const badge = tile?.querySelector('div[data-replay-ready]');
    window.__sessions[1].warnings = 3;
    renderCameraGrid('e1');
    const sameTile = [...document.querySelectorAll('#camera-grid-container [data-tile-key]')]
      .find(el => el.dataset.tileKey.includes("2026-09-24T01:06:00.000Z") && el.dataset.tileKey.startsWith("s2|"));
    return {
      sameNode: sameTile === tile,
      sameImage: sameTile?.querySelector('img') === img,
      sameBadgeNode: sameTile?.querySelector('div[data-replay-ready]') === badge,
      // ev-2 landed for this student during the replay step, so the badge it
      // did not have at first render must be showing now.
      replayOffered: badge?.style.display !== 'none',
      warning: sameTile?.querySelector('div[data-warn-tone]')?.textContent?.trim()
        || sameTile?.querySelector('.camera-grid-warn')?.textContent?.trim() || '',
    };
  });
  check(
    updatedInPlace.sameNode && updatedInPlace.sameImage && updatedInPlace.sameBadgeNode,
    `A repaint replaced the tile instead of updating it: ${JSON.stringify(updatedInPlace)}`,
  );
  check(
    updatedInPlace.replayOffered,
    `A replay that finished uploading was never offered on its existing tile: ${JSON.stringify(updatedInPlace)}`,
  );
  check(
    /3\/3/.test(updatedInPlace.warning),
    `The warning count on a surviving tile went stale: ${JSON.stringify(updatedInPlace)}`,
  );

  // ── A dropped exam selection must not erase loaded evidence ────────────────
  const withoutExam = await page.evaluate(async () => {
    const before = getSessionEvidenceRecords('s1').length;
    await refreshViolationEvidence({ examId: '', silent: true });
    return { before, after: getSessionEvidenceRecords('s1').length };
  });
  check(!(withoutExam.before < 1 || withoutExam.after !== withoutExam.before), `A refresh with no exam id wiped the replay evidence: ${JSON.stringify(withoutExam)}`);

  check(!errors.length, `Page errors: ${errors.join(' | ')}`);
  if (failures.length) {
    throw new Error(`Camera Grid replay failures:\n- ${failures.join(`\n- `)}`);
  }
  console.log('Camera Grid replay smoke tests passed.');
} finally {
  if (browser) await browser.close();
  await server.close();
}

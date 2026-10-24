// A replay is the ten seconds before detection and nothing more. The student's
// browser stores clips of 10-20 s, so this records a real MediaRecorder WebM
// longer than ten seconds - with no duration in its header, exactly like the
// exam page's clips - plays it through the review player in a real browser, and
// checks the professor can neither watch nor scrub past those ten seconds.
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
if (!executablePath) throw new Error('Chrome or Edge is required for the replay window test.');

// Long enough to prove the cut, short enough to keep the test quick.
const CLIP_SECONDS = 14;

const failures = [];
const check = (ok, message) => { if (!ok) failures.push(message); };
const near = (value, expected, tolerance = 0.35) => Math.abs(Number(value) - expected) <= tolerance;

const port = await availablePort();
const server = await createServer({ server: { host: '127.0.0.1', port, strictPort: true, hmr: false } });
let browser;
try {
  await server.listen();
  browser = await chromium.launch({ executablePath, headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${port}/css/style.css`, { waitUntil: 'domcontentloaded' });
  await page.setContent('<!doctype html><html><head></head><body><main id="test-root"></main></body></html>');
  for (const src of ['/js/supabase-sync.js', '/js/data.js', '/js/auth.js', '/js/admin.js']) {
    await page.addScriptTag({ url: `http://127.0.0.1:${port}${src}` });
  }

  await page.evaluate(async (clipSeconds) => {
    // Recorded the way the exam page records: MediaRecorder on a live stream,
    // one-second chunks, no duration written into the file.
    const canvas = document.createElement('canvas');
    canvas.width = 160;
    canvas.height = 120;
    const ctx = canvas.getContext('2d');
    let frame = 0;
    const paint = setInterval(() => {
      ctx.fillStyle = `hsl(${(frame += 7) % 360} 70% 50%)`;
      ctx.fillRect(0, 0, 160, 120);
    }, 66);
    const recorder = new MediaRecorder(canvas.captureStream(15), { mimeType: 'video/webm;codecs=vp8' });
    const chunks = [];
    recorder.ondataavailable = event => { if (event.data?.size) chunks.push(event.data); };
    const stopped = new Promise(res => { recorder.onstop = res; });
    recorder.start(1000);
    await new Promise(res => setTimeout(res, clipSeconds * 1000));
    recorder.stop();
    await stopped;
    clearInterval(paint);
    window.__clipUrl = URL.createObjectURL(new Blob(chunks, { type: 'video/webm' }));

    const exam = { id: 'e1', title: 'Midterm', status: 'active', requireCamera: true, questions: [{}], excludedStudentIds: [] };
    window.__sessions = [{
      id: 's1', examId: 'e1', studentId: '24-0001', studentName: 'Alice Cruz',
      submitted: false, startTime: '2026-09-24T01:00:00.000Z', answers: {}, warnings: 1,
      activities: [{ type: 'restricted_phone', timestamp: '2026-09-24T01:05:00.000Z', detail: 'A mobile phone was detected.' }],
      cameraSnapshots: [],
    }];
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
    window.renderMonitoringSectionLive = () => {};
    window.refreshOpenStudentLog = () => {};
    window.applyMonitorSessionsSnapshot = () => {};
    window.monitorApiRequest = () => Promise.resolve({ success: true, evidence: [] });
    window.resolveEvidencePlaybackUrl = () => Promise.resolve(window.__clipUrl);
    document.getElementById('test-root').innerHTML = `
      <select id="monitor-exam-select"><option value="e1" selected>Midterm</option></select>
      <div id="camera-grid-view"><div id="camera-grid-container"></div><div id="camera-grid-empty"></div></div>`;

    processIncomingViolationEvidence({
      id: 'ev-1', examId: 'e1', sessionId: 's1', violationType: 'restricted_phone',
      triggeredAt: '2026-09-24T01:05:00.000Z', createdAt: '2026-09-24T01:05:01.000Z',
      storageBucket: 'local-server', storagePath: 'clips/ev-1.webm', durationMs: clipSeconds * 1000,
      playbackUrl: '/api/monitor/replay/ev-1', reviewStatus: 'pending',
    });
    await openViolationReview('s1', 0);
  }, CLIP_SECONDS);

  await page.waitForFunction(() => _replayWindow.ready === true, null, { timeout: 15000 });

  const opened = await page.evaluate(() => {
    const video = document.getElementById('violation-review-video');
    return {
      duration: video.duration,
      start: _replayWindow.start,
      end: _replayWindow.end,
      currentTime: video.currentTime,
      clock: document.getElementById('violation-review-clock').textContent,
      seekMax: document.getElementById('violation-review-seek').max,
      nativeControls: video.hasAttribute('controls'),
      controlsShown: document.getElementById('violation-review-controls').style.display !== 'none',
      label: document.getElementById('violation-review-media-label').textContent,
    };
  });
  check(
    Number.isFinite(opened.duration) && near(opened.end, opened.duration, 0.01) && near(opened.end, CLIP_SECONDS, 1.2),
    `The clip's real length must be read from the file, not guessed: ${JSON.stringify(opened)}`,
  );
  check(near(opened.end - opened.start, 10, 0.01), `The playable window must be exactly ten seconds: ${JSON.stringify(opened)}`);
  check(near(opened.currentTime, opened.start), `The replay must open at the start of the last ten seconds: ${JSON.stringify(opened)}`);
  check(opened.clock === '0:00 / 0:10', `The clock must span ten seconds: ${JSON.stringify(opened)}`);
  check(Number(opened.seekMax) === 10, `The scrubber must span ten seconds: ${JSON.stringify(opened)}`);
  check(!opened.nativeControls, 'The browser\'s own controls show the whole file and must not be used.');
  check(opened.controlsShown, 'The replay controls must be shown with the clip.');
  check(/last 10 seconds/i.test(opened.label), `The label must say ten seconds: ${JSON.stringify(opened.label)}`);

  // Anything that tries to go back before the window is held at its start.
  const rewound = await page.evaluate(async () => {
    const video = document.getElementById('violation-review-video');
    video.currentTime = 0;
    await new Promise(res => setTimeout(res, 400));
    return { currentTime: video.currentTime, start: _replayWindow.start };
  });
  check(rewound.currentTime >= rewound.start - 0.06, `Seeking before the window must be refused: ${JSON.stringify(rewound)}`);

  const scrubbed = await page.evaluate(async () => {
    const video = document.getElementById('violation-review-video');
    const seek = document.getElementById('violation-review-seek');
    seek.value = '5';
    seek.dispatchEvent(new Event('input'));
    await new Promise(res => setTimeout(res, 400));
    return { currentTime: video.currentTime, start: _replayWindow.start, clock: document.getElementById('violation-review-clock').textContent };
  });
  check(near(scrubbed.currentTime, scrubbed.start + 5), `The scrubber must move within the window: ${JSON.stringify(scrubbed)}`);
  check(scrubbed.clock.startsWith('0:05') || scrubbed.clock.startsWith('0:04'), `The clock must follow the scrubber: ${JSON.stringify(scrubbed)}`);

  // Played through: it stops at the end of the window, and playing again starts
  // the ten seconds over rather than the whole file.
  const played = await page.evaluate(async () => {
    const video = document.getElementById('violation-review-video');
    video.muted = true;
    video.currentTime = _replayWindow.end - 1.5;
    await new Promise(res => setTimeout(res, 300));
    document.getElementById('violation-review-play').click();
    await new Promise(res => setTimeout(res, 2600));
    const atEnd = {
      paused: video.paused,
      currentTime: video.currentTime,
      clock: document.getElementById('violation-review-clock').textContent,
    };
    document.getElementById('violation-review-play').click();
    await new Promise(res => setTimeout(res, 500));
    const replayed = { currentTime: video.currentTime, playing: !video.paused };
    video.pause();
    return { atEnd, replayed, start: _replayWindow.start, end: _replayWindow.end };
  });
  check(played.atEnd.paused, `Playback must stop at the end of the window: ${JSON.stringify(played)}`);
  check(played.atEnd.clock === '0:10 / 0:10', `The clock must end on ten seconds: ${JSON.stringify(played)}`);
  check(
    played.replayed.playing && played.replayed.currentTime >= played.start - 0.06 && played.replayed.currentTime < played.start + 1.5,
    `Playing again must restart the ten seconds, not the whole file: ${JSON.stringify(played)}`,
  );

  check(errors.length === 0, `Page errors: ${errors.join(' | ')}`);
} finally {
  await browser?.close();
  await server.close();
}

if (failures.length) {
  throw new Error(`Replay window failures:\n- ${failures.join('\n- ')}`);
}
console.log('Replay window tests passed.');

// Every violation that puts a tile in Camera Grid has to come with a replay, so
// the professor can confirm or dismiss it from what the webcam actually saw.
// This drives the real exam client against a fake webcam and records which
// violation types end up posting replay evidence.
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
if (!executablePath) throw new Error('Chrome or Edge is required for the replay coverage test.');

const failures = [];
const check = (ok, message) => { if (!ok) failures.push(message); };

const port = await availablePort();
const server = await createServer({ server: { host: '127.0.0.1', port, strictPort: true, hmr: false } });
let browser;
try {
  await server.listen();
  browser = await chromium.launch({
    executablePath,
    headless: true,
    args: [
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      '--autoplay-policy=no-user-gesture-required',
    ],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${port}/css/style.css`, { waitUntil: 'domcontentloaded' });
  await page.setContent('<!doctype html><html><head></head><body><main id="test-root"></main></body></html>');
  for (const src of ['/js/supabase-sync.js', '/js/data.js', '/js/auth.js', '/js/exam.js']) {
    await page.addScriptTag({ url: `http://127.0.0.1:${port}${src}` });
  }

  // A real webcam track, a real MediaRecorder, and a real replay buffer. Only
  // the network is stood in for, so what is measured is the client's own
  // decision about which violations deserve a replay.
  const ready = await page.evaluate(async () => {
    window.__posts = [];
    const realFetch = window.fetch.bind(window);
    window.fetch = (url, options = {}) => {
      const href = String(url);
      let body = {};
      try { body = JSON.parse(options.body || '{}'); } catch (_) {}
      window.__posts.push({ href, body });
      if (href.includes('/api/monitor/violations')) {
        return Promise.resolve(new Response(JSON.stringify({ success: true, violation: { id: `v-${window.__posts.length}` } }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
      }
      if (href.includes('/api/monitor/violation-evidence')) {
        return Promise.resolve(new Response(JSON.stringify({ success: true, evidence: { id: `ev-${window.__posts.length}` } }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
      }
      if (href.includes('/api/monitor/')) {
        return Promise.resolve(new Response(JSON.stringify({ success: true }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
      }
      return realFetch(url, options);
    };

    const stream = await navigator.mediaDevices.getUserMedia({ video: { width: 320, height: 240 } });
    ExamApp.session = { id: 's1', studentId: '24-0001', studentName: 'Alice Cruz', examId: 'e1' };
    ExamApp.exam = { id: 'e1', title: 'Midterm', requireCamera: true };
    ExamApp._cameraStream = stream;
    ExamApp._startViolationReplayBuffer();
    // MediaRecorder emits nothing until its encoder has produced a first
    // cluster, so wait for real buffered video rather than a fixed delay.
    const deadline = Date.now() + 8000;
    const buffered = () => (ExamApp._violationClipRecorders || []).some(s => s?.chunks?.length > 0);
    while (!buffered() && Date.now() < deadline) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise(res => setTimeout(res, 200));
    }
    return {
      recording: (ExamApp._violationClipRecorders || []).filter(s => s?.recorder?.state === 'recording').length,
      warm: buffered(),
      mime: ExamApp._violationClipMimeType,
    };
  });
  check(ready.recording > 0, `The replay buffer never started recording: ${JSON.stringify(ready)}`);
  check(ready.warm, `The replay buffer never buffered any video: ${JSON.stringify(ready)}`);

  // Every type that Camera Grid puts a tile up for.
  const TYPES = [
    'no_person', 'multiple_people', 'look_down', 'low_brightness', 'camera_off',
    'restricted_phone', 'secondary_computer', 'restricted_book',
    'FACE_ABSENT', 'FACE_PARTIALLY_VISIBLE', 'FACE_TOO_CLOSE', 'FACE_TOO_FAR',
    'FACE_NEAR_FRAME_EDGE', 'SUSTAINED_HEAD_TURN', 'SUSTAINED_LOOKING_DOWN',
    'REPEATED_LOOKING_AWAY', 'FACE_OCCLUDED', 'FACE_TRACKING_UNSTABLE',
    'PHONE_NEAR_OR_COVERING_FACE',
  ];

  const captured = await page.evaluate(async (types) => {
    const out = {};
    for (const type of types) {
      // One clip per type, taken the way each violation path takes it.
      // eslint-disable-next-line no-await-in-loop
      const clip = await ExamApp._capturePreViolationReplayClip(type).catch(error => ({ error: error?.message || String(error) }));
      out[type] = clip?.clipBlob?.size ? { bytes: clip.clipBlob.size, durationMs: clip.durationMs } : (clip?.error ? { error: clip.error } : null);
      // Give the replacement segment a moment of video before the next type.
      // eslint-disable-next-line no-await-in-loop
      await new Promise(res => setTimeout(res, 1300));
    }
    return out;
  }, TYPES);

  const missing = Object.entries(captured).filter(([, value]) => !value?.bytes).map(([type]) => type);
  check(
    missing.length === 0,
    `No replay clip was captured for: ${missing.join(', ')} (full result ${JSON.stringify(captured)})`,
  );

  const backToBack = await page.evaluate(async () => {
    const recording = () => (ExamApp._violationClipRecorders || [])
      .filter(s => s?.recorder?.state === 'recording').length;
    // Two violations in the same instant: the second finds only a segment that
    // was created a moment ago, which is exactly the case that used to come back
    // empty and leave the buffer dead.
    const first = await ExamApp._capturePreViolationReplayClip('no_person');
    const afterFirst = recording();
    const second = await ExamApp._capturePreViolationReplayClip('FACE_ABSENT');
    const afterSecond = recording();
    return {
      first: first?.clipBlob?.size || 0,
      second: second?.clipBlob?.size || 0,
      afterFirst,
      afterSecond,
    };
  });
  check(
    backToBack.afterFirst > 0 && backToBack.afterSecond > 0,
    `A capture left the replay buffer with nothing recording, so the violations that follow lose their replays: ${JSON.stringify(backToBack)}`,
  );

  // A violation that arrives after the webcam has stopped is the one case where
  // a fresh clip cannot be recorded. The seconds leading up to it were already
  // buffered, so that is what has to be kept and uploaded.
  const afterCameraLoss = await page.evaluate(async () => {
    await new Promise(res => setTimeout(res, 1300));
    ExamApp._cameraStream.getTracks().forEach(track => track.stop());
    const clip = await ExamApp._capturePreViolationReplayClip('camera_off').catch(() => null);
    return { bytes: clip?.clipBlob?.size || 0 };
  });
  check(
    afterCameraLoss.bytes > 0,
    `camera_off lost its replay because the webcam had already stopped: ${JSON.stringify(afterCameraLoss)}`,
  );

  // camera_off is only raised after ten seconds of blackout, long after the last
  // segment has ended. The footage from before the camera died has to be held
  // over for it, or the one violation nobody can re-create has no evidence.
  const blackout = await page.evaluate(async () => {
    if (typeof ExamApp._preserveCameraLossReplayClip !== 'function') {
      return { held: false, bytes: 0, violationType: '', missing: true };
    }
    const stream = await navigator.mediaDevices.getUserMedia({ video: { width: 320, height: 240 } });
    ExamApp._cameraStream = stream;
    ExamApp._startViolationReplayBuffer();
    const deadline = Date.now() + 8000;
    while (!(ExamApp._violationClipRecorders || []).some(s => s?.chunks?.length > 0) && Date.now() < deadline) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise(res => setTimeout(res, 200));
    }

    // The watchdog notices the camera is no longer live.
    stream.getTracks().forEach(track => track.stop());
    ExamApp._preserveCameraLossReplayClip();
    await new Promise(res => setTimeout(res, 400));
    const held = !!ExamApp._cameraLossClip;

    // Recorders have long since ended by the time the warning is raised.
    ExamApp._violationClipRecorders = [];
    const clip = await ExamApp._capturePreViolationReplayClip('camera_off').catch(() => null);
    return { held, bytes: clip?.clipBlob?.size || 0, violationType: clip?.violationType || '' };
  });
  check(blackout.held, `The footage from before the blackout was not held: ${JSON.stringify(blackout)}`);
  check(
    blackout.bytes > 0 && blackout.violationType === 'camera_off',
    `The camera_off warning had no replay ten seconds after the webcam died: ${JSON.stringify(blackout)}`,
  );

  check(!errors.length, `Page errors: ${errors.join(' | ')}`);
  if (failures.length) {
    throw new Error(`Replay coverage failures:\n- ${failures.join('\n- ')}`);
  }
  console.log('Replay coverage tests passed.');
} finally {
  if (browser) await browser.close();
  await server.close();
}

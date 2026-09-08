import { access } from 'node:fs/promises';
import net from 'node:net';
import { resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { createServer } from 'vite';

async function availablePort() {
  return new Promise((resolvePort, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolvePort(port));
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
if (!executablePath) throw new Error('Chrome or Edge is required for the FaceMesh browser smoke test.');

const port = await availablePort();
const server = await createServer({
  server: { host: '127.0.0.1', port, strictPort: true, hmr: false },
});
let browser;
try {
  await server.listen();
  browser = await chromium.launch({ executablePath, headless: true });
  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });
  const result = await page.evaluate(async () => {
    const module = await import('/src/lib/proctoring/facemesh/browserSmoke.js');
    const direct = await module.smokeTestFaceLandmarker();
    const worker = await module.smokeTestFaceLandmarkerWorker();
    const failure = await module.smokeTestMissingFaceLandmarkerModel();
    const cleanup = await module.smokeTestFaceLandmarkerCleanupDuringInitialization();
    return { ...direct, ...worker, ...failure, ...cleanup };
  });
  if (
    !result.initialized
    || !result.matrixOutputAvailable
    || !result.workerInitialized
    || !result.missingModelRejected
    || !result.failedRuntimeStopped
    || !result.duplicateStartShared
    || !result.cancellationRejected
    || !result.cancelledRuntimeStopped
  ) {
    throw new Error(`Unexpected Face Landmarker smoke result: ${JSON.stringify(result)}`);
  }

  await page.setContent('<!doctype html><html><head></head><body></body></html>');
  await page.addScriptTag({ url: `http://127.0.0.1:${port}/js/exam.js` });
  const cameraBehavior = await page.evaluate(() => {
    const app = window.ExamApp;
    const warnings = [];
    app.issueWarning = (type, detail) => warnings.push({ type, detail });

    const primary = {
      topLeft: [200, 100],
      bottomRight: [440, 400],
      probability: [0.99],
    };
    const secondary = {
      topLeft: [30, 100],
      bottomRight: [170, 280],
      probability: [0.96],
    };
    const overlapGhost = {
      topLeft: [220, 120],
      bottomRight: [400, 360],
      probability: [0.98],
    };
    const twoFaces = app._classifyFacePredictions([primary, secondary], 640, 480);
    const duplicateBoxes = app._classifyFacePredictions([primary, overlapGhost], 640, 480);

    app._resetMultiplePeopleTracking();
    const timeline = [0, 1000, 2000, 3000, 4000]
      .map(now => app._updateMultiplePeopleTracking('blazeface', true, { now, holdMs: 1000 }));
    const recoveryStart = app._updateMultiplePeopleTracking('blazeface', false, { now: 5001, holdMs: 1000 });
    const recoveryEnd = app._updateMultiplePeopleTracking('blazeface', false, { now: 6001, holdMs: 1000 });

    app._resetMultiplePeopleTracking();
    app._updateMultiplePeopleTracking('yolo', true, { now: 0, holdMs: 1000 });
    app._updateMultiplePeopleTracking('yolo', true, { now: 1000, holdMs: 1000 });
    app._updateMultiplePeopleTracking('yolo', false, { now: 2001, holdMs: 1000 });

    return {
      primarySelected: !!twoFaces.primaryFace,
      extraFaceCount: twoFaces.extraFaces.length,
      overlapGhostIgnored: duplicateBoxes.extraFaces.length === 0,
      countdown: timeline.map(item => item.remainingSeconds),
      oneContinuousWarning: warnings.filter(item => item.type === 'multiple_people').length === 1,
      recoveryStarted: recoveryStart.active && !recoveryStart.justEnded,
      recoveryEnded: !recoveryEnd.active && recoveryEnd.justEnded,
      briefYoloDidNotWarn: warnings.filter(item => item.type === 'multiple_people').length === 1,
    };
  });
  if (
    !cameraBehavior.primarySelected
    || cameraBehavior.extraFaceCount !== 1
    || !cameraBehavior.overlapGhostIgnored
    || cameraBehavior.countdown.join(',') !== '3,2,1,0,0'
    || !cameraBehavior.oneContinuousWarning
    || !cameraBehavior.recoveryStarted
    || !cameraBehavior.recoveryEnded
    || !cameraBehavior.briefYoloDidNotWarn
  ) {
    throw new Error(`Unexpected camera behavior result: ${JSON.stringify(cameraBehavior)}`);
  }
  if (pageErrors.length) throw new Error(`Browser page errors: ${pageErrors.join('; ')}`);
  console.log(`Face Landmarker and camera behavior browser smoke tests passed using ${executablePath}.`);
} finally {
  await browser?.close();
  await server.close();
}

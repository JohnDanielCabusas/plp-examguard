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
  const result = {};
  const checks = [
    'smokeTestMissingHandLandmarkerModel',
    'smokeTestFaceLandmarker',
    'smokeTestFaceLandmarkerWorker',
    'smokeTestMissingFaceLandmarkerModel',
    'smokeTestFaceLandmarkerCleanupDuringInitialization',
  ];
  for (const check of checks) {
    const checkPage = await browser.newPage();
    checkPage.on('pageerror', error => pageErrors.push(error.message));
    try {
      await checkPage.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });
      const partial = await checkPage.evaluate(async checkName => {
        const module = await import('/src/lib/proctoring/facemesh/browserSmoke.js');
        return module[checkName]();
      }, check);
      Object.assign(result, partial);
      console.log(`${check} passed.`);
    } finally {
      await checkPage.close();
    }
  }
  if (
    !result.initialized
    || !result.matrixOutputAvailable
    || !result.workerInitialized
    || !result.handTrackingAvailable
    || !Number.isFinite(result.handCount)
    || !result.missingModelRejected
    || !result.failedRuntimeStopped
    || !result.missingHandReported
    || !result.faceContinuedWithoutHand
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

  const performancePage = await browser.newPage();
  performancePage.on('pageerror', error => pageErrors.push(error.message));
  try {
    await performancePage.setContent('<!doctype html><html><head></head><body></body></html>');
    await performancePage.addScriptTag({ url: `http://127.0.0.1:${port}/js/exam.js` });
    const performanceBehavior = await performancePage.evaluate(async () => {
      const app = window.ExamApp;
      const writes = [];
      window.DB = {
        updateSession: (id, updates) => writes.push({ id, updates }),
        getSession: id => ({ id, activities: [] }),
        addLog: () => {},
      };

      app._cameraStream = {};
      app._startViolationReplayBuffer = () => {};
      app._startCameraWatchdog = () => {};
      app._startYoloObjectMonitoring = () => {};
      app._checkInitialPresence = () => {};
      let legacyLoads = 0;
      app._loadFaceDetectionModel = () => {
        legacyLoads += 1;
        return Promise.resolve();
      };
      app._activateFaceMeshMonitoring = () => { app._faceRuleEngine = {}; };
      app._activateCameraMonitoring({});
      await Promise.resolve();
      const skippedDuplicateFaceModel = legacyLoads === 0;

      app._activateFaceMeshMonitoring = () => { app._faceRuleEngine = null; };
      app._activateCameraMonitoring({});
      await Promise.resolve();
      const retainedLegacyFallback = legacyLoads === 1;

      app.session = { id: 'performance-session', studentId: 'student-1' };
      app.exam = { id: 'exam-1', requireCamera: false };
      app.answers = { essay: 'first' };
      app._AUTO_SAVE_DELAY_MS = 25;
      app.autoSave();
      app.answers.essay = 'latest';
      app.autoSave();
      await new Promise(resolveWait => setTimeout(resolveWait, 60));
      const answerWrites = writes.filter(write => write.updates.answers);
      const batchedAutoSave = answerWrites.length === 1
        && answerWrites[0].updates.answers.essay === 'latest';

      let deferred = null;
      const warningOrder = [];
      app.warnings = 0;
      app._lastWarningTime = null;
      app._cameraPrompting = false;
      app._stopWarningCountdown = () => {};
      app._cancelReadCountdown = () => {};
      app.showWarningOverlay = () => warningOrder.push('overlay');
      app._runAfterNextPaint = callback => { deferred = callback; };
      app._recordActivity = () => warningOrder.push('persist');
      app._capturePreViolationReplayClip = () => Promise.resolve(null);
      app._notifyProfessorViolation = () => Promise.resolve(null);
      app._captureCameraViolationSnapshot = () => null;
      app.issueWarning('copy_attempt', 'test warning');
      const warningPaintedFirst = warningOrder.join(',') === 'overlay' && typeof deferred === 'function';
      deferred?.();
      const persistenceDeferred = warningOrder.join(',') === 'overlay,persist';

      app._discardPendingAutoSave();
      return {
        skippedDuplicateFaceModel,
        retainedLegacyFallback,
        batchedAutoSave,
        warningPaintedFirst,
        persistenceDeferred,
      };
    });
    if (
      !performanceBehavior.skippedDuplicateFaceModel
      || !performanceBehavior.retainedLegacyFallback
      || !performanceBehavior.batchedAutoSave
      || !performanceBehavior.warningPaintedFirst
      || !performanceBehavior.persistenceDeferred
    ) {
      throw new Error(`Unexpected examination performance result: ${JSON.stringify(performanceBehavior)}`);
    }
  } finally {
    await performancePage.close();
  }
  if (pageErrors.length) throw new Error(`Browser page errors: ${pageErrors.join('; ')}`);
  console.log(`Face Landmarker, camera, and examination performance browser smoke tests passed using ${executablePath}.`);
} finally {
  await browser?.close();
  await server.close();
}

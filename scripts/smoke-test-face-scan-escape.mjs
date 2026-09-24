// A student who cannot get through the pre-exam face scan cannot sit the exam at
// all, so the scan must never be a dead end. This drives the real calibration
// service and the real exam client: the scan lowers its bar rather than looping
// forever, tells the student which way to move, and always offers a way out —
// including reporting it to the professor, who answers with the same Allow/Deny
// webcam decision the panel already has.
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
if (!executablePath) throw new Error('Chrome or Edge is required for the face scan test.');

const failures = [];
const check = (ok, message) => { if (!ok) failures.push(message); };

const port = await availablePort();
const server = await createServer({ server: { host: '127.0.0.1', port, strictPort: true, hmr: false } });
let browser;
try {
  await server.listen();
  browser = await chromium.launch({ executablePath, headless: true });

  // ── The calibration service itself ────────────────────────────────────────
  const calib = await browser.newPage();
  const calibErrors = [];
  calib.on('pageerror', error => calibErrors.push(error.message));
  await calib.goto(`http://127.0.0.1:${port}/css/style.css`, { waitUntil: 'domcontentloaded' });
  await calib.setContent('<!doctype html><html><body></body></html>');

  const service = await calib.evaluate(async (origin) => {
    const { resolveFaceMonitoringConfig } = await import(`${origin}/src/lib/proctoring/facemesh/faceMonitoringConfig.js`);
    const { FaceCalibrationSession } = await import(`${origin}/src/lib/proctoring/facemesh/calibrationService.js`);
    const config = resolveFaceMonitoringConfig({}).calibration;

    // A face sitting high in the frame, the way a laptop camera above the screen
    // sees a seated student, but plainly inside the on-screen guide.
    const observation = (overrides = {}) => ({
      facePresent: true,
      trackingQuality: 0.6,
      partiallyVisible: false,
      nearFrameEdge: false,
      pose: { yaw: 0, pitch: 0, roll: 0 },
      geometry: { width: 0.24, height: 0.3, centerX: 0.5, centerY: 0.5 },
      ...overrides,
    });
    const highFace = (t) => observation({
      timestampMs: t,
      geometry: { width: 0.24, height: 0.3, centerX: 0.5, centerY: 0.26 },
    });

    // Accepted now: this is the seated-at-a-laptop case that used to be refused
    // with "Center your face inside the guide" while the student was in the guide.
    const highSession = new FaceCalibrationSession(config);
    const highResult = highSession.addObservation(highFace(0));

    // Genuinely out of frame, which still has to be refused - but with a
    // direction the student can act on.
    const wayOffSession = new FaceCalibrationSession(config);
    const wayOffResult = wayOffSession.addObservation(observation({
      timestampMs: 0,
      geometry: { width: 0.24, height: 0.3, centerX: 0.5, centerY: 0.05 },
    }));

    const leftSession = new FaceCalibrationSession(config);
    const leftResult = leftSession.addObservation(observation({
      timestampMs: 0,
      geometry: { width: 0.24, height: 0.3, centerX: 0.2, centerY: 0.5 },
    }));

    // A camera whose tracking quality never clears the strict bar: on the strict
    // setting this student can never finish, which is what traps them.
    const dim = (t) => observation({ timestampMs: t, trackingQuality: 0.34 });
    const dimSession = new FaceCalibrationSession(config);
    let strictProgress = 0;
    for (let t = 0; t <= 12000; t += 200) {
      const result = dimSession.addObservation(dim(t));
      strictProgress = result.progress || 0;
    }
    const strictComplete = dimSession.complete;

    // The assisted profile is what releases them.
    const { afterMs, ...thresholds } = config.assist;
    dimSession.relax(thresholds);
    let assistedResult = null;
    for (let t = 12200; t <= 20000; t += 200) {
      assistedResult = dimSession.addObservation(dim(t));
      if (assistedResult.complete) break;
    }

    // A normal student must still calibrate on the strict setting.
    const goodSession = new FaceCalibrationSession(config);
    let goodResult = null;
    for (let t = 0; t <= 9000; t += 150) {
      goodResult = goodSession.addObservation(observation({ timestampMs: t }));
      if (goodResult.complete) break;
    }

    return {
      highReason: highResult.reason,
      highAccepted: !/center|frame/i.test(highResult.reason || ''),
      wayOffReason: wayOffResult.reason,
      leftReason: leftResult.reason,
      strictComplete,
      strictProgress,
      assistedComplete: !!assistedResult?.complete,
      assistedBaseline: assistedResult?.baseline
        ? { assisted: assistedResult.baseline.assisted, samples: assistedResult.baseline.sampleCount }
        : null,
      goodComplete: !!goodResult?.complete,
      goodAssisted: goodResult?.baseline?.assisted,
      hasAssistConfig: Number(config.assist?.afterMs) > 0,
    };
  }, `http://127.0.0.1:${port}`);

  check(service.hasAssistConfig, 'The calibration config must define an assisted stage.');
  check(
    service.highAccepted,
    `A student sitting normally at a laptop, face inside the guide but high in the frame, must be accepted: ${JSON.stringify(service.highReason)}`,
  );
  check(
    /high in the frame|lower your screen/i.test(service.wayOffReason),
    `A face genuinely out of position must be told which way to move, not just "center your face": ${JSON.stringify(service.wayOffReason)}`,
  );
  check(
    /right|left/i.test(service.leftReason),
    `An off-centre face must be told which way to move: ${JSON.stringify(service.leftReason)}`,
  );
  check(
    !service.strictComplete,
    `This case is only interesting if the strict setting cannot finish it: ${JSON.stringify(service)}`,
  );
  check(
    service.assistedComplete && service.assistedBaseline?.assisted === true,
    `The assisted stage must let a poor camera finish, and say that it did: ${JSON.stringify(service)}`,
  );
  check(
    service.goodComplete && service.goodAssisted === false,
    `A normal student must still calibrate on the strict setting: ${JSON.stringify(service)}`,
  );
  check(!calibErrors.length, `Calibration page errors: ${calibErrors.join(' | ')}`);

  // ── The exam client's scan screen ─────────────────────────────────────────
  const exam = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const examErrors = [];
  exam.on('pageerror', error => examErrors.push(error.message));
  await exam.goto(`http://127.0.0.1:${port}/css/style.css`, { waitUntil: 'domcontentloaded' });
  await exam.setContent('<!doctype html><html><head></head><body><main id="test-root"></main></body></html>');
  for (const src of ['/js/supabase-sync.js', '/js/data.js', '/js/auth.js', '/js/exam.js']) {
    await exam.addScriptTag({ url: `http://127.0.0.1:${port}${src}` });
  }

  await exam.evaluate(() => {
    window.__session = {
      id: 's1', examId: 'e1', studentId: '24-0001', studentName: 'Alice Cruz',
      startTime: null, answers: {}, warnings: 0, activities: [], cameraSnapshots: [],
    };
    window.__messages = [];
    window.__exempt = false;
    Object.assign(window.DB, {
      getSession: () => window.__session,
      updateSession: (id, patch) => { Object.assign(window.__session, patch); },
      addLog: () => {},
      getExam: () => ({ id: 'e1', title: 'Midterm', requireCamera: true, ownerAdminId: 'admin-1' }),
      addMessage: (message) => { window.__messages.push(message); return message; },
      getMessagesForExamStudent: () => window.__messages,
      isStudentCameraExempt: () => window.__exempt,
    });
    window.SupabaseSync = null;

    document.getElementById('test-root').innerHTML = `
      <div id="state-exam"></div>
      <div id="face-calibration-modal" class="modal-backdrop hidden">
        <div id="face-calibration-status"></div>
        <div><span id="face-calibration-progress-bar"></span></div>
        <button id="face-calibration-retry" style="display:none"></button>
        <button id="face-calibration-report" style="display:none" onclick="ExamApp.reportFaceCalibrationProblem()"></button>
        <button id="face-calibration-continue" style="display:none"></button>
      </div>
      <div id="camera-off-overlay"></div><div id="motion-warning-overlay"></div>`;

    ExamApp.session = window.__session;
    ExamApp.exam = { id: 'e1', title: 'Midterm', requireCamera: true, ownerAdminId: 'admin-1' };
    ExamApp._cameraStream = { active: true };
    ExamApp._cameraRequired = true;
    ExamApp._renderChatMessages = () => {};
    ExamApp._updateChatBadge = () => {};
    ExamApp._showToast = () => {};
    ExamApp._showCameraRequirementNotice = () => {};
    ExamApp.stopCamera = () => {};
    ExamApp._beginExamRuntime = () => { window.__examStarted = true; };
    ExamApp.initCamera = () => {};
    ExamApp._faceMeshConfig = { calibration: { assist: { afterMs: 250, minimumTrackingQuality: 0.2 } } };
    ExamApp._faceCalibration = { relax: (overrides) => { window.__relaxed = overrides; } };
  });

  const scanScreen = await exam.evaluate(async () => {
    ExamApp._prepareFaceCalibration();
    const reportButton = document.getElementById('face-calibration-report');
    const atStart = {
      reportOffered: reportButton.style.display !== 'none',
      retryOffered: document.getElementById('face-calibration-retry').style.display !== 'none',
    };

    // The scan runs but never completes.
    ExamApp._scheduleFaceCalibrationAssist(ExamApp._faceCalibrationGeneration);
    await new Promise(res => setTimeout(res, 450));
    const afterAssist = {
      status: document.getElementById('face-calibration-status').textContent,
      retryOffered: document.getElementById('face-calibration-retry').style.display !== 'none',
      reportOffered: reportButton.style.display !== 'none',
      relaxed: window.__relaxed || null,
      logged: window.__session.activities.some(a => a.type === 'face_calibration_assisted'),
      // Standard detection is not an accurate enough model to proctor with, so it
      // must not be offered as a way past the scan.
      offersStandardMonitoring: /standard camera monitoring/i.test(document.body.textContent || '')
        || typeof ExamApp.continueWithoutFaceMesh === 'function',
    };

    // A later frame's status update must not take the help away again.
    ExamApp._setFaceCalibrationStatus('Keep your head centered.', 0.3);
    const afterRepaint = {
      retryOffered: document.getElementById('face-calibration-retry').style.display !== 'none',
      reportOffered: reportButton.style.display !== 'none',
    };

    return { atStart, afterAssist, afterRepaint };
  });

  check(scanScreen.atStart.reportOffered, `Reporting must be available for the whole scan: ${JSON.stringify(scanScreen.atStart)}`);
  check(!scanScreen.atStart.retryOffered, `Nothing should look broken before the scan has had its chance: ${JSON.stringify(scanScreen.atStart)}`);
  check(
    scanScreen.afterAssist.retryOffered && scanScreen.afterAssist.reportOffered,
    `A scan that will not finish must put every way out on screen: ${JSON.stringify(scanScreen.afterAssist)}`,
  );
  check(
    !scanScreen.afterAssist.offersStandardMonitoring,
    `Standard camera monitoring must not be offered as a way past the face scan: ${JSON.stringify(scanScreen.afterAssist)}`,
  );
  check(
    !!scanScreen.afterAssist.relaxed && scanScreen.afterAssist.relaxed.afterMs === undefined,
    `The assisted thresholds must be applied to the live scan: ${JSON.stringify(scanScreen.afterAssist.relaxed)}`,
  );
  check(scanScreen.afterAssist.logged, `The relaxed run must be recorded for the professor: ${JSON.stringify(scanScreen.afterAssist)}`);
  check(
    scanScreen.afterRepaint.retryOffered && scanScreen.afterRepaint.reportOffered,
    `The next frame's status update wiped the help actions: ${JSON.stringify(scanScreen.afterRepaint)}`,
  );

  // ── Reporting, and the professor's answer letting them in ─────────────────
  const reported = await exam.evaluate(async () => {
    document.getElementById('face-calibration-report').click();
    await new Promise(res => setTimeout(res, 40));
    const message = window.__messages.at(-1) || null;
    const button = document.getElementById('face-calibration-report');
    return {
      message: message && {
        type: message.type,
        category: message.reportCategory,
        role: message.senderRole,
        mentionsScan: /face scan/i.test(message.body || ''),
        carriesDiagnostics: /Tracking quality/i.test(message.body || ''),
      },
      buttonDisabled: button.disabled,
      buttonLabel: button.textContent,
      logged: window.__session.activities.some(a => a.type === 'face_scan_help_requested'),
      pollArmed: !!ExamApp._webcamWaitPoll,
    };
  });
  check(
    reported.message?.type === 'report' && reported.message?.category === 'face_scan_failed' && reported.message?.role === 'student',
    `Reporting must send a student report the professor can act on: ${JSON.stringify(reported.message)}`,
  );
  check(reported.message?.carriesDiagnostics, `The report should carry what the professor needs to judge it: ${JSON.stringify(reported.message)}`);
  check(reported.buttonDisabled && /waiting/i.test(reported.buttonLabel), `A sent report must show it was sent: ${JSON.stringify(reported)}`);
  check(reported.logged, `The request must appear in the activity log: ${JSON.stringify(reported)}`);
  check(reported.pollArmed, 'The student must start watching for the professor’s decision.');

  const released = await exam.evaluate(() => {
    // The professor allows this student to sit without the webcam.
    window.__exempt = true;
    ExamApp._syncCameraExemptionState();
    const modal = document.getElementById('face-calibration-modal');
    return {
      modalHidden: modal.classList.contains('hidden'),
      calibrating: ExamApp._faceMeshCalibrating,
      examStarted: window.__examStarted === true,
    };
  });
  check(
    released.modalHidden && !released.calibrating && released.examStarted,
    `An allowed exemption must release the student from the scan into the exam: ${JSON.stringify(released)}`,
  );
  check(!examErrors.length, `Exam page errors: ${examErrors.join(' | ')}`);

  // ── The professor sees a decision to make, not just a note ────────────────
  const admin = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const adminErrors = [];
  admin.on('pageerror', error => adminErrors.push(error.message));
  await admin.goto(`http://127.0.0.1:${port}/css/style.css`, { waitUntil: 'domcontentloaded' });
  await admin.setContent('<!doctype html><html><head></head><body><main id="test-root"></main></body></html>');
  for (const src of ['/js/supabase-sync.js', '/js/data.js', '/js/auth.js', '/js/admin.js']) {
    await admin.addScriptTag({ url: `http://127.0.0.1:${port}${src}` });
  }

  const professorView = await admin.evaluate(() => {
    const report = {
      id: 'm1', senderRole: 'student', type: 'report', reportCategory: 'face_scan_failed',
      body: 'The face scan will not complete, so I cannot start the exam.',
      createdAt: '2026-09-24T01:05:00.000Z',
    };
    const plainReport = {
      id: 'm2', senderRole: 'student', type: 'report', reportCategory: 'other',
      body: 'My chair is broken.', createdAt: '2026-09-24T01:06:00.000Z',
    };
    return {
      actionable: isProfChatWebcamRequestMessage(report),
      plainNotActionable: isProfChatWebcamRequestMessage(plainReport),
      label: profChatReportTagLabel(report),
      plainLabel: profChatReportTagLabel(plainReport),
    };
  });
  check(professorView.actionable, 'A face-scan report must offer the professor the webcam Allow/Deny decision.');
  check(!professorView.plainNotActionable, 'An unrelated report must not be turned into a webcam decision.');
  check(
    /face scan/i.test(professorView.label),
    `The professor should see what the student actually reported: ${JSON.stringify(professorView.label)}`,
  );
  check(
    /reported a problem/i.test(professorView.plainLabel),
    `Other reports keep their own label: ${JSON.stringify(professorView.plainLabel)}`,
  );
  check(!adminErrors.length, `Admin page errors: ${adminErrors.join(' | ')}`);

  if (failures.length) {
    throw new Error(`Face scan escape failures:\n- ${failures.join('\n- ')}`);
  }
  console.log('Face scan escape tests passed.');
} finally {
  if (browser) await browser.close();
  await server.close();
}

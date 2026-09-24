// A student fixing their internet is not cheating. While the connection is down
// the exam is on hold: it leaves fullscreen so they can reach their Wi-Fi
// settings, and nothing they do to get back online costs them a warning. When
// the connection returns they do not drop straight back into the questions —
// they get a timed gate to resume, after which monitoring is live again.
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
if (!executablePath) throw new Error('Chrome or Edge is required for the offline hold test.');

const failures = [];
const check = (ok, message) => { if (!ok) failures.push(message); };

const port = await availablePort();
const server = await createServer({ server: { host: '127.0.0.1', port, strictPort: true, hmr: false } });
let browser;
try {
  await server.listen();
  browser = await chromium.launch({ executablePath, headless: true });

  // ── Student side ──────────────────────────────────────────────────────────
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
      startTime: '2026-09-24T01:00:00.000Z', answers: {}, warnings: 0, activities: [],
      cameraSnapshots: [], submitted: false,
    };
    Object.assign(window.DB, {
      getSession: () => window.__session,
      updateSession: (id, patch) => { Object.assign(window.__session, patch); },
      addLog: () => {},
      getExam: () => ({ id: 'e1', title: 'Midterm', requireCamera: false }),
    });
    window.SupabaseSync = null;

    document.getElementById('test-root').innerHTML = `
      <div id="offline-overlay" style="display:none"><div id="offline-overlay-content"></div><div id="offline-overlay-detail"></div></div>`;

    ExamApp.session = window.__session;
    ExamApp.exam = { id: 'e1', title: 'Midterm', requireCamera: false };
    ExamApp.answers = {};
    ExamApp.warnings = 0;
    ExamApp._examRuntimeStarted = true;
    ExamApp._connectionState = 'online';

    // Fullscreen cannot be entered without a gesture in this harness, so the
    // exam's view of it is stood in for and the exit call is recorded.
    window.__fullscreen = true;
    window.__exitCalls = 0;
    ExamApp._isFullscreenActive = () => window.__fullscreen;
    document.exitFullscreen = () => {
      window.__exitCalls += 1;
      window.__fullscreen = false;
      return Promise.resolve();
    };
    ExamApp.requestFullscreen = () => { window.__fullscreen = true; return Promise.resolve(true); };
    ExamApp._notifyProfessorViolation = () => Promise.resolve(null);
    ExamApp.startCountdown = () => {};
    ExamApp._resyncSessionState = () => {};
    ExamApp.submitExam = () => {};
  });

  const offline = await exam.evaluate(() => {
    ExamApp._setConnectionState('offline');
    return {
      onHold: ExamApp._isExamOnOfflineHold?.() === true,
      exitCalls: window.__exitCalls,
      stillFullscreen: window.__fullscreen,
      overlayShown: document.getElementById('offline-overlay').style.display === 'flex',
      detail: document.getElementById('offline-overlay-detail').textContent,
      lastActivity: window.__session.activities.at(-1)?.type || '',
    };
  });
  check(offline.onHold, `Going offline must put the exam on hold: ${JSON.stringify(offline)}`);
  check(offline.exitCalls === 1 && !offline.stillFullscreen, `The exam must leave fullscreen so the student can reach their network settings: ${JSON.stringify(offline)}`);
  check(offline.overlayShown, `The offline overlay must cover the questions: ${JSON.stringify(offline)}`);
  check(/on hold/i.test(offline.detail), `The student should be told the exam is on hold: ${JSON.stringify(offline.detail)}`);
  check(offline.lastActivity === 'connection_lost', `The outage must be recorded: ${JSON.stringify(offline.lastActivity)}`);

  // Everything fixing a connection involves, while the exam is on hold.
  const heldViolations = await exam.evaluate(() => {
    const results = {};
    // The first fullscreen_exit belongs to the exam itself (it dropped out of
    // fullscreen on purpose), so a student-caused one is raised after it.
    results.ownExit = ExamApp.issueWarning('fullscreen_exit', 'Fullscreen mode exited');
    for (const [type, detail] of [
      ['fullscreen_exit', 'Fullscreen mode exited'],
      ['window_blur', 'Another application was opened'],
      ['tab_switch', 'Tab or window switched'],
      ['no_person', 'No person detected in camera frame'],
    ]) {
      results[type] = ExamApp.issueWarning(type, detail);
    }
    const held = window.__session.activities.filter(a => a?.metadata?.offlineHold === true);
    return {
      results,
      warnings: ExamApp.warnings,
      sessionWarnings: window.__session.warnings,
      heldCount: held.length,
      heldTypes: held.map(a => a.type),
      allNotCounted: held.every(a => a.metadata.countsAsWarning === false),
    };
  });
  check(
    Object.values(heldViolations.results).every(value => value === false),
    `No violation may be charged while the exam is on hold: ${JSON.stringify(heldViolations.results)}`,
  );
  check(
    heldViolations.warnings === 0 && (heldViolations.sessionWarnings || 0) === 0,
    `The warning count must not move during an outage: ${JSON.stringify(heldViolations)}`,
  );
  check(
    heldViolations.heldCount === 4 && heldViolations.allNotCounted,
    `Each held event must still be recorded for the professor, marked as not counted: ${JSON.stringify(heldViolations)}`,
  );
  check(
    ['fullscreen_exit', 'window_blur', 'tab_switch', 'no_person']
      .every(type => heldViolations.heldTypes.includes(type)),
    `Leaving fullscreen, switching window and stepping away all have to be held: ${JSON.stringify(heldViolations.heldTypes)}`,
  );

  // Pulling the network cannot license an attempt-ending violation.
  const terminal = await exam.evaluate(() => {
    const before = ExamApp.warnings;
    const raised = ExamApp.issueWarning('screen_record', 'Screen recording detected');
    return { raised, before, after: ExamApp.warnings, terminalActive: ExamApp._terminalViolationActive === true };
  });
  check(
    terminal.raised === true && terminal.terminalActive,
    `Screen recording must still end the attempt during an outage: ${JSON.stringify(terminal)}`,
  );

  // Nothing may demand fullscreen back while they are still in their settings.
  const enforcement = await exam.evaluate(async () => {
    ExamApp._terminalViolationActive = false;
    ExamApp._scheduleFullscreenEnforcement(0);
    await new Promise(res => setTimeout(res, 120));
    const lock = document.getElementById('fs-lock-overlay');
    return { lockShown: !!lock && lock.style.display !== 'none' };
  });
  check(!enforcement.lockShown, `The fullscreen lock must stay down while the exam is on hold: ${JSON.stringify(enforcement)}`);

  // ── Reconnecting opens a timed gate, not the exam ──────────────────────────
  const reconnected = await exam.evaluate(() => {
    ExamApp._setConnectionState('online');
    const gate = document.getElementById('offline-resume-overlay');
    return {
      stillOnHold: ExamApp._isExamOnOfflineHold?.() === true,
      offlineOverlayHidden: document.getElementById('offline-overlay').style.display === 'none',
      gateShown: !!gate && gate.style.display !== 'none',
      seconds: Number(document.getElementById('offline-resume-cd-num')?.textContent || 0),
      restored: window.__session.activities.some(a => a.type === 'connection_restored'),
    };
  });
  check(reconnected.offlineOverlayHidden, `The offline overlay must clear on reconnect: ${JSON.stringify(reconnected)}`);
  check(reconnected.gateShown, `Reconnecting must open the resume gate, not the exam: ${JSON.stringify(reconnected)}`);
  check(reconnected.stillOnHold, `The hold continues until the student is back in the exam: ${JSON.stringify(reconnected)}`);
  check(reconnected.seconds === 15, `The resume gate must count down the agreed 15 seconds: ${JSON.stringify(reconnected)}`);
  check(reconnected.restored, `The reconnection must be recorded: ${JSON.stringify(reconnected)}`);

  // ── Resuming ends the hold and monitoring bites again ────────────────────
  const resumed = await exam.evaluate(async () => {
    ExamApp._lastWarningTime = 0;
    const resumeButton = document.getElementById('offline-resume-btn');
    if (!resumeButton) {
      return { onHold: true, gateHidden: false, fullscreen: window.__fullscreen, resumeLogged: false, warned: null, warnings: ExamApp.warnings, missing: true };
    }
    resumeButton.click();
    await new Promise(res => setTimeout(res, 80));
    const gate = document.getElementById('offline-resume-overlay');
    const warned = ExamApp.issueWarning('window_blur', 'Another application was opened');
    return {
      onHold: ExamApp._isExamOnOfflineHold?.() === true,
      gateHidden: !gate || gate.style.display === 'none',
      fullscreen: window.__fullscreen,
      resumeLogged: window.__session.activities.some(a => a.type === 'connection_hold_ended'),
      warned,
      warnings: ExamApp.warnings,
    };
  });
  check(!resumed.onHold, `Resuming must end the hold: ${JSON.stringify(resumed)}`);
  check(resumed.gateHidden, `The resume gate must close once the student is back: ${JSON.stringify(resumed)}`);
  check(resumed.fullscreen, `Resuming must put the exam back in fullscreen: ${JSON.stringify(resumed)}`);
  check(resumed.resumeLogged, `The resume must be recorded for the professor: ${JSON.stringify(resumed)}`);
  check(
    resumed.warned === true && resumed.warnings === 1,
    `Once resumed, leaving the exam counts again: ${JSON.stringify(resumed)}`,
  );

  // A student who never comes back to the gate loses the hold anyway.
  const timedOut = await exam.evaluate(async () => {
    ExamApp.warnings = 0;
    ExamApp._setConnectionState('offline');
    ExamApp._setConnectionState('online');
    // Expire the gate instead of waiting fifteen seconds for it.
    ExamApp._offlineResumeDeadline = Date.now() - 1;
    await new Promise(res => setTimeout(res, 250));
    const gate = document.getElementById('offline-resume-overlay');
    return {
      onHold: ExamApp._isExamOnOfflineHold?.() === true,
      gateHidden: !gate || gate.style.display === 'none',
      timeoutLogged: window.__session.activities.some(a => a?.metadata?.resumeReason === 'timeout'),
    };
  });
  check(
    !timedOut.onHold && timedOut.gateHidden,
    `An unanswered resume gate must hand the exam back to normal monitoring: ${JSON.stringify(timedOut)}`,
  );
  check(timedOut.timeoutLogged, `A gate that ran out must say so in the log: ${JSON.stringify(timedOut)}`);

  // A hold must not outlive the attempt, or the next one runs with fullscreen
  // enforcement switched off.
  const afterTeardown = await exam.evaluate(() => {
    ExamApp._setConnectionState('offline');
    const heldBefore = ExamApp._isExamOnOfflineHold?.() === true;
    ExamApp._stopConnectionMonitor();
    const gate = document.getElementById('offline-resume-overlay');
    return {
      heldBefore,
      heldAfter: ExamApp._isExamOnOfflineHold?.() === true,
      gateHidden: !gate || gate.style.display === 'none',
    };
  });
  check(
    afterTeardown.heldBefore && !afterTeardown.heldAfter && afterTeardown.gateHidden,
    `Ending the attempt must clear the hold: ${JSON.stringify(afterTeardown)}`,
  );

  check(!examErrors.length, `Exam page errors: ${examErrors.join(' | ')}`);

  // ── Professor side ────────────────────────────────────────────────────────
  const admin = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const adminErrors = [];
  admin.on('pageerror', error => adminErrors.push(error.message));
  await admin.goto(`http://127.0.0.1:${port}/css/style.css`, { waitUntil: 'domcontentloaded' });
  await admin.setContent('<!doctype html><html><head></head><body><main id="test-root"></main></body></html>');
  for (const src of ['/js/supabase-sync.js', '/js/data.js', '/js/auth.js', '/js/admin.js']) {
    await admin.addScriptTag({ url: `http://127.0.0.1:${port}${src}` });
  }

  const professorView = await admin.evaluate(() => {
    const session = {
      id: 's1', examId: 'e1', studentId: '24-0001', studentName: 'Alice Cruz',
      startTime: '2026-09-24T01:00:00.000Z', submitted: false, warnings: 1,
      activities: [
        { type: 'connection_lost', timestamp: '2026-09-24T01:05:00.000Z', detail: 'Internet connection lost' },
        { type: 'tab_switch', timestamp: '2026-09-24T01:05:30.000Z', detail: 'Tab or window switched', metadata: { offlineHold: true, countsAsWarning: false } },
        { type: 'connection_hold_ended', timestamp: '2026-09-24T01:06:00.000Z', detail: 'Exam resumed', metadata: { offlineHeldSeconds: 60, resumeReason: 'student' } },
        { type: 'tab_switch', timestamp: '2026-09-24T01:20:00.000Z', detail: 'Tab or window switched' },
      ],
      cameraSnapshots: [],
    };
    Object.assign(window.DB, { getSession: () => session, getSessions: () => [session] });

    const holder = document.createElement('div');
    holder.innerHTML = buildStudentLogBody(session);
    const cards = [...holder.querySelectorAll('.activity-log-timeline-card')].map(card => ({
      type: card.querySelector('.log-type')?.textContent?.trim() || '',
      detail: card.querySelector('.log-detail')?.textContent?.trim() || '',
      badge: card.querySelector('.activity-log-review-badge')?.textContent?.trim() || '',
      offersDismiss: !!card.querySelector('.activity-log-dismiss-warning-btn'),
    }));

    return {
      cards,
      heldAlerts: session.activities.filter(a => isViolationAlertActivity(a)).map(a => a.type),
      summary: (() => {
        const div = document.createElement('div');
        div.innerHTML = renderBehaviorSummary(session.activities);
        return div.textContent.replace(/\s+/g, ' ').trim();
      })(),
    };
  });

  const heldCard = professorView.cards.find(card => /tab/i.test(card.type) && /not counted/i.test(card.badge));
  const chargedCard = professorView.cards.filter(card => /tab/i.test(card.type)).find(card => card.offersDismiss);
  check(!!heldCard, `A held event must be shown as not counted: ${JSON.stringify(professorView.cards)}`);
  check(
    !!heldCard && !heldCard.offersDismiss,
    `There is no warning behind a held event, so it must not offer a dismissal: ${JSON.stringify(heldCard)}`,
  );
  check(!!chargedCard, `A real tab switch outside the outage must still be dismissible: ${JSON.stringify(professorView.cards)}`);
  check(
    professorView.heldAlerts.length === 1,
    `Only the charged violation may raise a live alert: ${JSON.stringify(professorView.heldAlerts)}`,
  );
  check(
    /1 Tab Switch/.test(professorView.summary) && !/2 Tab Switch/.test(professorView.summary),
    `The conduct counter must count the charged violation only: ${JSON.stringify(professorView.summary)}`,
  );
  check(!adminErrors.length, `Admin page errors: ${adminErrors.join(' | ')}`);

  if (failures.length) {
    throw new Error(`Offline hold failures:\n- ${failures.join('\n- ')}`);
  }
  console.log('Offline hold tests passed.');
} finally {
  if (browser) await browser.close();
  await server.close();
}

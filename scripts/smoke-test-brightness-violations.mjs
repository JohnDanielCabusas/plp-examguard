import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright-core';

const candidates = process.platform === 'win32'
  ? [
      resolve(process.env['PROGRAMFILES(X86)'] || 'C:/Program Files (x86)', 'Microsoft/Edge/Application/msedge.exe'),
      resolve(process.env.PROGRAMFILES || 'C:/Program Files', 'Google/Chrome/Application/chrome.exe'),
    ]
  : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/microsoft-edge'];

let executablePath;
for (const candidate of candidates) {
  try { await access(candidate); executablePath = candidate; break; } catch (_) {}
}
if (!executablePath) throw new Error('Chrome or Edge is required for the brightness violation test.');

const browser = await chromium.launch({ executablePath, headless: true });
try {
  // Student: skipping the screen check records Low Screen Brightness without a
  // strike, and the check is not shown again on resume. A dark camera picture
  // is still the low_brightness (Low Camera Lighting) strike.
  const studentPage = await browser.newPage();
  await studentPage.setContent('<!doctype html><html><body><div id="brightness-check-overlay" style="display:flex"></div></body></html>');
  await studentPage.addScriptTag({ path: resolve('public/js/exam.js') });
  const student = await studentPage.evaluate(() => {
    const app = window.ExamApp;
    const session = { id: 'session-a', studentId: 'student-a', activities: [] };
    const strikes = [];
    window.DB = {
      getSession: () => session,
      updateSession: (id, changes) => Object.assign(session, changes),
      addLog: () => {},
    };
    app.session = session;
    app.exam = { id: 'exam-a' };
    app.issueWarning = (type, detail) => strikes.push(type);
    app._brightnessCheckFails = 4;
    app._skipBrightnessCheck();
    const skipped = session.activities.map(activity => activity.type);
    const overlayHidden = document.getElementById('brightness-check-overlay').style.display === 'none';
    let rendered = false;
    app._renderBrightnessCheckRound = () => { rendered = true; };
    app._startBrightnessCheck();

    app._setCameraStatusText = () => {};
    app._adjustLockedExposure = () => {};
    app._showBrightnessPrompt = () => {};
    app._hideBrightnessPrompt = () => {};
    const frame = new Uint8ClampedArray(4 * 10).fill(30);
    for (let i = 0; i < 40; i++) app._checkAmbientBrightness(frame, 10);
    return { skipped, overlayHidden, shownAgain: rendered, strikes };
  });
  assert.deepEqual(student.skipped, ['low_screen_brightness']);
  assert.equal(student.overlayHidden, true);
  assert.equal(student.shownAgain, false);
  assert.deepEqual(student.strikes, ['low_brightness']);

  // Professor: the two violations carry separate names, the screen one alerts
  // but is not a reviewable strike, and both get their own export column.
  const professorPage = await browser.newPage();
  await professorPage.route('https://examguard.test/', route => route.fulfill({
    contentType: 'text/html', body: '<!doctype html><html><body></body></html>',
  }));
  await professorPage.goto('https://examguard.test/');
  await professorPage.addScriptTag({ path: resolve('public/js/admin.js') });
  const professor = await professorPage.evaluate(() => ({
    camera: getBehaviorLabel('low_brightness'),
    screen: getBehaviorLabel('low_screen_brightness'),
    screenAlerts: isViolationAlertActivity({ type: 'low_screen_brightness' }),
    screenReviewable: REVIEWABLE_ACTIVITY_TYPES.has('low_screen_brightness'),
    cameraReviewable: REVIEWABLE_ACTIVITY_TYPES.has('low_brightness'),
    distinctIcons: getViolationTypeIconSvg('low_brightness') !== getViolationTypeIconSvg('low_screen_brightness'),
  }));
  assert.equal(professor.camera, 'Low Camera Lighting');
  assert.equal(professor.screen, 'Low Screen Brightness');
  assert.equal(professor.screenAlerts, true);
  assert.equal(professor.screenReviewable, false);
  assert.equal(professor.cameraReviewable, true);
  assert.equal(professor.distinctIcons, true);
  console.log('Low Camera Lighting and Low Screen Brightness are recorded and labelled separately.');
} finally {
  await browser.close();
}

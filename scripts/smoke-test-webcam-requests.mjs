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
if (!executablePath) throw new Error('Chrome or Edge is required for the webcam request UI test.');

const browser = await chromium.launch({ executablePath, headless: true });
try {
  const studentPage = await browser.newPage();
  await studentPage.setContent('<!doctype html><html><body></body></html>');
  await studentPage.addScriptTag({ path: resolve('public/js/exam.js') });
  const student = await studentPage.evaluate(() => {
    const app = window.ExamApp;
    const sent = [];
    let cameraExempt = false;
    window.DB = {
      isStudentCameraExempt: () => cameraExempt,
      addMessage: message => sent.push(message),
    };
    app.exam = { id: 'exam-a', requireCamera: false };
    app.session = { id: 'session-a', studentId: 'student-a', studentName: 'Student A' };
    app._rememberTrustedInteraction = () => {};
    app._renderChatMessages = () => {};
    app._showToast = () => {};
    app._continueExamLaunch = () => {};
    app._ensureChatUI();
    const options = () => [...document.querySelectorAll('#exam-chat-reports [data-report]')]
      .map(button => button.dataset.report);
    const cameraOffOptions = options();
    app._stageReport('webcam');
    const blockedStaging = !app._pendingReport;

    app.exam.requireCamera = true;
    app._ensureChatUI();
    const cameraOnOptions = options();
    app._stageReport('webcam');
    const stagedWhileRequired = app._pendingReport?.key === 'webcam';
    app.exam.requireCamera = false;
    app._sendChatMessage();
    const blockedSend = sent.length === 0;
    app._renderChatReportOptions();
    const removedAfterChange = !options().includes('webcam') && !app._pendingReport;
    app.sendWebcamReport();
    const blockedConsentReport = sent.length === 0;

    app.exam.requireCamera = true;
    cameraExempt = true;
    app._renderChatReportOptions();
    const exemptOptions = options();
    return { cameraOffOptions, cameraOnOptions, blockedStaging, stagedWhileRequired,
      blockedSend, removedAfterChange, blockedConsentReport, exemptOptions };
  });
  assert.deepEqual(student.cameraOffOptions, ['loading', 'question', 'other']);
  assert.ok(student.cameraOnOptions.includes('webcam'));
  assert.equal(student.blockedStaging, true);
  assert.equal(student.stagedWhileRequired, true);
  assert.equal(student.blockedSend, true);
  assert.equal(student.removedAfterChange, true);
  assert.equal(student.blockedConsentReport, true);
  assert.ok(!student.exemptOptions.includes('webcam'));

  const professorPage = await browser.newPage();
  await professorPage.route('https://examguard.test/', route => route.fulfill({
    contentType: 'text/html',
    body: '<!doctype html><html><body><div id="prof-chat-body"></div></body></html>',
  }));
  await professorPage.goto('https://examguard.test/');
  await professorPage.addScriptTag({ path: resolve('public/js/admin.js') });
  const professor = await professorPage.evaluate(async () => {
    const exam = { id: 'exam-a', requireCamera: false };
    const messages = [{ id: 'request-a', senderRole: 'student', type: 'report', reportCategory: 'webcam',
      createdAt: '2026-09-18T00:00:00.000Z', body: 'My webcam is not working.' }];
    const exemptions = [];
    const confirmations = [];
    let confirmResult = false;
    let disableDuringConfirm = false;
    window.DB = {
      getExam: () => exam,
      getMessagesForExamStudent: () => messages,
      setStudentCameraExempt: (...args) => exemptions.push(args),
      addMessage: message => messages.push({ ...message, id: `decision-${messages.length}`, createdAt: new Date().toISOString() }),
    };
    window.Auth = { getAdminSession: () => ({ id: 'professor-a' }) };
    showToast = () => {};
    renderProfCameraRow = () => {};
    showConfirm = async options => {
      confirmations.push(options);
      if (disableDuringConfirm) exam.requireCamera = false;
      return confirmResult;
    };
    _profChatCtx = { examId: 'exam-a', studentId: 'student-a', sessionId: 'session-a', studentName: 'Student A' };

    renderProfChatMessages();
    const hiddenWhenOff = !document.querySelector('.prof-chat-report-action');
    await respondToWebcamRequest('request-a', 'deny');
    const ignoredWhenOff = messages.length === 1 && exemptions.length === 0 && confirmations.length === 0;

    exam.requireCamera = true;
    renderProfChatMessages();
    const actionsWhenOn = document.querySelectorAll('.prof-chat-report-action').length;
    await respondToWebcamRequest('request-a', 'deny');
    const cancelledWithoutMutation = messages.length === 1 && exemptions.length === 0;

    confirmResult = true;
    disableDuringConfirm = true;
    await respondToWebcamRequest('request-a', 'deny');
    const stoppedAfterSettingChange = messages.length === 1 && exemptions.length === 0;
    exam.requireCamera = true;
    disableDuringConfirm = false;
    await respondToWebcamRequest('request-a', 'deny');
    const deniedAfterConfirmation = messages.length === 2
      && messages[1].reportCategory === 'deny'
      && exemptions.length === 1
      && exemptions[0][2] === false;
    await respondToWebcamRequest('request-a', 'deny');
    const duplicatePrevented = messages.length === 2;
    return { hiddenWhenOff, ignoredWhenOff, actionsWhenOn, cancelledWithoutMutation, stoppedAfterSettingChange,
      deniedAfterConfirmation, duplicatePrevented, confirmations };
  });
  assert.equal(professor.hiddenWhenOff, true);
  assert.equal(professor.ignoredWhenOff, true);
  assert.equal(professor.actionsWhenOn, 2);
  assert.equal(professor.cancelledWithoutMutation, true);
  assert.equal(professor.stoppedAfterSettingChange, true);
  assert.equal(professor.deniedAfterConfirmation, true);
  assert.equal(professor.duplicatePrevented, true);
  assert.equal(professor.confirmations.length, 3);
  assert.match(professor.confirmations[0].title, /Deny webcam request/);
  console.log('Webcam request availability and professor deny confirmation passed.');
} finally {
  await browser.close();
}

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

    // Allow asks first too.
    messages.push({ id: 'request-b', senderRole: 'student', type: 'report', reportCategory: 'webcam',
      createdAt: new Date(Date.now() + 1000).toISOString(), body: 'Still broken.' });
    const allowCountBefore = messages.length;
    confirmResult = false;
    await respondToWebcamRequest('request-b', 'allow');
    const allowCancelledWithoutMutation = messages.length === allowCountBefore && exemptions.length === 1;
    confirmResult = true;
    await respondToWebcamRequest('request-b', 'allow');
    const allowedAfterConfirmation = messages.at(-1).reportCategory === 'allow'
      && exemptions.length === 2 && exemptions[1][2] === true;

    // The header toggle asks first, then tells the student in chat.
    let exempt = true;
    DB.isStudentCameraExempt = () => exempt;
    DB.setStudentCameraExempt = (...args) => { exemptions.push(args); exempt = args[2]; };
    refreshProfCameraFromSync = async () => {};
    const toggleCountBefore = messages.length;
    confirmResult = false;
    await toggleCameraExemption();
    const toggleCancelledWithoutMutation = messages.length === toggleCountBefore && exempt === true;
    confirmResult = true;
    await toggleCameraExemption();
    const reEnableNotice = messages.at(-1);
    const reEnabledWithNotice = exempt === false
      && reEnableNotice.type === 'webcam_requirement' && reEnableNotice.reportCategory === 'enabled';
    renderProfChatMessages();
    const reEnableRendered = !!document.querySelector('.prof-chat-report-bubble.is-required');
    return { hiddenWhenOff, ignoredWhenOff, actionsWhenOn, cancelledWithoutMutation, stoppedAfterSettingChange,
      deniedAfterConfirmation, duplicatePrevented, allowCancelledWithoutMutation, allowedAfterConfirmation,
      toggleCancelledWithoutMutation, reEnabledWithNotice, reEnableRendered, confirmations };
  });
  assert.equal(professor.hiddenWhenOff, true);
  assert.equal(professor.ignoredWhenOff, true);
  assert.equal(professor.actionsWhenOn, 2);
  assert.equal(professor.cancelledWithoutMutation, true);
  assert.equal(professor.stoppedAfterSettingChange, true);
  assert.equal(professor.deniedAfterConfirmation, true);
  assert.equal(professor.duplicatePrevented, true);
  assert.equal(professor.allowCancelledWithoutMutation, true);
  assert.equal(professor.allowedAfterConfirmation, true);
  assert.equal(professor.toggleCancelledWithoutMutation, true);
  assert.equal(professor.reEnabledWithNotice, true);
  assert.equal(professor.reEnableRendered, true);
  assert.equal(professor.confirmations.length, 7);
  assert.match(professor.confirmations[0].title, /Deny webcam request/);
  assert.match(professor.confirmations[3].title, /Allow webcam off/);
  assert.match(professor.confirmations[5].title, /Re-enable webcam/);

  // A student mid-exam whose exemption was revoked gets the "turned back on"
  // notice when the professor's chat notice arrives, even if the exams
  // realtime event never reached them.
  const reEnablePage = await browser.newPage();
  await reEnablePage.setContent('<!doctype html><html><body><div id="state-exam"></div><div id="state-submitted" class="hidden"></div></body></html>');
  await reEnablePage.addScriptTag({ content: 'function lockBodyScroll(){} function unlockBodyScroll(){}' });
  await reEnablePage.addScriptTag({ path: resolve('public/js/exam.js') });
  const reEnable = await reEnablePage.evaluate(async () => {
    const app = window.ExamApp;
    const exam = { id: 'exam-a', requireCamera: true, cameraExemptStudentIds: [] };
    const messages = [];
    let refreshed = 0;
    window.DB = {
      getExam: () => exam,
      isStudentCameraExempt: () => exam.cameraExemptStudentIds.includes('student-a'),
      getMessagesForExamStudent: () => messages,
    };
    window.SupabaseSync = { refreshExam: async () => { refreshed++; } };
    app.exam = exam;
    app.session = { id: 'session-a', studentId: 'student-a', studentName: 'Student A' };
    app._examRuntimeStarted = true;
    app._cameraRequired = false;
    messages.push({ id: 'notice-a', senderRole: 'professor', type: 'webcam_requirement', reportCategory: 'enabled',
      createdAt: new Date().toISOString(), body: 'Turn on your webcam.' });
    app._handleIncomingWebcamRequirementChange();
    await new Promise(r => setTimeout(r, 10));
    const modal = document.getElementById('camera-requirement-modal');
    return {
      refreshed,
      cameraRequired: app._cameraRequired,
      modalShown: !!modal && !modal.classList.contains('hidden'),
      title: document.getElementById('camera-requirement-title')?.textContent,
    };
  });
  assert.equal(reEnable.refreshed, 1);
  assert.equal(reEnable.cameraRequired, true);
  assert.equal(reEnable.modalShown, true);
  assert.match(reEnable.title, /Turned Back On/);
  // A closed exam editor leaves the exam's id in #exam-id. Its draft hook must
  // not capture later webcam toggles from Monitoring, or Re-enable never saves.
  const editorPage = await browser.newPage();
  await editorPage.route('https://examguard.test/', route => route.fulfill({
    contentType: 'text/html',
    body: '<!doctype html><html><body><section id="section-exams" class="admin-section"><input id="exam-id"><div id="exam-editor-view" class="hidden"></div></section></body></html>',
  }));
  await editorPage.goto('https://examguard.test/');
  await editorPage.addScriptTag({ path: resolve('public/js/data.js') });
  await editorPage.addScriptTag({ path: resolve('public/js/admin.js') });
  const editor = await editorPage.evaluate(() => {
    const synced = [];
    window.SupabaseSync = { syncDoc: (table, doc) => synced.push([...(doc.cameraExemptStudentIds || [])]) };
    DB._write(DB.KEYS.exams, [{ id: 'exam-a', requireCamera: true, cameraExemptStudentIds: [] }]);
    updateExamEditorSaveButtonState = () => {};
    refreshExamEditorStatusUI = () => {};
    bindExamEditorPersistenceHooks();
    document.getElementById('exam-id').value = 'exam-a';
    DB.setStudentCameraExempt('exam-a', 'student-a', true);
    const offSaved = DB.isStudentCameraExempt('exam-a', 'student-a');
    DB.setStudentCameraExempt('exam-a', 'student-a', false);
    const onSaved = !DB.isStudentCameraExempt('exam-a', 'student-a');

    // With the editor really open, unsaved edits still stay in the draft.
    document.getElementById('exam-editor-view').classList.remove('hidden');
    currentQBuilderExamId = 'exam-a';
    setExamEditorDraftExam(DB.getExam('exam-a'));
    const syncsBefore = synced.length;
    DB.updateExam('exam-a', { title: 'Unsaved title' });
    const draftKept = synced.length === syncsBefore && DB.getExam('exam-a').title === 'Unsaved title';
    return { offSaved, onSaved, synced, draftKept };
  });
  assert.equal(editor.offSaved, true);
  assert.equal(editor.onSaved, true);
  assert.deepEqual(editor.synced, [['student-a'], []]);
  assert.equal(editor.draftKept, true);
  console.log('Webcam request availability, professor confirmations, re-enable notice and exam-editor draft isolation passed.');
} finally {
  await browser.close();
}

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
if (!executablePath) throw new Error('Chrome or Edge is required for the Random Forest UI smoke test.');

const port = await availablePort();
const server = await createServer({ server: { host: '127.0.0.1', port, strictPort: true, hmr: false } });
let browser;
try {
  await server.listen();
  browser = await chromium.launch({ executablePath, headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });
  await page.setContent('<!doctype html><html><head></head><body><main id="test-root"></main></body></html>');
  await page.addStyleTag({ url: `http://127.0.0.1:${port}/css/style.css` });
  await page.addScriptTag({ url: `http://127.0.0.1:${port}/js/admin.js` });

  const states = await page.evaluate(() => {
    const root = document.getElementById('test-root');
    root.innerHTML = `<select id="stats-exam-select"><option value="exam-a" selected>Exam</option></select>${randomForestCardShell()}`;
    const loading = !!document.querySelector('.rf-loading');
    renderRandomForestPredictionState('exam-a', {
      success: true,
      summary: {
        totalSessions: 5,
        analyzedSessions: 3,
        pendingSessions: 1,
        unavailableSessions: 1,
        failedSessions: 0,
        normalCount: 1,
        needsMonitoringCount: 1,
        suspiciousCount: 1,
      },
      predictions: [
        { examSessionId: 's-normal', studentId: '24-0001', studentName: 'Normal Student', status: 'completed', riskLevel: 'normal', suspiciousProbability: 0.18, submittedAt: '2026-09-08T01:30:00.000Z' },
        { examSessionId: 's-pending', studentId: '24-0004', studentName: 'Pending Student', status: 'pending', suspiciousProbability: null, submittedAt: '2026-09-08T01:33:00.000Z' },
        { examSessionId: 's-risk', studentId: '24-0003', studentName: 'Risk Student', status: 'completed', riskLevel: 'suspicious', suspiciousProbability: 0.912, submittedAt: '2026-09-08T01:32:00.000Z' },
        { examSessionId: 's-review', studentId: '24-0002', studentName: 'Review Student', status: 'completed', riskLevel: 'needs_monitoring', suspiciousProbability: 0.62, submittedAt: '2026-09-08T01:31:00.000Z' },
        { examSessionId: 's-old', studentId: '24-0005', studentName: 'Legacy Student', status: 'unavailable', suspiciousProbability: null, unavailableReason: 'This session predates the required monitoring summary.', submittedAt: '2026-09-08T01:34:00.000Z' },
      ],
      modelVersion: '1.0.0',
      generatedAt: '2026-09-08T02:00:00.000Z',
    });
    return {
      loading,
      title: document.getElementById('rf-prediction-title')?.textContent,
      populated: document.querySelector('.rf-summary-grid')?.textContent,
      partial: document.querySelector('.rf-partial-note')?.textContent,
      disclaimer: document.querySelector('.rf-review-note')?.textContent,
      studentTableLabel: document.querySelector('.rf-student-list')?.getAttribute('aria-label'),
      studentRows: [...document.querySelectorAll('.rf-student-row:not(.rf-student-header)')].map(row => row.textContent.replace(/\s+/g, ' ').trim()),
    };
  });
  if (
    !states.loading
    || states.title !== 'Random Forest Risk Analysis'
    || !states.populated?.includes('3/5')
    || !states.partial?.includes('1 pending · 1 unavailable')
    || !states.disclaimer?.includes('do not prove misconduct')
    || !states.studentTableLabel?.includes('by student')
    || !states.studentRows?.[0]?.includes('Risk Student')
    || !states.studentRows?.[0]?.includes('91.2%')
    || !states.studentRows?.some(row => row.includes('Review Student') && row.includes('Needs monitoring'))
    || !states.studentRows?.some(row => row.includes('Legacy Student') && row.includes('Unavailable'))
  ) {
    throw new Error(`Unexpected populated Random Forest card: ${JSON.stringify(states)}`);
  }

  await page.setViewportSize({ width: 360, height: 740 });
  const mobile = await page.evaluate(() => {
    const card = document.querySelector('.rf-prediction-card');
    return {
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
      columns: getComputedStyle(document.querySelector('.rf-summary-grid')).gridTemplateColumns,
      cardWidth: card.getBoundingClientRect().width,
    };
  });
  if (mobile.scrollWidth > mobile.clientWidth || mobile.columns.includes(' ')) {
    throw new Error(`Random Forest card overflowed on mobile: ${JSON.stringify(mobile)}`);
  }

  const alternateStates = await page.evaluate(() => {
    renderRandomForestPredictionState('exam-a', {
      success: true,
      summary: { totalSessions: 0, analyzedSessions: 0 },
      modelVersion: '1.0.0',
    });
    const empty = document.querySelector('.rf-state-message')?.textContent;
    renderRandomForestPredictionState('exam-a', { success: false, message: 'Test failure' });
    const error = document.querySelector('[role="alert"]')?.textContent;
    return { empty, error };
  });
  if (!alternateStates.empty?.includes('No completed sessions') || !alternateStates.error?.includes('Retry')) {
    throw new Error(`Random Forest card states failed: ${JSON.stringify(alternateStates)}`);
  }

  const violationReviewStates = await page.evaluate(() => {
    ensureViolationReviewModal();
    const readState = () => {
      const footerStatus = document.getElementById('violation-review-reviewed');
      const dismiss = document.getElementById('violation-review-dismiss-btn');
      const confirm = document.getElementById('violation-review-confirm-btn');
      return {
        status: footerStatus?.textContent || '',
        statusHidden: footerStatus?.classList.contains('hidden'),
        statusInFooter: footerStatus?.parentElement?.id === 'violation-review-actions',
        dismissText: dismiss?.textContent || '',
        dismissDisabled: !!dismiss?.disabled,
        confirmText: confirm?.textContent || '',
        confirmDisabled: !!confirm?.disabled,
      };
    };

    renderViolationReviewDecisionState(null);
    const pending = readState();
    renderViolationReviewDecisionState({
      reviewStatus: 'confirmed',
      reviewedAt: '2026-09-08T02:00:00.000Z',
    });
    const confirmed = readState();
    renderViolationReviewDecisionState({
      reviewStatus: 'dismissed',
      reviewedAt: '2026-09-08T02:00:00.000Z',
    });
    const dismissed = readState();
    renderViolationReviewDecisionState({ reviewStatus: 'pending' }, { savingStatus: 'confirmed' });
    const saving = readState();
    return { pending, confirmed, dismissed, saving };
  });
  if (
    !violationReviewStates.pending.statusHidden
    || !violationReviewStates.pending.statusInFooter
    || violationReviewStates.pending.dismissDisabled
    || violationReviewStates.pending.confirmDisabled
    || !violationReviewStates.confirmed.status.includes('Violation confirmed')
    || !violationReviewStates.confirmed.confirmDisabled
    || violationReviewStates.confirmed.confirmText !== '✓ Violation Confirmed'
    || violationReviewStates.confirmed.dismissText !== 'Change to Dismissed'
    || !violationReviewStates.dismissed.status.includes('dismissed as a false positive')
    || !violationReviewStates.dismissed.dismissDisabled
    || violationReviewStates.dismissed.dismissText !== '✓ Violation Dismissed'
    || violationReviewStates.dismissed.confirmText !== 'Change to Confirmed'
    || !violationReviewStates.saving.status.includes('Saving decision')
    || !violationReviewStates.saving.dismissDisabled
    || !violationReviewStates.saving.confirmDisabled
  ) {
    throw new Error(`Violation review footer states failed: ${JSON.stringify(violationReviewStates)}`);
  }

  const monitoringExamOptions = await page.evaluate(() => {
    const exams = [
      { id: 'closed-exam', title: 'Closed Exam', status: 'closed' },
      { id: 'ready-exam', title: 'Ready Exam', status: 'ready' },
      { id: 'active-exam', title: 'Active Exam', status: 'active' },
      { id: 'draft-exam', title: 'Draft Exam', status: 'draft' },
    ];
    const monitorable = getMonitorableExams(exams);
    return {
      values: monitorable.map(exam => exam.id),
      statuses: monitorable.map(exam => exam.status),
    };
  });
  if (
    monitoringExamOptions.values.join(',') !== 'ready-exam,active-exam'
    || monitoringExamOptions.statuses.join(',') !== 'ready,active'
  ) {
    throw new Error(`Monitoring exam selector filtering failed: ${JSON.stringify(monitoringExamOptions)}`);
  }
  if (errors.length) throw new Error(`Browser page errors: ${errors.join('; ')}`);
  console.log(`Random Forest, violation review, and monitoring selector states passed using ${executablePath}.`);
} finally {
  await browser?.close();
  await server.close();
}

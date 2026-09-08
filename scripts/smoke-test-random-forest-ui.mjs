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
        totalSessions: 12,
        analyzedSessions: 10,
        pendingSessions: 1,
        unavailableSessions: 1,
        failedSessions: 0,
        normalCount: 6,
        needsMonitoringCount: 3,
        suspiciousCount: 1,
        averageSuspiciousProbability: 0.384,
      },
      modelVersion: '1.0.0',
      generatedAt: '2026-09-08T02:00:00.000Z',
    });
    return {
      loading,
      title: document.getElementById('rf-prediction-title')?.textContent,
      populated: document.querySelector('.rf-summary-grid')?.textContent,
      distributionLabel: document.querySelector('.rf-distribution')?.getAttribute('aria-label'),
      partial: document.querySelector('.rf-partial-note')?.textContent,
      disclaimer: document.querySelector('.rf-review-note')?.textContent,
      containsStudentResults: root.textContent.includes('Student Results'),
    };
  });
  if (
    !states.loading
    || states.title !== 'Random Forest Prediction'
    || !states.populated?.includes('38.4%')
    || !states.distributionLabel?.includes('6 normal')
    || !states.partial?.includes('2 of 12')
    || !states.disclaimer?.includes('does not confirm academic dishonesty')
    || states.containsStudentResults
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
  if (!alternateStates.empty?.includes('No completed sessions yet') || !alternateStates.error?.includes('Retry')) {
    throw new Error(`Random Forest card states failed: ${JSON.stringify(alternateStates)}`);
  }
  if (errors.length) throw new Error(`Browser page errors: ${errors.join('; ')}`);
  console.log(`Random Forest loading, empty, error, partial, populated, accessible, and mobile states passed using ${executablePath}.`);
} finally {
  await browser?.close();
  await server.close();
}


import assert from 'node:assert/strict';
import { access, mkdir } from 'node:fs/promises';
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

const browserCandidates = process.platform === 'win32'
  ? [
      resolve(process.env['PROGRAMFILES(X86)'] || 'C:/Program Files (x86)', 'Microsoft/Edge/Application/msedge.exe'),
      resolve(process.env.PROGRAMFILES || 'C:/Program Files', 'Google/Chrome/Application/chrome.exe'),
    ]
  : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/microsoft-edge'];

let executablePath = '';
for (const candidate of browserCandidates) {
  try {
    await access(candidate);
    executablePath = candidate;
    break;
  } catch (_) {}
}
if (!executablePath) throw new Error('Chrome or Edge is required for the zoom-responsive UI test.');

const port = await availablePort();
const server = await createServer({ server: { host: '127.0.0.1', port, strictPort: true, hmr: false } });
const captureDir = String(process.env.RESPONSIVE_CAPTURE_DIR || '').trim();
if (captureDir) await mkdir(captureDir, { recursive: true });
let browser;

async function nextLayout(page) {
  await page.evaluate(() => new Promise(resolveAnimation => requestAnimationFrame(() => requestAnimationFrame(resolveAnimation))));
  // Sidebar expansion/collapse intentionally animates for up to 280ms. Wait for
  // that contract before measuring the settled zoom-responsive layout.
  await page.waitForTimeout(320);
}

try {
  await server.listen();
  browser = await chromium.launch({ executablePath, headless: true });
  const page = await browser.newPage({ viewport: { width: 1880, height: 900 } });
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });
  await page.setContent(`<!doctype html><html data-theme="dark"><head></head><body>
    <div class="admin-layout">
      <aside class="sidebar"></aside>
      <main class="main-content" id="admin-main">
        <header class="topbar">
          <span class="topbar-title">Live Monitoring</span>
          <div class="topbar-actions"><span class="topbar-date">Wednesday, September 16</span><button class="btn">Unmute</button><button class="topbar-user-pill"><span>A</span><span>Administrator</span></button></div>
        </header>
        <div class="content-area" id="admin-workspace">
          <div class="course-cards-grid" id="course-cards-grid">
            ${Array.from({ length: 3 }, (_, index) => `<article class="course-card"><div class="course-card-header"><div class="course-card-name">Course ${index + 1}</div></div><div class="course-card-body"><div class="course-card-actions"><button class="btn-action-ghost">Edit</button><button class="tbl-btn-archive">Archive</button></div></div></article>`).join('')}
          </div>
          <div class="exam-cards-grid" id="exam-cards-grid" style="margin-top:24px">
            ${Array.from({ length: 3 }, (_, index) => `<article class="exam-card"><div class="exam-card-header"><div class="exam-card-title">Exam ${index + 1}</div></div><div class="exam-card-body"></div><div class="exam-card-footer"><button class="btn-action-ghost">Edit</button><button class="tbl-btn-archive">Archive</button></div></article>`).join('')}
          </div>
          <div class="monitoring-grid" id="monitoring-grid"><section class="card"></section><aside class="activity-log"></aside></div>
          <div class="table-wrapper"><table><thead><tr><th>Student</th><th>Warnings</th></tr></thead><tbody><tr id="student-row"><td data-label="Student">Student One</td><td data-label="Warnings">3</td></tr></tbody></table></div>
        </div>
      </main>
    </div>
  </body></html>`);
  await page.addStyleTag({ url: `http://127.0.0.1:${port}/css/style.css` });
  await nextLayout(page);

  let layout = await page.evaluate(() => ({
    mainWidth: document.getElementById('admin-main').clientWidth,
    mainLeft: document.getElementById('admin-main').getBoundingClientRect().left,
    titleLeft: document.querySelector('.topbar-title').getBoundingClientRect().left,
    workspaceWidth: document.getElementById('admin-workspace').clientWidth,
    monitorColumns: getComputedStyle(document.getElementById('monitoring-grid')).gridTemplateColumns,
    rowDisplay: getComputedStyle(document.getElementById('student-row')).display,
    topbarHeight: document.querySelector('.topbar').offsetHeight,
    courseWidths: [...document.querySelectorAll('.course-card')].map(card => card.getBoundingClientRect().width),
    examWidths: [...document.querySelectorAll('.exam-card')].map(card => card.getBoundingClientRect().width),
  }));
  assert.ok(layout.mainWidth > 1400, `Expected a wide desktop main area, received ${layout.mainWidth}px.`);
  assert.equal(layout.mainLeft, 260, 'The desktop main area must begin after the fixed sidebar.');
  assert.ok(layout.titleLeft >= 280, 'Topbar content must not render underneath the sidebar.');
  assert.equal(layout.monitorColumns.trim().split(/\s+/).length, 2, 'Monitoring should use two columns when there is enough usable width.');
  assert.equal(layout.rowDisplay, 'table-row', 'Wide tables should retain their desktop layout.');
  assert.equal(layout.topbarHeight, 60, 'The wide top bar should remain compact.');
  assert.ok(Math.min(...layout.courseWidths) >= 290 && Math.max(...layout.courseWidths) <= 340, `Course cards should retain the compact FaceMesh proportions; received ${layout.courseWidths.join(', ')}px.`);
  assert.ok(Math.min(...layout.examWidths) >= 300 && Math.max(...layout.examWidths) <= 340, `Exam cards should retain the compact FaceMesh proportions; received ${layout.examWidths.join(', ')}px.`);

  for (const selector of ['.course-card', '.exam-card', '.course-card-actions .btn-action-ghost', '.exam-card-footer .btn-action-ghost']) {
    const before = await page.locator(selector).first().boundingBox();
    await page.locator(selector).first().hover();
    await page.waitForTimeout(350);
    const after = await page.locator(selector).first().boundingBox();
    assert.ok(Math.abs(after.x - before.x) < 0.25, `${selector} must not shift horizontally on hover.`);
    assert.ok(Math.abs(after.y - before.y) < 0.25, `${selector} must not lift into nearby content on hover.`);
    assert.ok(Math.abs(after.width - before.width) < 0.25, `${selector} must not change width on hover.`);
  }
  if (captureDir) await page.screenshot({ path: resolve(captureDir, 'admin-desktop.png'), fullPage: true });

  await page.setViewportSize({ width: 1250, height: 900 });
  await nextLayout(page);
  layout = await page.evaluate(() => ({
    workspaceWidth: document.getElementById('admin-workspace').clientWidth,
    monitorColumns: getComputedStyle(document.getElementById('monitoring-grid')).gridTemplateColumns,
    rowDisplay: getComputedStyle(document.getElementById('student-row')).display,
    courseColumns: getComputedStyle(document.getElementById('course-cards-grid')).gridTemplateColumns,
    examColumns: getComputedStyle(document.getElementById('exam-cards-grid')).gridTemplateColumns,
  }));
  assert.ok(layout.workspaceWidth < 1100, `The test must represent a zoom-constrained workspace behind the sidebar; received ${layout.workspaceWidth}px.`);
  assert.equal(layout.monitorColumns.trim().split(/\s+/).length, 1, 'Monitoring should stack based on usable workspace width.');
  assert.equal(layout.rowDisplay, 'table-row', 'A moderately constrained table should remain tabular while it still fits.');
  assert.equal(layout.courseColumns.trim().split(/\s+/).length, 3, 'Course cards should retain three compact columns at a moderately constrained desktop width.');
  assert.equal(layout.examColumns.trim().split(/\s+/).length, 3, 'Exam cards should retain three compact columns at a moderately constrained desktop width.');

  await page.setViewportSize({ width: 960, height: 900 });
  await nextLayout(page);
  layout = await page.evaluate(() => {
    const topbar = document.querySelector('.topbar');
    const actions = document.querySelector('.topbar-actions');
    return {
      mainWidth: document.getElementById('admin-main').clientWidth,
      rowDisplay: getComputedStyle(document.getElementById('student-row')).display,
      topbarHeight: topbar.offsetHeight,
      actionsWidth: actions.offsetWidth,
      topbarInnerWidth: topbar.clientWidth,
      courseColumns: getComputedStyle(document.getElementById('course-cards-grid')).gridTemplateColumns,
      examColumns: getComputedStyle(document.getElementById('exam-cards-grid')).gridTemplateColumns,
    };
  });
  assert.ok(layout.mainWidth > 600 && layout.mainWidth < 800, `Expected the sidebar-constrained main area to be about 700px, received ${layout.mainWidth}px.`);
  assert.equal(layout.rowDisplay, 'block', 'Tables should switch to labeled cards when zoom leaves too little usable width.');
  assert.ok(layout.topbarHeight > 60, 'Topbar controls should wrap instead of overflowing at high zoom.');
  assert.ok(layout.actionsWidth > layout.topbarInnerWidth * 0.8, 'Wrapped topbar actions should receive their own full-width row.');
  assert.equal(layout.courseColumns.trim().split(/\s+/).length, 2, 'Course cards should reflow to two compact columns at high desktop zoom.');
  assert.equal(layout.examColumns.trim().split(/\s+/).length, 2, 'Exam cards should reflow to two compact columns at high desktop zoom.');
  if (captureDir) await page.screenshot({ path: resolve(captureDir, 'admin-high-zoom.png'), fullPage: true });

  await page.setContent(`<!doctype html><html><head></head><body>
    <div class="student-portal">
      <aside class="portal-sidebar"></aside>
      <main class="portal-main" id="portal-main">
        <header class="portal-topbar"><span class="portal-topbar-title">Student Portal</span><div class="portal-topbar-actions"><button class="btn">Theme</button><button class="btn">Profile</button></div></header>
        <div class="portal-content"><div class="dash-quick-row"><div></div><div></div></div></div>
      </main>
    </div>
  </body></html>`);
  await page.addStyleTag({ url: `http://127.0.0.1:${port}/css/style.css` });
  await nextLayout(page);
  const portalLayout = await page.evaluate(() => ({
    mainWidth: document.getElementById('portal-main').clientWidth,
    topbarHeight: document.querySelector('.portal-topbar').offsetHeight,
    actionsWidth: document.querySelector('.portal-topbar-actions').offsetWidth,
    topbarInnerWidth: document.querySelector('.portal-topbar').clientWidth,
  }));
  assert.ok(portalLayout.mainWidth < 800, `The portal test must keep the desktop sidebar while constraining its content; received ${portalLayout.mainWidth}px.`);
  assert.ok(portalLayout.topbarHeight > 64, 'Student portal actions should wrap when zoom constrains the space after the sidebar.');
  assert.ok(portalLayout.actionsWidth > portalLayout.topbarInnerWidth * 0.8);

  await page.setViewportSize({ width: 800, height: 900 });
  await page.setContent(`<!doctype html><html><head></head><body>
    <section id="state-exam" style="display:flex;flex-direction:column;height:100dvh;overflow:hidden">
      <header class="examv2-topbar"><div class="examv2-topbar-left">Exam</div><div class="examv2-timer">10:00</div><div class="examv2-topbar-right">Student</div></header>
      <div class="examv2-stats-bar"><div class="examv2-stat">Questions</div><div>Submit</div></div>
      <div class="examv2-layout"><aside class="examv2-nav-panel" id="exam-nav">Questions</aside><main class="examv2-main"><div class="examv2-question-wrap"><div class="mcq-options" id="mcq-options"><button>One</button><button>Two</button></div></div></main></div>
    </section>
  </body></html>`);
  await page.addStyleTag({ url: `http://127.0.0.1:${port}/css/style.css` });
  await nextLayout(page);
  const examLayout = await page.evaluate(() => ({
    navDisplay: getComputedStyle(document.getElementById('exam-nav')).display,
    answerColumns: getComputedStyle(document.getElementById('mcq-options')).gridTemplateColumns,
  }));
  assert.equal(examLayout.navDisplay, 'none', 'Exam navigation should collapse before it squeezes the question content.');
  assert.equal(examLayout.answerColumns.trim().split(/\s+/).length, 1, 'Exam answers should stack when zoom reduces the exam width.');
  if (captureDir) await page.screenshot({ path: resolve(captureDir, 'exam-high-zoom.png'), fullPage: true });

  console.log('Zoom-responsive UI checks passed.');
} finally {
  await browser?.close();
  await server.close();
}

// Exercises paginated reports and preserves export/filter scope in a real browser.
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
if (!executablePath) throw new Error('Chrome or Edge is required for the monitoring search smoke test.');

const port = await availablePort();
const server = await createServer({ server: { host: '127.0.0.1', port, strictPort: true, hmr: false } });
let browser;
const errors = [];
try {
  await server.listen();
  browser = await chromium.launch({ executablePath, headless: true });
  const page = await browser.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${port}/css/style.css`, { waitUntil: 'domcontentloaded' });
  await page.setContent('<!doctype html><html><body><main id="test-root"></main></body></html>');
  for (const src of ['/js/supabase-sync.js', '/js/data.js', '/js/auth.js', '/js/admin.js']) await page.addScriptTag({ url: `http://127.0.0.1:${port}${src}` });
  await page.evaluate(() => {
    window.addEventListener('dbReady', event => event.stopImmediatePropagation(), true);
    const exam = { id: 'e1', title: 'Report pagination', status: 'closed', questions: [], excludedStudentIds: [], requireCamera: false };
    window.__sessions = Array.from({ length: 55 }, (_, index) => ({ id: `s${index}`, examId: 'e1', studentId: `student-${index}`, studentName: `Student ${String(index).padStart(2, '0')}`, submitted: true, score: index, maxScore: 60, warnings: 0, activities: [], answers: {}, cameraSnapshots: [] }));
    Object.assign(DB, {
      getExam: () => exam, getExams: () => [exam], getSubjects: () => [], getSubject: () => null,
      getStudents: () => [], getAllStudentsRaw: () => [], getSessionsByExam: () => window.__sessions,
      getSession: id => window.__sessions.find(row => row.id === id), getStudent: () => null,
    });
    Object.assign(Auth, { getAdminSession: () => ({ id: 'prof-1', name: 'Professor' }) });
    window.__detailLoads = [];
    SupabaseSync.refreshSessionRows = async ids => { window.__detailLoads.push([...ids]); };
    document.getElementById('test-root').innerHTML = `
      <select id="report-exam-select"><option value="e1" selected>Report pagination</option></select>
      <button id="btn-copy-report-scores"></button><button id="btn-release-scores"></button>
      <span id="report-exam-title"></span><span id="report-live-badge"></span>
      <div id="report-summary"><span id="report-submitted-count"></span><span id="report-avg-score"></span></div>
      <span id="report-absent-count"></span>
      <div><table><thead><tr><th><input id="report-select-all" type="checkbox"></th></tr></thead><tbody id="report-tbody"></tbody></table></div>
      <span id="report-selected-count"></span><button id="btn-report-bulk-retake"><span id="report-bulk-retake-count"></span></button>`;
    currentSection = 'reports';
    renderReportTable();
  });
  const read = () => page.evaluate(() => ({
    rows: [...document.querySelectorAll('#report-tbody .report-row-check')].map(box => box.getAttribute('onchange')),
    pager: document.getElementById('report-pagination').textContent,
    total: document.getElementById('report-submitted-count').textContent,
    exportCount: getSelectedReportSessions('e1').length,
  }));
  const first = await read();
  if (first.rows.length !== 25 || first.total !== '55 submitted' || first.exportCount !== 55) throw new Error('First page, total count, or complete export scope is incorrect.');
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  const second = await read();
  if (second.rows.length !== 25 || !second.pager.includes('Page 2 of 3')) throw new Error('Next page did not load.');
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  const third = await read();
  if (third.rows.length !== 5 || !third.pager.includes('Page 3 of 3') || third.exportCount !== 55) throw new Error('Last page lost records or narrowed the export scope.');
  const all = new Set([...first.rows, ...second.rows, ...third.rows]);
  if (all.size !== 55) throw new Error('Some report records are missing or duplicated.');
  const detailSizes = await page.evaluate(() => window.__detailLoads.map(ids => ids.length));
  if (!detailSizes.every(size => size <= 25)) throw new Error('A page downloaded more details than needed.');
  await page.evaluate(() => { reportFilters.search = 'Student 00'; renderReportTable(); });
  const filtered = await read();
  if (filtered.rows.length !== 1 || filtered.exportCount !== 1) throw new Error('Filtering did not reset pagination and export scope correctly.');
  if (errors.length) throw new Error(errors.join(' | '));
  console.log('Report pagination browser test passed: 55 reachable records, 25-row detail loads, full exports and filter resets.');
} finally {
  if (browser) await browser.close();
  await server.close();
}

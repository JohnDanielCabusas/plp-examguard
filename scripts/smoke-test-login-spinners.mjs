// Every login button that waits on the server shows a spinner that actually
// turns — including with Windows "Animation effects" off (reduced motion), which
// used to freeze it — and a second press while it waits sends nothing.
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
  try { await access(candidate); executablePath = candidate; break; } catch (_) {}
}
if (!executablePath) throw new Error('Chrome or Edge is required for the login spinner test.');

const failures = [];
const check = (ok, message) => { if (!ok) failures.push(message); };

const port = await availablePort();
const server = await createServer({ server: { host: '127.0.0.1', port, strictPort: true, hmr: false } });
let browser;
try {
  await server.listen();
  browser = await chromium.launch({ executablePath, headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'networkidle' });
  await page.waitForSelector('#admin-identifier', { timeout: 20000 });

  // Each server call waits until the test lets it go, and counts how often it ran.
  await page.evaluate(() => {
    window.__calls = {};
    window.__release = {};
    const slow = (name, value) => () => {
      window.__calls[name] = (window.__calls[name] || 0) + 1;
      return new Promise((res) => { window.__release[name] = () => res(value); });
    };
    window.Auth.continueProfessorLogin = slow('continue', { success: true, nextStep: 'password', accountType: 'professor', identifier: 'prof', email: 'p@x' });
    window.Auth.adminLogin = slow('login', { success: false, message: 'Incorrect password.' });
  });

  const spinnerState = () => page.evaluate(async () => {
    const spinner = document.querySelector('.btn-spinner');
    if (!spinner) return { present: false };
    const style = getComputedStyle(spinner);
    const first = getComputedStyle(spinner).transform;
    await new Promise(res => setTimeout(res, 350));
    return {
      present: true,
      iterations: style.animationIterationCount,
      rotating: first !== getComputedStyle(spinner).transform,
      buttonDisabled: !!spinner.closest('button')?.disabled,
      label: spinner.closest('button')?.textContent?.trim() || '',
    };
  });

  await page.fill('#admin-identifier', 'prof');
  await page.click('button:has-text("Continue")');
  const continuing = await spinnerState();
  check(continuing.present && continuing.rotating && continuing.iterations === 'infinite',
    `Continue spinner must keep turning with reduced motion on: ${JSON.stringify(continuing)}`);
  await page.evaluate(() => window.__release.continue());
  await page.waitForSelector('#admin-password', { timeout: 5000 });

  await page.fill('#admin-password', 'secret');
  await page.click('button:has-text("Sign In")');
  const signingIn = await spinnerState();
  check(signingIn.present && signingIn.rotating, `Sign In must show a turning spinner: ${JSON.stringify(signingIn)}`);
  check(signingIn.buttonDisabled && /signing in/i.test(signingIn.label), `Sign In must say it is working: ${JSON.stringify(signingIn)}`);
  // Enter in the password field while the first request is still out.
  await page.press('#admin-password', 'Enter');
  await page.waitForTimeout(150);
  check(await page.evaluate(() => window.__calls.login) === 1, 'A second press while signing in must not send again.');

  await page.evaluate(() => window.__release.login());
  await page.waitForSelector('[role="alert"]', { timeout: 5000 });
  const after = await page.evaluate(() => ({
    spinner: !!document.querySelector('.btn-spinner'),
    label: [...document.querySelectorAll('button')].find(b => /sign in/i.test(b.textContent))?.textContent?.trim() || '',
    error: document.querySelector('[role="alert"]')?.textContent || '',
  }));
  check(!after.spinner && after.label === 'Sign In' && /incorrect password/i.test(after.error),
    `A failed sign-in must clear the spinner and show the error: ${JSON.stringify(after)}`);

  check(!errors.length, `Page errors: ${errors.join(' | ')}`);
  if (failures.length) throw new Error(`Login spinner failures:\n- ${failures.join('\n- ')}`);
  console.log('Login spinner tests passed.');
} finally {
  if (browser) await browser.close();
  await server.close();
}

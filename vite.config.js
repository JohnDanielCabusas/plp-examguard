import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { loadEnv } from 'vite';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { forwardEnvironment } = require('./server/environment.cjs');
const { handleEmailRoute } = require('./server/email-route.cjs');
const { handleAuthRoute } = require('./server/auth-route.cjs');
const { handleMonitorRoute } = require('./server/monitor-route.cjs');
const { handleRandomForestRoute } = require('./server/random-forest-route.cjs');
const { handleMonitorWebSocketUpgrade } = require('./server/monitor-websocket.cjs');

function resolveHost(env) {
  const value = String(env.VITE_HOST || env.HOST || '').trim();
  return value || '0.0.0.0';
}

function resolvePort(...candidates) {
  for (const candidate of candidates) {
    const value = Number(candidate);
    if (Number.isInteger(value) && value >= 1024 && value <= 65535) {
      return value;
    }
  }
  return 4173;
}

function ignoreNonFrontendWatchPath(filePath) {
  const normalized = String(filePath || '').replace(/\\/g, '/');
  return /(?:^|\/)\.venv(?:\/|$)/.test(normalized)
    || /(?:^|\/)ml(?:\/|$)/.test(normalized)
    || /(?:^|\/)weights(?:\/|$)/.test(normalized)
    || /(?:^|\/)__pycache__(?:\/|$)/.test(normalized);
}

const SERVER_ENV_NAMES = [
  'SMTP_HOST',
  'SMTP_PORT',
  'SMTP_SECURE',
  'SMTP_USER',
  'SMTP_PASS',
  'SMTP_FROM_EMAIL',
  'SMTP_FALLBACK_MODE',
  'SUPABASE_DB_HOST',
  'SUPABASE_DB_PORT',
  'SUPABASE_DB_NAME',
  'SUPABASE_DB_USER',
  'SUPABASE_DB_PASSWORD',
  'SUPABASE_DB_SSL',
  'VITE_SUPABASE_URL',
  'VITE_SUPABASE_PUBLISHABLE_KEY',
  'AUTH_DEFAULT_SYSADMIN_PASSWORD',
  'AUTH_DEFAULT_PROFESSOR_PASSWORD',
  'AUTH_DEFAULT_PROFESSOR_USERNAME',
  'AUTH_DEFAULT_PROFESSOR_EMAIL',
  'RF_PYTHON_PATH',
  'RF_MODEL_PATH',
  'RF_METADATA_PATH',
];

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const host = resolveHost(env);
  const port = resolvePort(env.VITE_PORT, env.PORT, process.env.VITE_PORT, process.env.PORT);
  forwardEnvironment(env, SERVER_ENV_NAMES);

  return {
    plugins: [
      react(),
      {
        name: 'rewrite-clean-urls',
        configureServer(server) {
          server.httpServer?.on('upgrade', (req, socket, head) => {
            Promise.resolve(handleMonitorWebSocketUpgrade(req, socket, head)).catch(() => {
              try { socket.destroy(); } catch (_) {}
            });
          });
          server.middlewares.use((req, res, next) => {
            const pathname = req.url ? new URL(req.url, 'http://localhost').pathname : '';
            if (pathname.startsWith('/api/auth/')) {
              handleAuthRoute(req, res);
              return;
            }
            if (pathname.startsWith('/api/monitor/')) {
              handleMonitorRoute(req, res);
              return;
            }
            if (
              pathname.startsWith('/api/exam-sessions/')
              || pathname.startsWith('/api/statistics/random-forest')
            ) {
              handleRandomForestRoute(req, res);
              return;
            }
            if (pathname === '/api/email/send-verification') {
              handleEmailRoute(req, res);
              return;
            }
            if (req.url === '/admin') req.url = '/admin.html';
            else if (req.url === '/exam') req.url = '/exam.html';
            else if (req.url === '/super-admin') req.url = '/super-admin.html';
            next();
          });
        },
      },
    ],
    publicDir: 'public',
    server: {
      host,
      port,
      strictPort: false,
      allowedHosts: true,
      // A Vite full reload during a live exam is indistinguishable from a
      // student refresh and can trigger the exam's anti-refresh submission.
      // Keep every student exam stable; developers refresh deliberately after
      // making changes instead of Vite reloading connected exam clients.
      hmr: false,
      // The Python YOLO environment can contain tens of thousands of files.
      // Watching it exhausts Windows handles and makes Vite appear stuck even
      // though the HTTP port is already listening.
      watch: {
        ignored: ignoreNonFrontendWatchPath,
      },
    },
    preview: {
      host,
      port,
      strictPort: false,
      allowedHosts: true,
    },
    build: {
      rollupOptions: {
        input: {
          index: 'index.html',
          admin: 'admin.html',
          exam: 'exam.html',
          'super-admin': 'super-admin.html',
        },
      },
    },
  };
});

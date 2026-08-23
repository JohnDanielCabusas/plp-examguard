import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { loadEnv } from 'vite';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { handleEmailRoute } = require('./server/email-route.cjs');
const { handleAuthRoute } = require('./server/auth-route.cjs');
const { handleMonitorRoute } = require('./server/monitor-route.cjs');
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

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const host = resolveHost(env);
  const port = resolvePort(env.VITE_PORT, env.PORT, process.env.VITE_PORT, process.env.PORT);
  process.env.SMTP_HOST = env.SMTP_HOST || process.env.SMTP_HOST;
  process.env.SMTP_PORT = env.SMTP_PORT || process.env.SMTP_PORT;
  process.env.SMTP_SECURE = env.SMTP_SECURE || process.env.SMTP_SECURE;
  process.env.SMTP_USER = env.SMTP_USER || process.env.SMTP_USER;
  process.env.SMTP_PASS = env.SMTP_PASS || process.env.SMTP_PASS;
  process.env.SMTP_FROM_EMAIL = env.SMTP_FROM_EMAIL || process.env.SMTP_FROM_EMAIL;
  process.env.SMTP_FALLBACK_MODE = env.SMTP_FALLBACK_MODE || process.env.SMTP_FALLBACK_MODE;
  process.env.SUPABASE_DB_HOST = env.SUPABASE_DB_HOST || process.env.SUPABASE_DB_HOST;
  process.env.SUPABASE_DB_PORT = env.SUPABASE_DB_PORT || process.env.SUPABASE_DB_PORT;
  process.env.SUPABASE_DB_NAME = env.SUPABASE_DB_NAME || process.env.SUPABASE_DB_NAME;
  process.env.SUPABASE_DB_USER = env.SUPABASE_DB_USER || process.env.SUPABASE_DB_USER;
  process.env.SUPABASE_DB_PASSWORD = env.SUPABASE_DB_PASSWORD || process.env.SUPABASE_DB_PASSWORD;
  process.env.SUPABASE_DB_SSL = env.SUPABASE_DB_SSL || process.env.SUPABASE_DB_SSL;
  process.env.VITE_SUPABASE_URL = env.VITE_SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  process.env.VITE_SUPABASE_PUBLISHABLE_KEY = env.VITE_SUPABASE_PUBLISHABLE_KEY || process.env.VITE_SUPABASE_PUBLISHABLE_KEY;
  process.env.AUTH_DEFAULT_SYSADMIN_PASSWORD = env.AUTH_DEFAULT_SYSADMIN_PASSWORD || process.env.AUTH_DEFAULT_SYSADMIN_PASSWORD;
  process.env.AUTH_DEFAULT_PROFESSOR_PASSWORD = env.AUTH_DEFAULT_PROFESSOR_PASSWORD || process.env.AUTH_DEFAULT_PROFESSOR_PASSWORD;
  process.env.AUTH_DEFAULT_PROFESSOR_USERNAME = env.AUTH_DEFAULT_PROFESSOR_USERNAME || process.env.AUTH_DEFAULT_PROFESSOR_USERNAME;
  process.env.AUTH_DEFAULT_PROFESSOR_EMAIL = env.AUTH_DEFAULT_PROFESSOR_EMAIL || process.env.AUTH_DEFAULT_PROFESSOR_EMAIL;

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

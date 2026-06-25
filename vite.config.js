import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { loadEnv } from 'vite';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { handleEmailRoute } = require('./server/email-route.cjs');

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  process.env.SMTP_HOST = env.SMTP_HOST || process.env.SMTP_HOST;
  process.env.SMTP_PORT = env.SMTP_PORT || process.env.SMTP_PORT;
  process.env.SMTP_SECURE = env.SMTP_SECURE || process.env.SMTP_SECURE;
  process.env.SMTP_USER = env.SMTP_USER || process.env.SMTP_USER;
  process.env.SMTP_PASS = env.SMTP_PASS || process.env.SMTP_PASS;
  process.env.SMTP_FROM_EMAIL = env.SMTP_FROM_EMAIL || process.env.SMTP_FROM_EMAIL;

  return {
    plugins: [
      react(),
      {
        name: 'rewrite-clean-urls',
        configureServer(server) {
          server.middlewares.use((req, res, next) => {
            const pathname = req.url ? new URL(req.url, 'http://localhost').pathname : '';
            if (pathname === '/api/email/send-verification') {
              handleEmailRoute(req, res);
              return;
            }
            if (req.url === '/admin') req.url = '/admin.html';
            else if (req.url === '/exam') req.url = '/exam.html';
            next();
          });
        },
      },
    ],
    publicDir: 'public',
    build: {
      rollupOptions: {
        input: {
          index: 'index.html',
          admin: 'admin.html',
          exam: 'exam.html',
        },
      },
    },
  };
});

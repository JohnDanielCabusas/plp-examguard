import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [
    react(),
    {
      name: 'rewrite-clean-urls',
      configureServer(server) {
        server.middlewares.use((req, _res, next) => {
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
});

const http = require('http');
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env.local') });
const { handleEmailRoute } = require('./server/email-route.cjs');
const { handleAuthRoute } = require('./server/auth-route.cjs');

// Serve from the Vite build output in production
const rootDir = path.join(__dirname, 'dist');
const port = Number(process.env.PORT) || 3000;

const contentTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
};

const routeMap = {
  '/': 'index.html',
  '/index': 'index.html',
  '/index.html': 'index.html',
  '/admin': 'admin.html',
  '/admin.html': 'admin.html',
  '/exam': 'exam.html',
  '/exam.html': 'exam.html',
};

function sendFile(res, filePath) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(err.code === 'ENOENT' ? 404 : 500, {
        'Content-Type': 'text/plain; charset=utf-8',
      });
      res.end(err.code === 'ENOENT' ? 'Not found' : 'Internal server error');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': contentTypes[ext] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  let pathname = decodeURIComponent(url.pathname);

  if (pathname.startsWith('/api/auth/')) {
    handleAuthRoute(req, res);
    return;
  }

  if (pathname === '/api/email/send-verification') {
    handleEmailRoute(req, res);
    return;
  }

  if (routeMap[pathname]) {
    pathname = `/${routeMap[pathname]}`;
  }

  const safePath = path.normalize(path.join(rootDir, pathname));
  if (!safePath.startsWith(rootDir)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Forbidden');
    return;
  }

  let filePath = safePath;
  if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
    filePath = path.join(filePath, 'index.html');
  }

  sendFile(res, filePath);
});

server.listen(port, () => {
  console.log(`TUKLAS running at http://localhost:${port}`);
  console.log(`Serving from: ${rootDir}`);
  console.log(`Run "npm run build" first to generate the dist/ folder.`);
});

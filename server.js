const http = require('http');
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env.local') });
const { handleEmailRoute } = require('./server/email-route.cjs');
const { handleAuthRoute } = require('./server/auth-route.cjs');
const { handleMonitorRoute } = require('./server/monitor-route.cjs');
const { handleMonitorWebSocketUpgrade } = require('./server/monitor-websocket.cjs');
const { cleanupProfessorActivityLog } = require('./server/auth-service.cjs');

function normalizeHost(value) {
  const normalized = String(value || '').trim();
  return normalized || '0.0.0.0';
}

function normalizePort(...candidates) {
  for (const candidate of candidates) {
    const port = Number(candidate);
    if (Number.isInteger(port) && port >= 1024 && port <= 65535) {
      return port;
    }
  }
  return 4300;
}

// Serve from the Vite build output in production
const rootDir = path.join(__dirname, 'dist');
const host = normalizeHost(process.env.HOST);
const basePort = normalizePort(process.env.PORT);

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
  '.onnx': 'application/octet-stream',
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
    const relativePath = path.relative(rootDir, filePath).replace(/\\/g, '/');
    const isVersionedModel = ext === '.onnx';
    const isHashedAsset = relativePath.startsWith('assets/') && /-[A-Za-z0-9_-]{8,}\./.test(path.basename(filePath));
    const cacheControl = isVersionedModel || isHashedAsset
      ? 'public, max-age=31536000, immutable'
      : ext === '.html' || relativePath === 'models/yolo-proctor-v1.json'
        ? 'no-cache'
        : 'public, max-age=3600';
    res.writeHead(200, {
      'Content-Type': contentTypes[ext] || 'application/octet-stream',
      'Cache-Control': cacheControl,
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

  if (pathname.startsWith('/api/monitor/')) {
    handleMonitorRoute(req, res);
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

server.on('upgrade', (req, socket, head) => {
  Promise.resolve(handleMonitorWebSocketUpgrade(req, socket, head))
    .then((handled) => {
      if (handled) return;
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      socket.destroy();
    })
    .catch(() => {
      try {
        socket.write('HTTP/1.1 500 Internal Server Error\r\nConnection: close\r\n\r\n');
      } catch (_) {}
      socket.destroy();
    });
});

function startServer(port) {
  server.listen(port, host, () => {
    console.log(`TUKLAS running at http://${host}:${port}`);
    console.log(`Serving from: ${rootDir}`);
    console.log(`Run "npm run build" first to generate the dist/ folder.`);
  });
}

server.on('error', (error) => {
  if ((error?.code === 'EACCES' || error?.code === 'EADDRINUSE') && server._retryCount < 5) {
    server._retryCount = (server._retryCount || 0) + 1;
    const nextPort = basePort + server._retryCount;
    console.warn(`Port ${error.port || basePort} is unavailable (${error.code}). Retrying on ${nextPort}...`);
    setTimeout(() => startServer(nextPort), 150);
    return;
  }
  throw error;
});

startServer(basePort);

// Database maintenance: trim the professor activity log so it can't grow
// without bound. Runs once at startup, then once every 24h for as long as
// this process stays up.
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
cleanupProfessorActivityLog();
setInterval(cleanupProfessorActivityLog, ONE_DAY_MS);

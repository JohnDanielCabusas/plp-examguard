const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
require('dotenv').config({ path: path.join(__dirname, '.env.local') });
const { handleEmailRoute } = require('./server/email-route.cjs');
const { handleAuthRoute } = require('./server/auth-route.cjs');
const { handleMonitorRoute } = require('./server/monitor-route.cjs');
const { handleBrandingRoute } = require('./server/branding-route.cjs');
const { handleRandomForestRoute } = require('./server/random-forest-route.cjs');
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
  // Without application/wasm the browser cannot compile the engine while it downloads.
  '.wasm': 'application/wasm',
  '.task': 'application/octet-stream',
};

// Text and WebAssembly shrink 3-4x compressed; model weights (.onnx/.task) barely
// shrink, so they are streamed as-is.
const COMPRESSIBLE_EXTENSIONS = new Set(['.html', '.css', '.js', '.json', '.svg', '.wasm']);
const WEEK_SECONDS = 7 * 24 * 60 * 60;

const routeMap = {
  '/': 'index.html',
  '/index': 'index.html',
  '/index.html': 'index.html',
  '/admin': 'admin.html',
  '/admin.html': 'admin.html',
  '/exam': 'exam.html',
  '/exam.html': 'exam.html',
};

function getCacheControl(filePath, ext) {
  const relativePath = path.relative(rootDir, filePath).replace(/\\/g, '/');
  const isVersionedModel = ext === '.onnx';
  const isHashedAsset = relativePath.startsWith('assets/') && /-[A-Za-z0-9_-]{8,}\./.test(path.basename(filePath));
  if (isVersionedModel || isHashedAsset) return 'public, max-age=31536000, immutable';
  if (ext === '.html' || relativePath === 'models/yolo-proctor-v1.json') return 'no-cache';
  // MediaPipe engine and face/hand models are tens of MB and change only on a
  // redeploy; the ETag lets the browser revalidate cheaply when this expires.
  if (relativePath.startsWith('vendor/') || relativePath.startsWith('models/')) return `public, max-age=${WEEK_SECONDS}`;
  return 'public, max-age=3600';
}

function pickEncoding(req) {
  const accepted = String(req.headers['accept-encoding'] || '');
  if (/\bbr\b/.test(accepted)) return 'br';
  if (/\bgzip\b/.test(accepted)) return 'gzip';
  return null;
}

// Compressed copies are built once per file version and reused for every
// student, on libuv's thread pool so the event loop stays free.
const compressedCache = new Map(); // `${filePath}|${encoding}` -> { etag, promise }

function getCompressed(filePath, etag, encoding) {
  const key = `${filePath}|${encoding}`;
  const cached = compressedCache.get(key);
  if (cached && cached.etag === etag) return cached.promise;
  const promise = fs.promises.readFile(filePath).then(data => new Promise((resolve, reject) => {
    const done = (error, result) => (error ? reject(error) : resolve(result));
    if (encoding === 'br') {
      zlib.brotliCompress(data, {
        params: {
          [zlib.constants.BROTLI_PARAM_QUALITY]: data.length > 1024 * 1024 ? 5 : 9,
          [zlib.constants.BROTLI_PARAM_SIZE_HINT]: data.length,
        },
      }, done);
    } else {
      zlib.gzip(data, { level: 6 }, done);
    }
  }));
  compressedCache.set(key, { etag, promise });
  promise.catch(() => compressedCache.delete(key));
  return promise;
}

function sendNotFound(res, err) {
  res.writeHead(err?.code === 'ENOENT' ? 404 : 500, {
    'Content-Type': 'text/plain; charset=utf-8',
  });
  res.end(err?.code === 'ENOENT' ? 'Not found' : 'Internal server error');
}

function sendFile(req, res, filePath) {
  fs.stat(filePath, (statError, stat) => {
    if (statError || !stat.isFile()) {
      sendNotFound(res, statError || { code: 'ENOENT' });
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    const etag = `"${stat.size.toString(36)}-${Math.floor(stat.mtimeMs).toString(36)}"`;
    const headers = {
      'Content-Type': contentTypes[ext] || 'application/octet-stream',
      'Cache-Control': getCacheControl(filePath, ext),
      ETag: etag,
      'Last-Modified': stat.mtime.toUTCString(),
    };
    const compressible = COMPRESSIBLE_EXTENSIONS.has(ext) && stat.size > 1024;
    if (compressible) headers.Vary = 'Accept-Encoding';

    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, headers);
      res.end();
      return;
    }

    const encoding = compressible ? pickEncoding(req) : null;
    if (encoding) {
      getCompressed(filePath, etag, encoding)
        .then((body) => {
          res.writeHead(200, { ...headers, 'Content-Encoding': encoding, 'Content-Length': body.length });
          res.end(req.method === 'HEAD' ? undefined : body);
        })
        .catch((error) => sendNotFound(res, error));
      return;
    }

    res.writeHead(200, { ...headers, 'Content-Length': stat.size });
    if (req.method === 'HEAD') { res.end(); return; }
    // Streamed rather than read whole: a class starting together would otherwise
    // hold dozens of copies of the 10-25 MB model files in memory at once.
    const stream = fs.createReadStream(filePath);
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  });
}

// Build compressed copies of the large engine files at startup so the first
// student of the day doesn't wait on compression.
function prewarmCompressedAssets(dir = rootDir) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) { prewarmCompressedAssets(fullPath); continue; }
    if (!COMPRESSIBLE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
    try {
      const stat = fs.statSync(fullPath);
      if (stat.size < 256 * 1024) continue;
      const etag = `"${stat.size.toString(36)}-${Math.floor(stat.mtimeMs).toString(36)}"`;
      getCompressed(fullPath, etag, 'br').catch(() => {});
    } catch (_) {}
  }
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

  if (
    pathname.startsWith('/api/exam-sessions/')
    || pathname.startsWith('/api/statistics/random-forest')
  ) {
    handleRandomForestRoute(req, res);
    return;
  }

  if (pathname === '/api/branding/logo') {
    handleBrandingRoute(req, res);
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

  sendFile(req, res, filePath);
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
prewarmCompressedAssets();

// Database maintenance: trim the professor activity log so it can't grow
// without bound. Runs once at startup, then once every 24h for as long as
// this process stays up.
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
cleanupProfessorActivityLog();
setInterval(cleanupProfessorActivityLog, ONE_DAY_MS);

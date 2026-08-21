const crypto = require('crypto');
const { getCurrentProfessorSession } = require('./auth-route.cjs');

const WEBSOCKET_MAGIC = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const HEARTBEAT_MS = 15000;
const professorClients = new Map();

function websocketAcceptValue(key) {
  return crypto
    .createHash('sha1')
    .update(`${String(key || '')}${WEBSOCKET_MAGIC}`)
    .digest('base64');
}

function encodeFrame(opcode, payload = '') {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
  const length = body.length;

  let header;
  if (length < 126) {
    header = Buffer.alloc(2);
    header[1] = length;
  } else if (length < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }

  header[0] = 0x80 | (opcode & 0x0f);
  return Buffer.concat([header, body]);
}

function decodeFrames(buffer) {
  const frames = [];
  let offset = 0;

  while (offset + 2 <= buffer.length) {
    const firstByte = buffer[offset];
    const secondByte = buffer[offset + 1];
    const opcode = firstByte & 0x0f;
    const masked = (secondByte & 0x80) === 0x80;
    let payloadLength = secondByte & 0x7f;
    let headerLength = 2;

    if (payloadLength === 126) {
      if (offset + 4 > buffer.length) break;
      payloadLength = buffer.readUInt16BE(offset + 2);
      headerLength = 4;
    } else if (payloadLength === 127) {
      if (offset + 10 > buffer.length) break;
      const bigLength = buffer.readBigUInt64BE(offset + 2);
      if (bigLength > BigInt(Number.MAX_SAFE_INTEGER)) break;
      payloadLength = Number(bigLength);
      headerLength = 10;
    }

    const maskLength = masked ? 4 : 0;
    const frameLength = headerLength + maskLength + payloadLength;
    if (offset + frameLength > buffer.length) break;

    const payloadStart = offset + headerLength + maskLength;
    let payload = buffer.subarray(payloadStart, payloadStart + payloadLength);

    if (masked) {
      const mask = buffer.subarray(offset + headerLength, offset + headerLength + 4);
      const unmasked = Buffer.alloc(payloadLength);
      for (let i = 0; i < payloadLength; i += 1) {
        unmasked[i] = payload[i] ^ mask[i % 4];
      }
      payload = unmasked;
    }

    frames.push({ opcode, payload });
    offset += frameLength;
  }

  return {
    frames,
    remaining: offset < buffer.length ? buffer.subarray(offset) : Buffer.alloc(0),
  };
}

function addProfessorClient(adminId, socket) {
  if (!professorClients.has(adminId)) professorClients.set(adminId, new Set());

  const client = {
    adminId,
    socket,
    buffer: Buffer.alloc(0),
    heartbeat: null,
    closed: false,
  };

  professorClients.get(adminId).add(client);
  return client;
}

function removeProfessorClient(client) {
  if (!client || client.closed) return;
  client.closed = true;
  if (client.heartbeat) clearInterval(client.heartbeat);

  const clients = professorClients.get(client.adminId);
  if (clients) {
    clients.delete(client);
    if (!clients.size) professorClients.delete(client.adminId);
  }

  try { client.socket.destroy(); } catch (_) {}
}

function sendSocketMessage(socket, message) {
  try {
    socket.write(encodeFrame(0x1, JSON.stringify(message)));
  } catch (_) {}
}

function broadcastProfessorMessage(adminId, message) {
  const clients = professorClients.get(adminId);
  if (!clients?.size) return;

  [...clients].forEach((client) => {
    if (client.socket.destroyed || client.closed) {
      removeProfessorClient(client);
      return;
    }
    sendSocketMessage(client.socket, message);
  });
}

function broadcastViolation(adminId, violation) {
  if (!adminId || !violation) return;
  broadcastProfessorMessage(adminId, {
    type: 'violation',
    payload: violation,
  });
}

function attachSocketLifecycle(client) {
  const { socket } = client;

  client.heartbeat = setInterval(() => {
    if (socket.destroyed || client.closed) {
      removeProfessorClient(client);
      return;
    }
    try {
      socket.write(encodeFrame(0x9));
    } catch (_) {
      removeProfessorClient(client);
    }
  }, HEARTBEAT_MS);

  socket.on('data', (chunk) => {
    if (client.closed) return;
    client.buffer = Buffer.concat([client.buffer, chunk]);
    const { frames, remaining } = decodeFrames(client.buffer);
    client.buffer = remaining;

    frames.forEach((frame) => {
      switch (frame.opcode) {
        case 0x8:
          try { socket.end(encodeFrame(0x8)); } catch (_) {}
          removeProfessorClient(client);
          break;
        case 0x9:
          try { socket.write(encodeFrame(0xA, frame.payload)); } catch (_) {}
          break;
        case 0xA:
        case 0x1:
        case 0x2:
        default:
          break;
      }
    });
  });

  socket.on('close', () => removeProfessorClient(client));
  socket.on('end', () => removeProfessorClient(client));
  socket.on('error', () => removeProfessorClient(client));
}

async function handleMonitorWebSocketUpgrade(req, socket, head) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname !== '/api/monitor/socket') return false;

  const upgrade = String(req.headers.upgrade || '').toLowerCase();
  const connection = String(req.headers.connection || '').toLowerCase();
  const key = String(req.headers['sec-websocket-key'] || '').trim();
  const version = String(req.headers['sec-websocket-version'] || '').trim();

  if (upgrade !== 'websocket' || !connection.includes('upgrade') || !key || version !== '13') {
    socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return true;
  }

  const admin = await getCurrentProfessorSession(req);
  if (!admin?.id) {
    socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return true;
  }

  const acceptValue = websocketAcceptValue(key);
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n'
    + 'Upgrade: websocket\r\n'
    + 'Connection: Upgrade\r\n'
    + `Sec-WebSocket-Accept: ${acceptValue}\r\n`
    + '\r\n',
  );

  socket.setNoDelay(true);
  socket.setKeepAlive(true, HEARTBEAT_MS);

  const client = addProfessorClient(admin.id, socket);
  attachSocketLifecycle(client);

  if (head && head.length) {
    socket.emit('data', head);
  }

  sendSocketMessage(socket, {
    type: 'connected',
    payload: {
      success: true,
      adminId: admin.id,
      connectedAt: new Date().toISOString(),
    },
  });

  return true;
}

module.exports = {
  handleMonitorWebSocketUpgrade,
  broadcastViolation,
};

const crypto = require('crypto');
const { query } = require('./db.cjs');
const { isConnectivityIssue, toUserMessage } = require('./error-utils.cjs');
const { broadcastViolation } = require('./monitor-websocket.cjs');
const {
  jsonResponse,
  readJsonBody,
  forbid,
  getCurrentProfessorSession,
  getCurrentStudentSession,
} = require('./auth-route.cjs');

const DEFAULT_VIOLATION_LIMIT = 50;
const MAX_VIOLATION_LIMIT = 200;
const STREAM_HEARTBEAT_MS = 15000;
const monitorStreamClients = new Map();

function createId() {
  return crypto.randomUUID ? crypto.randomUUID() : `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
}

function badRequest(res, message) {
  jsonResponse(res, 400, { success: false, message });
}

function methodNotAllowed(res) {
  jsonResponse(res, 405, { success: false, message: 'Method not allowed.' });
}

function normalizeLimit(rawLimit) {
  const parsed = Number.parseInt(String(rawLimit || DEFAULT_VIOLATION_LIMIT), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_VIOLATION_LIMIT;
  return Math.min(parsed, MAX_VIOLATION_LIMIT);
}

function normalizeMonitorViolation(row) {
  return {
    id: row.id,
    ownerAdminId: row.owner_admin_id || '',
    examId: row.exam_id || '',
    sessionId: row.session_id || '',
    studentId: row.student_id || '',
    studentName: row.student_name || '',
    violationType: row.violation_type || 'unknown',
    detail: row.detail || '',
    warningCount: Number(row.warning_count || 0),
    createdAt: row.created_at || null,
  };
}

function writeSseEvent(res, eventName, payload) {
  if (eventName) res.write(`event: ${eventName}\n`);
  if (typeof payload !== 'undefined') {
    const body = JSON.stringify(payload);
    body.split(/\r?\n/).forEach((line) => {
      res.write(`data: ${line}\n`);
    });
  }
  res.write('\n');
}

function addMonitorStreamClient(adminId, res) {
  if (!monitorStreamClients.has(adminId)) {
    monitorStreamClients.set(adminId, new Set());
  }

  const client = {
    res,
    heartbeat: setInterval(() => {
      try {
        res.write(': keep-alive\n\n');
      } catch (_) {}
    }, STREAM_HEARTBEAT_MS),
  };

  monitorStreamClients.get(adminId).add(client);
  return client;
}

function removeMonitorStreamClient(adminId, client) {
  if (!client) return;
  if (client.heartbeat) clearInterval(client.heartbeat);

  const clients = monitorStreamClients.get(adminId);
  if (!clients) return;
  clients.delete(client);
  if (!clients.size) monitorStreamClients.delete(adminId);
}

function broadcastViolationEvent(adminId, violation) {
  const clients = monitorStreamClients.get(adminId);
  if (!clients?.size) return;

  for (const client of [...clients]) {
    try {
      writeSseEvent(client.res, 'violation', violation);
    } catch (_) {
      removeMonitorStreamClient(adminId, client);
    }
  }
}

async function handleViolationInsert(req, res, body) {
  const student = await getCurrentStudentSession(req);
  if (!student) return forbid(res);

  const sessionId = String(body?.sessionId || '').trim();
  const examId = String(body?.examId || '').trim();
  const studentId = String(body?.studentId || '').trim().toUpperCase();
  const studentName = String(body?.studentName || '').trim();
  const violationType = String(body?.violationType || '').trim();
  const detail = String(body?.detail || '').trim();
  const warningCount = Number.parseInt(String(body?.warningCount ?? 0), 10);

  if (!sessionId) return badRequest(res, 'Session ID is required.');
  if (!examId) return badRequest(res, 'Exam ID is required.');
  if (!studentId) return badRequest(res, 'Student ID is required.');
  if (!violationType) return badRequest(res, 'Violation type is required.');
  if (student.studentId !== studentId) return forbid(res);

  const { rows } = await query(
    `select s.id,
            s.exam_id,
            s.student_id,
            s.student_name,
            coalesce(s.owner_admin_id, e.owner_admin_id) as owner_admin_id
       from public.sessions s
       left join public.exams e on e.id = s.exam_id
      where s.id = $1
      limit 1`,
    [sessionId],
  );
  const session = rows[0] || null;
  if (!session) return jsonResponse(res, 404, { success: false, message: 'Exam session not found.' });
  if (String(session.student_id || '').trim().toUpperCase() !== studentId) return forbid(res);
  if (String(session.exam_id || '').trim() !== examId) return badRequest(res, 'Exam session does not match the current exam.');

  const ownerAdminId = String(session.owner_admin_id || '').trim();
  if (!ownerAdminId) {
    return jsonResponse(res, 409, {
      success: false,
      message: 'This exam session is missing its professor owner. Please contact the system administrator.',
    });
  }

  const eventId = createId();
  const createdAt = new Date().toISOString();
  const effectiveWarningCount = Number.isFinite(warningCount) && warningCount >= 0 ? warningCount : 0;
  const effectiveStudentName = studentName || String(session.student_name || '').trim() || student.name || studentId;
  const violation = {
    id: eventId,
    ownerAdminId,
    examId,
    sessionId,
    studentId,
    studentName: effectiveStudentName,
    violationType,
    detail,
    warningCount: effectiveWarningCount,
    createdAt,
  };

  // Fast path: push to the professor immediately after validation instead of
  // waiting for the database insert/logging work to finish.
  broadcastViolationEvent(ownerAdminId, violation);
  broadcastViolation(ownerAdminId, violation);

  const insertResult = await query(
    `insert into public.violation_events (
       id, owner_admin_id, exam_id, session_id, student_id, student_name, violation_type, detail, warning_count, created_at
     ) values (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10::timestamptz
     )
     returning id, owner_admin_id, exam_id, session_id, student_id, student_name, violation_type, detail, warning_count, created_at`,
    [
      eventId,
      ownerAdminId,
      examId,
      sessionId,
      studentId,
      effectiveStudentName,
      violationType,
      detail,
      effectiveWarningCount,
      createdAt,
    ],
  );

  jsonResponse(res, 200, {
    success: true,
    violation: normalizeMonitorViolation(insertResult.rows[0] || violation),
  });
}

async function handleViolationList(req, res, url) {
  const admin = await getCurrentProfessorSession(req);
  if (!admin) return forbid(res);

  const examId = String(url.searchParams.get('examId') || '').trim();
  const since = String(url.searchParams.get('since') || '').trim();
  const limit = normalizeLimit(url.searchParams.get('limit'));
  const values = [admin.id];
  const where = ['owner_admin_id = $1'];

  if (examId) {
    values.push(examId);
    where.push(`exam_id = $${values.length}`);
  }

  if (since) {
    values.push(since);
    where.push(`created_at > $${values.length}::timestamptz`);
  }

  values.push(limit);
  const { rows } = await query(
    `select id, owner_admin_id, exam_id, session_id, student_id, student_name, violation_type, detail, warning_count, created_at
       from public.violation_events
      where ${where.join(' and ')}
      order by created_at asc, id asc
      limit $${values.length}`,
    values,
  );

  const violations = rows.map(normalizeMonitorViolation);
  jsonResponse(res, 200, {
    success: true,
    violations,
    cursor: violations.length ? violations[violations.length - 1].createdAt : since || null,
  });
}

async function handleSessionList(req, res, url) {
  const admin = await getCurrentProfessorSession(req);
  if (!admin) return forbid(res);

  const examId = String(url.searchParams.get('examId') || '').trim();
  if (!examId) return badRequest(res, 'Exam ID is required.');

  const { rows } = await query(
    `select s.*
       from public.sessions s
       left join public.exams e on e.id = s.exam_id
      where s.exam_id = $2
        and (
          s.owner_admin_id = $1
          or (s.owner_admin_id is null and e.owner_admin_id = $1)
        )
      order by s.created_at asc, s.id asc`,
    [admin.id, examId],
  );

  jsonResponse(res, 200, {
    success: true,
    examId,
    sessions: rows || [],
  });
}

async function handleMonitorStream(req, res) {
  const admin = await getCurrentProfessorSession(req);
  if (!admin) return forbid(res);

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  req.socket?.setKeepAlive?.(true);
  req.socket?.setNoDelay?.(true);
  res.flushHeaders?.();
  res.write('retry: 1000\n\n');

  const client = addMonitorStreamClient(admin.id, res);
  writeSseEvent(res, 'connected', { success: true, adminId: admin.id, connectedAt: new Date().toISOString() });

  const cleanup = () => removeMonitorStreamClient(admin.id, client);
  req.on('close', cleanup);
  res.on('close', cleanup);
}

async function handleMonitorRoute(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;

  try {
    if (pathname === '/api/monitor/violation') {
      if (req.method !== 'POST') return methodNotAllowed(res);
      let body;
      try {
        body = await readJsonBody(req);
      } catch {
        return badRequest(res, 'Invalid JSON body.');
      }
      return handleViolationInsert(req, res, body);
    }

    if (pathname === '/api/monitor/violations') {
      if (req.method !== 'GET') return methodNotAllowed(res);
      return handleViolationList(req, res, url);
    }

    if (pathname === '/api/monitor/sessions') {
      if (req.method !== 'GET') return methodNotAllowed(res);
      return handleSessionList(req, res, url);
    }

    if (pathname === '/api/monitor/stream') {
      if (req.method !== 'GET') return methodNotAllowed(res);
      return handleMonitorStream(req, res);
    }

    return false;
  } catch (error) {
    const connectivityIssue = isConnectivityIssue(error);
    const message = toUserMessage(error, 'Unable to process monitoring request right now.', { context: 'sync' });
    jsonResponse(res, connectivityIssue ? 503 : 500, { success: false, message, connectivityIssue });
    return true;
  }
}

module.exports = {
  handleMonitorRoute,
};

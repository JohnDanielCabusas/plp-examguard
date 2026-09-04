const crypto = require('crypto');
const path = require('path');
const { connect, query } = require('./db.cjs');
const { isConnectivityIssue, toUserMessage } = require('./error-utils.cjs');
const { broadcastViolation, broadcastViolationEvidence } = require('./monitor-websocket.cjs');
const {
  readEvidenceFile,
} = require('./violation-evidence-store.cjs');
const {
  downloadStorageObject,
  uploadStorageObject,
} = require('./supabase-storage.cjs');
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
const REPLAYABLE_VIOLATION_TYPES = new Set([
  'no_person',
  'multiple_people',
  'look_down',
  'low_brightness',
  'camera_off',
  'restricted_phone',
  'secondary_computer',
  'restricted_book',
]);

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
    detectionMetadata: row.detection_metadata && typeof row.detection_metadata === 'object'
      ? row.detection_metadata
      : {},
    warningCount: Number(row.warning_count || 0),
    createdAt: row.created_at || null,
  };
}

function normalizeDetectionMetadata(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const boundingBox = value.boundingBox && typeof value.boundingBox === 'object'
    ? {
        x: Math.max(0, Number(value.boundingBox.x || 0)),
        y: Math.max(0, Number(value.boundingBox.y || 0)),
        width: Math.max(0, Number(value.boundingBox.width || 0)),
        height: Math.max(0, Number(value.boundingBox.height || 0)),
        frameWidth: Math.max(0, Number(value.boundingBox.frameWidth || 0)),
        frameHeight: Math.max(0, Number(value.boundingBox.frameHeight || 0)),
      }
    : null;
  return {
    source: String(value.source || '').slice(0, 40),
    objectClass: String(value.objectClass || '').slice(0, 80),
    objectLabel: String(value.objectLabel || '').slice(0, 120),
    rawClass: String(value.rawClass || '').slice(0, 80),
    confidence: Math.max(0, Math.min(1, Number(value.confidence || 0))),
    averageConfidence: Math.max(0, Math.min(1, Number(value.averageConfidence || 0))),
    verificationConfidence: Math.max(0, Math.min(1, Number(value.verificationConfidence || 0))),
    fullFrameConfidence: Math.max(0, Math.min(1, Number(value.fullFrameConfidence || 0))),
    boundingBox,
    frameHits: Math.max(0, Math.min(100, Number(value.frameHits || 0))),
    confirmationMs: Math.max(0, Math.min(60000, Number(value.confirmationMs || 0))),
    modelVersion: String(value.modelVersion || '').slice(0, 120),
    inferenceBackend: String(value.inferenceBackend || '').slice(0, 40),
    inferenceMs: Math.max(0, Math.min(60000, Number(value.inferenceMs || 0))),
    policyMode: String(value.policyMode || '').slice(0, 20),
    policyDecision: String(value.policyDecision || '').slice(0, 40),
  };
}

function isReplayableViolationType(type) {
  return REPLAYABLE_VIOLATION_TYPES.has(String(type || '').trim());
}

function detectEvidenceMimeType(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 128) return '';
  const isWebm = buffer[0] === 0x1a
    && buffer[1] === 0x45
    && buffer[2] === 0xdf
    && buffer[3] === 0xa3;
  if (isWebm) return 'video/webm';

  const isMp4 = buffer.length >= 12 && buffer.subarray(4, 8).toString('ascii') === 'ftyp';
  if (isMp4) return 'video/mp4';

  return '';
}

function extensionForMimeType(mimeType) {
  return mimeType === 'video/mp4' ? 'mp4' : 'webm';
}

function normalizeReviewStatus(rawStatus) {
  const status = String(rawStatus || '').trim().toLowerCase();
  return ['pending', 'confirmed', 'dismissed'].includes(status) ? status : 'pending';
}

function normalizeEvidenceDuration(rawDurationMs) {
  const durationMs = Number.parseInt(String(rawDurationMs ?? 0), 10);
  if (!Number.isFinite(durationMs) || durationMs < 0) return 0;
  return Math.min(durationMs, 10000);
}

function normalizeWarningAdjustment(rawAdjustment) {
  const adjustment = Number.parseInt(String(rawAdjustment ?? 0), 10);
  if (!Number.isFinite(adjustment)) return 0;
  if (adjustment > 0) return 0;
  if (adjustment < -1) return -1;
  return adjustment;
}

function decodeBase64Payload(rawValue) {
  const value = String(rawValue || '').trim();
  if (!value) return null;
  const match = value.match(/^data:.*?;base64,(.+)$/i);
  const payload = match ? match[1] : value;
  return Buffer.from(payload, 'base64');
}

function isSupportedEvidenceBuffer(buffer, mimeType) {
  return detectEvidenceMimeType(buffer) === mimeType;
}

function normalizeEvidenceRow(row) {
  const storageBucket = row.storage_bucket || '';
  return {
    id: row.id,
    violationEventId: row.violation_event_id,
    ownerAdminId: row.owner_admin_id || '',
    examId: row.exam_id || '',
    sessionId: row.session_id || '',
    studentId: row.student_id || '',
    violationType: row.violation_type || 'unknown',
    evidenceType: row.evidence_type || 'pre_violation_webcam_clip',
    storageBucket,
    storagePath: row.storage_path || '',
    mimeType: row.mime_type || 'video/webm',
    clipStartedAt: row.clip_started_at || null,
    clipEndedAt: row.clip_ended_at || null,
    triggeredAt: row.triggered_at || null,
    durationMs: Number(row.duration_ms || 0),
    fileSizeBytes: Number(row.file_size_bytes || 0),
    reviewStatus: row.review_status || 'pending',
    reviewNotes: row.review_notes || '',
    warningAdjustment: Number(row.warning_adjustment || 0),
    warningApplied: !!row.warning_applied,
    reviewedBy: row.reviewed_by || '',
    reviewedAt: row.reviewed_at || null,
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
    rawWarnings: Number(row.raw_warnings ?? 0),
    adjustedWarnings: Number(row.adjusted_warnings ?? row.raw_warnings ?? 0),
    playbackUrl: row.id
      ? `/api/monitor/violation-evidence/${encodeURIComponent(row.id)}/file`
      : '',
  };
}

async function getSessionWarningSummary(sessionId) {
  const { rows } = await query(
    `select greatest(
              0,
              coalesce(s.warnings, 0)
              - coalesce(sum(case when ve.warning_applied then ve.warning_adjustment else 0 end), 0)
            ) as raw_warnings,
            greatest(0, coalesce(s.warnings, 0)) as adjusted_warnings
       from public.sessions s
       left join public.violation_evidence ve on ve.session_id = s.id
      where s.id = $1
      group by s.id, s.warnings
      limit 1`,
    [sessionId],
  );
  const row = rows[0] || null;
  return {
    rawWarnings: Number(row?.raw_warnings ?? 0),
    adjustedWarnings: Number(row?.adjusted_warnings ?? row?.raw_warnings ?? 0),
  };
}

async function getViolationEventForStudent(sessionId, violationEventId, examId, studentId) {
  const { rows } = await query(
    `select ve.id,
            ve.owner_admin_id,
            ve.exam_id,
            ve.session_id,
            ve.student_id,
            ve.violation_type,
            ve.created_at
       from public.violation_events ve
      where ve.id = $1
        and ve.session_id = $2
        and ve.exam_id = $3
        and upper(coalesce(ve.student_id, '')) = upper($4)
      limit 1`,
    [violationEventId, sessionId, examId, studentId],
  );
  return rows[0] || null;
}

async function getEvidenceRecordForProfessor(adminId, evidenceId) {
  const { rows } = await query(
    `select ve.*,
            greatest(
              0,
              coalesce(sess.warnings, 0)
              - coalesce(sum(case when peer.warning_applied then peer.warning_adjustment else 0 end), 0)
            ) as raw_warnings,
            greatest(0, coalesce(sess.warnings, 0)) as adjusted_warnings
       from public.violation_evidence ve
       left join public.sessions sess on sess.id = ve.session_id
       left join public.violation_evidence peer on peer.session_id = ve.session_id
      where ve.id = $1
        and ve.owner_admin_id = $2
      group by ve.id, sess.warnings
      limit 1`,
    [evidenceId, adminId],
  );
  return rows[0] || null;
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
  const detectionMetadata = normalizeDetectionMetadata(body?.detectionMetadata);
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
    detectionMetadata,
    warningCount: effectiveWarningCount,
    createdAt,
  };

  // Fast path: push to the professor immediately after validation instead of
  // waiting for the database insert/logging work to finish.
  broadcastViolationEvent(ownerAdminId, violation);
  broadcastViolation(ownerAdminId, violation);

  const insertResult = await query(
    `insert into public.violation_events (
       id, owner_admin_id, exam_id, session_id, student_id, student_name, violation_type, detail, detection_metadata, warning_count, created_at
     ) values (
       $1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11::timestamptz
     )
     returning id, owner_admin_id, exam_id, session_id, student_id, student_name, violation_type, detail, detection_metadata, warning_count, created_at`,
    [
      eventId,
      ownerAdminId,
      examId,
      sessionId,
      studentId,
      effectiveStudentName,
      violationType,
      detail,
      JSON.stringify(detectionMetadata),
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
    `select id, owner_admin_id, exam_id, session_id, student_id, student_name, violation_type, detail, detection_metadata, warning_count, created_at
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

async function handleViolationEvidenceInsert(req, res, body) {
  const student = await getCurrentStudentSession(req);
  if (!student) return forbid(res);

  const violationEventId = String(body?.violationEventId || '').trim();
  const sessionId = String(body?.sessionId || '').trim();
  const examId = String(body?.examId || '').trim();
  const studentId = String(body?.studentId || '').trim().toUpperCase();
  const violationType = String(body?.violationType || '').trim();
  const evidenceType = String(body?.evidenceType || 'pre_violation_webcam_clip').trim() || 'pre_violation_webcam_clip';
  const clipStartedAt = String(body?.clipStartedAt || '').trim();
  const clipEndedAt = String(body?.clipEndedAt || '').trim();
  const triggeredAt = String(body?.triggeredAt || '').trim();
  const durationMs = normalizeEvidenceDuration(body?.durationMs);
  const fileSizeBytes = Number.parseInt(String(body?.fileSizeBytes ?? 0), 10);
  const payloadBuffer = decodeBase64Payload(body?.clipBase64 || '');
  // Detect the real container from its bytes instead of trusting the browser's
  // MIME label. Safari may report an MP4 codec-qualified type (or no type).
  const mimeType = detectEvidenceMimeType(payloadBuffer);

  if (!violationEventId) return badRequest(res, 'Violation event ID is required.');
  if (!sessionId) return badRequest(res, 'Session ID is required.');
  if (!examId) return badRequest(res, 'Exam ID is required.');
  if (!studentId) return badRequest(res, 'Student ID is required.');
  if (!violationType) return badRequest(res, 'Violation type is required.');
  if (!clipStartedAt || !clipEndedAt || !triggeredAt) return badRequest(res, 'Clip timestamps are required.');
  if (!payloadBuffer?.length) return badRequest(res, 'Replay clip payload is required.');
  if (!mimeType || !isSupportedEvidenceBuffer(payloadBuffer, mimeType)) {
    return badRequest(res, 'Replay clip is not a valid WebM or MP4 video.');
  }
  if (student.studentId !== studentId) return forbid(res);
  if (!isReplayableViolationType(violationType)) {
    return badRequest(res, 'Replay evidence is only supported for webcam-detected violations.');
  }

  const violationEvent = await getViolationEventForStudent(sessionId, violationEventId, examId, studentId);
  if (!violationEvent) {
    return jsonResponse(res, 404, { success: false, message: 'Matching violation event not found for this session.' });
  }

  const evidenceId = createId();
  const storageBucket = 'violation-evidence';
  const storagePath = path.posix.join(
    'replays',
    examId,
    sessionId,
    `${violationEventId}.${extensionForMimeType(mimeType)}`,
  );

  await uploadStorageObject(storageBucket, storagePath, payloadBuffer, mimeType);

  const insertResult = await query(
    `insert into public.violation_evidence (
       id,
       violation_event_id,
       owner_admin_id,
       exam_id,
       session_id,
       student_id,
       violation_type,
       evidence_type,
       storage_bucket,
       storage_path,
       mime_type,
       clip_started_at,
       clip_ended_at,
       triggered_at,
       duration_ms,
       file_size_bytes
     ) values (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
       $12::timestamptz, $13::timestamptz, $14::timestamptz, $15, $16
     )
     on conflict (violation_event_id) do update
       set storage_bucket = excluded.storage_bucket,
           storage_path = excluded.storage_path,
           mime_type = excluded.mime_type,
           clip_started_at = excluded.clip_started_at,
           clip_ended_at = excluded.clip_ended_at,
           triggered_at = excluded.triggered_at,
           duration_ms = excluded.duration_ms,
           file_size_bytes = excluded.file_size_bytes,
           updated_at = now()
     returning *`,
    [
      evidenceId,
      violationEventId,
      String(violationEvent.owner_admin_id || '').trim() || null,
      examId,
      sessionId,
      studentId,
      violationType,
      evidenceType,
       storageBucket,
       storagePath,
       mimeType,
      clipStartedAt,
      clipEndedAt,
      triggeredAt,
      durationMs,
      Number.isFinite(fileSizeBytes) && fileSizeBytes > 0 ? fileSizeBytes : payloadBuffer.length,
     ],
  );

  const summary = await getSessionWarningSummary(sessionId);
  const evidence = {
    ...normalizeEvidenceRow(insertResult.rows[0] || {}),
    rawWarnings: summary.rawWarnings,
    adjustedWarnings: summary.adjustedWarnings,
  };
  broadcastViolationEvidence(String(violationEvent.owner_admin_id || '').trim(), evidence);
  jsonResponse(res, 200, {
    success: true,
    evidence,
  });
}

async function handleViolationEvidenceList(req, res, url) {
  const admin = await getCurrentProfessorSession(req);
  if (!admin) return forbid(res);

  const examId = String(url.searchParams.get('examId') || '').trim();
  const sessionId = String(url.searchParams.get('sessionId') || '').trim();
  const violationEventId = String(url.searchParams.get('violationEventId') || '').trim();
  const values = [admin.id];
  const where = ['ve.owner_admin_id = $1'];

  if (examId) {
    values.push(examId);
    where.push(`ve.exam_id = $${values.length}`);
  }
  if (sessionId) {
    values.push(sessionId);
    where.push(`ve.session_id = $${values.length}`);
  }
  if (violationEventId) {
    values.push(violationEventId);
    where.push(`ve.violation_event_id = $${values.length}`);
  }

  const { rows } = await query(
    `select ve.*,
            greatest(
              0,
              coalesce(sess.warnings, 0)
              - coalesce(sum(case when peer.warning_applied then peer.warning_adjustment else 0 end), 0)
            ) as raw_warnings,
            greatest(0, coalesce(sess.warnings, 0)) as adjusted_warnings
       from public.violation_evidence ve
       left join public.sessions sess on sess.id = ve.session_id
       left join public.violation_evidence peer on peer.session_id = ve.session_id
      where ${where.join(' and ')}
      group by ve.id, sess.warnings
      order by ve.created_at desc, ve.id desc`,
    values,
  );

  jsonResponse(res, 200, {
    success: true,
    evidence: rows.map(normalizeEvidenceRow),
  });
}

async function handleViolationEvidenceReview(req, res, evidenceId, body) {
  const admin = await getCurrentProfessorSession(req);
  if (!admin) return forbid(res);

  const reviewStatus = normalizeReviewStatus(body?.reviewStatus);
  const reviewNotes = String(body?.reviewNotes || '').trim();
  let warningAdjustment = normalizeWarningAdjustment(body?.warningAdjustment);

  if (!['confirmed', 'dismissed'].includes(reviewStatus)) {
    return badRequest(res, 'Review status must be confirmed or dismissed.');
  }

  if (reviewStatus === 'confirmed') warningAdjustment = 0;
  if (reviewStatus === 'dismissed' && warningAdjustment === 0) warningAdjustment = -1;

  const client = await connect();
  let updatedEvidence = null;
  let updatedSession = null;
  let reopened = false;

  try {
    await client.query('begin');
    const existingResult = await client.query(
      `select ve.*,
              sess.warnings as session_warnings,
              sess.submitted as session_submitted,
              sess.auto_submitted as session_auto_submitted,
              sess.submit_reason as session_submit_reason
         from public.violation_evidence ve
         join public.sessions sess on sess.id = ve.session_id
        where ve.id = $1
          and ve.owner_admin_id = $2
        for update of ve, sess`,
      [evidenceId, admin.id],
    );
    const existing = existingResult.rows[0] || null;
    if (!existing) {
      await client.query('rollback');
      return jsonResponse(res, 404, { success: false, message: 'Violation evidence record not found.' });
    }

    const previousAppliedAdjustment = existing.warning_applied
      ? normalizeWarningAdjustment(existing.warning_adjustment)
      : 0;
    const warningDelta = warningAdjustment - previousAppliedAdjustment;
    const evidenceResult = await client.query(
      `update public.violation_evidence
          set review_status = $3,
              review_notes = $4,
              warning_adjustment = $5,
              warning_applied = true,
              reviewed_by = $6,
              reviewed_at = now()
        where id = $1
          and owner_admin_id = $2
        returning *`,
      [evidenceId, admin.id, reviewStatus, reviewNotes || null, warningAdjustment, admin.id],
    );
    updatedEvidence = evidenceResult.rows[0] || existing;

    if (warningDelta !== 0) {
      const activity = [{
        type: warningDelta < 0 ? 'violation_review_dismissed' : 'violation_review_confirmed',
        timestamp: new Date().toISOString(),
        detail: warningDelta < 0
          ? 'Professor dismissed webcam violation replay as a false positive'
          : 'Professor changed replay review to confirmed',
      }];
      const sessionResult = await client.query(
        `update public.sessions
            set warnings = greatest(0, coalesce(warnings, 0) + $2),
                activities = coalesce(activities, '[]'::jsonb) || $3::jsonb
          where id = $1
          returning *`,
        [existing.session_id, warningDelta, JSON.stringify(activity)],
      );
      updatedSession = sessionResult.rows[0] || null;
    } else {
      const sessionResult = await client.query('select * from public.sessions where id = $1', [existing.session_id]);
      updatedSession = sessionResult.rows[0] || null;
    }

    const adjustmentResult = await client.query(
      `select coalesce(sum(warning_adjustment), 0)::integer as applied_adjustment
         from public.violation_evidence
        where session_id = $1
          and warning_applied = true`,
      [existing.session_id],
    );
    const appliedAdjustment = Number(adjustmentResult.rows[0]?.applied_adjustment || 0);
    const adjustedWarnings = Number(updatedSession?.warnings || 0);
    const recordedWarnings = Math.max(0, adjustedWarnings - appliedAdjustment);
    const wasWarningAutoSubmit = updatedSession?.submit_reason === 'violations'
      || (!updatedSession?.submit_reason && !!updatedSession?.auto_submitted && recordedWarnings >= 3);

    if (
      reviewStatus === 'dismissed'
      && updatedSession?.submitted
      && updatedSession?.auto_submitted
      && adjustedWarnings < 3
      && wasWarningAutoSubmit
    ) {
      const reopenActivity = [{
        type: 'violation_review_reopened',
        timestamp: new Date().toISOString(),
        detail: 'Exam reopened after professor dismissed a webcam violation replay',
      }];
      const reopenedResult = await client.query(
        `update public.sessions
            set submitted = false,
                auto_submitted = false,
                submit_reason = null,
                start_time = case
                  when start_time is not null and end_time is not null then start_time + (now() - end_time)
                  else start_time
                end,
                end_time = null,
                score = null,
                score_released = false,
                activities = coalesce(activities, '[]'::jsonb) || $2::jsonb
          where id = $1
          returning *`,
        [existing.session_id, JSON.stringify(reopenActivity)],
      );
      updatedSession = reopenedResult.rows[0] || updatedSession;
      reopened = true;
    }

    updatedEvidence.raw_warnings = recordedWarnings;
    updatedEvidence.adjusted_warnings = Number(updatedSession?.warnings || 0);
    await client.query('commit');
  } catch (error) {
    await client.query('rollback').catch(() => {});
    throw error;
  } finally {
    client.release();
  }

  jsonResponse(res, 200, {
    success: true,
    evidence: normalizeEvidenceRow(updatedEvidence),
    session: updatedSession,
    reopened,
  });
}

async function handleViolationEvidenceFile(req, res, evidenceId) {
  const admin = await getCurrentProfessorSession(req);
  if (!admin) return forbid(res);

  const evidence = await getEvidenceRecordForProfessor(admin.id, evidenceId);
  if (!evidence?.storage_path) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Evidence file not found.');
    return;
  }

  if (evidence.storage_bucket === 'local-server') {
    const { data } = await readEvidenceFile(evidence.storage_path);
    res.writeHead(200, {
      'Content-Type': evidence.mime_type || 'video/webm',
      'Content-Length': data.length,
      'Cache-Control': 'private, no-store',
      'Accept-Ranges': 'bytes',
    });
    res.end(data);
    return;
  }

  const object = await downloadStorageObject(
    evidence.storage_bucket,
    evidence.storage_path,
    String(req.headers.range || '').trim(),
  );
  const headers = {
    'Content-Type': evidence.mime_type || 'video/webm',
    'Content-Length': object.contentLength || object.data.length,
    'Cache-Control': 'private, no-store',
    'Accept-Ranges': object.acceptRanges || 'bytes',
  };
  if (object.contentRange) headers['Content-Range'] = object.contentRange;
  res.writeHead(object.status === 206 ? 206 : 200, headers);
  res.end(object.data);
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
  const evidenceReviewMatch = pathname.match(/^\/api\/monitor\/violation-evidence\/([^/]+)\/review$/);
  const evidenceFileMatch = pathname.match(/^\/api\/monitor\/violation-evidence\/([^/]+)\/file$/);

  try {
    if (pathname === '/api/monitor/violation') {
      if (req.method !== 'POST') return methodNotAllowed(res);
      let body;
      try {
        body = await readJsonBody(req);
      } catch {
        return badRequest(res, 'Invalid JSON body.');
      }
      return await handleViolationInsert(req, res, body);
    }

    if (pathname === '/api/monitor/violations') {
      if (req.method !== 'GET') return methodNotAllowed(res);
      return await handleViolationList(req, res, url);
    }

    if (pathname === '/api/monitor/sessions') {
      if (req.method !== 'GET') return methodNotAllowed(res);
      return await handleSessionList(req, res, url);
    }

    if (pathname === '/api/monitor/violation-evidence') {
      if (req.method === 'GET') return await handleViolationEvidenceList(req, res, url);
      if (req.method === 'POST') {
        let body;
        try {
          body = await readJsonBody(req);
        } catch {
          return badRequest(res, 'Invalid JSON body.');
        }
        return await handleViolationEvidenceInsert(req, res, body);
      }
      return methodNotAllowed(res);
    }

    if (evidenceReviewMatch) {
      if (req.method !== 'PATCH') return methodNotAllowed(res);
      let body;
      try {
        body = await readJsonBody(req);
      } catch {
        return badRequest(res, 'Invalid JSON body.');
      }
      return await handleViolationEvidenceReview(req, res, decodeURIComponent(evidenceReviewMatch[1]), body);
    }

    if (evidenceFileMatch) {
      if (req.method !== 'GET') return methodNotAllowed(res);
      return await handleViolationEvidenceFile(req, res, decodeURIComponent(evidenceFileMatch[1]));
    }

    if (pathname === '/api/monitor/stream') {
      if (req.method !== 'GET') return methodNotAllowed(res);
      return await handleMonitorStream(req, res);
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

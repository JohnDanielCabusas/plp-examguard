const { evidenceListQuery } = require('./evidence-list-query.cjs');
const crypto = require('crypto');
const path = require('path');
const { connect, query } = require('./db.cjs');
const { isConnectivityIssue, toUserMessage } = require('./error-utils.cjs');
const { broadcastViolation, broadcastViolationEvidence } = require('./monitor-websocket.cjs');
const {
  readEvidenceFile,
} = require('./violation-evidence-store.cjs');
const {
  deleteStorageObject,
  downloadStorageObject,
  uploadStorageObject,
} = require('./supabase-storage.cjs');
const {
  jsonResponse,
  readJsonBody,
  forbid,
  getCurrentProfessorSession,
  getCurrentStudentSession,
  getCurrentSysAdminSession,
} = require('./auth-route.cjs');

const { storeSnapshot, readSnapshot, decodeSnapshot } = require('./snapshot-assets.cjs');

const DEFAULT_VIOLATION_LIMIT = 50;
const MAX_VIOLATION_LIMIT = 200;
const STREAM_HEARTBEAT_MS = 15000;
const monitorStreamClients = new Map();
const FACEMESH_INCIDENT_TYPES = new Set([
  'FACE_ABSENT',
  'FACE_PARTIALLY_VISIBLE',
  'FACE_TOO_CLOSE',
  'FACE_TOO_FAR',
  'FACE_NEAR_FRAME_EDGE',
  'SUSTAINED_HEAD_TURN',
  'SUSTAINED_LOOKING_DOWN',
  'REPEATED_LOOKING_AWAY',
  'FACE_OCCLUDED',
  'FACE_TRACKING_UNSTABLE',
  'PHONE_NEAR_OR_COVERING_FACE',
  'FACE_LIVENESS_UNCONFIRMED',
  'FACE_ON_PHONE_SCREEN',
]);
// Incidents that need both the face scan and the object detector to agree.
const FACEMESH_YOLO_INCIDENT_TYPES = new Set([
  'PHONE_NEAR_OR_COVERING_FACE',
  'FACE_ON_PHONE_SCREEN',
]);
const REPLAYABLE_VIOLATION_TYPES = new Set([
  'no_person',
  'multiple_people',
  'look_down',
  'low_brightness',
  'camera_off',
  'restricted_phone',
  'secondary_computer',
  'restricted_book',
  ...FACEMESH_INCIDENT_TYPES,
]);
// These are the activity entries that can be tied to a formal warning.  The
// session warning counter itself is only a number, so retaining the dismissal
// on the original activity gives professors an auditable, one-click reversal
// instead of silently altering the student's record.
const WARNING_ACTIVITY_TYPES = new Set([
  'no_person', 'multiple_people', 'look_down', 'low_brightness', 'camera_off',
  'window_blur', 'tab_switch', 'fullscreen_exit', 'copy_attempt', 'paste_attempt',
  'ctrl_c_attempt', 'ctrl_v_attempt', 'screen_record', 'camera_denied', 'screenshot',
  'restricted_phone', 'secondary_computer', 'restricted_book',
  ...FACEMESH_INCIDENT_TYPES,
]);
// What a review hands back to the professor's page: the monitoring summary plus
// the timeline the decision changed. Answers, camera images and archived
// attempts are left out; they did not change and are the bulk of the row.
const REVIEWED_SESSION_COLUMNS = `id, exam_id, exam_code, student_id, student_name, year_level, section,
  year_section, department, program, start_time, end_time, warnings, score, max_score, submitted,
  auto_submitted, submit_reason, score_released, owner_admin_id, created_at, activities`;
// Ends the attempt outright rather than counting as one of the three strikes,
// so dismissing it has no warning to give back.
const TERMINAL_ACTIVITY_TYPES = new Set(['screen_record']);

function isReviewableActivity(activity) {
  const type = String(activity?.type || '').trim();
  return WARNING_ACTIVITY_TYPES.has(type) || activity?.metadata?.countsAsWarning === true;
}

// Whether this activity actually cost the student a warning. Being a violation
// type is not enough: a YOLO alert, a review-only FaceMesh indicator and anything
// raised while the exam was on hold are recorded without a strike.
function activityCountsAsWarning(activity) {
  const type = String(activity?.type || '').trim();
  const metadata = activity?.metadata && typeof activity.metadata === 'object' ? activity.metadata : {};
  if (metadata.offlineHold === true || metadata.countsAsWarning === false) return false;
  if (metadata.policyMode === 'alert' || metadata.policyMode === 'shadow') return false;
  if (TERMINAL_ACTIVITY_TYPES.has(type)) return false;
  if (FACEMESH_INCIDENT_TYPES.has(type)) return metadata.countsAsWarning === true;
  return WARNING_ACTIVITY_TYPES.has(type) || metadata.countsAsWarning === true;
}
const FACEMESH_EVENT_SEVERITY = Object.freeze({
  FACE_ABSENT: 'MODERATE',
  FACE_PARTIALLY_VISIBLE: 'INFO',
  FACE_TOO_CLOSE: 'INFO',
  FACE_TOO_FAR: 'INFO',
  FACE_NEAR_FRAME_EDGE: 'INFO',
  SUSTAINED_HEAD_TURN: 'LOW',
  SUSTAINED_LOOKING_DOWN: 'LOW',
  REPEATED_LOOKING_AWAY: 'MODERATE',
  FACE_OCCLUDED: 'LOW',
  FACE_TRACKING_UNSTABLE: 'INFO',
  PHONE_NEAR_OR_COVERING_FACE: 'HIGH',
  FACE_LIVENESS_UNCONFIRMED: 'MODERATE',
  FACE_ON_PHONE_SCREEN: 'HIGH',
});
const FACEMESH_EVENT_DETAILS = Object.freeze({
  FACE_ABSENT: 'No person detected in the camera frame',
  FACE_PARTIALLY_VISIBLE: 'Face partially outside camera',
  FACE_TOO_CLOSE: 'Face is too close to the camera',
  FACE_TOO_FAR: 'Face is too far from the camera',
  FACE_NEAR_FRAME_EDGE: 'Face is near the camera frame edge',
  SUSTAINED_HEAD_TURN: 'Sustained head turn detected',
  SUSTAINED_LOOKING_DOWN: 'Sustained downward head direction detected',
  REPEATED_LOOKING_AWAY: 'Repeated looking-away pattern detected',
  FACE_OCCLUDED: 'Face appears obstructed',
  FACE_TRACKING_UNSTABLE: 'Face tracking is unstable',
  PHONE_NEAR_OR_COVERING_FACE: 'Phone detected near or covering the face',
  FACE_LIVENESS_UNCONFIRMED: 'Face did not respond to the on-screen liveness check',
  FACE_ON_PHONE_SCREEN: 'Face appears to be shown on a phone screen',
});

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
    clientIncidentId: String(value.clientIncidentId || '').slice(0, 128),
    phase: ['start', 'update', 'end'].includes(String(value.phase || '').toLowerCase())
      ? String(value.phase).toLowerCase()
      : '',
    severity: ['INFO', 'LOW', 'MODERATE', 'HIGH'].includes(String(value.severity || '').toUpperCase())
      ? String(value.severity).toUpperCase()
      : 'INFO',
    direction: ['LEFT', 'RIGHT', 'UP', 'DOWN', 'CENTER'].includes(String(value.direction || '').toUpperCase())
      ? String(value.direction).toUpperCase()
      : '',
    startedAt: String(value.startedAt || '').slice(0, 40),
    endedAt: String(value.endedAt || '').slice(0, 40),
    durationMs: Math.max(0, Math.min(86400000, Number(value.durationMs || 0))),
    maxYaw: Math.max(0, Math.min(180, Math.abs(Number(value.maxYaw || 0)))),
    maxPitch: Math.max(0, Math.min(180, Math.abs(Number(value.maxPitch || 0)))),
    trackingConfidence: Math.max(0, Math.min(1, Number(value.trackingConfidence || 0))),
    phoneConfidence: Math.max(0, Math.min(1, Number(value.phoneConfidence || 0))),
    requiresProfessorReview: value.requiresProfessorReview !== false,
    countsAsWarning: value.countsAsWarning === true,
    relatedIncidentIds: Array.isArray(value.relatedIncidentIds)
      ? value.relatedIncidentIds.slice(0, 20).map(item => String(item || '').slice(0, 128)).filter(Boolean)
      : [],
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

// A replay holds at least the ten seconds before detection, plus up to five more
// from the recorder that was cut (see the exam page's replay buffer).
const MAX_REPLAY_CLIP_MS = 20000;

function normalizeEvidenceDuration(rawDurationMs) {
  const durationMs = Number.parseInt(String(rawDurationMs ?? 0), 10);
  if (!Number.isFinite(durationMs) || durationMs < 0) return 0;
  return Math.min(durationMs, MAX_REPLAY_CLIP_MS);
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

async function handleFaceIncidentUpsert(req, res, body) {
  const student = await getCurrentStudentSession(req);
  if (!student) return forbid(res);

  const sessionId = String(body?.sessionId || '').trim();
  const examId = String(body?.examId || '').trim();
  const studentId = String(body?.studentId || '').trim().toUpperCase();
  const studentName = String(body?.studentName || '').trim();
  const eventType = String(body?.eventType || '').trim().toUpperCase();
  const clientIncidentId = String(body?.clientIncidentId || '').trim();
  const phase = String(body?.phase || '').trim().toLowerCase();
  const source = String(body?.source || 'FACEMESH').trim().toUpperCase();

  if (!sessionId || !examId || !studentId) return badRequest(res, 'Exam session identifiers are required.');
  if (!FACEMESH_INCIDENT_TYPES.has(eventType)) return badRequest(res, 'Unsupported FaceMesh incident type.');
  if (!/^[a-zA-Z0-9-]{8,128}$/.test(clientIncidentId)) return badRequest(res, 'Invalid incident ID.');
  if (!['start', 'update', 'end'].includes(phase)) return badRequest(res, 'Invalid incident phase.');
  if (!['FACEMESH', 'FACEMESH_YOLO'].includes(source)) return badRequest(res, 'Invalid incident source.');
  if (FACEMESH_YOLO_INCIDENT_TYPES.has(eventType) !== (source === 'FACEMESH_YOLO')) {
    return badRequest(res, 'Incident source does not match its event type.');
  }
  if (student.studentId !== studentId) return forbid(res);

  const { rows } = await query(
    `select s.id,
            s.exam_id,
            s.student_id,
            s.student_name,
            coalesce(s.warnings, 0) as warnings,
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
  if (!ownerAdminId) return jsonResponse(res, 409, { success: false, message: 'Exam professor owner is missing.' });

  const startedDate = new Date(body?.startedAt || Date.now());
  const createdAt = Number.isFinite(startedDate.getTime()) ? startedDate.toISOString() : new Date().toISOString();
  const detectionMetadata = normalizeDetectionMetadata({
    ...body,
    clientIncidentId,
    phase,
    source,
  });
  detectionMetadata.severity = FACEMESH_EVENT_SEVERITY[eventType];
  detectionMetadata.requiresProfessorReview = true;
  const detail = FACEMESH_EVENT_DETAILS[eventType];
  const sessionWarningCount = Math.max(0, Math.min(3, Number(session.warnings || 0)));
  const requestedWarningCount = Math.max(0, Math.min(3, Number(body?.warningCount || 0)));
  // A completed FaceMesh rule now counts as a formal warning. The browser may
  // sync the incident before the session UPSERT reaches Supabase, so reflect
  // its bounded warning count in the live event without lowering server state.
  const effectiveWarningCount = detectionMetadata.countsAsWarning
    ? Math.max(sessionWarningCount, requestedWarningCount)
    : sessionWarningCount;
  const effectiveStudentName = studentName || String(session.student_name || '').trim() || student.name || studentId;
  const liveIncident = {
    id: clientIncidentId,
    ownerAdminId,
    examId,
    sessionId,
    studentId,
    studentName: effectiveStudentName,
    violationType: eventType,
    detail,
    detectionMetadata,
    warningCount: effectiveWarningCount,
    createdAt,
  };

  // The initial WebSocket alert is real-time UI, so it must not wait for the
  // incident UPSERT. Later phases still persist normally and update the
  // monitoring timeline after Supabase confirms them.
  if (phase === 'start') {
    broadcastViolationEvent(ownerAdminId, liveIncident);
    broadcastViolation(ownerAdminId, liveIncident);
  }

  const insertResult = await query(
    `insert into public.violation_events as existing (
       id, owner_admin_id, exam_id, session_id, student_id, student_name, violation_type, detail, detection_metadata, warning_count, created_at
     ) values (
       $1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11::timestamptz
     )
     on conflict (id) do update
       set detail = excluded.detail,
           detection_metadata = excluded.detection_metadata,
           warning_count = excluded.warning_count
       where existing.owner_admin_id = excluded.owner_admin_id
         and existing.session_id = excluded.session_id
         and existing.student_id = excluded.student_id
     returning id, owner_admin_id, exam_id, session_id, student_id, student_name, violation_type, detail, detection_metadata, warning_count, created_at`,
    [
      clientIncidentId,
      ownerAdminId,
      examId,
      sessionId,
      studentId,
      effectiveStudentName,
      eventType,
      detail,
      JSON.stringify(detectionMetadata),
      effectiveWarningCount,
      createdAt,
    ],
  );
  if (!insertResult.rows.length) return jsonResponse(res, 409, { success: false, message: 'Incident ID is already in use.' });

  const incident = normalizeMonitorViolation(insertResult.rows[0]);
  if (phase !== 'start') {
    broadcastViolationEvent(ownerAdminId, incident);
    broadcastViolation(ownerAdminId, incident);
  }
  return jsonResponse(res, 200, { success: true, incident });
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

  // The video is uploaded first so no row ever points at a missing file. If the
  // row is then refused, the video is removed again: a database check that once
  // rejected every FaceMesh clip left 151 unreferenced videos (41 MB) behind.
  let insertResult;
  try {
    insertResult = await query(
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
  } catch (error) {
    await deleteStorageObject(storageBucket, storagePath).catch(() => {});
    throw error;
  }

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
    evidenceListQuery(where),
    values,
  );

  jsonResponse(res, 200, {
    success: true,
    evidence: rows.map(normalizeEvidenceRow),
  });
}

// One decision path for every violation a professor reviews: browser activity,
// webcam detections, FaceMesh incidents and YOLO alerts, with or without a
// replay clip. Two separate paths (a replay review and a warning dismissal) used
// to exist, and because neither knew about the other the same violation could be
// deducted twice, and a YOLO alert that never cost a warning had one taken off.
//
// The deduction for a violation is recorded on the activity itself
// (metadata.warningDismissed), so it can only ever be applied once and is undone
// exactly once if the professor changes the decision back to confirmed.
async function handleActivityReview(req, res, sessionId, activityIndex, body) {
  const admin = await getCurrentProfessorSession(req);
  if (!admin) return forbid(res);

  const reviewStatus = normalizeReviewStatus(body?.reviewStatus);
  if (!['confirmed', 'dismissed'].includes(reviewStatus)) {
    return badRequest(res, 'Review status must be confirmed or dismissed.');
  }
  if (!Number.isInteger(activityIndex) || activityIndex < 0) {
    return badRequest(res, 'A violation activity is required.');
  }
  const reviewNotes = String(body?.reviewNotes || '').trim().slice(0, 2000);
  const evidenceId = String(body?.evidenceId || '').trim();

  const client = await connect();
  try {
    await client.query('begin');
    // Only the one activity is read. The activities column grows with the whole
    // attempt, and the row lock already keeps the index stable underneath us.
    const result = await client.query(
      `select s.id, s.exam_id, s.warnings, s.submitted, s.auto_submitted, s.submit_reason,
              s.start_time, s.end_time,
              s.activities -> $2::int as activity,
              coalesce(s.owner_admin_id, e.owner_admin_id) as effective_owner_admin_id
         from public.sessions s
         left join public.exams e on e.id = s.exam_id
        where s.id = $1
        for update of s`,
      [sessionId, activityIndex],
    );
    const session = result.rows[0] || null;
    if (!session || String(session.effective_owner_admin_id || '') !== String(admin.id || '')) {
      await client.query('rollback');
      return jsonResponse(res, 404, { success: false, message: 'Exam session not found.' });
    }
    const activity = session.activity && typeof session.activity === 'object' ? session.activity : null;
    if (!activity || !isReviewableActivity(activity)) {
      await client.query('rollback');
      return badRequest(res, 'That activity is not a reviewable violation.');
    }

    let evidence = null;
    if (evidenceId) {
      const evidenceResult = await client.query(
        `select id, warning_applied, warning_adjustment
           from public.violation_evidence
          where id = $1 and session_id = $2 and owner_admin_id = $3
          for update`,
        [evidenceId, sessionId, admin.id],
      );
      evidence = evidenceResult.rows[0] || null;
      if (!evidence) {
        await client.query('rollback');
        return jsonResponse(res, 404, { success: false, message: 'Violation evidence record not found.' });
      }
    }

    const metadata = activity.metadata && typeof activity.metadata === 'object' ? activity.metadata : {};
    // A replay dismissed before this route existed deducted through the evidence
    // row. That deduction is moved onto the activity below, so it is not repeated.
    const legacyEvidenceDeduction = !!evidence?.warning_applied && Number(evidence.warning_adjustment || 0) < 0;
    const alreadyDeducted = metadata.warningDismissed === true || legacyEvidenceDeduction;
    const counted = activityCountsAsWarning(activity);

    let warningDelta = 0;
    if (reviewStatus === 'dismissed' && counted && !alreadyDeducted && Number(session.warnings || 0) > 0) warningDelta = -1;
    if (reviewStatus === 'confirmed' && alreadyDeducted) warningDelta = 1;
    const deducted = reviewStatus === 'dismissed' ? (alreadyDeducted || warningDelta < 0) : false;

    const reviewedAt = new Date().toISOString();
    const nextMetadata = {
      ...metadata,
      reviewStatus,
      reviewNotes: reviewNotes || null,
      reviewedAt,
      reviewedBy: admin.id,
      warningDismissed: deducted,
      warningDismissedAt: deducted ? (metadata.warningDismissedAt || reviewedAt) : null,
      warningDismissedBy: deducted ? (metadata.warningDismissedBy || admin.id) : null,
    };
    const audit = warningDelta === 0 ? [] : [{
      type: warningDelta < 0 ? 'warning_dismissed' : 'violation_review_confirmed',
      timestamp: reviewedAt,
      detail: warningDelta < 0
        ? `Professor dismissed the ${String(activity.type || '').replace(/_/g, ' ')} warning as a false positive`
        : `Professor changed the ${String(activity.type || '').replace(/_/g, ' ')} review back to confirmed`,
      metadata: { reviewedActivityIndex: activityIndex, reviewedActivityType: activity.type },
    }];

    const update = await client.query(
      `update public.sessions
          set warnings = greatest(0, coalesce(warnings, 0) + $3),
              activities = jsonb_set(coalesce(activities, '[]'::jsonb), array[$2::text, 'metadata'], $4::jsonb, true)
                           || $5::jsonb
        where id = $1
        returning ${REVIEWED_SESSION_COLUMNS}`,
      [sessionId, String(activityIndex), warningDelta, JSON.stringify(nextMetadata), JSON.stringify(audit)],
    );
    let updatedSession = update.rows[0] || null;

    let updatedEvidence = null;
    if (evidence) {
      // The deduction now lives on the activity, so the evidence row no longer
      // carries one; it only records the review.
      const evidenceUpdate = await client.query(
        `update public.violation_evidence
            set review_status = $2,
                review_notes = $3,
                warning_adjustment = 0,
                warning_applied = true,
                reviewed_by = $4,
                reviewed_at = now(),
                updated_at = now()
          where id = $1
          returning *`,
        [evidence.id, reviewStatus, reviewNotes || null, admin.id],
      );
      updatedEvidence = evidenceUpdate.rows[0] || null;
    }

    // A false positive that pushed the student over the limit also caused the
    // automatic submission, so dismissing it hands the attempt back.
    let reopened = false;
    const remainingWarnings = Number(updatedSession?.warnings || 0);
    const submittedForViolations = updatedSession?.submit_reason === 'violations'
      || (!updatedSession?.submit_reason && !!updatedSession?.auto_submitted && Number(session.warnings || 0) >= 3);
    if (
      warningDelta < 0
      && updatedSession?.submitted
      && updatedSession?.auto_submitted
      && submittedForViolations
      && remainingWarnings < 3
    ) {
      const reopenActivity = [{
        type: 'violation_review_reopened',
        timestamp: new Date().toISOString(),
        detail: 'Exam reopened after professor dismissed the violation that ended it',
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
          returning ${REVIEWED_SESSION_COLUMNS}`,
        [sessionId, JSON.stringify(reopenActivity)],
      );
      updatedSession = reopenedResult.rows[0] || updatedSession;
      reopened = true;
    }

    await client.query('commit');
    return jsonResponse(res, 200, {
      success: true,
      session: updatedSession,
      evidence: updatedEvidence ? normalizeEvidenceRow(updatedEvidence) : null,
      warningDelta,
      reopened,
    });
  } catch (error) {
    await client.query('rollback').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
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

  // A re-uploaded replay keeps its evidence id but changes these fields. The
  // browser revalidates each view; an unchanged clip is answered without
  // downloading it from Storage again.
  const etag = `"${crypto.createHash('sha256')
    .update([evidence.id, evidence.storage_path, evidence.file_size_bytes, evidence.clip_ended_at].join('|'))
    .digest('hex').slice(0, 32)}"`;
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, { 'Cache-Control': 'private, no-cache', ETag: etag });
    res.end();
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
    'Cache-Control': 'private, no-cache',
    ETag: etag,
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
    `select s.id,
            s.exam_id,
            s.exam_code,
            s.student_id,
            s.student_name,
            s.year_level,
            s.section,
            s.year_section,
            s.department,
            s.program,
            s.start_time,
            s.end_time,
            s.warnings,
            s.score,
            s.max_score,
            s.submitted,
            s.auto_submitted,
            s.submit_reason,
            s.score_released,
            s.owner_admin_id,
            s.created_at,
            case
              when jsonb_typeof(s.camera_snapshots) = 'array' and jsonb_array_length(s.camera_snapshots) > 0
                then jsonb_build_array(s.camera_snapshots -> 0)
              else '[]'::jsonb
            end as camera_snapshots
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

async function authorizeSnapshotSession(req, sessionId) {
  const { rows } = await query(`select s.student_id, coalesce(s.owner_admin_id,e.owner_admin_id) owner_admin_id
    from public.sessions s left join public.exams e on e.id=s.exam_id where s.id=$1`, [sessionId]);
  if (!rows[0]) return false;
  const student = await getCurrentStudentSession(req);
  if (student?.studentId === rows[0].student_id) return true;
  const professor = await getCurrentProfessorSession(req);
  if (professor?.id === rows[0].owner_admin_id) return true;
  return !!(await getCurrentSysAdminSession(req));
}

async function handleSnapshotUpload(req, res) {
  let body;
  try { body = await readSnapshotBody(req); }
  catch (error) { jsonResponse(res, error.status || 400, { success: false, message: error.message }); return true; }
  const sessionId = String(body?.sessionId || '').trim();
  if (!sessionId || !(await authorizeSnapshotSession(req, sessionId))) { forbid(res); return true; }
  try { decodeSnapshot(body?.imageData); }
  catch (error) { jsonResponse(res, 400, { success: false, message: error.message }); return true; }
  const snapshot = await storeSnapshot(sessionId, body.imageData);
  jsonResponse(res, 200, { success: true, snapshot });
  return true;
}

function readSnapshotBody(req) {
  return new Promise((resolve, reject) => {
    let bytes = 0;
    const chunks = [];
    req.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > 3 * 1024 * 1024) {
        const error = new Error('Snapshot request is too large.'); error.status = 413;
        reject(error);
      } else chunks.push(chunk);
    });
    req.on('error', reject);
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch (_) { reject(new Error('Invalid snapshot request.')); }
    });
  });
}

async function handleSnapshotFile(req, res, id) {
  const { rows } = await query('select session_id from public.camera_snapshot_assets where id=$1', [id]);
  if (!rows[0] || !(await authorizeSnapshotSession(req, rows[0].session_id))) { forbid(res); return true; }
  const etag = `"${id}"`;
  // The id is a hash of the image bytes, so a URL's content never changes.
  const headers = { 'Cache-Control': 'private, max-age=31536000, immutable', 'ETag': etag, 'X-Content-Type-Options': 'nosniff' };
  if (req.headers['if-none-match'] === etag) { res.writeHead(304, headers); res.end(); return true; }
  const snapshot = await readSnapshot(id);
  if (!snapshot) { jsonResponse(res, 404, { success: false, message: 'Snapshot unavailable.' }); return true; }
  res.writeHead(200, { ...headers, 'Content-Type': snapshot.mime_type, 'Content-Length': snapshot.data.length });
  res.end(snapshot.data);
  return true;
}

async function handleDashboardSummary(req, res) {
  const admin = await getCurrentProfessorSession(req);
  if (!admin) { forbid(res); return true; }
  const { rows } = await query(`select
    (select count(*)::integer from public.subjects where owner_admin_id=$1) subjects,
    (select count(*)::integer from public.students st where not coalesce(st.archived,false)
      and exists (select 1 from public.subjects sub where sub.owner_admin_id=$1
        and st.enrolled_subjects @> jsonb_build_array(sub.id))) students,
    (select count(*)::integer from public.exams where owner_admin_id=$1) exams,
    (select count(*)::integer from public.exams where owner_admin_id=$1 and status='active') as "activeExams",
    (select count(*)::integer from public.sessions s left join public.exams e on e.id=s.exam_id
      where coalesce(s.owner_admin_id,e.owner_admin_id)=$1 and s.submitted) submissions`, [admin.id]);
  jsonResponse(res, 200, { success: true, summary: rows[0] });
  return true;
}

async function handleMonitorRoute(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;
  const snapshotFileMatch = pathname.match(/^\/api\/monitor\/snapshots\/([a-f0-9]{64})\/file$/);
  const activityReviewMatch = pathname.match(/^\/api\/monitor\/sessions\/([^/]+)\/activities\/(\d+)\/review$/);
  const evidenceFileMatch = pathname.match(/^\/api\/monitor\/violation-evidence\/([^/]+)\/file$/);

  try {
    // Students' connection indicator probes this every few seconds; it must not
    // touch the database.
    if (pathname === '/api/monitor/health') {
      res.writeHead(204, { 'Cache-Control': 'no-store' });
      res.end();
      return;
    }

    if (pathname === '/api/monitor/snapshots') {
      if (req.method !== 'POST') return methodNotAllowed(res);
      return await handleSnapshotUpload(req, res);
    }
    if (snapshotFileMatch) {
      if (req.method !== 'GET') return methodNotAllowed(res);
      return await handleSnapshotFile(req, res, snapshotFileMatch[1]);
    }
    if (pathname === '/api/monitor/dashboard-summary') {
      if (req.method !== 'GET') return methodNotAllowed(res);
      return await handleDashboardSummary(req, res);
    }
    if (pathname === '/api/monitor/incident') {
      if (req.method !== 'POST') return methodNotAllowed(res);
      let body;
      try {
        body = await readJsonBody(req);
      } catch {
        return badRequest(res, 'Invalid JSON body.');
      }
      return await handleFaceIncidentUpsert(req, res, body);
    }

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

    if (activityReviewMatch) {
      if (req.method !== 'PATCH') return methodNotAllowed(res);
      let body;
      try {
        body = await readJsonBody(req);
      } catch {
        return badRequest(res, 'Invalid JSON body.');
      }
      return await handleActivityReview(
        req,
        res,
        decodeURIComponent(activityReviewMatch[1]),
        Number.parseInt(activityReviewMatch[2], 10),
        body,
      );
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

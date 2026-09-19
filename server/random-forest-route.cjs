const crypto = require('crypto');
const { query } = require('./db.cjs');
const { isConnectivityIssue, toUserMessage } = require('./error-utils.cjs');
const {
  jsonResponse,
  forbid,
  getCurrentProfessorSession,
} = require('./auth-route.cjs');
const {
  PredictionUnavailableError,
  aggregateViolationFeatureSnapshot,
} = require('./random-forest-aggregation.cjs');
const {
  getModelMetadata,
  predict,
} = require('./random-forest-worker.cjs');

const MAX_REFRESH_SESSIONS = 250;
const MAX_REFRESH_CONCURRENCY = 4;
const RULE_LOG_POLICY_VERSION = 'rule-logs-v3';

function getPredictionProfile(cameraEnabled) {
  return cameraEnabled === true ? 'full' : 'browser';
}

function getPredictionModelVersion(metadata, profile) {
  return `${metadata.model_version}+${RULE_LOG_POLICY_VERSION}-${profile}`;
}

function badRequest(res, message) {
  jsonResponse(res, 400, { success: false, message });
}

function methodNotAllowed(res) {
  jsonResponse(res, 405, { success: false, message: 'Method not allowed.' });
}

function normalizePredictionRow(row) {
  return {
    id: row.id,
    examSessionId: row.exam_session_id,
    status: row.status,
    suspiciousProbability: row.suspicious_probability === null ? null : Number(row.suspicious_probability),
    riskLevel: row.risk_level || null,
    requiresProfessorReview: row.requires_professor_review === true,
    modelVersion: row.model_version,
    unavailableReason: row.unavailable_reason || null,
    dataNote: row.status === 'completed' ? (row.unavailable_reason || null) : null,
    predictedAt: row.predicted_at || null,
    updatedAt: row.updated_at || null,
  };
}

function normalizeStatisticsPredictionRow(row) {
  const hasPrediction = !!row.prediction_id;
  return {
    examSessionId: row.exam_session_id,
    studentId: row.student_id || '',
    studentName: row.student_name || row.student_id || 'Student',
    submittedAt: row.submitted_at || null,
    status: hasPrediction ? (row.prediction_status || 'pending') : 'pending',
    suspiciousProbability: row.suspicious_probability === null || row.suspicious_probability === undefined
      ? null
      : Number(row.suspicious_probability),
    riskLevel: row.risk_level || null,
    requiresProfessorReview: row.requires_professor_review === true,
    unavailableReason: row.unavailable_reason || null,
    dataNote: hasPrediction && row.prediction_status === 'completed' ? (row.unavailable_reason || null) : null,
    predictedAt: row.predicted_at || null,
  };
}

async function loadOwnedSession(professorId, sessionId) {
  const { rows } = await query(
    `select s.*,
            e.subject_id as course_id,
            e.require_camera as exam_require_camera,
            coalesce(s.owner_admin_id, e.owner_admin_id) as resolved_owner_admin_id
       from public.sessions s
       join public.exams e on e.id = s.exam_id
      where s.id = $1
        and coalesce(s.owner_admin_id, e.owner_admin_id) = $2
      limit 1`,
    [sessionId, professorId],
  );
  return rows[0] || null;
}

async function savePredictionRecord(session, modelVersion, values) {
  const { rows } = await query(
    `insert into public.random_forest_predictions as existing (
       id, owner_admin_id, exam_session_id, student_id, exam_id, course_id,
       status, suspicious_probability, risk_level, requires_professor_review,
       model_version, feature_snapshot_json, unavailable_reason, predicted_at,
       created_at, updated_at
     ) values (
       $1, $2, $3, $4, $5, $6,
       $7, $8, $9, $10,
       $11, $12::jsonb, $13, $14::timestamptz,
       now(), now()
     )
     on conflict (exam_session_id, model_version) do update
       set owner_admin_id = excluded.owner_admin_id,
           student_id = excluded.student_id,
           exam_id = excluded.exam_id,
           course_id = excluded.course_id,
           status = excluded.status,
           suspicious_probability = excluded.suspicious_probability,
           risk_level = excluded.risk_level,
           requires_professor_review = excluded.requires_professor_review,
           feature_snapshot_json = excluded.feature_snapshot_json,
           unavailable_reason = excluded.unavailable_reason,
           predicted_at = excluded.predicted_at,
           updated_at = now()
       where existing.owner_admin_id = excluded.owner_admin_id
     returning *`,
    [
      crypto.randomUUID(),
      session.resolved_owner_admin_id,
      session.id,
      session.student_id,
      session.exam_id,
      session.course_id,
      values.status,
      values.suspiciousProbability ?? null,
      values.riskLevel || null,
      values.requiresProfessorReview === true,
      modelVersion,
      JSON.stringify(values.features || {}),
      values.unavailableReason || null,
      values.predictedAt || (values.status === 'completed' ? new Date().toISOString() : null),
    ],
  );
  if (!rows.length) throw new Error('Prediction record ownership conflict.');
  return rows[0];
}

async function loadSessionViolationEvents(session) {
  const { rows } = await query(
    `select ve.violation_type,
            ve.detection_metadata,
            ve.warning_count,
            exists (
              select 1
                from public.violation_evidence evidence
               where evidence.violation_event_id = ve.id
                 and evidence.review_status = 'dismissed'
            ) as dismissed
       from public.violation_events ve
      where ve.session_id = $1
        and ve.exam_id = $2
        and ve.owner_admin_id = $3
      order by ve.created_at asc, ve.id asc`,
    [session.id, session.exam_id, session.resolved_owner_admin_id],
  );
  return rows;
}

async function generateSessionPrediction(session) {
  const cameraEnabled = session.exam_require_camera === true;
  const profile = getPredictionProfile(cameraEnabled);
  const metadata = getModelMetadata(profile);
  const modelVersion = getPredictionModelVersion(metadata, profile);
  try {
    const recordedEvents = await loadSessionViolationEvents(session);
    const { features, violations, violationCount } = aggregateViolationFeatureSnapshot(
      session,
      recordedEvents,
      metadata.missing_feature_defaults,
      { cameraEnabled },
    );
    // No rule violation means no suspicion. In particular, timeout, elapsed
    // duration, normal browser start/end records, consent, and calibration do
    // not enter the model or raise the displayed probability.
    const result = violationCount > 0
      ? await predict(features, profile)
      : {
          suspiciousProbability: 0,
          riskLevel: 'normal',
          requiresProfessorReview: false,
        };
    const scopeNote = cameraEnabled ? '' : ' Webcam behavior was excluded because Motion Detection was off.';
    const dataNote = violationCount > 0
      ? `Based on ${violationCount} recorded rule violation${violationCount === 1 ? '' : 's'}; session timing and pre-exam checks were excluded.${scopeNote}`
      : `No recorded rule violations. Session timing and pre-exam checks were excluded.${scopeNote}`;
    return savePredictionRecord(session, modelVersion, {
      ...result,
      status: 'completed',
      features: {
        ...features,
        rule_violation_count: violationCount,
        rule_violation_types: violations.map(event => String(event.violation_type || event.violationType || event.type || '')),
      },
      unavailableReason: dataNote,
    });
  } catch (error) {
    if (error instanceof PredictionUnavailableError) {
      return savePredictionRecord(session, modelVersion, {
        status: 'unavailable',
        unavailableReason: error.message,
      });
    }
    await savePredictionRecord(session, modelVersion, {
      status: 'failed',
      unavailableReason: 'The prediction service could not analyze this session.',
    });
    throw error;
  }
}

async function getOwnedExam(professorId, examId) {
  const { rows } = await query(
    `select e.id, e.subject_id as course_id, e.owner_admin_id, e.require_camera
       from public.exams e
      where e.id = $1 and e.owner_admin_id = $2
      limit 1`,
    [examId, professorId],
  );
  return rows[0] || null;
}

async function buildStatisticsSummary(professorId, exam) {
  const profile = getPredictionProfile(exam.require_camera);
  const metadata = getModelMetadata(profile);
  const modelVersion = getPredictionModelVersion(metadata, profile);
  // One row per student, not one row per session. A student who retakes an exam
  // can end up with more than one submitted session row, and every one of them
  // carried its own violations into this list — which is why the same name
  // appeared twice in the suspicion probability (#29). Only the student's most
  // recent attempt is scored; the earlier ones stay in the session record but
  // no longer stand beside it as a second person.
  const latestSessionsCte = `
    with latest_sessions as (
      select distinct on (coalesce(nullif(s.student_id, ''), s.id)) s.*
        from public.sessions s
        join public.exams e on e.id = s.exam_id
       where s.exam_id = $2
         and s.submitted = true
         and coalesce(s.owner_admin_id, e.owner_admin_id) = $1
       order by coalesce(nullif(s.student_id, ''), s.id),
                s.end_time desc nulls last,
                s.start_time desc nulls last,
                s.id
    )`;
  const { rows } = await query(
    `${latestSessionsCte}
     select count(*)::integer as total_sessions,
            count(*) filter (where p.status = 'completed')::integer as analyzed_sessions,
            count(*) filter (where p.status = 'unavailable')::integer as unavailable_sessions,
            count(*) filter (where p.status = 'failed')::integer as failed_sessions,
            count(*) filter (where p.id is null or p.status = 'pending')::integer as pending_sessions,
            count(*) filter (where p.status = 'completed' and p.risk_level = 'normal')::integer as normal_count,
            count(*) filter (where p.status = 'completed' and p.risk_level = 'needs_monitoring')::integer as needs_monitoring_count,
            count(*) filter (where p.status = 'completed' and p.risk_level = 'suspicious')::integer as suspicious_count,
            avg(p.suspicious_probability) filter (where p.status = 'completed') as average_probability,
            max(p.updated_at) as last_updated
       from latest_sessions s
       left join public.random_forest_predictions p
         on p.exam_session_id = s.id
        and p.model_version = $3
        and p.owner_admin_id = $1`,
    [professorId, exam.id, modelVersion],
  );
  const row = rows[0] || {};
  const predictionResult = await query(
    `${latestSessionsCte}
     select s.id as exam_session_id,
            s.student_id,
            s.student_name,
            s.end_time as submitted_at,
            p.id as prediction_id,
            p.status as prediction_status,
            p.suspicious_probability,
            p.risk_level,
            p.requires_professor_review,
            p.unavailable_reason,
            p.predicted_at
       from latest_sessions s
       left join public.random_forest_predictions p
         on p.exam_session_id = s.id
        and p.model_version = $3
        and p.owner_admin_id = $1
      order by lower(coalesce(nullif(s.student_name, ''), s.student_id)),
               s.end_time desc nulls last,
               s.id`,
    [professorId, exam.id, modelVersion],
  );
  const normalCount = Number(row.normal_count || 0);
  const needsMonitoringCount = Number(row.needs_monitoring_count || 0);
  const suspiciousCount = Number(row.suspicious_count || 0);
  return {
    scope: { courseId: exam.course_id, examId: exam.id },
    summary: {
      totalSessions: Number(row.total_sessions || 0),
      analyzedSessions: Number(row.analyzed_sessions || 0),
      pendingSessions: Number(row.pending_sessions || 0),
      unavailableSessions: Number(row.unavailable_sessions || 0),
      failedSessions: Number(row.failed_sessions || 0),
      normalCount,
      needsMonitoringCount,
      suspiciousCount,
      averageSuspiciousProbability: row.average_probability === null ? null : Number(row.average_probability),
    },
    distribution: [
      { riskLevel: 'normal', count: normalCount },
      { riskLevel: 'needs_monitoring', count: needsMonitoringCount },
      { riskLevel: 'suspicious', count: suspiciousCount },
    ],
    predictions: predictionResult.rows.map(normalizeStatisticsPredictionRow),
    modelVersion,
    lastUpdated: row.last_updated || null,
    generatedAt: new Date().toISOString(),
  };
}

async function handleGenerate(req, res, sessionId) {
  const admin = await getCurrentProfessorSession(req);
  if (!admin) return forbid(res);
  const session = await loadOwnedSession(admin.id, sessionId);
  if (!session) return jsonResponse(res, 404, { success: false, message: 'Completed examination session not found.' });
  if (session.submitted !== true) {
    return jsonResponse(res, 409, { success: false, message: 'Predictions are available only for completed examination sessions.' });
  }
  const prediction = await generateSessionPrediction(session);
  return jsonResponse(res, 200, { success: true, prediction: normalizePredictionRow(prediction) });
}

async function handleSummary(req, res, url) {
  const admin = await getCurrentProfessorSession(req);
  if (!admin) return forbid(res);
  const examId = String(url.searchParams.get('examId') || '').trim();
  if (!examId) return badRequest(res, 'Exam ID is required.');
  const exam = await getOwnedExam(admin.id, examId);
  if (!exam) return jsonResponse(res, 404, { success: false, message: 'Exam not found.' });
  const summary = await buildStatisticsSummary(admin.id, exam);
  return jsonResponse(res, 200, { success: true, ...summary });
}

async function handleRefresh(req, res, url) {
  const admin = await getCurrentProfessorSession(req);
  if (!admin) return forbid(res);
  const examId = String(url.searchParams.get('examId') || '').trim();
  if (!examId) return badRequest(res, 'Exam ID is required.');
  const exam = await getOwnedExam(admin.id, examId);
  if (!exam) return jsonResponse(res, 404, { success: false, message: 'Exam not found.' });
  const profile = getPredictionProfile(exam.require_camera);
  const metadata = getModelMetadata(profile);
  const modelVersion = getPredictionModelVersion(metadata, profile);
  const { rows } = await query(
    `select s.*,
            e.subject_id as course_id,
            e.require_camera as exam_require_camera,
            coalesce(s.owner_admin_id, e.owner_admin_id) as resolved_owner_admin_id
       from public.sessions s
       join public.exams e on e.id = s.exam_id
       left join public.random_forest_predictions p
         on p.exam_session_id = s.id
        and p.model_version = $3
        and p.owner_admin_id = $1
      where s.exam_id = $2
        and s.submitted = true
        and coalesce(s.owner_admin_id, e.owner_admin_id) = $1
        and (p.id is null or p.status in ('pending', 'unavailable', 'failed'))
      order by case when p.id is null or p.status = 'pending' then 0
                    when p.status = 'failed' then 1
                    else 2 end,
               s.end_time asc nulls last,
               s.id asc
      limit $4`,
    [admin.id, examId, modelVersion, MAX_REFRESH_SESSIONS],
  );

  const counts = { completed: 0, unavailable: 0, failed: 0 };
  let nextIndex = 0;
  const processNext = async () => {
    while (nextIndex < rows.length) {
      const session = rows[nextIndex];
      nextIndex += 1;
      try {
        const record = await generateSessionPrediction(session);
        if (record.status === 'completed') counts.completed += 1;
        else if (record.status === 'unavailable') counts.unavailable += 1;
        else counts.failed += 1;
      } catch (_) {
        counts.failed += 1;
      }
    }
  };
  await Promise.all(Array.from(
    { length: Math.min(MAX_REFRESH_CONCURRENCY, rows.length) },
    () => processNext(),
  ));
  const summary = await buildStatisticsSummary(admin.id, exam);
  return jsonResponse(res, 200, {
    success: true,
    processed: rows.length,
    completed: counts.completed,
    unavailable: counts.unavailable,
    failed: counts.failed,
    hasMorePending: (
      Number(summary.summary?.pendingSessions || 0)
      + Number(summary.summary?.unavailableSessions || 0)
      + Number(summary.summary?.failedSessions || 0)
    ) > 0,
    ...summary,
  });
}

async function handleRandomForestRoute(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;
  const generateMatch = pathname.match(/^\/api\/exam-sessions\/([^/]+)\/random-forest-prediction$/);
  try {
    if (generateMatch) {
      if (req.method !== 'POST') return methodNotAllowed(res);
      return await handleGenerate(req, res, decodeURIComponent(generateMatch[1]));
    }
    if (pathname === '/api/statistics/random-forest') {
      if (req.method !== 'GET') return methodNotAllowed(res);
      return await handleSummary(req, res, url);
    }
    if (pathname === '/api/statistics/random-forest/refresh') {
      if (req.method !== 'POST') return methodNotAllowed(res);
      return await handleRefresh(req, res, url);
    }
    return jsonResponse(res, 404, { success: false, message: 'Random Forest route not found.' });
  } catch (error) {
    const connectivityIssue = isConnectivityIssue(error);
    const fallback = 'Unable to process Random Forest predictions right now.';
    const message = connectivityIssue
      ? toUserMessage(error, fallback, { context: 'sync' })
      : fallback;
    console.error('[Random Forest]', error?.message || error);
    return jsonResponse(res, connectivityIssue ? 503 : 500, { success: false, message, connectivityIssue });
  }
}

module.exports = {
  buildStatisticsSummary,
  generateSessionPrediction,
  handleRandomForestRoute,
};

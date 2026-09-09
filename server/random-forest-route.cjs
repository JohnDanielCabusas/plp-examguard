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
  aggregateSessionFeatures,
} = require('./random-forest-aggregation.cjs');
const {
  getModelMetadata,
  predict,
} = require('./random-forest-worker.cjs');

const MAX_REFRESH_SESSIONS = 250;

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
    predictedAt: row.predicted_at || null,
  };
}

async function loadOwnedSession(professorId, sessionId) {
  const { rows } = await query(
    `select s.*,
            e.subject_id as course_id,
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

async function generateSessionPrediction(session) {
  const metadata = getModelMetadata();
  try {
    const features = aggregateSessionFeatures(session);
    const result = await predict(features);
    return savePredictionRecord(session, metadata.model_version, {
      ...result,
      status: 'completed',
      features,
    });
  } catch (error) {
    if (error instanceof PredictionUnavailableError) {
      return savePredictionRecord(session, metadata.model_version, {
        status: 'unavailable',
        unavailableReason: error.message,
      });
    }
    await savePredictionRecord(session, metadata.model_version, {
      status: 'failed',
      unavailableReason: 'The prediction service could not analyze this session.',
    });
    throw error;
  }
}

async function getOwnedExam(professorId, examId) {
  const { rows } = await query(
    `select e.id, e.subject_id as course_id, e.owner_admin_id
       from public.exams e
      where e.id = $1 and e.owner_admin_id = $2
      limit 1`,
    [examId, professorId],
  );
  return rows[0] || null;
}

async function buildStatisticsSummary(professorId, exam) {
  const metadata = getModelMetadata();
  const { rows } = await query(
    `select count(*)::integer as total_sessions,
            count(*) filter (where p.status = 'completed')::integer as analyzed_sessions,
            count(*) filter (where p.status = 'unavailable')::integer as unavailable_sessions,
            count(*) filter (where p.status = 'failed')::integer as failed_sessions,
            count(*) filter (where p.id is null or p.status = 'pending')::integer as pending_sessions,
            count(*) filter (where p.status = 'completed' and p.risk_level = 'normal')::integer as normal_count,
            count(*) filter (where p.status = 'completed' and p.risk_level = 'needs_monitoring')::integer as needs_monitoring_count,
            count(*) filter (where p.status = 'completed' and p.risk_level = 'suspicious')::integer as suspicious_count,
            avg(p.suspicious_probability) filter (where p.status = 'completed') as average_probability,
            max(p.updated_at) as last_updated
       from public.sessions s
       join public.exams e on e.id = s.exam_id
       left join public.random_forest_predictions p
         on p.exam_session_id = s.id
        and p.model_version = $3
        and p.owner_admin_id = $1
      where s.exam_id = $2
        and s.submitted = true
        and coalesce(s.owner_admin_id, e.owner_admin_id) = $1`,
    [professorId, exam.id, metadata.model_version],
  );
  const row = rows[0] || {};
  const predictionResult = await query(
    `select s.id as exam_session_id,
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
       from public.sessions s
       join public.exams e on e.id = s.exam_id
       left join public.random_forest_predictions p
         on p.exam_session_id = s.id
        and p.model_version = $3
        and p.owner_admin_id = $1
      where s.exam_id = $2
        and s.submitted = true
        and coalesce(s.owner_admin_id, e.owner_admin_id) = $1
      order by lower(coalesce(nullif(s.student_name, ''), s.student_id)),
               s.end_time desc nulls last,
               s.id`,
    [professorId, exam.id, metadata.model_version],
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
    modelVersion: metadata.model_version,
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
  const metadata = getModelMetadata();
  const { rows } = await query(
    `select s.*,
            e.subject_id as course_id,
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
      order by s.end_time asc nulls last, s.id asc
      limit $4`,
    [admin.id, examId, metadata.model_version, MAX_REFRESH_SESSIONS],
  );

  let completed = 0;
  let unavailable = 0;
  let failed = 0;
  for (const session of rows) {
    try {
      const record = await generateSessionPrediction(session);
      if (record.status === 'completed') completed += 1;
      else if (record.status === 'unavailable') unavailable += 1;
      else failed += 1;
    } catch (_) {
      failed += 1;
    }
  }
  const summary = await buildStatisticsSummary(admin.id, exam);
  return jsonResponse(res, 200, {
    success: true,
    processed: rows.length,
    completed,
    unavailable,
    failed,
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

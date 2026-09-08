const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');

require('dotenv').config({ path: path.resolve(__dirname, '../.env.local') });

const database = require('../server/db.cjs');

async function main() {
  const client = await database.connect();
  try {
    await client.query('begin');
    const sessionId = `rf-db-test-${crypto.randomUUID()}`;
    const modelVersion = 'rf-v1-db-test';
    const insertSql = `
      insert into public.random_forest_predictions (
        id, owner_admin_id, exam_session_id, student_id, exam_id,
        status, suspicious_probability, risk_level,
        requires_professor_review, model_version,
        feature_snapshot_json, predicted_at
      ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, now())
    `;
    const sharedValues = [
      'test-owner', sessionId, 'test-student', 'test-exam', 'completed',
    ];

    await client.query(insertSql, [
      crypto.randomUUID(),
      ...sharedValues,
      0.42,
      'normal',
      false,
      modelVersion,
      '{}',
    ]);

    await client.query(`${insertSql}
      on conflict (exam_session_id, model_version) do update set
        suspicious_probability = excluded.suspicious_probability,
        risk_level = excluded.risk_level,
        requires_professor_review = excluded.requires_professor_review
    `, [
      crypto.randomUUID(),
      ...sharedValues,
      0.73,
      'needs_monitoring',
      true,
      modelVersion,
      '{}',
    ]);

    const result = await client.query(`
      select
        count(*)::int as count,
        max(suspicious_probability)::float8 as probability,
        max(risk_level) as risk,
        bool_or(requires_professor_review) as requires_review
      from public.random_forest_predictions
      where exam_session_id = $1 and model_version = $2
    `, [sessionId, modelVersion]);

    assert.equal(result.rows[0].count, 1);
    assert.equal(result.rows[0].probability, 0.73);
    assert.equal(result.rows[0].risk, 'needs_monitoring');
    assert.equal(result.rows[0].requires_review, true);
    await client.query('rollback');
    console.log('Live Random Forest prediction-table and idempotent-upsert test passed; transaction rolled back.');
  } catch (error) {
    try { await client.query('rollback'); } catch (_) {}
    throw error;
  } finally {
    client.release();
    await database.getPool().end();
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});

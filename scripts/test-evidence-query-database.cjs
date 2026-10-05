const assert = require('node:assert/strict');
const fs = require('node:fs');
const { Client } = require('pg');
const { evidenceListQuery } = require('../server/evidence-list-query.cjs');
const env = require('dotenv').parse(fs.readFileSync(require('node:path').join(__dirname, '../.env.newproject')));
assert.equal(new URL(env.VITE_SUPABASE_URL).hostname, 'vehjkwwamdjvhbduacod.supabase.co');
const client = new Client({ host: env.SUPABASE_DB_HOST, port: +env.SUPABASE_DB_PORT, database: env.SUPABASE_DB_NAME, user: env.SUPABASE_DB_USER, password: env.SUPABASE_DB_PASSWORD, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 10000 });
(async () => {
  await client.connect();
  try {
    await client.query('begin');
    await client.query(`create temporary table audit_sessions(id text primary key, warnings integer);
      create temporary table audit_evidence(id text primary key, session_id text, owner_admin_id text, warning_applied boolean, warning_adjustment integer, created_at timestamptz);
      insert into audit_sessions select 'session-'||i, i % 5 from generate_series(1,50) i;
      insert into audit_evidence select 'evidence-'||i, 'session-'||(i%50+1), case when i%3=0 then 'other' else 'owner' end, i%2=0, case when i%7=0 then null else (i%3)-1 end, now() from generate_series(1,1500) i;`);
    for (const predicates of [['ve.owner_admin_id=$1'], ['ve.owner_admin_id=$1', 've.session_id=$2']]) {
      const values = predicates.length === 1 ? ['owner'] : ['owner', 'session-1'];
      const old = `select ve.*, greatest(0,coalesce(sess.warnings,0)-coalesce(sum(case when peer.warning_applied then peer.warning_adjustment else 0 end),0)) raw_warnings, greatest(0,coalesce(sess.warnings,0)) adjusted_warnings
        from audit_evidence ve left join audit_sessions sess on sess.id=ve.session_id left join audit_evidence peer on peer.session_id=ve.session_id
        where ${predicates.join(' and ')} group by ve.id,sess.warnings order by ve.created_at desc,ve.id desc`;
      const optimized = evidenceListQuery(predicates).replaceAll('public.violation_evidence', 'pg_temp.audit_evidence').replaceAll('public.sessions', 'pg_temp.audit_sessions');
      assert.deepEqual((await client.query(optimized, values)).rows, (await client.query(old, values)).rows);
    }
    const indexes = await client.query("select count(*)::int count from pg_index i join pg_class c on c.oid=i.indexrelid where i.indisvalid and c.relname=any($1::text[])", [['messages_owner_updated_idx','messages_student_updated_idx','logs_owner_id_idx','logs_student_id_idx','professor_activity_created_idx']]);
    assert.equal(indexes.rows[0].count, 5);
    const messageId = `audit-${require('node:crypto').randomUUID()}`;
    const inserted = await client.query('insert into public.messages(id,body) values($1,$2) returning updated_at::text', [messageId, 'temporary trigger test']);
    const updated = await client.query('update public.messages set read_at=now() where id=$1 returning updated_at::text', [messageId]);
    assert.notEqual(updated.rows[0].updated_at, inserted.rows[0].updated_at, 'read receipt advances server timestamp');
    await client.query('rollback');
    console.log('Evidence query matches original totals for 1,500 temporary records; all five new indexes valid. No application rows modified.');
  } finally { await client.end(); }
})().catch(error => { console.error(error.message); process.exitCode = 1; });

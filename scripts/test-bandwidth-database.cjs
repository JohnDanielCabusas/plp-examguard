const assert = require('node:assert/strict');
const path = require('node:path');
const crypto = require('node:crypto');
const http = require('node:http');
require('dotenv').config({ path: path.resolve(__dirname, '../.env.newproject'), override: true, quiet: true });
const { createClient } = require('@supabase/supabase-js');
const { query, getPool } = require('../server/db.cjs');
const { handleMonitorRoute } = require('../server/monitor-route.cjs');
const { storageGatewayKey } = require('../server/snapshot-assets.cjs');
const { externalize } = require('./apply-bandwidth-optimizations.cjs');

const PIXEL = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==';
const prefix = `optimization-test-${crypto.randomUUID()}`;
const subjectId = `${prefix}-subject`, examId = `${prefix}-exam`, sessionId = `${prefix}-session`;
let assetPath;
let server;

function cookie(name, payload) {
  const encoded = Buffer.from(JSON.stringify({ ...payload, expiresAt: Date.now() + 60000 })).toString('base64url');
  const signature = crypto.createHmac('sha256', process.env.AUTH_SESSION_SECRET || process.env.SUPABASE_DB_PASSWORD).update(encoded).digest('hex');
  return `${name}=${encoded}.${signature}`;
}

(async () => {
  assert.equal(new URL(process.env.VITE_SUPABASE_URL).hostname, 'vehjkwwamdjvhbduacod.supabase.co', 'live verification targets only the new project');
  const protectedTables = (await query(`select c.relrowsecurity rls_enabled,
    exists(select 1 from pg_policy p where p.polrelid=c.oid and not p.polpermissive) deny_policy,
    has_table_privilege('anon',c.oid,'SELECT') anon_select,
    has_table_privilege('authenticated',c.oid,'SELECT') authenticated_select
    from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where (n.nspname,c.relname) in (('examguard_private','storage_gateway'),('public','camera_snapshot_assets'))`)).rows;
  assert.equal(protectedTables.length, 2);
  assert.ok(protectedTables.every(table => table.rls_enabled && table.deny_policy && !table.anon_select && !table.authenticated_select), 'server-only tables have explicit deny policies and no client read grants');
  const professors = (await query('select id from public.professors order by id limit 1')).rows;
  const students = (await query('select student_id from public.students order by student_id limit 2')).rows;
  assert.ok(professors.length && students.length >= 2, 'two existing accounts are required for isolation checks');
  const owner = professors[0].id;
  await query('insert into public.subjects(id,code,name,owner_admin_id) values($1,$2,$3,$4)', [subjectId, prefix, 'Optimization verification fixture', owner]);
  await query('insert into public.exams(id,subject_id,title,time_limit,status,owner_admin_id) values($1,$2,$3,60,$4,$5)', [examId, subjectId, 'Optimization verification fixture', 'closed', owner]);
  await query(`insert into public.sessions(id,exam_id,student_id,student_name,owner_admin_id,submitted,answers,attempt_history)
    values($1,$2,$3,$4,$5,true,$6::jsonb,$7::jsonb)`,
  [sessionId, examId, students[0].student_id, 'Optimization verification fixture', owner,
    JSON.stringify({ q1: 'original-answer' }), JSON.stringify([{ answers: { archived: 'retained' }, cameraSnapshots: [{ imageData: PIXEL }] }])]);
  server = http.createServer((req, res) => { handleMonitorRoute(req, res).then(handled => { if (!handled) { res.writeHead(404); res.end(); } }); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const ownCookie = cookie('acs_student_auth', { role: 'student', studentNumber: students[0].student_id });
  const otherCookie = cookie('acs_student_auth', { role: 'student', studentNumber: students[1].student_id });
  const professorCookie = cookie('acs_admin_auth', { role: 'professor', professorId: owner });
  const upload = () => fetch(`${base}/api/monitor/snapshots`, { method: 'POST', headers: { Cookie: ownCookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId, imageData: PIXEL }) });
  const uploadResponse = await upload();
  const uploaded = await uploadResponse.json();
  assert.equal(uploadResponse.status, 200, JSON.stringify(uploaded));
  const asset = uploaded.snapshot;
  assetPath = asset.storagePath;
  assert.equal((await (await upload()).json()).snapshot.assetId, asset.assetId, 'upload retries reuse the same reference');
  assert.equal((await query('select count(*)::integer count from public.camera_snapshot_assets where session_id=$1', [sessionId])).rows[0].count, 1);
  assert.equal((await fetch(`${base}${asset.imageData}`)).status, 403, 'anonymous image access is denied');
  assert.equal((await fetch(`${base}${asset.imageData}`, { headers: { Cookie: otherCookie } })).status, 403, 'another student cannot read this evidence');
  const file = await fetch(`${base}${asset.imageData}`, { headers: { Cookie: ownCookie } });
  assert.equal(file.status, 200);
  assert.equal(Buffer.from(await file.arrayBuffer()).equals(Buffer.from(PIXEL.split(',')[1], 'base64')), true, 'stored evidence is byte-for-byte intact');
  const etag = file.headers.get('etag');
  assert.equal((await fetch(`${base}${asset.imageData}`, { headers: { Cookie: professorCookie, 'If-None-Match': etag } })).status, 304, 'authorized conditional reads avoid downloading the image again');
  assert.equal((await fetch(`${base}${asset.imageData}`, { headers: { Cookie: otherCookie, 'If-None-Match': etag } })).status, 403, 'conditional reads still enforce access');
  const direct = await fetch(`${process.env.VITE_SUPABASE_URL}/storage/v1/object/camera-snapshots/${asset.storagePath}`, { headers: { apikey: process.env.VITE_SUPABASE_PUBLISHABLE_KEY, Authorization: `Bearer ${process.env.VITE_SUPABASE_PUBLISHABLE_KEY}` } });
  const directPayload = await direct.json();
  assert.notEqual(direct.status, 200, 'publishable keys alone cannot read the private bucket');
  assert.ok(directPayload.error || directPayload.message);

  const archive = await externalize([{ answers: { archived: 'retained' }, cameraSnapshots: [{ imageData: PIXEL }] }], sessionId, { query });
  assert.equal(archive[0].cameraSnapshots[0].assetId, asset.assetId);
  await query('update public.sessions set camera_snapshots=$2::jsonb,attempt_history=$3::jsonb where id=$1', [sessionId, JSON.stringify([{ timestamp: 'verification', ...asset }]), JSON.stringify(archive)]);
  const supabase = createClient(process.env.VITE_SUPABASE_URL, process.env.VITE_SUPABASE_PUBLISHABLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const patch = await supabase.from('sessions').update({ answers: { q1: 'updated-answer' } }).eq('id', sessionId).select('id');
  assert.equal(patch.error, null);
  assert.equal(patch.data.length, 1);
  const stored = (await query('select answers,camera_snapshots,attempt_history from public.sessions where id=$1', [sessionId])).rows[0];
  assert.equal(stored.answers.q1, 'updated-answer');
  assert.equal(stored.camera_snapshots[0].assetId, asset.assetId, 'answer patches retain image references');
  assert.equal(stored.attempt_history[0].answers.archived, 'retained', 'answer patches retain archived attempts');
  const dashboard = await (await fetch(`${base}/api/monitor/dashboard-summary`, { headers: { Cookie: professorCookie } })).json();
  assert.equal(dashboard.success, true);
  assert.ok(dashboard.summary.submissions >= 1);
  const expected = (await query('select count(*)::integer count from public.sessions where owner_admin_id=$1 and submitted', [owner])).rows[0].count;
  assert.equal(dashboard.summary.submissions, expected, 'SQL totals include all submissions');
  const indexes = (await query(`select c.relname from pg_index i join pg_class c on c.oid=i.indexrelid
    where i.indisvalid and c.relname in ('sessions_student_exam_idx','sessions_owner_exam_idx','sessions_exam_created_idx','exams_subject_created_idx','exams_owner_created_idx','students_enrolled_subjects_gin_idx')`)).rows;
  assert.equal(indexes.length, 6, 'all six targeted query indexes are valid');
  console.log('New-project integration passed: authenticated private images, denied cross-user access, identical bytes, retry safety, conditional caching, field patches, archived evidence, SQL totals and valid indexes.');
})().catch(error => { console.error(error.message); process.exitCode = 1; }).finally(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
  try {
    // Delete only this run's own fixture object and records.
    if (assetPath) {
      const response = await fetch(`${process.env.VITE_SUPABASE_URL}/storage/v1/object/camera-snapshots`, {
        method: 'DELETE', headers: { apikey: process.env.VITE_SUPABASE_PUBLISHABLE_KEY, Authorization: `Bearer ${process.env.VITE_SUPABASE_PUBLISHABLE_KEY}`, 'Content-Type': 'application/json', 'x-examguard-storage-key': storageGatewayKey() },
        body: JSON.stringify({ prefixes: [assetPath] }),
      });
      if (!response.ok) throw new Error('Verification storage cleanup failed.');
    }
    await query('delete from public.sessions where id=$1', [sessionId]);
    await query('delete from public.exams where id=$1', [examId]);
    await query('delete from public.subjects where id=$1', [subjectId]);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
  await getPool().end();
});

import dotenv from 'dotenv';
import { createRequire } from 'node:module';
import pg from 'pg';

// The project's env file beats machine-wide variables, as in server.js; with no
// .env.local (CI, a deploy shell) the real environment is used unchanged.
dotenv.config({ path: '.env.local', override: true, quiet: true });
const { downloadStorageObject } = createRequire(import.meta.url)('../server/supabase-storage.cjs');

const requiredDbVars = [
  'SUPABASE_DB_HOST',
  'SUPABASE_DB_PORT',
  'SUPABASE_DB_NAME',
  'SUPABASE_DB_USER',
  'SUPABASE_DB_PASSWORD',
];

const missing = requiredDbVars.filter(name => !String(process.env[name] || '').trim());
if (missing.length) {
  console.error(`Replay readiness check cannot connect to the database. Missing: ${missing.join(', ')}`);
  process.exit(1);
}

const { Client } = pg;
const client = new Client({
  host: process.env.SUPABASE_DB_HOST,
  port: Number(process.env.SUPABASE_DB_PORT),
  database: process.env.SUPABASE_DB_NAME,
  user: process.env.SUPABASE_DB_USER,
  password: process.env.SUPABASE_DB_PASSWORD,
  ssl: process.env.SUPABASE_DB_SSL === 'disable' ? false : { rejectUnauthorized: false },
});

try {
  await client.connect();
  const { rows } = await client.query(`
    select
      to_regclass('public.violation_evidence') is not null as evidence_table,
      exists (
        select 1 from storage.buckets where id = 'violation-evidence'
      ) as evidence_bucket,
      (
        select count(*) >= 2
        from pg_policies
        where schemaname = 'storage'
          and tablename = 'objects'
          and policyname in ('violation_evidence_gateway_insert', 'violation_evidence_gateway_select')
      ) as evidence_policies,
      not exists (
        select 1 from pg_policies
        where schemaname = 'storage' and tablename = 'objects'
          and policyname like 'violation_evidence_anon_%'
      ) as evidence_private
  `);
  const readiness = rows[0] || {};
  console.log(`Replay metadata table: ${readiness.evidence_table ? 'ready' : 'missing'}`);
  console.log(`Replay storage bucket: ${readiness.evidence_bucket ? 'ready' : 'missing'}`);
  console.log(`Replay upload/playback policies: ${readiness.evidence_policies ? 'ready' : 'missing'}`);
  console.log(`Replay videos closed to the public key: ${readiness.evidence_private ? 'yes' : 'NO'}`);
  if (!readiness.evidence_table || !readiness.evidence_bucket || !readiness.evidence_policies || !readiness.evidence_private) {
    process.exitCode = 1;
  }

  if (readiness.evidence_table) {
    const sampleResult = await client.query(`
      select storage_bucket, storage_path, mime_type
      from public.violation_evidence
      order by created_at desc
      limit 1
    `);
    const sample = sampleResult.rows[0];
    if (!sample) {
      console.log('Stored replay retrieval: no replay has been recorded yet');
    } else {
      // Read the way the server reads it: with the storage gateway key.
      let signature = Buffer.alloc(0);
      let failure = '';
      try {
        signature = (await downloadStorageObject(sample.storage_bucket, sample.storage_path, 'bytes=0-11')).data;
      } catch (error) {
        failure = error?.status || error?.message || 'error';
      }
      const isWebm = signature.length >= 4
        && signature[0] === 0x1a
        && signature[1] === 0x45
        && signature[2] === 0xdf
        && signature[3] === 0xa3;
      const isMp4 = signature.length >= 8 && signature.subarray(4, 8).toString('ascii') === 'ftyp';
      const sampleIsPlayable = !failure && (isWebm || isMp4);
      console.log(`Stored replay retrieval: ${sampleIsPlayable ? 'ready' : `failed (${failure || 'not a video'})`}`);
      if (!sampleIsPlayable) process.exitCode = 1;
    }
  }
} catch (error) {
  console.error(`Replay readiness check failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}

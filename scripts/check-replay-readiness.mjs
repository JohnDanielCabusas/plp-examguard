import 'dotenv/config';
import dotenv from 'dotenv';
import pg from 'pg';

dotenv.config({ path: '.env.local', override: false, quiet: true });

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

function encodeStorageObjectPath(bucket, objectPath) {
  const encodedPath = String(objectPath || '')
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .split('/')
    .map(segment => encodeURIComponent(segment))
    .join('/');
  return `${encodeURIComponent(bucket)}/${encodedPath}`;
}

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
          and policyname in ('violation_evidence_anon_insert', 'violation_evidence_anon_select')
      ) as evidence_policies
  `);
  const readiness = rows[0] || {};
  console.log(`Replay metadata table: ${readiness.evidence_table ? 'ready' : 'missing'}`);
  console.log(`Replay storage bucket: ${readiness.evidence_bucket ? 'ready' : 'missing'}`);
  console.log(`Replay upload/playback policies: ${readiness.evidence_policies ? 'ready' : 'missing'}`);
  if (!readiness.evidence_table || !readiness.evidence_bucket || !readiness.evidence_policies) {
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
      const storageUrl = String(process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL || '')
        .trim()
        .replace(/\/+$/, '');
      const storageKey = String(
        process.env.SUPABASE_SERVICE_ROLE_KEY
          || process.env.VITE_SUPABASE_PUBLISHABLE_KEY
          || process.env.SUPABASE_PUBLISHABLE_KEY
          || '',
      ).trim();
      if (!storageUrl || !storageKey) {
        console.log('Stored replay retrieval: server storage credentials are missing');
        process.exitCode = 1;
      } else {
        const response = await fetch(
          `${storageUrl}/storage/v1/object/${encodeStorageObjectPath(sample.storage_bucket, sample.storage_path)}`,
          {
            headers: {
              apikey: storageKey,
              Authorization: `Bearer ${storageKey}`,
              Range: 'bytes=0-11',
            },
          },
        );
        const signature = Buffer.from(await response.arrayBuffer());
        const isWebm = signature.length >= 4
          && signature[0] === 0x1a
          && signature[1] === 0x45
          && signature[2] === 0xdf
          && signature[3] === 0xa3;
        const isMp4 = signature.length >= 8 && signature.subarray(4, 8).toString('ascii') === 'ftyp';
        const sampleIsPlayable = response.ok && (isWebm || isMp4);
        console.log(`Stored replay retrieval: ${sampleIsPlayable ? 'ready' : `failed (${response.status})`}`);
        if (!sampleIsPlayable) process.exitCode = 1;
      }
    }
  }
} catch (error) {
  console.error(`Replay readiness check failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}

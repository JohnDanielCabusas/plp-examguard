const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const dotenv = require('dotenv');
const { Client } = require('pg');
const { storageGatewayKey, storeSnapshot } = require('../server/snapshot-assets.cjs');
const { downloadStorageObject } = require('../server/supabase-storage.cjs');

const root = path.resolve(__dirname, '..');
const EXPECTED_PROJECT = 'vehjkwwamdjvhbduacod';

async function externalize(value, sessionId, client) {
  if (Array.isArray(value)) return Promise.all(value.map(item => externalize(item, sessionId, client)));
  if (!value || typeof value !== 'object') return value;
  const result = { ...value };
  if (typeof value.imageData === 'string' && value.imageData.startsWith('data:image/')) {
    const reference = await storeSnapshot(sessionId, value.imageData, {
      query: (sql, values) => client.query(sql, values),
      uploadStorageObject: require('../server/supabase-storage.cjs').uploadStorageObject,
    });
    const downloaded = await downloadStorageObject(reference.storageBucket, reference.storagePath);
    const original = Buffer.from(value.imageData.split(',')[1], 'base64');
    if (!downloaded.data.equals(original)) throw new Error('Snapshot verification failed; embedded original retained.');
    Object.assign(result, reference);
  }
  for (const key of Object.keys(value)) {
    if (key !== 'imageData' && value[key] && typeof value[key] === 'object') result[key] = await externalize(value[key], sessionId, client);
  }
  return result;
}

async function main() {
  const envPath = path.resolve(root, process.argv.find(argument => argument.startsWith('--env='))?.slice(6) || '.env.newproject');
  const environment = dotenv.parse(await fs.readFile(envPath));
  if (new URL(environment.VITE_SUPABASE_URL).hostname !== `${EXPECTED_PROJECT}.supabase.co`
    || environment.SUPABASE_DB_USER !== `postgres.${EXPECTED_PROJECT}`) throw new Error('Refusing migration: configuration does not identify the new project.');
  Object.assign(process.env, environment);
  const client = new Client({ host: environment.SUPABASE_DB_HOST, port: +environment.SUPABASE_DB_PORT,
    database: environment.SUPABASE_DB_NAME, user: environment.SUPABASE_DB_USER, password: environment.SUPABASE_DB_PASSWORD,
    ssl: environment.SUPABASE_DB_SSL === 'disable' ? false : { rejectUnauthorized: false }, connectionTimeoutMillis: 10000 });
  await client.connect();
  try {
    await client.query('begin');
    try {
      await client.query("set local lock_timeout='5s'");
      await client.query(await fs.readFile(path.join(root, 'supabase/bandwidth-optimizations.sql'), 'utf8'));
      await client.query(await fs.readFile(path.join(root, 'supabase/query-audit-optimizations.sql'), 'utf8'));
      const keyHash = crypto.createHash('sha256').update(storageGatewayKey(environment)).digest('hex');
      await client.query('insert into examguard_private.storage_gateway(id,key_hash) values(true,$1) on conflict(id) do update set key_hash=excluded.key_hash', [keyHash]);
      await client.query('commit');
    } catch (error) { await client.query('rollback'); throw error; }
    let migrated = 0;
    let skipped = 0;
    if (process.argv.includes('--migrate-snapshots')) {
      const { rows } = await client.query(`select id,camera_snapshots,attempt_history from public.sessions
        where camera_snapshots::text like '%data:image/%' or attempt_history::text like '%data:image/%'`);
      const backupDir = path.join(root, '.data', 'snapshot-migration');
      await fs.mkdir(backupDir, { recursive: true });
      for (const row of rows) {
        // Retain the originals outside the DB; never remove storage evidence.
        const filename = crypto.createHash('sha256').update(row.id).digest('hex') + '-' + Date.now() + '.json';
        await fs.writeFile(path.join(backupDir, filename), JSON.stringify(row), { flag: 'wx' });
        const snapshots = await externalize(row.camera_snapshots, row.id, client);
        const history = await externalize(row.attempt_history, row.id, client);
        const result = await client.query(`update public.sessions set camera_snapshots=$2::jsonb,attempt_history=$3::jsonb
          where id=$1 and camera_snapshots=$4::jsonb and attempt_history=$5::jsonb`,
        [row.id, JSON.stringify(snapshots), JSON.stringify(history), JSON.stringify(row.camera_snapshots), JSON.stringify(row.attempt_history)]);
        if (result.rowCount) migrated++; else skipped++;
      }
    }
    console.log(`Applied storage and indexes to ${EXPECTED_PROJECT}. Snapshot rows migrated: ${migrated}; concurrently changed rows retained: ${skipped}.`);
  } finally { await client.end(); }
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { externalize };

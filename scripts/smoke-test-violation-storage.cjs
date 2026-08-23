require('dotenv').config({ path: require('path').join(__dirname, '..', '.env.local') });

const crypto = require('crypto');
const { downloadStorageObject, uploadStorageObject } = require('../server/supabase-storage.cjs');
const { getPool, query } = require('../server/db.cjs');

function encodeObjectPath(bucket, objectPath) {
  return `${encodeURIComponent(bucket)}/${objectPath.split('/').map(encodeURIComponent).join('/')}`;
}

(async () => {
  const bucket = 'violation-evidence';
  const objectPath = `smoke-tests/${crypto.randomUUID()}.webm`;
  const payload = Buffer.from('violation-replay-storage-smoke-test');
  const url = String(process.env.VITE_SUPABASE_URL || '').replace(/\/+$/, '');
  const key = String(process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.VITE_SUPABASE_PUBLISHABLE_KEY || '');

  try {
    await query('drop policy if exists violation_evidence_smoke_test_delete on storage.objects');
    await query(`create policy violation_evidence_smoke_test_delete
      on storage.objects for delete to anon
      using (bucket_id = 'violation-evidence' and name like 'smoke-tests/%')`);
    await uploadStorageObject(bucket, objectPath, payload, 'video/webm');
    const downloaded = await downloadStorageObject(bucket, objectPath);
    if (!downloaded.data.equals(payload)) throw new Error('Downloaded replay data did not match the upload.');
    console.log('Supabase replay upload and authenticated playback smoke test passed.');
  } catch (error) {
    console.error(error.message || error);
    process.exitCode = 1;
  } finally {
    if (url && key) {
      const smokeObjects = await query(
        `select name from storage.objects
          where bucket_id = $1 and name like 'smoke-tests/%'`,
        [bucket],
      ).catch(() => ({ rows: [{ name: objectPath }] }));
      for (const object of smokeObjects.rows) {
        const response = await fetch(`${url}/storage/v1/object/${encodeObjectPath(bucket, object.name)}`, {
          method: 'DELETE',
          headers: { apikey: key, Authorization: `Bearer ${key}` },
        }).catch(() => null);
        if (!response?.ok) process.exitCode = 1;
      }

      const remaining = await query(
        `select count(*)::integer as count from storage.objects
          where bucket_id = $1 and name like 'smoke-tests/%'`,
        [bucket],
      ).catch(() => ({ rows: [{ count: -1 }] }));
      if (Number(remaining.rows[0]?.count) !== 0) {
        console.error('Unable to clean up temporary replay smoke-test objects.');
        process.exitCode = 1;
      }
    }
    await query('drop policy if exists violation_evidence_smoke_test_delete on storage.objects').catch(() => {});
    await getPool().end().catch(() => {});
  }
})();

// Uploads, downloads and removes a replay the way the server does, with the
// storage gateway key, and checks the public key can neither read nor list it.
// The project's env file beats machine-wide variables, as in server.js.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env.local'), override: true, quiet: true });

const crypto = require('crypto');
const { deleteStorageObject, downloadStorageObject, uploadStorageObject } = require('../server/supabase-storage.cjs');
const { getPool, query } = require('../server/db.cjs');

(async () => {
  const bucket = 'violation-evidence';
  const objectPath = `smoke-tests/${crypto.randomUUID()}.webm`;
  const payload = Buffer.from('violation-replay-storage-smoke-test');
  const url = String(process.env.VITE_SUPABASE_URL || '').replace(/\/+$/, '');
  const publicKey = String(process.env.VITE_SUPABASE_PUBLISHABLE_KEY || '');

  try {
    await uploadStorageObject(bucket, objectPath, payload, 'video/webm');
    const downloaded = await downloadStorageObject(bucket, objectPath);
    if (!downloaded.data.equals(payload)) throw new Error('Downloaded replay data did not match the upload.');

    const publicHeaders = { apikey: publicKey, Authorization: `Bearer ${publicKey}` };
    const read = await fetch(`${url}/storage/v1/object/${bucket}/${objectPath}`, { headers: publicHeaders });
    if (read.ok) throw new Error('The public key could download a replay video.');
    const list = await fetch(`${url}/storage/v1/object/list/${bucket}`, {
      method: 'POST',
      headers: { ...publicHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ prefix: 'smoke-tests/', limit: 100 }),
    });
    const listed = list.ok ? await list.json().catch(() => []) : [];
    if (Array.isArray(listed) && listed.length) throw new Error('The public key could list replay videos.');

    console.log('Replay storage smoke test passed: server upload, download and removal work; the public key cannot read or list replays.');
  } catch (error) {
    console.error(error.message || error);
    process.exitCode = 1;
  } finally {
    await deleteStorageObject(bucket, objectPath).catch(() => {});
    const remaining = await query(
      `select count(*)::integer as count from storage.objects where bucket_id = $1 and name = $2`,
      [bucket, objectPath],
    ).catch(() => ({ rows: [{ count: -1 }] }));
    if (Number(remaining.rows[0]?.count) !== 0) {
      console.error('Unable to clean up the temporary replay smoke-test object.');
      process.exitCode = 1;
    }
    await getPool().end().catch(() => {});
  }
})();

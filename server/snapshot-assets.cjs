const crypto = require('crypto');
const { query } = require('./db.cjs');
const { uploadStorageObject, downloadStorageObject } = require('./supabase-storage.cjs');

const SNAPSHOT_BUCKET = 'camera-snapshots';
const MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024;

function storageGatewayKey(environment = process.env) {
  if (!environment.SUPABASE_DB_PASSWORD) throw new Error('Snapshot storage gateway is not configured.');
  return crypto.createHmac('sha256', environment.SUPABASE_DB_PASSWORD)
    .update('examguard-private-snapshot-storage-v1').digest('hex');
}

function decodeSnapshot(imageData) {
  const match = String(imageData || '').match(/^data:(image\/(?:jpeg|png|webp|gif));base64,([A-Za-z0-9+/=]+)$/);
  if (!match || match[2].length > Math.ceil(MAX_SNAPSHOT_BYTES * 4 / 3) + 4) throw new Error('Invalid or oversized snapshot.');
  const data = Buffer.from(match[2], 'base64');
  if (!data.length || data.length > MAX_SNAPSHOT_BYTES) throw new Error('Invalid or oversized snapshot.');
  const mimeType = match[1];
  const valid = mimeType === 'image/jpeg' ? data[0] === 0xff && data[1] === 0xd8
    : mimeType === 'image/png' ? data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    : mimeType === 'image/gif' ? /^GIF8[79]a$/.test(data.subarray(0, 6).toString())
    : data.subarray(0, 4).toString() === 'RIFF' && data.subarray(8, 12).toString() === 'WEBP';
  if (!valid) throw new Error('Snapshot content does not match its image type.');
  return { data, mimeType };
}

async function storeSnapshot(sessionId, imageData, dependencies = { query, uploadStorageObject }) {
  const { data, mimeType } = decodeSnapshot(imageData);
  const id = crypto.createHash('sha256').update(String(sessionId)).update('\0').update(mimeType).update('\0').update(data).digest('hex');
  const storagePath = `${crypto.createHash('sha256').update(String(sessionId)).digest('hex')}/${id}`;
  const existing = await dependencies.query('select id from public.camera_snapshot_assets where id = $1', [id]);
  if (!existing.rows.length) {
    // Only publish the reference after a successful upload. An interrupted DB
    // insert leaves a harmless object that the same content hash can retry.
    await dependencies.uploadStorageObject(SNAPSHOT_BUCKET, storagePath, data, mimeType);
    await dependencies.query(`insert into public.camera_snapshot_assets
      (id, session_id, storage_path, mime_type, byte_size) values ($1,$2,$3,$4,$5)
      on conflict (id) do nothing`, [id, sessionId, storagePath, mimeType, data.length]);
  }
  return { assetId: id, storageBucket: SNAPSHOT_BUCKET, storagePath, imageData: `/api/monitor/snapshots/${id}/file` };
}

async function readSnapshot(id) {
  const { rows } = await query('select * from public.camera_snapshot_assets where id = $1', [id]);
  if (!rows[0]) return null;
  const object = await downloadStorageObject(SNAPSHOT_BUCKET, rows[0].storage_path);
  return { ...rows[0], data: object.data };
}

module.exports = { SNAPSHOT_BUCKET, MAX_SNAPSHOT_BYTES, storageGatewayKey, decodeSnapshot, storeSnapshot, readSnapshot };

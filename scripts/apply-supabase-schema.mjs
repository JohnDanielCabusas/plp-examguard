import 'dotenv/config';
import dotenv from 'dotenv';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

// Every other database script in scripts/ reads .env.local; this one did not,
// so it reported the connection settings missing even when they were sitting
// right there in the file. override:false keeps real environment variables
// winning, which is what CI and a deploy shell rely on.
dotenv.config({ path: '.env.local', override: false, quiet: true });

const { Client } = pg;

const requiredVars = [
  'SUPABASE_DB_HOST',
  'SUPABASE_DB_PORT',
  'SUPABASE_DB_NAME',
  'SUPABASE_DB_USER',
  'SUPABASE_DB_PASSWORD',
];

const missing = requiredVars.filter(name => !process.env[name]);

if (missing.length) {
  console.error(`Missing required env vars: ${missing.join(', ')}`);
  process.exit(1);
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const schemaPath = path.resolve(__dirname, '..', 'supabase', 'schema-bootstrap.sql');
const sql = await fs.readFile(schemaPath, 'utf8');

const client = new Client({
  host: process.env.SUPABASE_DB_HOST,
  port: Number(process.env.SUPABASE_DB_PORT),
  database: process.env.SUPABASE_DB_NAME,
  user: process.env.SUPABASE_DB_USER,
  password: process.env.SUPABASE_DB_PASSWORD,
  ssl: process.env.SUPABASE_DB_SSL === 'disable'
    ? false
    : { rejectUnauthorized: false },
});

try {
  await client.connect();
  await client.query(sql);
  console.log(`Supabase schema applied successfully from ${schemaPath}`);
} catch (error) {
  console.error('Failed to apply Supabase schema.');
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}

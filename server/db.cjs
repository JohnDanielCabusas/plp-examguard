const { Pool } = require('pg');

let pool = null;

function getMissingEnvVars() {
  const required = [
    'SUPABASE_DB_HOST',
    'SUPABASE_DB_PORT',
    'SUPABASE_DB_NAME',
    'SUPABASE_DB_USER',
    'SUPABASE_DB_PASSWORD',
  ];
  return required.filter((name) => !process.env[name]);
}

function getPool() {
  if (pool) return pool;

  const missing = getMissingEnvVars();
  if (missing.length) {
    const error = new Error(`Server auth is not configured. Missing env vars: ${missing.join(', ')}`);
    error.code = 'AUTH_DB_CONFIG_MISSING';
    throw error;
  }

  pool = new Pool({
    host: process.env.SUPABASE_DB_HOST,
    port: Number(process.env.SUPABASE_DB_PORT),
    database: process.env.SUPABASE_DB_NAME,
    user: process.env.SUPABASE_DB_USER,
    password: process.env.SUPABASE_DB_PASSWORD,
    ssl: process.env.SUPABASE_DB_SSL === 'disable'
      ? false
      : { rejectUnauthorized: false },
  });

  return pool;
}

async function query(text, params = []) {
  const activePool = getPool();
  return activePool.query(text, params);
}

module.exports = {
  getMissingEnvVars,
  getPool,
  query,
};

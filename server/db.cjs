const { Pool } = require('pg');

let pool = null;
const AUTH_TIMEOUT_RETRY_DELAY_MS = 250;

function isAuthenticationTimeout(error) {
  const message = String(error?.message || error || '');
  return error?.code === 'EAUTHTIMEOUT'
    || /\bEAUTHTIMEOUT\b/i.test(message)
    || /timeout while waiting for message/i.test(message);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function retryAuthenticationTimeout(operation) {
  try {
    return await operation();
  } catch (error) {
    // This failure occurs during PostgreSQL authentication, before any query is
    // sent, so one retry is safe for both reads and writes.
    if (!isAuthenticationTimeout(error)) throw error;
    await delay(AUTH_TIMEOUT_RETRY_DELAY_MS);
    return operation();
  }
}

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
    // Keep the dev server from opening a large burst of authenticated
    // connections when several monitoring polls arrive together.
    max: 5,
    connectionTimeoutMillis: 10000,
    idleTimeoutMillis: 30000,
    keepAlive: true,
    ssl: process.env.SUPABASE_DB_SSL === 'disable'
      ? false
      : { rejectUnauthorized: false },
  });

  // pg emits idle-client failures as EventEmitter errors. Without a listener,
  // a temporary database/network interruption can terminate the Node process.
  pool.on('error', (error) => {
    console.warn('[Database] Idle connection dropped:', error?.message || error);
  });

  return pool;
}

async function query(text, params = []) {
  const activePool = getPool();
  return retryAuthenticationTimeout(() => activePool.query(text, params));
}

async function connect() {
  const activePool = getPool();
  return retryAuthenticationTimeout(() => activePool.connect());
}

module.exports = {
  connect,
  getMissingEnvVars,
  getPool,
  isAuthenticationTimeout,
  query,
};

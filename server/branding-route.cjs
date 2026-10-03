const { query } = require('./db.cjs');

// The school logo lives in settings.logo_url as a base64 data URI (~374 KB). When
// every student's login and portal pulled it straight from Supabase it was the
// single largest egress cost, so the browser loads it from here instead: this
// process reads it from the database at most once per cache window and the
// browser caches the decoded image.
const LOGO_CACHE_MS = 10 * 60 * 1000;
const DEFAULT_LOGO_PATH = '/plp-logo.png';

let cachedLogo = null; // { fetchedAt, value }

async function loadLogoValue() {
  if (cachedLogo && Date.now() - cachedLogo.fetchedAt < LOGO_CACHE_MS) return cachedLogo.value;
  const { rows } = await query("select logo_url from public.settings where id = 'main' limit 1");
  const value = String(rows?.[0]?.logo_url || '').trim();
  cachedLogo = { fetchedAt: Date.now(), value };
  return value;
}

function redirect(res, location) {
  res.writeHead(302, { Location: location, 'Cache-Control': 'no-cache' });
  res.end();
}

async function handleBrandingRoute(req, res) {
  let value = '';
  try {
    value = await loadLogoValue();
  } catch (error) {
    console.warn('[Branding] Unable to load the school logo:', error?.message || error);
    // Keep serving the last known logo through a database outage.
    value = cachedLogo?.value || '';
  }

  const dataUri = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(value);
  if (!dataUri) {
    redirect(res, value && /^(https?:)?\//.test(value) ? value : DEFAULT_LOGO_PATH);
    return;
  }

  const [, contentType, isBase64, payload] = dataUri;
  const body = isBase64 ? Buffer.from(payload, 'base64') : Buffer.from(decodeURIComponent(payload));
  res.writeHead(200, {
    'Content-Type': contentType,
    'Content-Length': body.length,
    'Cache-Control': `public, max-age=${Math.floor(LOGO_CACHE_MS / 1000)}`,
  });
  res.end(body);
}

module.exports = { handleBrandingRoute };

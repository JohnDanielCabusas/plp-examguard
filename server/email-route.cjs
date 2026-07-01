const { sendVerificationEmail } = require('./email-service.cjs');

function jsonResponse(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', chunk => {
      raw += chunk;
    });
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

async function handleEmailRoute(req, res, body) {
  if (req.method !== 'POST') {
    jsonResponse(res, 405, { success: false, message: 'Method not allowed.' });
    return true;
  }

  let payload = body;
  if (!payload) {
    try {
      payload = await readJsonBody(req);
    } catch {
      jsonResponse(res, 400, { success: false, message: 'Invalid JSON body.' });
      return true;
    }
  }

  const email = String(payload?.email || '').trim().toLowerCase();
  const code = String(payload?.code || '').trim();
  const type = String(payload?.type || '').trim();

  if (!email || !code || !type) {
    jsonResponse(res, 400, { success: false, message: 'email, code, and type are required.' });
    return true;
  }

  try {
    const delivery = await sendVerificationEmail({
      smtpConfig: {
        host: process.env.SMTP_HOST,
        port: process.env.SMTP_PORT,
        secure: process.env.SMTP_SECURE,
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
      fromEmail: process.env.SMTP_FROM_EMAIL || process.env.SMTP_USER,
      to: email,
      code,
      type,
    });
    const deliveryMode = delivery?.delivery || 'smtp';
    jsonResponse(res, 200, {
      success: true,
      delivery: deliveryMode,
      ...(deliveryMode === 'console' ? { previewCode: code } : {}),
      message: deliveryMode === 'console'
        ? 'Verification code generated in fallback mode. Check the server console or use the preview code shown in the app.'
        : 'Verification code sent successfully.',
    });
  } catch (error) {
    jsonResponse(res, 500, {
      success: false,
      message: error instanceof Error ? error.message : 'Unable to send verification code.',
    });
  }

  return true;
}

module.exports = {
  handleEmailRoute,
};

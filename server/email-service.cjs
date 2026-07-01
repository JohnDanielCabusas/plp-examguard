const nodemailer = require('nodemailer');

let transporter = null;
let transporterConfigKey = null;
const BRAND_NAME = 'TUKLAS';
const SUPPORT_NAME = 'TUKLAS Support';
const SCHOOL_NAME = 'Pamantasan ng Lungsod ng Pasig';

function normalizeFallbackMode(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'console') return 'console';
  if (normalized === 'console-on-error') return 'console-on-error';
  return 'off';
}

function getFallbackMode() {
  return normalizeFallbackMode(process.env.SMTP_FALLBACK_MODE);
}

function normalizeSmtpConfig({ host, port, secure, user, pass } = {}) {
  const normalizedHost = String(host || '').trim();
  const normalizedUser = String(user || '').trim().toLowerCase();
  const compactPass = String(pass || '').replace(/\s+/g, '');
  const normalizedSecure = String(secure).toLowerCase() !== 'false';
  const normalizedPort = Number(port || 465);

  return {
    host: normalizedHost,
    port: normalizedPort,
    secure: normalizedSecure,
    user: normalizedUser,
    pass: compactPass,
  };
}

function isGmailHost(host) {
  const normalizedHost = String(host || '').trim().toLowerCase();
  return normalizedHost === 'smtp.gmail.com' || normalizedHost.endsWith('.gmail.com');
}

function normalizeEmailType(type) {
  const normalized = String(type || '').trim().toLowerCase();
  if (normalized === 'student-verification') return 'student-verification';
  if (normalized === 'student-reset' || normalized === 'student-password-reset' || normalized === 'student-forgot-password') return 'student-reset';
  if (normalized === 'admin-reset' || normalized === 'professor-reset' || normalized === 'admin-password-reset') return 'admin-reset';
  return null;
}

function buildEmailPayload({ type, code, to, fromEmail }) {
  const emailType = normalizeEmailType(type);
  if (!emailType) throw new Error('Unsupported email type.');

  const isStudentVerification = emailType === 'student-verification';
  const isStudentReset = emailType === 'student-reset';
  const subject = isStudentVerification
    ? `${BRAND_NAME} Student Verification Code`
    : isStudentReset
      ? `${BRAND_NAME} Student Password Reset Code`
      : `${BRAND_NAME} Professor Password Reset Code`;
  const intro = isStudentVerification
    ? `You requested a verification code to continue signing in to ${BRAND_NAME}.`
    : isStudentReset
      ? `You requested a verification code to continue resetting your ${BRAND_NAME} student password.`
      : `You requested a verification code to continue resetting your ${BRAND_NAME} professor password.`;
  const instruction = isStudentVerification
    ? 'Enter the code below on the student login screen to verify your email address.'
    : isStudentReset
      ? 'Enter the code below on the student reset screen to continue updating your password.'
      : 'Enter the code below on the professor reset screen to continue updating your password.';
  const text = [
    BRAND_NAME,
    '',
    intro,
    instruction,
    '',
    `Verification code: ${code}`,
    '',
    'This code expires in 10 minutes.',
    'If you did not request this code, you may safely ignore this email.',
  ].join('\n');

  return {
    from: `"${BRAND_NAME}" <${String(fromEmail || '').trim().toLowerCase()}>`,
    to,
    subject,
    replyTo: String(fromEmail || '').trim().toLowerCase(),
    text,
    html: `
      <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">
        Your ${BRAND_NAME} verification code is ${code}. This code expires in 10 minutes.
      </div>
      <div style="margin:0;padding:32px 16px;background:#eef3ef;">
        <div style="font-family:Segoe UI,Arial,sans-serif;color:#14231a;max-width:620px;margin:0 auto;background:#ffffff;border:1px solid #d9e3db;border-radius:20px;overflow:hidden;box-shadow:0 10px 28px rgba(15,45,26,0.08);">
          <div style="background:linear-gradient(135deg,#12381e 0%,#164524 55%,#1f5b30 100%);padding:28px 32px;color:#ffffff;">
            <div style="font-size:12px;letter-spacing:1.8px;text-transform:uppercase;opacity:0.82;margin-bottom:10px;font-weight:600;">${SCHOOL_NAME}</div>
            <h1 style="margin:0;font-size:28px;line-height:1.2;font-weight:700;">${BRAND_NAME} Verification</h1>
          </div>
          <div style="padding:34px 32px 30px;">
            <div style="max-width:520px;">
              <p style="margin:0 0 16px;font-size:17px;line-height:1.7;color:#18261d;">Good day,</p>
              <p style="margin:0 0 14px;font-size:16px;line-height:1.8;color:#24342a;">${intro}</p>
              <p style="margin:0 0 26px;font-size:16px;line-height:1.8;color:#24342a;">${instruction}</p>
            </div>
            <div style="margin:0 0 28px;padding:24px 22px;background:linear-gradient(180deg,#f7f9f7 0%,#f1f5f1 100%);border:1px solid #dde6df;border-radius:16px;text-align:center;">
              <div style="font-size:12px;letter-spacing:2px;text-transform:uppercase;color:#66756c;margin-bottom:12px;font-weight:700;">6-Digit Verification Code</div>
              <div style="font-size:42px;line-height:1.1;font-weight:800;letter-spacing:10px;color:#173a21;font-family:'Segoe UI',Arial,sans-serif;">${code}</div>
            </div>
            <div style="max-width:520px;">
              <p style="margin:0 0 10px;font-size:14px;line-height:1.75;color:#33443a;">This code expires in <strong>10 minutes</strong>.</p>
              <p style="margin:0 0 10px;font-size:14px;line-height:1.75;color:#33443a;">For your security, please do not share this code with anyone.</p>
              <p style="margin:0 0 22px;font-size:14px;line-height:1.75;color:#33443a;">If you did not request this code, you may safely ignore this email.</p>
              <p style="margin:0;font-size:14px;line-height:1.75;color:#18261d;">Regards,<br /><strong>${SUPPORT_NAME}</strong></p>
            </div>
          </div>
          <div style="padding:18px 32px;border-top:1px solid #e4ebe5;background:#f8faf8;font-size:12px;line-height:1.7;color:#718076;">
            This is an automated message from ${BRAND_NAME}. Please do not reply directly to this email.
          </div>
        </div>
      </div>
    `,
  };
}

function createTransport({ host, port, secure, user, pass }) {
  const normalized = normalizeSmtpConfig({ host, port, secure, user, pass });

  if (isGmailHost(normalized.host)) {
    return nodemailer.createTransport({
      service: 'gmail',
      host: 'smtp.gmail.com',
      port: 465,
      secure: true,
      requireTLS: true,
      authMethod: 'LOGIN',
      connectionTimeout: 10000,
      greetingTimeout: 10000,
      socketTimeout: 15000,
      auth: {
        user: normalized.user,
        pass: normalized.pass,
      },
      tls: {
        servername: 'smtp.gmail.com',
      },
    });
  }

  return nodemailer.createTransport({
    host: normalized.host,
    port: normalized.port,
    secure: normalized.secure,
    pool: true,
    maxConnections: 3,
    maxMessages: 100,
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 15000,
    auth: {
      user: normalized.user,
      pass: normalized.pass,
    },
  });
}

function getTransportConfigKey({ host, port, secure, user, pass }) {
  const normalized = normalizeSmtpConfig({ host, port, secure, user, pass });
  return JSON.stringify({
    host: normalized.host,
    port: normalized.port,
    secure: normalized.secure,
    user: normalized.user,
    pass: normalized.pass,
  });
}

function getReadyTransport(smtpConfig) {
  const nextConfigKey = getTransportConfigKey(smtpConfig || {});
  if (!transporter || transporterConfigKey !== nextConfigKey) {
    transporter = createTransport(smtpConfig);
    transporterConfigKey = nextConfigKey;
  }
  return transporter;
}

function logVerificationCode({ to, code, type }) {
  console.log(`[Email Fallback] ${type} code for ${to}: ${code}`);
  return {
    accepted: [to],
    rejected: [],
    response: 'console-fallback',
    delivery: 'console',
    previewCode: code,
  };
}

function isGmailAuthError(error, smtpConfig) {
  const host = String(smtpConfig?.host || '').trim().toLowerCase();
  const message = String(error?.message || '').toLowerCase();
  const response = String(error?.response || '').toLowerCase();
  return host.includes('gmail') && (
    message.includes('534-5.7.9')
    || response.includes('534-5.7.9')
    || message.includes('webloginrequired')
    || response.includes('webloginrequired')
    || message.includes('application-specific password')
    || message.includes('invalid login')
  );
}

function mapEmailError(error, smtpConfig) {
  if (isGmailAuthError(error, smtpConfig)) {
    const friendlyError = new Error(
      'Gmail blocked the SMTP login. Sign in to the Gmail account in a browser, confirm it is active, and use a 16-digit Google App Password for SMTP_PASS. For local testing, you can also set SMTP_FALLBACK_MODE=console-on-error.',
    );
    friendlyError.code = 'SMTP_GMAIL_AUTH_FAILED';
    friendlyError.cause = error;
    return friendlyError;
  }

  return error;
}

async function sendVerificationEmail({ smtpConfig, fromEmail, to, code, type }) {
  if (!smtpConfig?.host) throw new Error('Missing SMTP_HOST.');
  if (!smtpConfig?.user) throw new Error('Missing SMTP_USER.');
  if (!smtpConfig?.pass) throw new Error('Missing SMTP_PASS.');
  if (!fromEmail) throw new Error('Missing SMTP_FROM_EMAIL.');
  if (!to) throw new Error('Missing recipient email.');
  if (!code) throw new Error('Missing verification code.');

  const fallbackMode = getFallbackMode();
  if (fallbackMode === 'console') {
    return logVerificationCode({ to, code, type });
  }

  const readyTransporter = getReadyTransport(smtpConfig);
  const payload = buildEmailPayload({ type, code, to, fromEmail });
  try {
    const result = await readyTransporter.sendMail({
      ...payload,
      headers: {
        'X-Priority': '1',
        'X-Mailer': `${BRAND_NAME} SMTP`,
      },
    });
    return { ...result, delivery: 'smtp' };
  } catch (error) {
    transporter = null;
    transporterConfigKey = null;
    const mappedError = mapEmailError(error, smtpConfig);
    if (fallbackMode === 'console-on-error') {
      console.warn(`[Email Fallback] SMTP delivery failed: ${mappedError.message}`);
      return logVerificationCode({ to, code, type });
    }
    throw mappedError;
  }
}

module.exports = {
  sendVerificationEmail,
};

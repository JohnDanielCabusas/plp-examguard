const nodemailer = require('nodemailer');

let transporter = null;
let transporterReadyPromise = null;

function normalizeEmailType(type) {
  if (type === 'student-verification' || type === 'admin-reset') return type;
  return null;
}

function buildEmailPayload({ type, code, to, fromEmail }) {
  const emailType = normalizeEmailType(type);
  if (!emailType) throw new Error('Unsupported email type.');

  const isStudent = emailType === 'student-verification';
  const subject = isStudent
    ? 'PLP ExamGuard Student Verification Code'
    : 'PLP ExamGuard Professor Password Reset Code';
  const intro = isStudent
    ? 'You requested a verification code to continue signing in to PLP ExamGuard.'
    : 'You requested a verification code to continue resetting your PLP ExamGuard professor password.';
  const instruction = isStudent
    ? 'Enter the code below on the student login screen to verify your email address.'
    : 'Enter the code below on the professor reset screen to continue updating your password.';
  const text = [
    'PLP ExamGuard',
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
    from: `"PLP ExamGuard" <${fromEmail}>`,
    to,
    subject,
    replyTo: fromEmail,
    text,
    html: `
      <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">
        Your PLP ExamGuard verification code is ${code}. This code expires in 10 minutes.
      </div>
      <div style="margin:0;padding:24px 0;background:#f5f7f7;">
        <div style="font-family:Segoe UI,Arial,sans-serif;line-height:1.6;color:#111827;max-width:600px;margin:0 auto;background:#ffffff;border:1px solid #e5e7eb;border-radius:16px;overflow:hidden;">
          <div style="background:linear-gradient(135deg,#0a1f12 0%,#0f2d1a 60%,#1a4d2a 100%);padding:24px 28px;color:#ffffff;">
            <div style="font-size:12px;letter-spacing:1.2px;text-transform:uppercase;opacity:0.78;margin-bottom:8px;">Pamantasan ng Lungsod ng Pasig</div>
            <h1 style="margin:0;font-size:24px;line-height:1.3;">PLP ExamGuard Verification</h1>
          </div>
          <div style="padding:28px;">
            <p style="margin:0 0 14px;font-size:15px;">Good day,</p>
            <p style="margin:0 0 14px;font-size:15px;">${intro}</p>
            <p style="margin:0 0 22px;font-size:15px;">${instruction}</p>
            <div style="margin:0 0 22px;padding:18px 20px;background:#f3f4f6;border:1px solid #e5e7eb;border-radius:12px;text-align:center;">
              <div style="font-size:12px;letter-spacing:1px;text-transform:uppercase;color:#6b7280;margin-bottom:8px;">6-digit verification code</div>
              <div style="font-size:34px;font-weight:700;letter-spacing:8px;color:#0f2d1a;">${code}</div>
            </div>
            <p style="margin:0 0 8px;font-size:14px;">This code expires in <strong>10 minutes</strong>.</p>
            <p style="margin:0 0 8px;font-size:14px;">For your security, please do not share this code with anyone.</p>
            <p style="margin:0 0 18px;font-size:14px;">If you did not request this code, you may safely ignore this email.</p>
            <p style="margin:0;font-size:14px;">Regards,<br /><strong>PLP ExamGuard Support</strong></p>
          </div>
          <div style="padding:18px 28px;border-top:1px solid #e5e7eb;background:#fafafa;font-size:12px;color:#6b7280;">
            This is an automated message from PLP ExamGuard. Please do not reply directly to this email.
          </div>
        </div>
      </div>
    `,
  };
}

function createTransport({ host, port, secure, user, pass }) {
  return nodemailer.createTransport({
    host,
    port: Number(port || 465),
    secure: String(secure).toLowerCase() !== 'false',
    pool: true,
    maxConnections: 3,
    maxMessages: 100,
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 15000,
    auth: {
      user,
      pass: String(pass || '').replace(/\s+/g, ''),
    },
  });
}

async function getReadyTransport(smtpConfig) {
  if (!transporter) {
    transporter = createTransport(smtpConfig);
  }
  if (!transporterReadyPromise) {
    transporterReadyPromise = transporter.verify().catch(error => {
      transporterReadyPromise = null;
      transporter = null;
      throw error;
    });
  }
  await transporterReadyPromise;
  return transporter;
}

async function sendVerificationEmail({ smtpConfig, fromEmail, to, code, type }) {
  if (!smtpConfig?.host) throw new Error('Missing SMTP_HOST.');
  if (!smtpConfig?.user) throw new Error('Missing SMTP_USER.');
  if (!smtpConfig?.pass) throw new Error('Missing SMTP_PASS.');
  if (!fromEmail) throw new Error('Missing SMTP_FROM_EMAIL.');
  if (!to) throw new Error('Missing recipient email.');
  if (!code) throw new Error('Missing verification code.');

  const readyTransporter = await getReadyTransport(smtpConfig);
  const payload = buildEmailPayload({ type, code, to, fromEmail });
  return readyTransporter.sendMail({
    ...payload,
    headers: {
      'X-Priority': '1',
      'X-Mailer': 'PLP ExamGuard SMTP',
    },
  });
}

module.exports = {
  sendVerificationEmail,
};

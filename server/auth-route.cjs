const crypto = require('crypto');
const { sendVerificationEmail } = require('./email-service.cjs');
const {
  createCode,
  normalizeProfessor,
  normalizeStudent,
  normalizeSysAdmin,
  hashPassword,
  verifyPassword,
  getProfessorByUsername,
  getProfessorByEmail,
  getProfessorById,
  getProfessorPublicById,
  updateProfessorPassword,
  logProfessorActivity,
  recoverProfessorOwnership,
  saveProfessor,
  deleteProfessor,
  getSysAdminRow,
  saveSysAdminProfile,
  updateSysAdminPassword,
  getSettingsRow,
  normalizeSettings,
  saveSettings,
  getStudentByEmail,
  getStudentByStudentId,
  updateStudentPassword,
  checkStudentEmailStatus,
  saveStudentSetup,
} = require('./auth-service.cjs');

const verificationStore = new Map();
const TEN_MINUTES = 10 * 60 * 1000;
const SESSION_MAX_AGE_MS = 12 * 60 * 60 * 1000;
const ADMIN_SESSION_COOKIE = 'acs_admin_auth';
const SYSADMIN_SESSION_COOKIE = 'acs_sysadmin_auth';
const STUDENT_SESSION_COOKIE = 'acs_student_auth';

function jsonResponse(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

function getSessionSecret() {
  return String(
    process.env.AUTH_SESSION_SECRET
    || process.env.SUPABASE_DB_PASSWORD
    || 'replace-this-auth-session-secret'
  );
}

function toBase64Url(value) {
  return Buffer.from(value)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function fromBase64Url(value) {
  const normalized = String(value || '').replace(/-/g, '+').replace(/_/g, '/');
  const padding = normalized.length % 4 ? '='.repeat(4 - (normalized.length % 4)) : '';
  return Buffer.from(normalized + padding, 'base64').toString('utf8');
}

function signValue(value) {
  return crypto.createHmac('sha256', getSessionSecret()).update(value).digest('hex');
}

function serializeSession(payload) {
  const json = JSON.stringify(payload);
  const encoded = toBase64Url(json);
  return `${encoded}.${signValue(encoded)}`;
}

function deserializeSession(raw) {
  const value = String(raw || '');
  const dotIndex = value.lastIndexOf('.');
  if (dotIndex <= 0) return null;

  const encoded = value.slice(0, dotIndex);
  const signature = value.slice(dotIndex + 1);
  const expected = signValue(encoded);
  const actualBuffer = Buffer.from(signature, 'hex');
  const expectedBuffer = Buffer.from(expected, 'hex');
  if (
    actualBuffer.length !== expectedBuffer.length
    || !crypto.timingSafeEqual(actualBuffer, expectedBuffer)
  ) {
    return null;
  }

  try {
    const payload = JSON.parse(fromBase64Url(encoded));
    if (!payload || typeof payload !== 'object') return null;
    if (payload.expiresAt && Date.now() > payload.expiresAt) return null;
    return payload;
  } catch {
    return null;
  }
}

function parseCookies(req) {
  const raw = String(req.headers?.cookie || '');
  if (!raw) return {};
  return raw.split(';').reduce((acc, part) => {
    const [name, ...rest] = part.trim().split('=');
    if (!name) return acc;
    acc[name] = decodeURIComponent(rest.join('='));
    return acc;
  }, {});
}

function appendSetCookie(res, cookie) {
  const existing = res.getHeader('Set-Cookie');
  if (!existing) {
    res.setHeader('Set-Cookie', cookie);
    return;
  }
  const next = Array.isArray(existing) ? [...existing, cookie] : [existing, cookie];
  res.setHeader('Set-Cookie', next);
}

function buildCookie(name, value, req, maxAgeMs = SESSION_MAX_AGE_MS) {
  const isSecure = req.headers['x-forwarded-proto'] === 'https'
    || req.socket?.encrypted
    || process.env.NODE_ENV === 'production';
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.max(0, Math.floor(maxAgeMs / 1000))}`,
  ];
  if (isSecure) parts.push('Secure');
  return parts.join('; ');
}

function writeSessionCookie(res, req, cookieName, payload) {
  appendSetCookie(res, buildCookie(cookieName, serializeSession({
    ...payload,
    expiresAt: Date.now() + SESSION_MAX_AGE_MS,
  }), req));
}

function clearSessionCookie(res, req, cookieName) {
  appendSetCookie(res, buildCookie(cookieName, '', req, 0));
}

function readSessionCookie(req, cookieName) {
  const cookies = parseCookies(req);
  return deserializeSession(cookies[cookieName]);
}

function forbid(res, message = 'Not authorized.') {
  jsonResponse(res, 403, { success: false, message });
}

function buildProfessorSessionPayload(admin) {
  return { role: 'professor', professorId: admin.id };
}

function buildSysAdminSessionPayload() {
  return { role: 'sysadmin', sysAdminId: 'main' };
}

function buildStudentSessionPayload(student) {
  return { role: 'student', studentNumber: student.student_id };
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

function verificationKey(flow, email) {
  return `${flow}:${String(email || '').trim().toLowerCase()}`;
}

function clearVerification(flow, email) {
  verificationStore.delete(verificationKey(flow, email));
}

function getVerification(flow, email) {
  const pending = verificationStore.get(verificationKey(flow, email));
  if (!pending) return null;
  if (Date.now() > pending.expiresAt) {
    clearVerification(flow, email);
    return null;
  }
  return pending;
}

function setVerification(flow, email, payload) {
  verificationStore.set(verificationKey(flow, email), payload);
}

async function sendCodeEmail({ email, code, type }) {
  return sendVerificationEmail({
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
}

async function getCurrentProfessorSession(req) {
  const session = readSessionCookie(req, ADMIN_SESSION_COOKIE);
  if (!session || session.role !== 'professor' || !session.professorId) return null;
  return getProfessorPublicById(session.professorId);
}

async function getCurrentSysAdminSession(req) {
  const session = readSessionCookie(req, SYSADMIN_SESSION_COOKIE);
  if (!session || session.role !== 'sysadmin') return null;
  const sysAdmin = await getSysAdminRow();
  return normalizeSysAdmin(sysAdmin);
}

async function getCurrentStudentSession(req) {
  const session = readSessionCookie(req, STUDENT_SESSION_COOKIE);
  if (!session || session.role !== 'student' || !session.studentNumber) return null;
  const student = await getStudentByStudentId(session.studentNumber);
  return normalizeStudent(student);
}

async function handleProfessorLogin(req, res, body) {
  const username = String(body?.username || '').trim();
  const password = String(body?.password || '');
  const admin = await getProfessorByUsername(username);
  if (!admin) return jsonResponse(res, 401, { success: false, message: 'Invalid username or password.' });

  const verification = await verifyPassword(password, admin.password);
  if (!verification.valid) return jsonResponse(res, 401, { success: false, message: 'Invalid username or password.' });
  if (verification.needsUpgrade && verification.hash) {
    await updateProfessorPassword(admin.id, verification.hash);
  }

  try {
    await recoverProfessorOwnership(admin);
  } catch (error) {
    console.warn('[auth-route] recoverProfessorOwnership during login:', error.message || error);
  }

  await logProfessorActivity('login', admin);
  writeSessionCookie(res, req, ADMIN_SESSION_COOKIE, buildProfessorSessionPayload(admin));

  jsonResponse(res, 200, {
    success: true,
    admin: {
      id: admin.id,
      username: admin.username,
      name: admin.name,
      email: admin.email || '',
      department: admin.department || '',
      loginAt: new Date().toISOString(),
    },
  });
}

async function handleSysAdminLogin(req, res, body) {
  const username = String(body?.username || '').trim();
  const password = String(body?.password || '');
  const sysAdmin = await getSysAdminRow();
  if (!sysAdmin || sysAdmin.username !== username) {
    return jsonResponse(res, 401, { success: false, message: 'Invalid username or password.' });
  }

  const verification = await verifyPassword(password, sysAdmin.password);
  if (!verification.valid) {
    return jsonResponse(res, 401, { success: false, message: 'Invalid username or password.' });
  }
  if (verification.needsUpgrade && verification.hash) {
    await updateSysAdminPassword(verification.hash);
  }

  writeSessionCookie(res, req, SYSADMIN_SESSION_COOKIE, buildSysAdminSessionPayload());

  jsonResponse(res, 200, {
    success: true,
    session: {
      username: sysAdmin.username,
      name: sysAdmin.name || 'System Administrator',
      email: sysAdmin.email || '',
      department: sysAdmin.department || '',
      loginAt: new Date().toISOString(),
    },
  });
}

async function handleStudentStatus(res, body) {
  const email = String(body?.email || '').trim().toLowerCase();
  if (!email) return jsonResponse(res, 400, { success: false, message: 'Email is required.' });
  const status = await checkStudentEmailStatus(email);
  jsonResponse(res, 200, { success: true, ...status });
}

async function handleStudentLogin(req, res, body) {
  const email = String(body?.email || '').trim().toLowerCase();
  const password = String(body?.password || '');
  const student = await getStudentByEmail(email);

  if (!student) return jsonResponse(res, 404, { success: false, message: 'No account found with this email.' });
  if (!student.password) return jsonResponse(res, 400, { success: false, message: 'Account setup incomplete. Please set up your account first.' });

  const verification = await verifyPassword(password, student.password);
  if (!verification.valid) return jsonResponse(res, 401, { success: false, message: 'Incorrect password. Please try again.' });
  if (verification.needsUpgrade && verification.hash) {
    await updateStudentPassword(student.id, verification.hash);
  }

  writeSessionCookie(res, req, STUDENT_SESSION_COOKIE, buildStudentSessionPayload(student));

  jsonResponse(res, 200, {
    success: true,
    session: {
      studentId: student.student_id,
      studentName: student.name,
      yearLevel: student.year_level || '',
      section: student.section || '',
      yearSection: student.year_section || '',
      department: student.department || '',
      program: student.program || '',
      email: student.email,
      loginAt: new Date().toISOString(),
    },
  });
}

async function issueVerification(res, { flow, email, type, meta }) {
  const code = createCode();
  setVerification(flow, email, {
    email,
    code,
    verified: false,
    createdAt: Date.now(),
    expiresAt: Date.now() + TEN_MINUTES,
    meta,
  });
  const delivery = await sendCodeEmail({ email, code, type });
  const deliveryMode = delivery?.delivery || 'smtp';
  jsonResponse(res, 200, {
    success: true,
    ...meta,
    delivery: deliveryMode,
    ...(deliveryMode === 'console' ? { previewCode: code } : {}),
    message: deliveryMode === 'console'
      ? 'Verification code generated in fallback mode. Check the server console or use the preview code shown in the app.'
      : 'Verification code sent successfully.',
  });
}

async function handleProfessorResetRequest(res, body) {
  const email = String(body?.email || '').trim().toLowerCase();
  const admin = await getProfessorByEmail(email);
  if (!admin) return jsonResponse(res, 404, { success: false, message: 'No professor account found with that email address.' });
  await issueVerification(res, {
    flow: 'admin-reset',
    email,
    type: 'admin-reset',
    meta: { username: admin.username, adminId: admin.id },
  });
}

async function handleStudentVerificationRequest(res, body) {
  const email = String(body?.email || '').trim().toLowerCase();
  if (!email.endsWith('@plpasig.edu.ph')) {
    return jsonResponse(res, 400, { success: false, message: 'Only @plpasig.edu.ph email addresses are allowed.' });
  }
  const studentStatus = await checkStudentEmailStatus(email);
  await issueVerification(res, {
    flow: 'student-verification',
    email,
    type: 'student-verification',
    meta: {
      hasPassword: !!studentStatus.hasPassword,
      needsSetup: !!studentStatus.needsSetup || !studentStatus.exists,
    },
  });
}

async function handleStudentResetRequest(res, body) {
  const email = String(body?.email || '').trim().toLowerCase();
  const student = await getStudentByEmail(email);
  if (!student || !student.password) {
    return jsonResponse(res, 404, { success: false, message: 'No existing student account found with that email address.' });
  }
  await issueVerification(res, {
    flow: 'student-reset',
    email,
    type: 'student-reset',
    meta: { studentId: student.id },
  });
}

async function verifyCode(res, { flow, email, code }) {
  const pending = getVerification(flow, email);
  if (!pending) {
    return jsonResponse(res, 400, { success: false, message: 'Verification session not found or has expired. Please request a new code.' });
  }
  if (String(code || '').trim() !== pending.code) {
    return jsonResponse(res, 400, { success: false, message: 'Incorrect verification code. Please try again.' });
  }
  setVerification(flow, email, { ...pending, verified: true, verifiedAt: Date.now() });
  jsonResponse(res, 200, { success: true, ...(pending.meta || {}) });
}

async function completeProfessorReset(res, body) {
  const email = String(body?.email || '').trim().toLowerCase();
  const password = String(body?.password || '');
  const pending = getVerification('admin-reset', email);
  if (!pending || !pending.verified) {
    return jsonResponse(res, 400, { success: false, message: 'Please verify the 6-digit code first.' });
  }
  if (password.length < 6) {
    return jsonResponse(res, 400, { success: false, message: 'Password must be at least 6 characters.' });
  }
  const admin = await getProfessorByEmail(email);
  if (!admin) return jsonResponse(res, 404, { success: false, message: 'Professor account not found.' });

  await updateProfessorPassword(admin.id, await hashPassword(password));
  clearVerification('admin-reset', email);
  jsonResponse(res, 200, { success: true, username: admin.username });
}

async function completeStudentReset(res, body) {
  const email = String(body?.email || '').trim().toLowerCase();
  const password = String(body?.password || '');
  const pending = getVerification('student-reset', email);
  if (!pending || !pending.verified) {
    return jsonResponse(res, 400, { success: false, message: 'Please verify the 6-digit code first.' });
  }
  if (password.length < 6) {
    return jsonResponse(res, 400, { success: false, message: 'Password must be at least 6 characters.' });
  }
  const student = await getStudentByEmail(email);
  if (!student) return jsonResponse(res, 404, { success: false, message: 'Student account not found.' });

  await updateStudentPassword(student.id, await hashPassword(password));
  clearVerification('student-reset', email);
  jsonResponse(res, 200, { success: true });
}

async function handleStudentSetup(req, res, body) {
  const email = String(body?.email || '').trim().toLowerCase();
  const pending = getVerification('student-verification', email);
  if (!pending || !pending.verified) {
    return jsonResponse(res, 400, { success: false, message: 'Please verify your email first.' });
  }
  if (String(body?.password || '').length < 6) {
    return jsonResponse(res, 400, { success: false, message: 'Password must be at least 6 characters.' });
  }
  const result = await saveStudentSetup(body);
  if (!result.success) return jsonResponse(res, 400, result);
  const student = await getStudentByStudentId(result.session?.studentId);
  if (student) {
    writeSessionCookie(res, req, STUDENT_SESSION_COOKIE, buildStudentSessionPayload(student));
  }
  clearVerification('student-verification', email);
  jsonResponse(res, 200, result);
}

async function handleProfessorVerify(req, res, body) {
  const session = await getCurrentProfessorSession(req);
  if (!session || session.id !== body?.id) return forbid(res);
  const admin = await getProfessorById(body?.id);
  if (!admin) return jsonResponse(res, 404, { success: false, message: 'Professor account not found.' });
  const verification = await verifyPassword(String(body?.password || ''), admin.password);
  if (verification.valid && verification.needsUpgrade && verification.hash) {
    await updateProfessorPassword(admin.id, verification.hash);
  }
  jsonResponse(res, 200, { success: verification.valid });
}

async function handleStudentVerify(req, res, body) {
  const session = await getCurrentStudentSession(req);
  if (!session || session.studentId !== body?.studentId) return forbid(res);
  const student = await getStudentByStudentId(body?.studentId || '');
  if (!student) return jsonResponse(res, 404, { success: false, message: 'Student account not found.' });
  const verification = await verifyPassword(String(body?.password || ''), student.password);
  if (verification.valid && verification.needsUpgrade && verification.hash) {
    await updateStudentPassword(student.id, verification.hash);
  }
  jsonResponse(res, 200, { success: verification.valid });
}

async function handleSysAdminVerify(req, res, body) {
  const session = await getCurrentSysAdminSession(req);
  if (!session) return forbid(res);
  const sysAdmin = await getSysAdminRow();
  if (!sysAdmin) return jsonResponse(res, 404, { success: false, message: 'System administrator account not found.' });
  const verification = await verifyPassword(String(body?.password || ''), sysAdmin.password);
  if (verification.valid && verification.needsUpgrade && verification.hash) {
    await updateSysAdminPassword(verification.hash);
  }
  jsonResponse(res, 200, { success: verification.valid });
}

async function handleProfessorChangePassword(req, res, body) {
  const session = await getCurrentProfessorSession(req);
  if (!session || session.id !== body?.id) return forbid(res);
  const admin = await getProfessorById(body?.id);
  if (!admin) return jsonResponse(res, 404, { success: false, message: 'Professor account not found.' });
  const currentPassword = String(body?.currentPassword || '');
  const newPassword = String(body?.newPassword || '');
  if (newPassword.length < 6) return jsonResponse(res, 400, { success: false, message: 'Password must be at least 6 characters.' });
  const verification = await verifyPassword(currentPassword, admin.password);
  if (!verification.valid) return jsonResponse(res, 400, { success: false, message: 'Current password is incorrect.' });
  await updateProfessorPassword(admin.id, await hashPassword(newPassword));
  jsonResponse(res, 200, { success: true });
}

async function handleStudentChangePassword(req, res, body) {
  const session = await getCurrentStudentSession(req);
  if (!session || session.studentId !== body?.studentId) return forbid(res);
  const student = await getStudentByStudentId(body?.studentId || '');
  if (!student) return jsonResponse(res, 404, { success: false, message: 'Student account not found.' });
  const currentPassword = String(body?.currentPassword || '');
  const newPassword = String(body?.newPassword || '');
  if (newPassword.length < 6) return jsonResponse(res, 400, { success: false, message: 'Password must be at least 6 characters.' });
  const verification = await verifyPassword(currentPassword, student.password);
  if (!verification.valid) return jsonResponse(res, 400, { success: false, message: 'Current password is incorrect.' });
  await updateStudentPassword(student.id, await hashPassword(newPassword));
  jsonResponse(res, 200, { success: true });
}

async function handleSysAdminChangePassword(req, res, body) {
  const session = await getCurrentSysAdminSession(req);
  if (!session) return forbid(res);
  const sysAdmin = await getSysAdminRow();
  if (!sysAdmin) return jsonResponse(res, 404, { success: false, message: 'System administrator account not found.' });
  const currentPassword = String(body?.currentPassword || '');
  const newPassword = String(body?.newPassword || '');
  if (newPassword.length < 6) return jsonResponse(res, 400, { success: false, message: 'Password must be at least 6 characters.' });
  const verification = await verifyPassword(currentPassword, sysAdmin.password);
  if (!verification.valid) return jsonResponse(res, 400, { success: false, message: 'Current password is incorrect.' });
  await updateSysAdminPassword(await hashPassword(newPassword));
  jsonResponse(res, 200, { success: true });
}

async function handleProfessorSave(req, res, body) {
  const session = await getCurrentSysAdminSession(req);
  if (!session) return forbid(res);
  const name = String(body?.name || '').trim();
  const username = String(body?.username || '').trim().toLowerCase();
  const email = String(body?.email || '').trim().toLowerCase();
  const password = String(body?.password || '');

  if (!name) return jsonResponse(res, 400, { success: false, message: 'Full name is required.' });
  if (!username) return jsonResponse(res, 400, { success: false, message: 'Username is required.' });
  if (!/^[a-z0-9_.-]{3,30}$/.test(username)) {
    return jsonResponse(res, 400, { success: false, message: 'Username must be 3-30 characters (letters, numbers, _ . -).' });
  }
  if (!body?.id && !password) return jsonResponse(res, 400, { success: false, message: 'Password is required.' });
  if (password && password.length < 6) return jsonResponse(res, 400, { success: false, message: 'Password must be at least 6 characters.' });

  const result = await saveProfessor({
    id: body?.id || null,
    name,
    username,
    email,
    password: password || null,
  });
  jsonResponse(res, result.success ? 200 : 400, result);
}

async function handleProfessorDelete(req, res, body) {
  const session = await getCurrentSysAdminSession(req);
  if (!session) return forbid(res);
  const id = String(body?.id || '').trim();
  if (!id) return jsonResponse(res, 400, { success: false, message: 'Professor id is required.' });
  const result = await deleteProfessor(id);
  jsonResponse(res, result.success ? 200 : 400, result);
}

async function handleProfessorSession(req, res) {
  const admin = await getCurrentProfessorSession(req);
  if (!admin) return forbid(res);
  try {
    await recoverProfessorOwnership(admin);
  } catch (error) {
    console.warn('[auth-route] recoverProfessorOwnership during session:', error.message || error);
  }
  jsonResponse(res, 200, {
    success: true,
    admin: {
      ...admin,
      loginAt: new Date().toISOString(),
    },
  });
}

async function handleStudentSession(req, res) {
  const student = await getCurrentStudentSession(req);
  if (!student) return forbid(res);
  jsonResponse(res, 200, {
    success: true,
    session: {
      studentId: student.studentId,
      studentName: student.name,
      yearLevel: student.yearLevel || '',
      section: student.section || '',
      yearSection: student.yearSection || '',
      department: student.department || '',
      program: student.program || '',
      email: student.email || '',
      loginAt: new Date().toISOString(),
    },
  });
}

async function handleSysAdminSession(req, res) {
  const session = await getCurrentSysAdminSession(req);
  if (!session) return forbid(res);
  jsonResponse(res, 200, {
    success: true,
    session: {
      username: session.username,
      name: session.name || 'System Administrator',
      email: session.email || '',
      department: session.department || '',
      loginAt: new Date().toISOString(),
    },
  });
}

function handleLogout(req, res, cookieName) {
  clearSessionCookie(res, req, cookieName);
  jsonResponse(res, 200, { success: true });
}

async function handleSysAdminProfileSave(req, res, body) {
  const session = await getCurrentSysAdminSession(req);
  if (!session) return forbid(res);
  const result = await saveSysAdminProfile(body || {});
  jsonResponse(res, result.success ? 200 : 400, result);
}

async function handleSettingsSave(req, res, body) {
  const session = await getCurrentSysAdminSession(req);
  if (!session) return forbid(res);
  const result = await saveSettings(body || {});
  jsonResponse(res, result.success ? 200 : 400, result);
}

async function handleAuthRoute(req, res) {
  if (req.method !== 'POST') {
    jsonResponse(res, 405, { success: false, message: 'Method not allowed.' });
    return true;
  }

  let body;
  try {
    body = await readJsonBody(req);
  } catch {
    jsonResponse(res, 400, { success: false, message: 'Invalid JSON body.' });
    return true;
  }

  const pathname = new URL(req.url, `http://${req.headers.host}`).pathname;

  try {
    switch (pathname) {
      case '/api/auth/professor/login': await handleProfessorLogin(req, res, body); return true;
      case '/api/auth/sysadmin/login': await handleSysAdminLogin(req, res, body); return true;
      case '/api/auth/student/status': await handleStudentStatus(res, body); return true;
      case '/api/auth/student/login': await handleStudentLogin(req, res, body); return true;
      case '/api/auth/professor/reset/request': await handleProfessorResetRequest(res, body); return true;
      case '/api/auth/professor/reset/verify': await verifyCode(res, { flow: 'admin-reset', email: body?.email, code: body?.code }); return true;
      case '/api/auth/professor/reset/complete': await completeProfessorReset(res, body); return true;
      case '/api/auth/student/verification/request': await handleStudentVerificationRequest(res, body); return true;
      case '/api/auth/student/verification/verify': await verifyCode(res, { flow: 'student-verification', email: body?.email, code: body?.code }); return true;
      case '/api/auth/student/reset/request': await handleStudentResetRequest(res, body); return true;
      case '/api/auth/student/reset/verify': await verifyCode(res, { flow: 'student-reset', email: body?.email, code: body?.code }); return true;
      case '/api/auth/student/reset/complete': await completeStudentReset(res, body); return true;
      case '/api/auth/student/setup': await handleStudentSetup(req, res, body); return true;
      case '/api/auth/professor/session': await handleProfessorSession(req, res); return true;
      case '/api/auth/student/session': await handleStudentSession(req, res); return true;
      case '/api/auth/sysadmin/session': await handleSysAdminSession(req, res); return true;
      case '/api/auth/professor/logout': handleLogout(req, res, ADMIN_SESSION_COOKIE); return true;
      case '/api/auth/student/logout': handleLogout(req, res, STUDENT_SESSION_COOKIE); return true;
      case '/api/auth/sysadmin/logout': handleLogout(req, res, SYSADMIN_SESSION_COOKIE); return true;
      case '/api/auth/professor/verify': await handleProfessorVerify(req, res, body); return true;
      case '/api/auth/student/verify': await handleStudentVerify(req, res, body); return true;
      case '/api/auth/sysadmin/verify': await handleSysAdminVerify(req, res, body); return true;
      case '/api/auth/professor/change-password': await handleProfessorChangePassword(req, res, body); return true;
      case '/api/auth/student/change-password': await handleStudentChangePassword(req, res, body); return true;
      case '/api/auth/sysadmin/change-password': await handleSysAdminChangePassword(req, res, body); return true;
      case '/api/auth/sysadmin/profile/save': await handleSysAdminProfileSave(req, res, body); return true;
      case '/api/auth/settings/save': await handleSettingsSave(req, res, body); return true;
      case '/api/auth/professor/save': await handleProfessorSave(req, res, body); return true;
      case '/api/auth/professor/delete': await handleProfessorDelete(req, res, body); return true;
      default: return false;
    }
  } catch (error) {
    const message = error?.code === 'AUTH_DB_CONFIG_MISSING'
      ? error.message
      : (error instanceof Error ? error.message : 'Unable to process authentication request.');
    jsonResponse(res, 500, { success: false, message });
    return true;
  }
}

module.exports = {
  handleAuthRoute,
};

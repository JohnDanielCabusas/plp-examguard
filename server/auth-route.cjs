const { sendVerificationEmail } = require('./email-service.cjs');
const {
  createCode,
  ensureDefaultAuthRecords,
  normalizeProfessor,
  normalizeStudent,
  normalizeSysAdmin,
  hashPassword,
  verifyPassword,
  getProfessorByUsername,
  getProfessorByEmail,
  getProfessorById,
  updateProfessorPassword,
  saveProfessor,
  deleteProfessor,
  getSysAdminRow,
  updateSysAdminPassword,
  getStudentByEmail,
  getStudentByStudentId,
  updateStudentPassword,
  checkStudentEmailStatus,
  saveStudentSetup,
} = require('./auth-service.cjs');

const verificationStore = new Map();
const TEN_MINUTES = 10 * 60 * 1000;

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

async function handleProfessorLogin(res, body) {
  const username = String(body?.username || '').trim();
  const password = String(body?.password || '');
  const admin = await getProfessorByUsername(username);
  if (!admin) return jsonResponse(res, 401, { success: false, message: 'Invalid username or password.' });

  const verification = await verifyPassword(password, admin.password);
  if (!verification.valid) return jsonResponse(res, 401, { success: false, message: 'Invalid username or password.' });
  if (verification.needsUpgrade && verification.hash) {
    await updateProfessorPassword(admin.id, verification.hash);
  }

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

async function handleSysAdminLogin(res, body) {
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

async function handleStudentLogin(res, body) {
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

async function handleStudentSetup(res, body) {
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
  clearVerification('student-verification', email);
  jsonResponse(res, 200, result);
}

async function handleProfessorVerify(res, body) {
  const admin = await getProfessorById(body?.id);
  if (!admin) return jsonResponse(res, 404, { success: false, message: 'Professor account not found.' });
  const verification = await verifyPassword(String(body?.password || ''), admin.password);
  if (verification.valid && verification.needsUpgrade && verification.hash) {
    await updateProfessorPassword(admin.id, verification.hash);
  }
  jsonResponse(res, 200, { success: verification.valid });
}

async function handleStudentVerify(res, body) {
  const student = await getStudentByStudentId(body?.studentId || '');
  if (!student) return jsonResponse(res, 404, { success: false, message: 'Student account not found.' });
  const verification = await verifyPassword(String(body?.password || ''), student.password);
  if (verification.valid && verification.needsUpgrade && verification.hash) {
    await updateStudentPassword(student.id, verification.hash);
  }
  jsonResponse(res, 200, { success: verification.valid });
}

async function handleSysAdminVerify(res, body) {
  const sysAdmin = await getSysAdminRow();
  if (!sysAdmin) return jsonResponse(res, 404, { success: false, message: 'System administrator account not found.' });
  const verification = await verifyPassword(String(body?.password || ''), sysAdmin.password);
  if (verification.valid && verification.needsUpgrade && verification.hash) {
    await updateSysAdminPassword(verification.hash);
  }
  jsonResponse(res, 200, { success: verification.valid });
}

async function handleProfessorChangePassword(res, body) {
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

async function handleStudentChangePassword(res, body) {
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

async function handleSysAdminChangePassword(res, body) {
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

async function handleProfessorSave(res, body) {
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

async function handleProfessorDelete(res, body) {
  const id = String(body?.id || '').trim();
  if (!id) return jsonResponse(res, 400, { success: false, message: 'Professor id is required.' });
  const result = await deleteProfessor(id);
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
    await ensureDefaultAuthRecords();
    switch (pathname) {
      case '/api/auth/professor/login': await handleProfessorLogin(res, body); return true;
      case '/api/auth/sysadmin/login': await handleSysAdminLogin(res, body); return true;
      case '/api/auth/student/status': await handleStudentStatus(res, body); return true;
      case '/api/auth/student/login': await handleStudentLogin(res, body); return true;
      case '/api/auth/professor/reset/request': await handleProfessorResetRequest(res, body); return true;
      case '/api/auth/professor/reset/verify': await verifyCode(res, { flow: 'admin-reset', email: body?.email, code: body?.code }); return true;
      case '/api/auth/professor/reset/complete': await completeProfessorReset(res, body); return true;
      case '/api/auth/student/verification/request': await handleStudentVerificationRequest(res, body); return true;
      case '/api/auth/student/verification/verify': await verifyCode(res, { flow: 'student-verification', email: body?.email, code: body?.code }); return true;
      case '/api/auth/student/reset/request': await handleStudentResetRequest(res, body); return true;
      case '/api/auth/student/reset/verify': await verifyCode(res, { flow: 'student-reset', email: body?.email, code: body?.code }); return true;
      case '/api/auth/student/reset/complete': await completeStudentReset(res, body); return true;
      case '/api/auth/student/setup': await handleStudentSetup(res, body); return true;
      case '/api/auth/professor/verify': await handleProfessorVerify(res, body); return true;
      case '/api/auth/student/verify': await handleStudentVerify(res, body); return true;
      case '/api/auth/sysadmin/verify': await handleSysAdminVerify(res, body); return true;
      case '/api/auth/professor/change-password': await handleProfessorChangePassword(res, body); return true;
      case '/api/auth/student/change-password': await handleStudentChangePassword(res, body); return true;
      case '/api/auth/sysadmin/change-password': await handleSysAdminChangePassword(res, body); return true;
      case '/api/auth/professor/save': await handleProfessorSave(res, body); return true;
      case '/api/auth/professor/delete': await handleProfessorDelete(res, body); return true;
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

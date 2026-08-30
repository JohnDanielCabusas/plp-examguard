const crypto = require('crypto');
const { promisify } = require('util');
const { getPool, query } = require('./db.cjs');

const pbkdf2 = promisify(crypto.pbkdf2);

const PASSWORD_PREFIX = 'pbkdf2_sha256';
const PASSWORD_ITERATIONS = 210000;
const PASSWORD_KEY_LENGTH = 32;
const PASSWORD_DIGEST = 'sha256';
const DEFAULT_SYSADMIN_PASSWORD = String(process.env.AUTH_DEFAULT_SYSADMIN_PASSWORD || 'admin123');
const DEFAULT_PROFESSOR_PASSWORD = String(process.env.AUTH_DEFAULT_PROFESSOR_PASSWORD || 'admin123');
const DEFAULT_PASSWORD_USERNAME = String(process.env.AUTH_DEFAULT_PROFESSOR_USERNAME || 'admin').trim().toLowerCase();
const DEFAULT_PASSWORD_EMAIL = String(process.env.AUTH_DEFAULT_PROFESSOR_EMAIL || 'admin@school.edu').trim().toLowerCase();
const ACTIVITY_LOG_RETENTION_DAYS = 15;
const PROFESSOR_OWNED_TABLES = ['students', 'subjects', 'exams', 'sessions', 'logs'];

function createId() {
  return crypto.randomUUID ? crypto.randomUUID() : `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
}

function createCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function normalizeProfessor(row) {
  if (!row) return null;
  return {
    id: row.id,
    username: row.username || '',
    name: row.name,
    email: row.email || '',
    department: row.department || '',
    createdAt: row.created_at || null,
  };
}

function normalizeStudent(row) {
  if (!row) return null;
  return {
    id: row.id,
    studentId: row.student_id,
    name: row.name,
    email: row.email || '',
    yearLevel: row.year_level || '',
    section: row.section || '',
    yearSection: row.year_section || '',
    department: row.department || '',
    program: row.program || '',
    enrolledSubjects: Array.isArray(row.enrolled_subjects) ? row.enrolled_subjects : [],
    ownerAdminId: row.owner_admin_id || '',
    archived: !!row.archived,
    archivedAt: row.archived_at || null,
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
  };
}

function normalizeSysAdmin(row) {
  if (!row) return null;
  return {
    username: row.username,
    name: row.name || 'System Administrator',
    email: row.email || '',
    department: row.department || '',
  };
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const derived = await pbkdf2(String(password || ''), salt, PASSWORD_ITERATIONS, PASSWORD_KEY_LENGTH, PASSWORD_DIGEST);
  return `${PASSWORD_PREFIX}$${PASSWORD_ITERATIONS}$${salt.toString('base64')}$${derived.toString('base64')}`;
}

async function verifyPassword(password, storedValue) {
  const plain = String(password || '');
  const stored = String(storedValue || '');
  if (!plain || !stored) return { valid: false, needsUpgrade: false, hash: null };

  if (!stored.startsWith(`${PASSWORD_PREFIX}$`)) {
    const valid = stored === plain;
    return {
      valid,
      needsUpgrade: valid,
      hash: valid ? await hashPassword(plain) : null,
    };
  }

  const parts = stored.split('$');
  if (parts.length !== 4) return { valid: false, needsUpgrade: false, hash: null };

  const [, iterationsRaw, saltBase64, hashBase64] = parts;
  const iterations = Number.parseInt(iterationsRaw, 10);
  if (!Number.isFinite(iterations) || iterations <= 0) {
    return { valid: false, needsUpgrade: false, hash: null };
  }

  const salt = Buffer.from(saltBase64, 'base64');
  const expectedHash = Buffer.from(hashBase64, 'base64');
  const actualHash = await pbkdf2(plain, salt, iterations, expectedHash.length, PASSWORD_DIGEST);
  const valid = actualHash.length === expectedHash.length && crypto.timingSafeEqual(actualHash, expectedHash);
  const needsUpgrade = valid && (iterations !== PASSWORD_ITERATIONS || expectedHash.length !== PASSWORD_KEY_LENGTH);

  return {
    valid,
    needsUpgrade,
    hash: needsUpgrade ? await hashPassword(plain) : null,
  };
}

async function ensureRowPassword(table, idColumn, idValue, row, fallbackPassword) {
  if (!row) return null;
  const storedPassword = String(row.password || '');
  if (!storedPassword) {
    const passwordHash = await hashPassword(fallbackPassword);
    await query(`update public.${table} set password = $2 where ${idColumn} = $1`, [idValue, passwordHash]);
    return { ...row, password: passwordHash };
  }

  if (!storedPassword.startsWith(`${PASSWORD_PREFIX}$`)) {
    const passwordHash = await hashPassword(storedPassword);
    await query(`update public.${table} set password = $2 where ${idColumn} = $1`, [idValue, passwordHash]);
    return { ...row, password: passwordHash };
  }

  return row;
}

async function ensureDefaultAuthRecords() {
  let sysAdmin = await getSysAdminRow();
  if (!sysAdmin) {
    const sysAdminResult = await query(
      `insert into public.superadmin (id, username, password, name, email, department)
       values ('main', 'sysadmin', $1, 'System Administrator', 'sysadmin@school.edu', null)
       returning id, username, password, name, email, department`,
      [await hashPassword(DEFAULT_SYSADMIN_PASSWORD)],
    );
    sysAdmin = sysAdminResult.rows[0] || null;
  }
  sysAdmin = await ensureRowPassword('superadmin', 'id', 'main', sysAdmin, DEFAULT_SYSADMIN_PASSWORD);

  let defaultProfessor = await getProfessorById('admin1');
  if (!defaultProfessor) {
    const professorResult = await query(
      `insert into public.professors (id, username, password, name, email, department)
       values ('admin1', $1, $2, 'Administrator', $3, null)
       returning id, username, password, name, email, department, created_at`,
      [DEFAULT_PASSWORD_USERNAME, await hashPassword(DEFAULT_PROFESSOR_PASSWORD), DEFAULT_PASSWORD_EMAIL],
    );
    defaultProfessor = professorResult.rows[0] || null;
  }
  defaultProfessor = await ensureRowPassword('professors', 'id', 'admin1', defaultProfessor, DEFAULT_PROFESSOR_PASSWORD);

  return {
    sysAdmin,
    defaultProfessor,
  };
}

async function getProfessorByUsername(username) {
  const { rows } = await query(
    `select id, username, password, name, email, department, created_at
       from public.professors
      where lower(username) = lower($1)
      limit 1`,
    [String(username || '').trim()],
  );
  return rows[0] || null;
}

async function getProfessorByEmail(email) {
  const { rows } = await query(
    `select id, username, password, name, email, department, created_at
       from public.professors
      where lower(email) = lower($1)
      limit 1`,
    [String(email || '').trim().toLowerCase()],
  );
  return rows[0] || null;
}

async function getProfessorById(id) {
  const { rows } = await query(
    `select id, username, password, name, email, department, created_at
       from public.professors
      where id = $1
      limit 1`,
    [id],
  );
  return rows[0] || null;
}

async function getProfessorPublicById(id) {
  const row = await getProfessorById(id);
  return normalizeProfessor(row);
}

async function checkProfessorEmailStatus(email) {
  const professor = await getProfessorByEmail(email);
  if (!professor) {
    return {
      exists: false,
      hasCredentials: false,
      needsSetup: false,
    };
  }

  const hasUsername = !!String(professor.username || '').trim();
  const hasPassword = !!String(professor.password || '').trim();

  return {
    exists: true,
    hasCredentials: hasUsername && hasPassword,
    needsSetup: !hasUsername || !hasPassword,
  };
}

async function updateProfessorPassword(id, passwordHash) {
  await query('update public.professors set password = $2 where id = $1', [id, passwordHash]);
}

async function completeProfessorSetup({ id, username, password }) {
  const professor = await getProfessorById(id);
  if (!professor) return { success: false, message: 'Professor account not found.' };

  const existingUsername = String(professor.username || '').trim().toLowerCase();
  const normalizedUsername = String(username || '').trim().toLowerCase();
  const normalizedPassword = String(password || '');
  const usernameToSave = existingUsername || normalizedUsername;

  if (!usernameToSave) {
    return { success: false, message: 'Username is required.' };
  }
  if (!/^[a-z0-9_.-]{3,30}$/.test(usernameToSave)) {
    return { success: false, message: 'Username must be 3-30 characters (letters, numbers, _ . -).' };
  }
  if (existingUsername && normalizedUsername && existingUsername !== normalizedUsername) {
    return { success: false, message: 'This account already has a different username configured.' };
  }
  if (normalizedPassword.length < 6) {
    return { success: false, message: 'Password must be at least 6 characters.' };
  }

  const duplicateUsername = await query(
    `select id from public.professors where lower(username) = lower($1) and id <> $2 limit 1`,
    [usernameToSave, id],
  );
  if (duplicateUsername.rows[0]) {
    return { success: false, message: 'Username already exists.' };
  }

  const { rows } = await query(
    `update public.professors
        set username = $1,
            password = $2
      where id = $3
      returning id, username, name, email, department, created_at`,
    [usernameToSave, await hashPassword(normalizedPassword), id],
  );
  if (!rows[0]) return { success: false, message: 'Professor account not found.' };

  const updatedProfessor = normalizeProfessor(rows[0]);
  await logProfessorActivity('account_setup_completed', updatedProfessor, {
    entityType: 'professor',
    entityName: updatedProfessor.name,
  });
  return { success: true, professor: updatedProfessor };
}

async function logProfessorActivity(action, professor, { details = null, entityType = null, entityName = null } = {}) {
  try {
    await query(
      `insert into public.professor_activity_log (id, professor_id, professor_name, action, entity_type, entity_name, details)
       values ($1, $2, $3, $4, $5, $6, $7)`,
      [createId(), professor?.id || null, professor?.name || professor?.username || 'Unknown', action, entityType, entityName, details],
    );
  } catch (error) {
    console.error('[auth-service] logProfessorActivity failed:', error.message || error);
  }
}

// Keeps professor_activity_log from growing without bound — drops entries
// past the retention window. Called on server startup and on an interval
// (see server.js); safe to call as often as needed since it's a no-op when
// there's nothing to delete.
async function cleanupProfessorActivityLog() {
  try {
    const { rowCount } = await query(
      `delete from public.professor_activity_log where created_at < now() - interval '${ACTIVITY_LOG_RETENTION_DAYS} days'`,
    );
    if (rowCount) {
      console.log(`[auth-service] cleanupProfessorActivityLog: removed ${rowCount} entr${rowCount === 1 ? 'y' : 'ies'} older than ${ACTIVITY_LOG_RETENTION_DAYS} days.`);
    }
  } catch (error) {
    console.error('[auth-service] cleanupProfessorActivityLog failed:', error.message || error);
  }
}

async function saveProfessor({ id, name, username, email, password }) {
  const normalizedUsername = String(username || '').trim().toLowerCase();
  const normalizedEmail = String(email || '').trim().toLowerCase() || null;
  const normalizedName = String(name || '').trim();

  if (normalizedUsername) {
    const duplicateUsername = await query(
      `select id from public.professors where lower(username) = lower($1) and ($2::text is null or id <> $2) limit 1`,
      [normalizedUsername, id || null],
    );
    if (duplicateUsername.rows[0]) {
      return { success: false, message: 'Username already exists.' };
    }
  }

  if (normalizedEmail) {
    const duplicateEmail = await query(
      `select id from public.professors where lower(email) = lower($1) and ($2::text is null or id <> $2) limit 1`,
      [normalizedEmail, id || null],
    );
    if (duplicateEmail.rows[0]) {
      return { success: false, message: 'That email is already assigned to another professor. Duplicate emails are not allowed.' };
    }
  }

  if (id) {
    const updates = [normalizedName, normalizedEmail];
    let nextParamIndex = 3;
    let sql = `
      update public.professors
         set name = $1,
             email = $2`;
    if (normalizedUsername) {
      updates.push(normalizedUsername);
      sql += `,
             username = $${nextParamIndex}`;
      nextParamIndex += 1;
    }
    if (password) {
      updates.push(await hashPassword(password));
      sql += `,
             password = $${nextParamIndex}`;
      nextParamIndex += 1;
    }
    updates.push(id);
    sql += `
       where id = $${nextParamIndex}
       returning id, username, name, email, department, created_at`;
    const { rows } = await query(sql, updates);
    if (!rows[0]) return { success: false, message: 'Professor account not found.' };
    const professor = normalizeProfessor(rows[0]);
    await logProfessorActivity('account_updated', professor, { entityType: 'professor', entityName: professor.name });
    return { success: true, professor };
  }

  const { rows } = await query(
    `insert into public.professors (id, username, password, name, email)
     values ($1, $2, $3, $4, $5)
     returning id, username, name, email, department, created_at`,
    [
      createId(),
      normalizedUsername || null,
      password ? await hashPassword(password) : null,
      normalizedName,
      normalizedEmail,
    ],
  );
  const professor = normalizeProfessor(rows[0]);
  await logProfessorActivity('account_created', professor, { entityType: 'professor', entityName: professor.name });
  return { success: true, professor };
}

async function deleteProfessor(id) {
  if (!id) return { success: false, message: 'Professor id is required.' };
  const { rows } = await query(
    `delete from public.professors where id = $1 returning id, username, name, email, department, created_at`,
    [id],
  );
  if (!rows[0]) return { success: false, message: 'Professor account not found.' };
  const professor = normalizeProfessor(rows[0]);
  await logProfessorActivity('account_deleted', professor, { entityType: 'professor', entityName: professor.name });
  return { success: true };
}

async function countProfessorOwnedRows(executor, table, ownerId) {
  const { rows } = await executor(
    `select count(*)::int as count from public.${table} where owner_admin_id = $1`,
    [ownerId],
  );
  return Number(rows[0]?.count || 0);
}

async function getDeletedProfessorOwnerCandidates(professor) {
  const professorName = String(professor?.name || '').trim();
  if (!professor?.id || !professorName) return [];

  try {
    const { rows } = await query(
      `select distinct professor_id
         from public.professor_activity_log
        where professor_id is not null
          and professor_id <> $1
          and action = 'account_deleted'
          and lower(professor_name) = lower($2)`,
      [professor.id, professorName],
    );
    return rows
      .map(row => String(row.professor_id || '').trim())
      .filter(Boolean);
  } catch (error) {
    if (error?.code !== '42P01') {
      console.warn('[auth-service] getDeletedProfessorOwnerCandidates:', error.message || error);
    }
    return [];
  }
}

async function recoverProfessorOwnership(professor) {
  if (!professor?.id) return { recovered: false, reason: 'missing_professor' };

  const candidates = await getDeletedProfessorOwnerCandidates(professor);
  if (!candidates.length) return { recovered: false, reason: 'no_candidates' };

  const recoverable = [];
  for (const candidateId of candidates) {
    const existingProfessor = await getProfessorById(candidateId);
    if (existingProfessor) continue;

    let ownedRowCount = 0;
    for (const table of PROFESSOR_OWNED_TABLES) {
      ownedRowCount += await countProfessorOwnedRows(query, table, candidateId);
    }
    if (ownedRowCount > 0) recoverable.push({ candidateId, ownedRowCount });
  }

  if (recoverable.length !== 1) {
    return {
      recovered: false,
      reason: recoverable.length ? 'ambiguous_candidates' : 'no_orphaned_rows',
    };
  }

  const [{ candidateId }] = recoverable;
  const client = await getPool().connect();

  try {
    await client.query('begin');
    const migratedCounts = {};

    for (const table of PROFESSOR_OWNED_TABLES) {
      const result = await client.query(
        `update public.${table}
            set owner_admin_id = $2
          where owner_admin_id = $1`,
        [candidateId, professor.id],
      );
      migratedCounts[table] = result.rowCount || 0;
    }

    await client.query('commit');
    return { recovered: true, fromOwnerId: candidateId, migratedCounts };
  } catch (error) {
    try {
      await client.query('rollback');
    } catch (_) {
      // Ignore rollback errors so we can surface the original failure.
    }
    throw error;
  } finally {
    client.release();
  }
}

async function getSysAdminRow() {
  const { rows } = await query(
    `select id, username, password, name, email, department
       from public.superadmin
      where id = 'main'
      limit 1`,
  );
  return rows[0] || null;
}

async function saveSysAdminProfile({ username, name, email, department }) {
  const normalizedUsername = String(username || '').trim().toLowerCase();
  const normalizedName = String(name || '').trim();
  const normalizedEmail = String(email || '').trim().toLowerCase() || null;
  const normalizedDepartment = String(department || '').trim() || null;

  if (!normalizedUsername) return { success: false, message: 'Username is required.' };
  if (!normalizedName) return { success: false, message: 'Administrator name is required.' };
  if (!/^[a-z0-9_.-]{3,30}$/.test(normalizedUsername)) {
    return { success: false, message: 'Username must be 3-30 characters (letters, numbers, _ . -).' };
  }

  const { rows } = await query(
    `update public.superadmin
        set username = $1,
            name = $2,
            email = $3,
            department = $4
      where id = 'main'
      returning id, username, name, email, department`,
    [normalizedUsername, normalizedName, normalizedEmail, normalizedDepartment],
  );

  if (!rows[0]) return { success: false, message: 'System administrator account not found.' };
  return { success: true, sysAdmin: normalizeSysAdmin(rows[0]) };
}

async function getSettingsRow() {
  const { rows } = await query(
    `select id, school_name, logo_url, department, admin_name, admin_email, claude_api_key
       from public.settings
      where id = 'main'
      limit 1`,
  );
  return rows[0] || null;
}

function normalizeSettings(row, { includeSensitive = false } = {}) {
  if (!row) return null;
  return {
    schoolName: row.school_name || '',
    logoUrl: row.logo_url || '',
    department: row.department || '',
    adminName: row.admin_name || '',
    adminEmail: row.admin_email || '',
    ...(includeSensitive ? { claudeApiKey: row.claude_api_key || '' } : {}),
  };
}

async function saveSettings({ schoolName, logoUrl, department, adminName, adminEmail }) {
  const normalizedSchoolName = String(schoolName || '').trim();
  const normalizedLogoUrl = String(logoUrl || '').trim() || null;
  const normalizedDepartment = String(department || '').trim() || null;
  const normalizedAdminName = String(adminName || '').trim() || null;
  const normalizedAdminEmail = String(adminEmail || '').trim().toLowerCase() || null;

  if (!normalizedSchoolName) return { success: false, message: 'School / System name is required.' };

  const { rows } = await query(
    `insert into public.settings (id, school_name, logo_url, department, admin_name, admin_email)
     values ('main', $1, $2, $3, $4, $5)
     on conflict (id) do update
       set school_name = excluded.school_name,
           logo_url = excluded.logo_url,
           department = excluded.department,
           admin_name = excluded.admin_name,
           admin_email = excluded.admin_email
     returning id, school_name, logo_url, department, admin_name, admin_email, claude_api_key`,
    [normalizedSchoolName, normalizedLogoUrl, normalizedDepartment, normalizedAdminName, normalizedAdminEmail],
  );

  return { success: true, settings: normalizeSettings(rows[0]) };
}

async function updateSysAdminPassword(passwordHash) {
  await query(`update public.superadmin set password = $1 where id = 'main'`, [passwordHash]);
}

async function getStudentByEmail(email) {
  const { rows } = await query(
    `select id, student_id, name, email, password, year_level, section, year_section, department, program, enrolled_subjects, owner_admin_id, archived, archived_at, created_at, updated_at
       from public.students
      where lower(email) = lower($1)
      limit 1`,
    [String(email || '').trim().toLowerCase()],
  );
  return rows[0] || null;
}

async function getStudentByStudentId(studentId) {
  const { rows } = await query(
    `select id, student_id, name, email, password, year_level, section, year_section, department, program, enrolled_subjects, owner_admin_id, archived, archived_at, created_at, updated_at
       from public.students
      where upper(student_id) = upper($1)
      limit 1`,
    [String(studentId || '').trim().toUpperCase()],
  );
  return rows[0] || null;
}

async function updateStudentPassword(id, passwordHash) {
  await query(`update public.students set password = $2 where id = $1`, [id, passwordHash]);
}

async function checkStudentEmailStatus(email) {
  const student = await getStudentByEmail(email);
  if (!student) return { exists: false };
  if (!student.password) return { exists: true, needsSetup: true };
  return { exists: true, hasPassword: true };
}

async function saveStudentSetup({ email, studentId, password, fullName, yearSection, department, program }) {
  const normalizedEmail = String(email || '').trim().toLowerCase();
  const normalizedStudentId = String(studentId || '').trim().toUpperCase();
  const normalizedName = String(fullName || '').trim();
  const normalizedYearSection = String(yearSection || '').trim().toUpperCase();
  const selectedDepartment = String(department || '').trim();
  const selectedProgram = String(program || '').trim().toUpperCase();
  const yearSectionMatch = normalizedYearSection.match(/^([1-5])-([A-Z])$/);

  if (!yearSectionMatch) return { success: false, message: 'Year & section must use the format 3-B.' };

  const yearMap = { '1': '1st Year', '2': '2nd Year', '3': '3rd Year', '4': '4th Year', '5': '5th Year' };
  const parsedYearLevel = yearMap[yearSectionMatch[1]] || '';
  const parsedSection = `Section ${yearSectionMatch[2]}`;
  const hashedPassword = await hashPassword(password);

  const byEmail = await getStudentByEmail(normalizedEmail);
  if (byEmail?.password) return { success: false, message: 'An account already exists with this email. Please sign in instead.' };

  const byId = await getStudentByStudentId(normalizedStudentId);
  if (byEmail && byId && byEmail.id !== byId.id) {
    return {
      success: false,
      message: 'This Student ID is already assigned to another account. Please contact your professor or admin.',
    };
  }
  if (!byEmail && byId) {
    return {
      success: false,
      message: 'This Student ID is already assigned to another account. Please contact your professor or admin.',
    };
  }
  if (byEmail?.student_id && byEmail.student_id.toUpperCase() !== normalizedStudentId) {
    return {
      success: false,
      message: 'The Student ID does not match the verified email. Please contact your professor or admin.',
    };
  }

  const existingStudent = byEmail || byId;

  let row;
  if (existingStudent) {
    const nextName = normalizedName && (existingStudent.name === existingStudent.student_id || !existingStudent.name)
      ? normalizedName
      : existingStudent.name;
    const { rows } = await query(
      `update public.students
          set email = $1,
              password = $2,
              year_level = $3,
              section = $4,
              year_section = $5,
              department = $6,
              program = $7,
              student_id = coalesce(student_id, $8),
              name = $9
        where id = $10
        returning id, student_id, name, email, year_level, section, year_section, department, program, enrolled_subjects, owner_admin_id, archived, archived_at, created_at, updated_at`,
      [
        normalizedEmail,
        hashedPassword,
        parsedYearLevel,
        parsedSection,
        normalizedYearSection,
        selectedDepartment,
        selectedProgram,
        normalizedStudentId,
        nextName || existingStudent.name || normalizedStudentId,
        existingStudent.id,
      ],
    );
    row = rows[0] || null;
  } else {
    const idMatch = normalizedStudentId.match(/^(\d{2})-\d{5}$/);
    if (!idMatch) return { success: false, message: 'Invalid Student ID format (use YY-NNNNN, e.g. 23-00218).' };

    const { rows } = await query(
      `insert into public.students (
         id, student_id, name, email, password, year_level, section, year_section, department, program, enrolled_subjects, archived, archived_at
       ) values (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, '{}'::jsonb, false, null
       )
       returning id, student_id, name, email, year_level, section, year_section, department, program, enrolled_subjects, owner_admin_id, archived, archived_at, created_at, updated_at`,
      [
        createId(),
        normalizedStudentId,
        normalizedName || normalizedStudentId,
        normalizedEmail,
        hashedPassword,
        parsedYearLevel,
        parsedSection,
        normalizedYearSection,
        selectedDepartment,
        selectedProgram,
      ],
    );
    row = rows[0] || null;
  }

  const student = normalizeStudent(row);
  const session = {
    studentId: student.studentId,
    studentName: student.name,
    yearLevel: student.yearLevel || '',
    section: student.section || '',
    yearSection: student.yearSection || normalizedYearSection,
    department: student.department || selectedDepartment,
    program: student.program || selectedProgram,
    email: normalizedEmail,
    loginAt: new Date().toISOString(),
  };

  return { success: true, session };
}

module.exports = {
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
  getProfessorPublicById,
  checkProfessorEmailStatus,
  completeProfessorSetup,
  updateProfessorPassword,
  logProfessorActivity,
  cleanupProfessorActivityLog,
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
};

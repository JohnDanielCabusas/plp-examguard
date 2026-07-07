const crypto = require('crypto');
const { promisify } = require('util');
const { query } = require('./db.cjs');

const pbkdf2 = promisify(crypto.pbkdf2);

const PASSWORD_PREFIX = 'pbkdf2_sha256';
const PASSWORD_ITERATIONS = 210000;
const PASSWORD_KEY_LENGTH = 32;
const PASSWORD_DIGEST = 'sha256';
const DEFAULT_SYSADMIN_PASSWORD = String(process.env.AUTH_DEFAULT_SYSADMIN_PASSWORD || 'admin123');
const DEFAULT_PROFESSOR_PASSWORD = String(process.env.AUTH_DEFAULT_PROFESSOR_PASSWORD || 'admin123');
const DEFAULT_PASSWORD_USERNAME = String(process.env.AUTH_DEFAULT_PROFESSOR_USERNAME || 'admin').trim().toLowerCase();
const DEFAULT_PASSWORD_EMAIL = String(process.env.AUTH_DEFAULT_PROFESSOR_EMAIL || 'admin@school.edu').trim().toLowerCase();

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
    username: row.username,
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

async function updateProfessorPassword(id, passwordHash) {
  await query('update public.professors set password = $2 where id = $1', [id, passwordHash]);
}

async function saveProfessor({ id, name, username, email, password }) {
  const normalizedUsername = String(username || '').trim().toLowerCase();
  const normalizedEmail = String(email || '').trim().toLowerCase() || null;
  const normalizedName = String(name || '').trim();

  const duplicateUsername = await query(
    `select id from public.professors where lower(username) = lower($1) and ($2::text is null or id <> $2) limit 1`,
    [normalizedUsername, id || null],
  );
  if (duplicateUsername.rows[0]) {
    return { success: false, message: 'Username already exists.' };
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
    const updates = [normalizedUsername, normalizedName, normalizedEmail, id];
    let sql = `
      update public.professors
         set username = $1,
             name = $2,
             email = $3`;
    if (password) {
      updates.splice(3, 0, await hashPassword(password));
      sql += `,
             password = $4
       where id = $5
       returning id, username, name, email, department, created_at`;
    } else {
      sql += `
       where id = $4
       returning id, username, name, email, department, created_at`;
    }
    const { rows } = await query(sql, updates);
    if (!rows[0]) return { success: false, message: 'Professor account not found.' };
    return { success: true, professor: normalizeProfessor(rows[0]) };
  }

  const { rows } = await query(
    `insert into public.professors (id, username, password, name, email)
     values ($1, $2, $3, $4, $5)
     returning id, username, name, email, department, created_at`,
    [createId(), normalizedUsername, await hashPassword(password), normalizedName, normalizedEmail],
  );
  return { success: true, professor: normalizeProfessor(rows[0]) };
}

async function deleteProfessor(id) {
  if (!id) return { success: false, message: 'Professor id is required.' };
  const { rows } = await query(
    `delete from public.professors where id = $1 returning id`,
    [id],
  );
  if (!rows[0]) return { success: false, message: 'Professor account not found.' };
  return { success: true };
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
};

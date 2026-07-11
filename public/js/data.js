// ============================================================
// BODY SCROLL LOCK — shared across admin/exam/super-admin pages
// so an open modal always blocks background scrolling.
// ============================================================
function lockBodyScroll() {
  const count = (parseInt(document.body.dataset.modalOpenCount, 10) || 0) + 1;
  document.body.dataset.modalOpenCount = String(count);
  document.body.style.overflow = 'hidden';
}

function unlockBodyScroll() {
  const count = Math.max(0, (parseInt(document.body.dataset.modalOpenCount, 10) || 0) - 1);
  document.body.dataset.modalOpenCount = String(count);
  if (count === 0) document.body.style.overflow = '';
}

// ============================================================
// DATA LAYER - in-memory cache + Supabase sync
// ============================================================

const DB = {
  KEYS: {
    settings: 'acs_settings',
    admins: 'acs_professors',
    students: 'acs_students',
    subjects: 'acs_subjects',
    exams: 'acs_exams',
    sessions: 'acs_sessions',
    logs: 'acs_logs',
    sysadmin: 'acs_sysadmin',
    professorActivityLog: 'acs_professor_activity_log',
  },
  _cache: {},

  _read(key, fallback) {
    if (Object.prototype.hasOwnProperty.call(this._cache, key)) return this._cache[key];
    this._cache[key] = fallback;
    return this._cache[key];
  },

  _write(key, value) {
    this._cache[key] = value;
    return value;
  },

  clearCacheKey(key) {
    delete this._cache[key];
  },

  clearCache() {
    this._cache = {};
  },

  _getCurrentAdminId() {
    try {
      return window.Auth?.getAdminSession?.()?.id || null;
    } catch {
      return null;
    }
  },

  _getPrimaryAdminId() {
    const admins = this._read(this.KEYS.admins, []);
    return admins[0]?.id || null;
  },

  _getPrimaryAdmin() {
    const admins = this._read(this.KEYS.admins, []);
    return admins[0] || null;
  },

  _getLegacyPlaceholderOwnerId() {
    const admins = this._read(this.KEYS.admins, []);
    if (admins.length <= 1) return null;
    const primaryAdmin = admins[0];
    if (!primaryAdmin) return null;

    const username = String(primaryAdmin.username || '').trim().toLowerCase();
    const email = String(primaryAdmin.email || '').trim().toLowerCase();
    const name = String(primaryAdmin.name || '').trim().toLowerCase();
    const isDefaultSeedAdmin = username === 'admin'
      && email === 'admin@school.edu'
      && name === 'administrator';

    return isDefaultSeedAdmin ? primaryAdmin.id : null;
  },

  _shouldClaimLegacyOwner(ownerAdminId, currentAdminId = this._getCurrentAdminId()) {
    if (!currentAdminId) return false;
    const normalizedOwnerId = String(ownerAdminId || '').trim();
    if (!normalizedOwnerId) return true;
    const placeholderOwnerId = this._getLegacyPlaceholderOwnerId();
    if (!placeholderOwnerId) return false;
    return normalizedOwnerId === placeholderOwnerId && currentAdminId !== placeholderOwnerId;
  },

  _getDefaultOwnerAdminId() {
    return this._getCurrentAdminId() || this._getPrimaryAdminId() || null;
  },

  // Records a professor's own activity (course/exam/student changes made from
  // their admin panel) to the professor activity log shown on the system
  // admin dashboard. Best-effort — never blocks the action that triggered it.
  _logProfessorActivity(action, entityType, entityName) {
    const session = window.Auth?.getAdminSession?.() || this._getPrimaryAdmin();
    window.SupabaseSync?.logProfessorActivity?.({
      professorId: session?.id || this._getCurrentAdminId(),
      professorName: session?.name || session?.username || 'Unknown',
      action,
      entityType,
      entityName,
    });
  },

  _withOwner(data, ownerAdminId = this._getDefaultOwnerAdminId()) {
    return ownerAdminId ? { ...data, ownerAdminId } : { ...data };
  },

  _filterByOwner(records, ownerAdminId = this._getCurrentAdminId()) {
    if (!ownerAdminId) {
      // A missing owner id normally means "no admin context at all" (fine to pass
      // records through unfiltered). But if it's missing because Auth.getAdminSession()
      // just discovered the account was deleted mid-session, that must NEVER fall
      // through to "show everything" — that IS the data leak. Show nothing instead.
      if (typeof sessionStorage !== 'undefined' && sessionStorage.getItem('acs_admin_removed_notice')) return [];
      return records;
    }
    return records.filter(record => record?.ownerAdminId === ownerAdminId);
  },

  _deriveStudentOwner(student, subjects, fallbackOwnerId) {
    const matchedSubject = (student?.enrolledSubjects || [])
      .map(subjectId => subjects.find(subject => subject.id === subjectId))
      .find(Boolean);
    const matchedSubjectOwnerId = matchedSubject?.ownerAdminId;
    if (matchedSubjectOwnerId && !this._shouldClaimLegacyOwner(matchedSubjectOwnerId, fallbackOwnerId)) {
      return matchedSubjectOwnerId;
    }
    if (student?.ownerAdminId && !this._shouldClaimLegacyOwner(student.ownerAdminId, fallbackOwnerId)) {
      return student.ownerAdminId;
    }
    return fallbackOwnerId || null;
  },

  _resolveStudentOwner(student, fallbackOwnerId = this._getDefaultOwnerAdminId()) {
    const subjects = this._read(this.KEYS.subjects, []);
    return this._deriveStudentOwner(student, subjects, fallbackOwnerId) || '';
  },

  _replaceStudentRecord(student) {
    if (!student?.id) return null;
    const students = this.getAllStudentsRaw().map(entry => entry.id === student.id ? student : entry);
    this._write(this.KEYS.students, students);
    return students.find(entry => entry.id === student.id) || null;
  },

  _syncStudentRecord(student) {
    if (!student) return;
    SupabaseSync.syncDoc('students', student);
    this._saveStudentToSupabase(student).catch(error => {
      console.warn('[Supabase] Unable to sync updated student record:', error.message || error);
    });
  },

  _detachStudentFromProfessor(id, ownerAdminId) {
    const student = this.getStudentById(id);
    if (!student || !ownerAdminId) return null;

    const ownedSubjectIds = new Set(
      this._read(this.KEYS.subjects, [])
        .filter(subject => subject?.ownerAdminId === ownerAdminId)
        .map(subject => subject.id)
    );

    const remainingEnrolledSubjects = (student.enrolledSubjects || []).filter(subjectId => !ownedSubjectIds.has(subjectId));
    const nextStudent = this._sanitizeStudentRecord({
      ...student,
      enrolledSubjects: remainingEnrolledSubjects,
      ownerAdminId: this._resolveStudentOwner({ ...student, ownerAdminId: '', enrolledSubjects: remainingEnrolledSubjects }, null),
      archived: false,
      archivedAt: null,
    });

    const persistedStudent = this._replaceStudentRecord(nextStudent);
    if (persistedStudent) this._syncStudentRecord(persistedStudent);

    const exams = this._read(this.KEYS.exams, []);
    let examsChanged = false;
    const nextExams = exams.map(exam => {
      if (exam?.ownerAdminId !== ownerAdminId) return exam;
      const nextExcludedStudentIds = (exam.excludedStudentIds || []).filter(studentId => studentId !== id);
      if (nextExcludedStudentIds.length === (exam.excludedStudentIds || []).length) return exam;
      examsChanged = true;
      const updatedExam = { ...exam, excludedStudentIds: nextExcludedStudentIds };
      SupabaseSync.syncDoc('exams', updatedExam);
      return updatedExam;
    });
    if (examsChanged) this._write(this.KEYS.exams, nextExams);

    const removedSessionIds = new Set();
    const remainingSessions = this._read(this.KEYS.sessions, []).filter(session => {
      const matchesStudent = session?.studentId === student.studentId;
      const matchesOwner = session?.ownerAdminId === ownerAdminId;
      if (matchesStudent && matchesOwner) {
        if (session?.id) removedSessionIds.add(session.id);
        SupabaseSync.deleteDoc('sessions', session.id);
        return false;
      }
      return true;
    });
    this._write(this.KEYS.sessions, remainingSessions);

    const remainingLogs = this._read(this.KEYS.logs, []).filter(log => {
      const matchesStudent = log?.studentId === student.studentId;
      const matchesSession = log?.sessionId && removedSessionIds.has(log.sessionId);
      const matchesOwner = log?.ownerAdminId === ownerAdminId;
      if ((matchesStudent || matchesSession) && matchesOwner) {
        SupabaseSync.deleteDoc('logs', log.id);
        return false;
      }
      return true;
    });
    this._write(this.KEYS.logs, remainingLogs);

    return persistedStudent;
  },

  _migrateOwnerScope() {
    const currentAdminId = this._getCurrentAdminId();
    if (!currentAdminId) return;

    const syncMigrated = (table, next, prev) => {
      if (JSON.stringify(next) === JSON.stringify(prev)) return;
      this._write(this.KEYS[table], next);
      next.forEach((record, index) => {
        if (!prev[index] || prev[index].ownerAdminId === record.ownerAdminId) return;
        SupabaseSync.syncDoc(table, record);
      });
    };

    const rawSubjects = this._read(this.KEYS.subjects, []);
    const subjects = rawSubjects.map(subject => (
      this._shouldClaimLegacyOwner(subject.ownerAdminId, currentAdminId)
        ? { ...subject, ownerAdminId: currentAdminId }
        : subject
    ));
    syncMigrated('subjects', subjects, rawSubjects);

    const rawStudents = this._read(this.KEYS.students, []);
    const students = rawStudents.map(student => {
      if (!this._shouldClaimLegacyOwner(student.ownerAdminId, currentAdminId)) return student;
      return {
        ...student,
        ownerAdminId: this._deriveStudentOwner(student, subjects, currentAdminId),
      };
    });
    syncMigrated('students', students, rawStudents);

    const rawExams = this._read(this.KEYS.exams, []);
    const exams = rawExams.map(exam => {
      if (!this._shouldClaimLegacyOwner(exam.ownerAdminId, currentAdminId)) return exam;
      const subject = subjects.find(entry => entry.id === exam.subjectId);
      return { ...exam, ownerAdminId: subject?.ownerAdminId || currentAdminId };
    });
    syncMigrated('exams', exams, rawExams);

    const rawSessions = this._read(this.KEYS.sessions, []);
    const sessions = rawSessions.map(session => {
      if (!this._shouldClaimLegacyOwner(session.ownerAdminId, currentAdminId)) return session;
      const exam = exams.find(entry => entry.id === session.examId);
      return { ...session, ownerAdminId: exam?.ownerAdminId || currentAdminId };
    });
    syncMigrated('sessions', sessions, rawSessions);

    const rawLogs = this._read(this.KEYS.logs, []);
    const logs = rawLogs.map(log => {
      if (!this._shouldClaimLegacyOwner(log.ownerAdminId, currentAdminId)) return log;
      const session = sessions.find(entry => entry.id === log.sessionId);
      const exam = exams.find(entry => entry.id === log.examId);
      return {
        ...log,
        ownerAdminId: session?.ownerAdminId || exam?.ownerAdminId || currentAdminId,
      };
    });
    syncMigrated('logs', logs, rawLogs);
  },

  _getSupabaseClient() {
    return window.SupabaseBridge?.client || window.supabase || null;
  },

  _sanitizeAdminRecord(admin) {
    if (!admin) return admin;
    const { password, ...safeAdmin } = admin;
    return safeAdmin;
  },

  _sanitizeStudentRecord(student) {
    if (!student) return student;
    const { password, ...safeStudent } = student;
    return safeStudent;
  },

  _sanitizeSysAdminRecord(sysAdmin) {
    if (!sysAdmin) return sysAdmin;
    const { password, ...safeSysAdmin } = sysAdmin;
    return safeSysAdmin;
  },

  _normalizeStudentFromSupabase(row) {
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
  },

  _normalizeStudentForSupabase(student) {
    return {
      id: student.id,
      student_id: student.studentId,
      name: student.name,
      email: student.email || null,
      year_level: student.yearLevel || null,
      section: student.section || null,
      year_section: student.yearSection || null,
      department: student.department || null,
      program: student.program || null,
      enrolled_subjects: Array.isArray(student.enrolledSubjects) ? student.enrolledSubjects : [],
      owner_admin_id: student.ownerAdminId || null,
      archived: !!student.archived,
      archived_at: student.archivedAt || null,
    };
  },

  _upsertStudentInLocalCache(student) {
    if (!student?.id) return null;
    const students = [...this.getAllStudentsRaw()];
    const safeStudent = this._sanitizeStudentRecord(student);
    const index = students.findIndex(entry => entry.id === student.id);
    if (index >= 0) students[index] = { ...students[index], ...safeStudent };
    else students.push(safeStudent);
    this._write(this.KEYS.students, students);
    return students[index >= 0 ? index : students.length - 1];
  },

  async _findMatchingSupabaseStudent(student) {
    const supabase = this._getSupabaseClient();
    if (!supabase || !student) return null;

    if (student.id) {
      const { data, error } = await supabase
        .from('students')
        .select('id, student_id, name, email, year_level, section, year_section, department, program, enrolled_subjects, owner_admin_id, archived, archived_at, created_at, updated_at')
        .eq('id', student.id)
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      if (data) return this._normalizeStudentFromSupabase(data);
    }

    if (student.studentId) {
      const { data, error } = await supabase
        .from('students')
        .select('id, student_id, name, email, year_level, section, year_section, department, program, enrolled_subjects, owner_admin_id, archived, archived_at, created_at, updated_at')
        .eq('student_id', student.studentId)
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      if (data) return this._normalizeStudentFromSupabase(data);
    }

    if (student.email) {
      const { data, error } = await supabase
        .from('students')
        .select('id, student_id, name, email, year_level, section, year_section, department, program, enrolled_subjects, owner_admin_id, archived, archived_at, created_at, updated_at')
        .eq('email', student.email)
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      if (data) return this._normalizeStudentFromSupabase(data);
    }

    return null;
  },

  async _saveStudentToSupabase(student) {
    const supabase = this._getSupabaseClient();
    if (!supabase) return student;
    const existingStudent = await this._findMatchingSupabaseStudent(student);
    const payload = this._normalizeStudentForSupabase(existingStudent ? { ...existingStudent, ...student, id: existingStudent.id } : student);
    const { data, error } = await supabase
      .from('students')
      .upsert(payload, { onConflict: 'id' })
      .select()
      .single();
    if (error) throw error;
    const normalized = this._normalizeStudentFromSupabase(data);
    this._upsertStudentInLocalCache(normalized);
    return normalized;
  },

  async ensureStudentEmailInSupabase({ id, studentId, email }) {
    const supabase = this._getSupabaseClient();
    const normalizedEmail = String(email || '').trim().toLowerCase();
    if (!supabase || !normalizedEmail) return null;

    let query = supabase
      .from('students')
      .update({ email: normalizedEmail })
      .select()
      .limit(1);

    if (id) query = query.eq('id', id);
    else if (studentId) query = query.eq('student_id', String(studentId || '').trim().toUpperCase());
    else return null;

    const { data, error } = await query.single();
    if (error) throw error;
    const normalized = this._normalizeStudentFromSupabase(data);
    this._upsertStudentInLocalCache(normalized);
    return normalized;
  },

  async getStudentByEmailAsync(email, options = {}) {
    const { fallbackLocal = true } = options;
    const normalizedEmail = String(email || '').trim().toLowerCase();
    if (!normalizedEmail) return null;

    const supabase = this._getSupabaseClient();
    if (supabase) {
      const { data, error } = await supabase
        .from('students')
        .select('id, student_id, name, email, year_level, section, year_section, department, program, enrolled_subjects, owner_admin_id, archived, archived_at, created_at, updated_at')
        .eq('email', normalizedEmail)
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      if (data) {
        const normalized = this._normalizeStudentFromSupabase(data);
        this._upsertStudentInLocalCache(normalized);
        return normalized;
      }
    }

    if (!fallbackLocal) return null;

    const localStudent = this.getStudents().find(s => s.email && s.email.toLowerCase() === normalizedEmail) || null;
    if (localStudent && supabase) {
      this._saveStudentToSupabase(localStudent).catch(error => {
        console.warn('[Supabase] Unable to backfill local student by email:', error.message || error);
      });
    }
    return localStudent;
  },

  async getStudentByStudentIdAsync(studentId, options = {}) {
    const { fallbackLocal = true } = options;
    const normalizedStudentId = String(studentId || '').trim().toUpperCase();
    if (!normalizedStudentId) return null;

    const supabase = this._getSupabaseClient();
    if (supabase) {
      const { data, error } = await supabase
        .from('students')
        .select('id, student_id, name, email, year_level, section, year_section, department, program, enrolled_subjects, owner_admin_id, archived, archived_at, created_at, updated_at')
        .eq('student_id', normalizedStudentId)
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      if (data) {
        const normalized = this._normalizeStudentFromSupabase(data);
        this._upsertStudentInLocalCache(normalized);
        return normalized;
      }
    }

    if (!fallbackLocal) return null;

    const localStudent = this.getStudents().find(s => s.studentId === normalizedStudentId) || null;
    if (localStudent && supabase) {
      this._saveStudentToSupabase(localStudent).catch(error => {
        console.warn('[Supabase] Unable to backfill local student by student ID:', error.message || error);
      });
    }
    return localStudent;
  },

  _buildSeedData() {
    const seedAdminId = 'admin1';
    const createdAt = new Date().toISOString();
    const q1 = this.generateId();
    const q2 = this.generateId();
    const q3 = this.generateId();
    const q4 = this.generateId();
    const q5 = this.generateId();

    return {
      [this.KEYS.settings]: {
        schoolName: 'Pamantasan ng Lungsod ng Pasig',
        logoUrl: '/plp-logo.png',
        department: '',
        adminName: 'Administrator',
        adminEmail: 'admin@school.edu',
      },
      [this.KEYS.admins]: [
        { id: seedAdminId, username: 'admin', name: 'Administrator', email: 'admin@school.edu', department: '' },
      ],
      [this.KEYS.sysadmin]: {
        username: 'sysadmin',
        name: 'System Administrator',
        email: 'sysadmin@school.edu',
        department: '',
      },
      [this.KEYS.students]: [
        { id: this.generateId(), studentId: '26-00001', name: 'Alice Santos', yearLevel: '3rd Year', section: 'Section A', email: 'alice@school.edu', ownerAdminId: seedAdminId },
        { id: this.generateId(), studentId: '26-00002', name: 'Bob Reyes', yearLevel: '3rd Year', section: 'Section A', email: 'bob@school.edu', ownerAdminId: seedAdminId },
        { id: this.generateId(), studentId: '26-00003', name: 'Carlos Mendoza', yearLevel: '2nd Year', section: 'Section B', email: 'carlos@school.edu', ownerAdminId: seedAdminId },
      ],
      [this.KEYS.subjects]: [
        { id: 'subj1', code: 'CS101', name: 'Introduction to Computing', description: 'Fundamentals of computer science', createdAt, ownerAdminId: seedAdminId },
        { id: 'subj2', code: 'MATH201', name: 'Discrete Mathematics', description: 'Logic, sets, graphs and combinatorics', createdAt, ownerAdminId: seedAdminId },
      ],
      [this.KEYS.exams]: [
        {
          id: 'exam_demo1',
          subjectId: 'subj1',
          title: 'CS101 Midterm Examination',
          description: 'Covers topics from Week 1 to Week 8.',
          timeLimit: 30,
          code: 'EXAM01',
          status: 'ready',
          shuffleQuestions: true,
          shuffleAnswers: true,
          questions: [
            {
              id: q1,
              type: 'mcq',
              content: 'Which of the following is NOT a programming language?',
              options: ['Python', 'Java', 'HTML', 'C++'],
              correctAnswer: 'HTML',
              points: 2,
            },
            {
              id: q2,
              type: 'mcq',
              content: 'What does CPU stand for?',
              options: ['Central Processing Unit', 'Computer Personal Unit', 'Central Program Utility', 'Core Processing Unit'],
              correctAnswer: 'Central Processing Unit',
              points: 2,
            },
            {
              id: q3,
              type: 'tf',
              content: 'The Internet and the World Wide Web are the same thing.',
              options: ['True', 'False'],
              correctAnswer: 'False',
              points: 2,
            },
            {
              id: q4,
              type: 'tf',
              content: 'RAM is a type of non-volatile memory.',
              options: ['True', 'False'],
              correctAnswer: 'False',
              points: 2,
            },
            {
              id: q5,
              type: 'identification',
              content: 'What is the binary representation of the decimal number 10?',
              options: [],
              correctAnswer: '1010',
              points: 2,
            },
          ],
          createdAt,
          startedAt: null,
          closedAt: null,
          scoringReleased: false,
          ownerAdminId: seedAdminId,
        },
      ],
      [this.KEYS.sessions]: [],
      [this.KEYS.logs]: [],
    };
  },

  init() {
    const seeded = this._buildSeedData();
    Object.entries(seeded).forEach(([key, value]) => {
      if (!Object.prototype.hasOwnProperty.call(this._cache, key)) {
        this._cache[key] = value;
      }
    });
  },

  generateId() {
    return Date.now().toString(36) + Math.random().toString(36).substr(2);
  },

  // ---- Settings ----
  getSettings() {
    return this._read(this.KEYS.settings, {});
  },
  updateSettings(updates) {
    const current = this.getSettings();
    const next = { ...current, ...updates };
    this._write(this.KEYS.settings, next);
    SupabaseSync.syncSettings(next);
  },

  // ---- Admins (professors) ----
  getAdmins() {
    return this._read(this.KEYS.admins, []).map(admin => this._sanitizeAdminRecord(admin));
  },
  getAdmin(username) {
    return this.getAdmins().find(a => a.username === username) || null;
  },
  async refreshAdminsFromSupabase() {
    const supabase = this._getSupabaseClient();
    if (!supabase) return this.getAdmins();
    const adminSession = window.Auth?.getAdminSession?.();
    const sysAdminSession = window.Auth?.getSysAdminSession?.();
    let query = supabase
      .from('professors')
      .select('id, username, name, email, department, created_at');
    if (adminSession?.id && !sysAdminSession) query = query.eq('id', adminSession.id);
    const { data, error } = await query;
    if (error) throw error;
    const admins = (data || []).map(row => this._sanitizeAdminRecord({
      id: row.id,
      username: row.username,
      name: row.name,
      email: row.email || '',
      department: row.department || '',
      createdAt: row.created_at || null,
    }));
    this._write(this.KEYS.admins, admins);
    return admins;
  },
  updateAdmin(id, updates) {
    const safeUpdates = this._sanitizeAdminRecord(updates);
    const admins = this.getAdmins().map(a => a.id === id ? { ...a, ...safeUpdates } : a);
    this._write(this.KEYS.admins, admins);
    const updated = admins.find(a => a.id === id);
    if (updated) SupabaseSync.syncDoc('professors',updated);
  },
  addProfessor(data) {
    const admins = this.getAdmins();
    if (admins.find(a => a.username === data.username)) return { success: false, message: 'Username already exists.' };
    if (data.email && admins.find(a => (a.email || '').toLowerCase() === data.email.toLowerCase())) {
      return { success: false, message: 'Email already exists.' };
    }
    const newProf = this._sanitizeAdminRecord({ id: this.generateId(), createdAt: new Date().toISOString(), ...data });
    admins.push(newProf);
    this._write(this.KEYS.admins, admins);
    SupabaseSync.syncDoc('professors',newProf);
    return { success: true, professor: newProf };
  },
  // ---- System Admin ----
  getSysAdmin() {
    const stored = this._read(this.KEYS.sysadmin, null);
    return this._sanitizeSysAdminRecord(stored) || { username: 'sysadmin', name: 'System Administrator', email: 'sysadmin@school.edu', department: '' };
  },
  updateSysAdmin(updates) {
    const current = this.getSysAdmin();
    const updated = this._sanitizeSysAdminRecord({ ...current, ...updates });
    this._write(this.KEYS.sysadmin, updated);
    SupabaseSync.syncSysAdmin(updated);
    return updated;
  },

  // ---- Students ----
  getStudents() {
    this._migrateOwnerScope();
    return this._filterByOwner(this.getAllStudentsRaw()).filter(s => !s.archived);
  },
  getAllStudentsRaw() {
    this._migrateOwnerScope();
    return this._read(this.KEYS.students, []).map(student => this._sanitizeStudentRecord(student));
  },
  getArchivedStudents() {
    return this._filterByOwner(this.getAllStudentsRaw()).filter(s => s.archived);
  },
  getStudent(studentId) {
    const normalizedStudentId = this._normalizeStudentIdValue(studentId);
    if (!normalizedStudentId) return null;

    const matches = this.getAllStudentsRaw().filter(student =>
      this._normalizeStudentIdValue(student.studentId) === normalizedStudentId
    );
    if (!matches.length) return null;

    const ownerAdminId = this._getCurrentAdminId();
    if (ownerAdminId) {
      return matches.find(student => student.ownerAdminId === ownerAdminId) || null;
    }

    const studentSession = window.Auth?.getStudentSession?.();
    const sessionEmail = this._normalizeStudentEmailValue(studentSession?.email);
    if (sessionEmail) {
      return matches.find(student =>
        this._normalizeStudentEmailValue(student.email) === sessionEmail
      ) || matches[0];
    }

    return matches[0];
  },
  getStudentById(id) {
    return this.getAllStudentsRaw().find(s => s.id === id) || null;
  },
  _normalizeStudentIdValue(studentId) {
    return String(studentId || '').trim().toUpperCase();
  },
  _normalizeStudentEmailValue(email) {
    return String(email || '').trim().toLowerCase();
  },
  _yearLabelToNumber(value) {
    const normalized = String(value || '').trim();
    if (/^[1-5]$/.test(normalized)) return normalized;
    const match = normalized.match(/^([1-5])(st|nd|rd|th)\s+year$/i);
    return match ? match[1] : '';
  },
  _normalizeSectionValue(value) {
    return String(value || '').trim().replace(/^section\s+/i, '').toUpperCase();
  },
  // Mirrors admin.js's getStudentYearSectionParts: prefer the combined
  // "Y-SECTION" field (set once by admin.js when both are known), falling
  // back to the separate yearLevel/section fields.
  getStudentEffectiveYearSection(student) {
    const storedYearSection = String(student?.yearSection || '').trim().toUpperCase();
    const match = storedYearSection.match(/^([1-5])-(.+)$/);
    if (match) return { year: match[1], section: match[2].trim() };
    return {
      year: this._yearLabelToNumber(student?.yearLevel || ''),
      section: this._normalizeSectionValue(student?.section || ''),
    };
  },
  // A course can restrict enrollment to specific year levels and/or sections
  // (subject.yearLevels / subject.sections). Mirrors admin.js's
  // buildCourseYearSectionMeta pairing rules so "eligible to enroll" always
  // matches what the course card displays as its target year(s)/section(s).
  isStudentEligibleForCourse(student, subject) {
    const rawYears = Array.isArray(subject?.yearLevels) && subject.yearLevels.length
      ? subject.yearLevels
      : (subject?.yearLevel ? [subject.yearLevel] : []);
    const rawSections = Array.isArray(subject?.sections) ? subject.sections : [];

    const years = rawYears.map(y => this._yearLabelToNumber(y)).filter(Boolean);
    const sections = rawSections.map(s => this._normalizeSectionValue(s)).filter(Boolean);

    if (!years.length && !sections.length) return true;

    const { year: studentYear, section: studentSection } = this.getStudentEffectiveYearSection(student);

    if (years.length && sections.length) {
      let pairs;
      if (years.length === sections.length) {
        pairs = years.map((y, i) => [y, sections[i]]);
      } else if (years.length === 1) {
        pairs = sections.map(s => [years[0], s]);
      } else if (sections.length === 1) {
        pairs = years.map(y => [y, sections[0]]);
      } else {
        pairs = years.flatMap(y => sections.map(s => [y, s]));
      }
      return pairs.some(([y, s]) => y === studentYear && !!studentSection && s === studentSection);
    }
    if (years.length) return years.includes(studentYear);
    return sections.includes(studentSection);
  },
  findStudentConflict({ studentId, email, excludeId = null } = {}) {
    const normalizedStudentId = this._normalizeStudentIdValue(studentId);
    const normalizedEmail = this._normalizeStudentEmailValue(email);
    const students = this.getAllStudentsRaw();

    const studentIdMatch = normalizedStudentId
      ? students.find(student =>
          student.id !== excludeId &&
          this._normalizeStudentIdValue(student.studentId) === normalizedStudentId
        ) || null
      : null;

    const emailMatch = normalizedEmail
      ? students.find(student =>
          student.id !== excludeId &&
          this._normalizeStudentEmailValue(student.email) === normalizedEmail
        ) || null
      : null;

    return { studentIdMatch, emailMatch };
  },
  _buildStudentConflictMessage(conflict) {
    const hasStudentIdConflict = !!conflict?.studentIdMatch;
    const hasEmailConflict = !!conflict?.emailMatch;
    const hasArchivedConflict = !!(conflict?.studentIdMatch?.archived || conflict?.emailMatch?.archived);

    if (hasArchivedConflict) {
      if (hasStudentIdConflict && hasEmailConflict) {
        return 'A student with this Student ID or email already exists in the archive. Restore that record instead of creating a duplicate.';
      }
      if (hasStudentIdConflict) {
        return 'This Student ID already exists in the archive. Restore that student instead of creating a duplicate.';
      }
      return 'This email already exists in the archive. Restore that student instead of creating a duplicate.';
    }

    if (hasStudentIdConflict && hasEmailConflict) {
      return 'A student with this Student ID or email already exists.';
    }
    if (hasStudentIdConflict) {
      return 'This Student ID already exists.';
    }
    return 'This email already exists.';
  },
  _assertUniqueStudent({ studentId, email, excludeId = null } = {}) {
    const conflict = this.findStudentConflict({ studentId, email, excludeId });
    if (!conflict.studentIdMatch && !conflict.emailMatch) return;
    const error = new Error(this._buildStudentConflictMessage(conflict));
    error.code = 'DUPLICATE_STUDENT';
    error.conflict = conflict;
    throw error;
  },
  addStudent(data) {
    const students = [...this.getAllStudentsRaw()];
    const newStudent = this._sanitizeStudentRecord({
      id: this.generateId(),
      ...data,
      studentId: this._normalizeStudentIdValue(data.studentId),
      email: this._normalizeStudentEmailValue(data.email),
    });
    newStudent.ownerAdminId = this._resolveStudentOwner(newStudent, newStudent.ownerAdminId || this._getDefaultOwnerAdminId());
    this._assertUniqueStudent({ studentId: newStudent.studentId, email: newStudent.email });
    students.push(newStudent);
    this._write(this.KEYS.students, students);
    SupabaseSync.syncDoc('students', newStudent);
    this._saveStudentToSupabase(newStudent).catch(error => {
      console.warn('[Supabase] Unable to sync new student record:', error.message || error);
    });
    this._logProfessorActivity('student_added', 'student', newStudent.name || newStudent.studentId);
    return newStudent;
  },
  updateStudent(id, updates) {
    const current = this.getStudentById(id);
    if (!current) return;

    const nextStudentId = Object.prototype.hasOwnProperty.call(updates, 'studentId')
      ? this._normalizeStudentIdValue(updates.studentId)
      : this._normalizeStudentIdValue(current.studentId);
    const nextEmail = Object.prototype.hasOwnProperty.call(updates, 'email')
      ? this._normalizeStudentEmailValue(updates.email)
      : this._normalizeStudentEmailValue(current.email);

    this._assertUniqueStudent({ studentId: nextStudentId, email: nextEmail, excludeId: id });

    const normalizedUpdates = this._sanitizeStudentRecord({ ...updates });
    if (Object.prototype.hasOwnProperty.call(normalizedUpdates, 'studentId')) normalizedUpdates.studentId = nextStudentId;
    if (Object.prototype.hasOwnProperty.call(normalizedUpdates, 'email')) normalizedUpdates.email = nextEmail;

    const students = this.getAllStudentsRaw().map(s => {
      if (s.id !== id) return s;
      const mergedStudent = { ...s, ...normalizedUpdates };
      return {
        ...mergedStudent,
        ownerAdminId: this._resolveStudentOwner(mergedStudent, mergedStudent.ownerAdminId || this._getDefaultOwnerAdminId()),
      };
    });
    this._write(this.KEYS.students, students);
    const updated = students.find(s => s.id === id);
    if (updated) this._syncStudentRecord(updated);
  },
  syncStudentReferences(previousStudentId, nextStudent) {
    if (!previousStudentId || !nextStudent) return;

    const sessions = this.getSessions().map(session => {
      if (session.studentId !== previousStudentId) return session;
      const updatedSession = {
        ...session,
        studentId: nextStudent.studentId,
        studentName: nextStudent.name,
        yearLevel: nextStudent.yearLevel || '',
        section: nextStudent.section || '',
        yearSection: nextStudent.yearSection || '',
        department: nextStudent.department || '',
        program: nextStudent.program || '',
      };
      SupabaseSync.syncDoc('sessions', updatedSession);
      return updatedSession;
    });
    this._write(this.KEYS.sessions, sessions);

    const logs = this.getLogs().map(log => {
      if (log.studentId !== previousStudentId) return log;
      const updatedLog = { ...log, studentId: nextStudent.studentId };
      SupabaseSync.syncDoc('logs', updatedLog);
      return updatedLog;
    });
    this._write(this.KEYS.logs, logs);
  },
  archiveStudent(id) {
    const students = this.getAllStudentsRaw().map(s => s.id === id ? { ...s, archived: true, archivedAt: new Date().toISOString() } : s);
    this._write(this.KEYS.students, students);
    const archived = students.find(s => s.id === id);
    if (archived) SupabaseSync.syncDoc('students', archived);
    this._logProfessorActivity('student_archived', 'student', archived?.name || archived?.studentId);
  },
  restoreStudent(id) {
    const students = this.getAllStudentsRaw().map(s => s.id === id ? { ...s, archived: false, archivedAt: null } : s);
    this._write(this.KEYS.students, students);
    const restored = students.find(s => s.id === id);
    if (restored) SupabaseSync.syncDoc('students', restored);
    this._logProfessorActivity('student_restored', 'student', restored?.name || restored?.studentId);
  },
  deleteStudent(id) {
    const student = this.getStudentById(id);
    if (!student) return;

    const ownerAdminId = this._getCurrentAdminId();
    if (ownerAdminId) {
      this._detachStudentFromProfessor(id, ownerAdminId);
      this._logProfessorActivity('student_deleted', 'student', student?.name || student?.studentId);
      return;
    }

    const students = this.getAllStudentsRaw().filter(s => s.id !== id);
    this._write(this.KEYS.students, students);
    SupabaseSync.deleteDoc('students', id);
    this._logProfessorActivity('student_deleted', 'student', student?.name || student?.studentId);
  },
  studentExists(studentId) {
    return !!this.findStudentConflict({ studentId }).studentIdMatch;
  },

  // ---- Subjects ----
  getSubjects() {
    this._migrateOwnerScope();
    return this._filterByOwner(this._read(this.KEYS.subjects, []));
  },
  getSubject(id) {
    const subjects = this._read(this.KEYS.subjects, []);
    const subject = subjects.find(s => s.id === id) || null;
    const ownerAdminId = this._getCurrentAdminId();
    if (ownerAdminId && subject?.ownerAdminId !== ownerAdminId) return null;
    return subject;
  },
  addSubject(data) {
    const subjects = [...this._read(this.KEYS.subjects, [])];
    const newSubject = this._withOwner({ id: this.generateId(), createdAt: new Date().toISOString(), ...data });
    subjects.push(newSubject);
    this._write(this.KEYS.subjects, subjects);
    SupabaseSync.syncDoc('subjects', newSubject);
    this._logProfessorActivity('course_created', 'course', newSubject.name || newSubject.code);
    return newSubject;
  },
  updateSubject(id, updates) {
    const before = this._read(this.KEYS.subjects, []).find(s => s.id === id);
    const subjects = this._read(this.KEYS.subjects, []).map(s => s.id === id ? { ...s, ...updates, ownerAdminId: s.ownerAdminId || this._getDefaultOwnerAdminId() } : s);
    this._write(this.KEYS.subjects, subjects);
    const updated = subjects.find(s => s.id === id);
    if (updated) SupabaseSync.syncDoc('subjects', updated);
    if (updated && updates.archived === true && !before?.archived) {
      this._logProfessorActivity('course_archived', 'course', updated.name || updated.code);
    } else if (updated && updates.archived === false && before?.archived) {
      this._logProfessorActivity('course_restored', 'course', updated.name || updated.code);
    }
  },
  deleteSubject(id) {
    const subject = this._read(this.KEYS.subjects, []).find(s => s.id === id);
    const subjects = this._read(this.KEYS.subjects, []).filter(s => s.id !== id);
    this._write(this.KEYS.subjects, subjects);
    SupabaseSync.deleteDoc('subjects', id);
    this._logProfessorActivity('course_deleted', 'course', subject?.name || subject?.code);
  },

  // ---- Exams ----
  getExams() {
    this._migrateOwnerScope();
    return this._filterByOwner(this._read(this.KEYS.exams, []));
  },
  getExam(id) {
    const exams = this._read(this.KEYS.exams, []);
    const exam = exams.find(e => e.id === id) || null;
    const ownerAdminId = this._getCurrentAdminId();
    if (ownerAdminId && exam?.ownerAdminId !== ownerAdminId) return null;
    return exam;
  },
  getExamByCode(code) {
    return this._read(this.KEYS.exams, []).find(e => e.code === code.toUpperCase()) || null;
  },
  addExam(data) {
    const exams = [...this._read(this.KEYS.exams, [])];
    const subject = data.subjectId ? this._read(this.KEYS.subjects, []).find(s => s.id === data.subjectId) : null;
    const newExam = this._withOwner({ id: this.generateId(), createdAt: new Date().toISOString(), questions: [], ...data }, subject?.ownerAdminId || this._getDefaultOwnerAdminId());
    exams.push(newExam);
    this._write(this.KEYS.exams, exams);
    SupabaseSync.syncDoc('exams', newExam);
    this._logProfessorActivity('exam_created', 'exam', newExam.title);
    return newExam;
  },
  updateExam(id, updates) {
    const before = this._read(this.KEYS.exams, []).find(e => e.id === id);
    const subjects = this._read(this.KEYS.subjects, []);
    const exams = this._read(this.KEYS.exams, []).map(e => {
      if (e.id !== id) return e;
      const nextSubject = updates.subjectId ? subjects.find(s => s.id === updates.subjectId) : null;
      return {
        ...e,
        ...updates,
        ownerAdminId: nextSubject?.ownerAdminId || e.ownerAdminId || this._getDefaultOwnerAdminId(),
      };
    });
    this._write(this.KEYS.exams, exams);
    const updated = exams.find(e => e.id === id);
    if (!updated) return;
    SupabaseSync.syncDoc('exams', updated);
    if (updates.status === 'active' && before?.status !== 'active') {
      this._logProfessorActivity(before?.status === 'closed' ? 'exam_reopened' : 'exam_started', 'exam', updated.title);
    } else if (updates.status === 'closed' && before?.status !== 'closed') {
      this._logProfessorActivity('exam_closed', 'exam', updated.title);
    }
    if (updates.scoringReleased === true && !before?.scoringReleased) {
      this._logProfessorActivity('exam_scores_released', 'exam', updated.title);
    }
  },
  deleteExam(id) {
    const exam = this._read(this.KEYS.exams, []).find(e => e.id === id);
    const exams = this._read(this.KEYS.exams, []).filter(e => e.id !== id);
    this._write(this.KEYS.exams, exams);
    SupabaseSync.deleteDoc('exams', id);
    this._logProfessorActivity('exam_deleted', 'exam', exam?.title);
  },
  getActiveExams() {
    return this.getExams().filter(e => e.status === 'active');
  },

  // ---- Sessions ----
  getSessions() {
    this._migrateOwnerScope();
    return this._filterByOwner(this._read(this.KEYS.sessions, []));
  },
  getSession(id) {
    const sessions = this._read(this.KEYS.sessions, []);
    const session = sessions.find(s => s.id === id) || null;
    const ownerAdminId = this._getCurrentAdminId();
    if (ownerAdminId && session?.ownerAdminId !== ownerAdminId) return null;
    return session;
  },
  getSessionsByExam(examId) {
    return this.getSessions().filter(s => s.examId === examId);
  },
  getStudentSession(examId, studentId) {
    const matches = this.getSessions().filter(s => s.examId === examId && s.studentId === studentId);
    if (!matches.length) return null;

    const getTimestamp = session => {
      const raw = session?.endTime || session?.startTime || session?.createdAt || null;
      const time = raw ? new Date(raw).getTime() : 0;
      return Number.isFinite(time) ? time : 0;
    };

    return matches
      .slice()
      .sort((a, b) => {
        if (!!a.submitted !== !!b.submitted) return a.submitted ? 1 : -1;
        return getTimestamp(b) - getTimestamp(a);
      })[0];
  },
  addSession(data) {
    const sessions = [...this._read(this.KEYS.sessions, [])];
    const exam = data.examId ? this._read(this.KEYS.exams, []).find(entry => entry.id === data.examId) : null;
    const newSession = this._withOwner({ id: this.generateId(), ...data }, exam?.ownerAdminId || this._getDefaultOwnerAdminId());
    sessions.push(newSession);
    this._write(this.KEYS.sessions, sessions);
    SupabaseSync.syncDoc('sessions', newSession);
    return newSession;
  },
  updateSession(id, updates) {
    const sessions = this._read(this.KEYS.sessions, []).map(s => s.id === id ? { ...s, ...updates, ownerAdminId: s.ownerAdminId || this._getDefaultOwnerAdminId() } : s);
    this._write(this.KEYS.sessions, sessions);
    const updated = sessions.find(s => s.id === id);
    if (updated) SupabaseSync.syncDoc('sessions', updated);
  },

  // ---- Logs ----
  getLogs() {
    this._migrateOwnerScope();
    return this._filterByOwner(this._read(this.KEYS.logs, []));
  },
  addLog(data) {
    const logs = [...this._read(this.KEYS.logs, [])];
    const session = data.sessionId ? this._read(this.KEYS.sessions, []).find(entry => entry.id === data.sessionId) : null;
    const exam = data.examId ? this._read(this.KEYS.exams, []).find(entry => entry.id === data.examId) : null;
    const newLog = this._withOwner({ id: this.generateId(), timestamp: new Date().toISOString(), ...data }, session?.ownerAdminId || exam?.ownerAdminId || this._getDefaultOwnerAdminId());
    logs.push(newLog);
    this._write(this.KEYS.logs, logs);
    SupabaseSync.syncDoc('logs', newLog);
  },
  getLogsBySession(sessionId) {
    return this.getLogs().filter(l => l.sessionId === sessionId);
  },

  // ---- Professor activity log (system-admin actions on professor accounts) ----
  getProfessorActivityLog() {
    return this._read(this.KEYS.professorActivityLog, []);
  },
};

// Auto-initialize on load with in-memory defaults; Supabase data overwrites them once loaded.
DB.init();

// Expose as global for ES-module consumers (React)
window.DB = DB;

// ============================================================
// DATA LAYER - localStorage cache + Firestore sync
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
  },
  _cache: {},

  _read(key, fallback) {
    if (Object.prototype.hasOwnProperty.call(this._cache, key)) return this._cache[key];
    try {
      const raw = localStorage.getItem(key);
      const value = raw ? JSON.parse(raw) : fallback;
      this._cache[key] = value ?? fallback;
    } catch {
      this._cache[key] = fallback;
    }
    return this._cache[key];
  },

  _write(key, value) {
    this._cache[key] = value;
    localStorage.setItem(key, JSON.stringify(value));
    return value;
  },

  clearCacheKey(key) {
    delete this._cache[key];
  },

  clearCache() {
    this._cache = {};
  },

  _getSupabaseClient() {
    return window.SupabaseBridge?.client || window.supabase || null;
  },

  _normalizeStudentFromSupabase(row) {
    if (!row) return null;
    return {
      id: row.id,
      studentId: row.student_id,
      name: row.name,
      email: row.email || '',
      password: row.password || '',
      yearLevel: row.year_level || '',
      section: row.section || '',
      yearSection: row.year_section || '',
      department: row.department || '',
      program: row.program || '',
      enrolledSubjects: Array.isArray(row.enrolled_subjects) ? row.enrolled_subjects : [],
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
      password: student.password || null,
      year_level: student.yearLevel || null,
      section: student.section || null,
      year_section: student.yearSection || null,
      department: student.department || null,
      program: student.program || null,
      enrolled_subjects: Array.isArray(student.enrolledSubjects) ? student.enrolledSubjects : [],
      archived: !!student.archived,
      archived_at: student.archivedAt || null,
    };
  },

  _upsertStudentInLocalCache(student) {
    if (!student?.id) return null;
    const students = [...this.getAllStudentsRaw()];
    const index = students.findIndex(entry => entry.id === student.id);
    if (index >= 0) students[index] = { ...students[index], ...student };
    else students.push(student);
    this._write(this.KEYS.students, students);
    return students[index >= 0 ? index : students.length - 1];
  },

  async _findMatchingSupabaseStudent(student) {
    const supabase = this._getSupabaseClient();
    if (!supabase || !student) return null;

    if (student.id) {
      const { data, error } = await supabase
        .from('students')
        .select('*')
        .eq('id', student.id)
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      if (data) return this._normalizeStudentFromSupabase(data);
    }

    if (student.studentId) {
      const { data, error } = await supabase
        .from('students')
        .select('*')
        .eq('student_id', student.studentId)
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      if (data) return this._normalizeStudentFromSupabase(data);
    }

    if (student.email) {
      const { data, error } = await supabase
        .from('students')
        .select('*')
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
        .select('*')
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
        .select('*')
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

  init() {
    // Settings
    if (!localStorage.getItem(this.KEYS.settings)) {
      localStorage.setItem(this.KEYS.settings, JSON.stringify({
        schoolName: 'Pamantasan ng Lungsod ng Pasig',
        logoUrl: '/plp-logo.png',
        department: '',
        adminName: 'Administrator',
        adminEmail: 'admin@school.edu',
      }));
    }

    // Professors
    if (!localStorage.getItem(this.KEYS.admins)) {
      localStorage.setItem(this.KEYS.admins, JSON.stringify([
        { id: 'admin1', username: 'admin', password: 'admin123', name: 'Administrator', email: 'admin@school.edu' }
      ]));
    }

    // System admin credentials
    if (!localStorage.getItem('acs_sysadmin')) {
      localStorage.setItem('acs_sysadmin', JSON.stringify({
        username: 'sysadmin',
        password: 'admin123',
        name: 'System Administrator',
      }));
    }

    // Students - seed demo students
    if (!localStorage.getItem(this.KEYS.students)) {
      localStorage.setItem(this.KEYS.students, JSON.stringify([
        { id: this.generateId(), studentId: '26-00001', name: 'Alice Santos', yearLevel: '3rd Year', section: 'Section A', email: 'alice@school.edu' },
        { id: this.generateId(), studentId: '26-00002', name: 'Bob Reyes', yearLevel: '3rd Year', section: 'Section A', email: 'bob@school.edu' },
        { id: this.generateId(), studentId: '26-00003', name: 'Carlos Mendoza', yearLevel: '2nd Year', section: 'Section B', email: 'carlos@school.edu' },
      ]));
    } else {
      // Migration: replace old STU### format with new YY-NNNNN format
      const students = JSON.parse(localStorage.getItem(this.KEYS.students));
      const oldFmt = /^STU(\d+)$/i;
      const migrated = students.map((s, i) => {
        if (oldFmt.test(s.studentId)) {
          const num = String(i + 1).padStart(5, '0');
          return { ...s, studentId: '26-' + num };
        }
        return s;
      });
      localStorage.setItem(this.KEYS.students, JSON.stringify(migrated));
    }

    // Subjects - seed demo subjects
    if (!localStorage.getItem(this.KEYS.subjects)) {
      const subId1 = 'subj1';
      const subId2 = 'subj2';
      localStorage.setItem(this.KEYS.subjects, JSON.stringify([
        { id: subId1, code: 'CS101', name: 'Introduction to Computing', description: 'Fundamentals of computer science', createdAt: new Date().toISOString() },
        { id: subId2, code: 'MATH201', name: 'Discrete Mathematics', description: 'Logic, sets, graphs and combinatorics', createdAt: new Date().toISOString() },
      ]));
    }

    // Exams - seed one complete demo exam
    if (!localStorage.getItem(this.KEYS.exams)) {
      const subjects = this.getSubjects();
      const subId = subjects.length > 0 ? subjects[0].id : 'subj1';
      const q1 = this.generateId();
      const q2 = this.generateId();
      const q3 = this.generateId();
      const q4 = this.generateId();
      const q5 = this.generateId();
      localStorage.setItem(this.KEYS.exams, JSON.stringify([
        {
          id: 'exam_demo1',
          subjectId: subId,
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
          createdAt: new Date().toISOString(),
          startedAt: null,
          closedAt: null,
          scoringReleased: false,
        }
      ]));
    }

    // Sessions
    if (!localStorage.getItem(this.KEYS.sessions)) {
      localStorage.setItem(this.KEYS.sessions, JSON.stringify([]));
    }

    // Logs
    if (!localStorage.getItem(this.KEYS.logs)) {
      localStorage.setItem(this.KEYS.logs, JSON.stringify([]));
    }
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
    return this._read(this.KEYS.admins, []);
  },
  getAdmin(username) {
    return this.getAdmins().find(a => a.username === username) || null;
  },
  updateAdmin(id, updates) {
    const admins = this.getAdmins().map(a => a.id === id ? { ...a, ...updates } : a);
    this._write(this.KEYS.admins, admins);
    const updated = admins.find(a => a.id === id);
    if (updated) SupabaseSync.syncDoc('professors',updated);
  },
  addProfessor(data) {
    const admins = this.getAdmins();
    if (admins.find(a => a.username === data.username)) return { success: false, message: 'Username already exists.' };
    const newProf = { id: this.generateId(), createdAt: new Date().toISOString(), ...data };
    admins.push(newProf);
    this._write(this.KEYS.admins, admins);
    SupabaseSync.syncDoc('professors',newProf);
    return { success: true, professor: newProf };
  },
  deleteProfessor(id) {
    const admins = this.getAdmins().filter(a => a.id !== id);
    this._write(this.KEYS.admins, admins);
  },

  // ---- System Admin ----
  getSysAdmin() {
    const stored = this._read('acs_sysadmin', null);
    return stored || { username: 'sysadmin', password: 'admin123', name: 'System Administrator' };
  },
  updateSysAdmin(updates) {
    const current = this.getSysAdmin();
    const updated = { ...current, ...updates };
    this._write('acs_sysadmin', updated);
    return updated;
  },

  // ---- Students ----
  getStudents() {
    return this.getAllStudentsRaw().filter(s => !s.archived);
  },
  getAllStudentsRaw() {
    return this._read(this.KEYS.students, []);
  },
  getArchivedStudents() {
    return this.getAllStudentsRaw().filter(s => s.archived);
  },
  getStudent(studentId) {
    return this.getStudents().find(s => s.studentId === studentId) || null;
  },
  getStudentById(id) {
    return this.getAllStudentsRaw().find(s => s.id === id) || null;
  },
  addStudent(data) {
    const students = [...this.getAllStudentsRaw()];
    const newStudent = { id: this.generateId(), ...data };
    students.push(newStudent);
    this._write(this.KEYS.students, students);
    SupabaseSync.syncDoc('students', newStudent);
    this._saveStudentToSupabase(newStudent).catch(error => {
      console.warn('[Supabase] Unable to sync new student record:', error.message || error);
    });
    return newStudent;
  },
  updateStudent(id, updates) {
    const students = this.getAllStudentsRaw().map(s => s.id === id ? { ...s, ...updates } : s);
    this._write(this.KEYS.students, students);
    const updated = students.find(s => s.id === id);
    if (updated) SupabaseSync.syncDoc('students', updated);
    if (updated) {
      this._saveStudentToSupabase(updated).catch(error => {
        console.warn('[Supabase] Unable to sync updated student record:', error.message || error);
      });
    }
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
  },
  restoreStudent(id) {
    const students = this.getAllStudentsRaw().map(s => s.id === id ? { ...s, archived: false, archivedAt: null } : s);
    this._write(this.KEYS.students, students);
    const restored = students.find(s => s.id === id);
    if (restored) SupabaseSync.syncDoc('students', restored);
  },
  deleteStudent(id) {
    const students = this.getAllStudentsRaw().filter(s => s.id !== id);
    this._write(this.KEYS.students, students);
    SupabaseSync.deleteDoc('students', id);
  },
  studentExists(studentId) {
    return this.getStudents().some(s => s.studentId === studentId);
  },

  // ---- Subjects ----
  getSubjects() {
    return this._read(this.KEYS.subjects, []);
  },
  getSubject(id) {
    return this.getSubjects().find(s => s.id === id) || null;
  },
  addSubject(data) {
    const subjects = [...this.getSubjects()];
    const newSubject = { id: this.generateId(), createdAt: new Date().toISOString(), ...data };
    subjects.push(newSubject);
    this._write(this.KEYS.subjects, subjects);
    SupabaseSync.syncDoc('subjects', newSubject);
    return newSubject;
  },
  updateSubject(id, updates) {
    const subjects = this.getSubjects().map(s => s.id === id ? { ...s, ...updates } : s);
    this._write(this.KEYS.subjects, subjects);
    const updated = subjects.find(s => s.id === id);
    if (updated) SupabaseSync.syncDoc('subjects', updated);
  },
  deleteSubject(id) {
    const subjects = this.getSubjects().filter(s => s.id !== id);
    this._write(this.KEYS.subjects, subjects);
    SupabaseSync.deleteDoc('subjects', id);
  },

  // ---- Exams ----
  getExams() {
    return this._read(this.KEYS.exams, []);
  },
  getExam(id) {
    return this.getExams().find(e => e.id === id) || null;
  },
  getExamByCode(code) {
    return this.getExams().find(e => e.code === code.toUpperCase()) || null;
  },
  addExam(data) {
    const exams = [...this.getExams()];
    const newExam = { id: this.generateId(), createdAt: new Date().toISOString(), questions: [], ...data };
    exams.push(newExam);
    this._write(this.KEYS.exams, exams);
    SupabaseSync.syncDoc('exams', newExam);
    return newExam;
  },
  updateExam(id, updates) {
    const exams = this.getExams().map(e => e.id === id ? { ...e, ...updates } : e);
    this._write(this.KEYS.exams, exams);
    const updated = exams.find(e => e.id === id);
    if (updated) SupabaseSync.syncDoc('exams', updated);
  },
  deleteExam(id) {
    const exams = this.getExams().filter(e => e.id !== id);
    this._write(this.KEYS.exams, exams);
    SupabaseSync.deleteDoc('exams', id);
  },
  getActiveExams() {
    return this.getExams().filter(e => e.status === 'active');
  },

  // ---- Sessions ----
  getSessions() {
    return this._read(this.KEYS.sessions, []);
  },
  getSession(id) {
    return this.getSessions().find(s => s.id === id) || null;
  },
  getSessionsByExam(examId) {
    return this.getSessions().filter(s => s.examId === examId);
  },
  getStudentSession(examId, studentId) {
    return this.getSessions().find(s => s.examId === examId && s.studentId === studentId) || null;
  },
  addSession(data) {
    const sessions = [...this.getSessions()];
    const newSession = { id: this.generateId(), ...data };
    sessions.push(newSession);
    this._write(this.KEYS.sessions, sessions);
    SupabaseSync.syncDoc('sessions', newSession);
    return newSession;
  },
  updateSession(id, updates) {
    const sessions = this.getSessions().map(s => s.id === id ? { ...s, ...updates } : s);
    this._write(this.KEYS.sessions, sessions);
    const updated = sessions.find(s => s.id === id);
    if (updated) SupabaseSync.syncDoc('sessions', updated);
  },

  // ---- Logs ----
  getLogs() {
    return this._read(this.KEYS.logs, []);
  },
  addLog(data) {
    const logs = [...this.getLogs()];
    const newLog = { id: this.generateId(), timestamp: new Date().toISOString(), ...data };
    logs.push(newLog);
    this._write(this.KEYS.logs, logs);
    SupabaseSync.syncDoc('logs', newLog);
  },
  getLogsBySession(sessionId) {
    return this.getLogs().filter(l => l.sessionId === sessionId);
  },
};

// Auto-initialize on load (seeds localStorage defaults; Supabase data overwrites on dbReady)
DB.init();
window.addEventListener('storage', e => {
  if (e.key) DB.clearCacheKey(e.key);
  else DB.clearCache();
});

// Expose as global for ES-module consumers (React)
window.DB = DB;

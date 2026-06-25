// ============================================================
// DATA LAYER - localStorage cache + Firestore sync
// ============================================================

const DB = {
  KEYS: {
    settings: 'acs_settings',
    admins: 'acs_admins',
    students: 'acs_students',
    subjects: 'acs_subjects',
    exams: 'acs_exams',
    sessions: 'acs_sessions',
    logs: 'acs_logs',
  },
  _cache: {},

  normalizeEmail(email) {
    return String(email || '')
      .replace(/[\u200B-\u200D\uFEFF]/g, '')
      .trim()
      .toLowerCase()
      .replace(/\s+/g, '');
  },

  normalizeStudentId(studentId) {
    return String(studentId || '').trim().toUpperCase();
  },

  normalizeUsername(username) {
    return String(username || '').trim().toLowerCase();
  },

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

  init() {
    // Settings
    if (!localStorage.getItem(this.KEYS.settings)) {
      localStorage.setItem(this.KEYS.settings, JSON.stringify({
        schoolName: 'Pamantasan ng Lungsod ng Pasig',
        logoUrl: 'https://plpasig.edu.ph/wp-content/uploads/2023/01/cropped-logo120.png',
        department: '',
        adminName: 'Administrator',
        adminEmail: 'admin@school.edu',
        adminUsername: 'admin',
      }));
    } else {
      const settings = JSON.parse(localStorage.getItem(this.KEYS.settings) || '{}');
      const admins = JSON.parse(localStorage.getItem(this.KEYS.admins) || '[]');
      const primaryAdmin = admins[0] || {};
      if (!settings.adminUsername) {
        localStorage.setItem(this.KEYS.settings, JSON.stringify({
          ...settings,
          adminUsername: this.normalizeUsername(primaryAdmin.username || 'admin'),
        }));
      }
    }

    // Admins
    if (!localStorage.getItem(this.KEYS.admins)) {
      localStorage.setItem(this.KEYS.admins, JSON.stringify([
        { id: 'admin1', username: 'admin', password: 'admin123', name: 'Administrator', email: 'admin@school.edu' }
      ]));
    } else {
      const admins = JSON.parse(localStorage.getItem(this.KEYS.admins) || '[]');
      const normalizedAdmins = admins.map(admin => ({
        ...admin,
        username: this.normalizeUsername(admin.username),
        email: this.normalizeEmail(admin.email),
      }));
      localStorage.setItem(this.KEYS.admins, JSON.stringify(normalizedAdmins));
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
        const normalizedStudent = {
          ...s,
          studentId: this.normalizeStudentId(s.studentId),
          email: s.email ? this.normalizeEmail(s.email) : s.email,
        };
        if (oldFmt.test(s.studentId)) {
          const num = String(i + 1).padStart(5, '0');
          return { ...normalizedStudent, studentId: '26-' + num };
        }
        return normalizedStudent;
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
    FirebaseSync.syncSettings(next);
  },

  // ---- Admins ----
  getAdmins() {
    return this._read(this.KEYS.admins, []);
  },
  getAdmin(username) {
    const normalizedUsername = this.normalizeUsername(username);
    return this.getAdmins().find(a => this.normalizeUsername(a.username) === normalizedUsername) || null;
  },
  adminUsernameExists(username, excludeId = null) {
    const normalizedUsername = this.normalizeUsername(username);
    if (!normalizedUsername) return false;
    return this.getAdmins().some(admin =>
      admin.id !== excludeId &&
      this.normalizeUsername(admin.username) === normalizedUsername
    );
  },
  adminEmailExists(email, excludeId = null) {
    const normalizedEmail = this.normalizeEmail(email);
    if (!normalizedEmail) return false;
    return this.getAdmins().some(admin =>
      admin.id !== excludeId &&
      this.normalizeEmail(admin.email) === normalizedEmail
    );
  },
  updateAdmin(id, updates) {
    const nextUsername = Object.prototype.hasOwnProperty.call(updates, 'username')
      ? this.normalizeUsername(updates.username)
      : null;
    const nextEmail = Object.prototype.hasOwnProperty.call(updates, 'email')
      ? this.normalizeEmail(updates.email)
      : null;

    if (nextUsername && this.adminUsernameExists(nextUsername, id)) {
      throw new Error('That professor username is already in use.');
    }
    if (nextEmail && this.adminEmailExists(nextEmail, id)) {
      throw new Error('That professor email is already in use.');
    }

    const admins = this.getAdmins().map(a => a.id === id ? { ...a, ...updates } : a);
    const normalizedAdmins = admins.map(admin => admin.id !== id ? admin : {
      ...admin,
      username: nextUsername ?? admin.username,
      email: Object.prototype.hasOwnProperty.call(updates, 'email') ? nextEmail : admin.email,
    });
    this._write(this.KEYS.admins, normalizedAdmins);
    const updated = normalizedAdmins.find(a => a.id === id);
    if (updated) FirebaseSync.syncDoc('admins', updated);
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
    const normalizedStudentId = this.normalizeStudentId(studentId);
    return this.getStudents().find(s => this.normalizeStudentId(s.studentId) === normalizedStudentId) || null;
  },
  getStudentById(id) {
    return this.getAllStudentsRaw().find(s => s.id === id) || null;
  },
  getStudentByStudentId(studentId, options = {}) {
    const { includeArchived = false } = options;
    const normalizedStudentId = this.normalizeStudentId(studentId);
    const source = includeArchived ? this.getAllStudentsRaw() : this.getStudents();
    return source.find(s => this.normalizeStudentId(s.studentId) === normalizedStudentId) || null;
  },
  findStudentsByEmail(email, options = {}) {
    const { includeArchived = false } = options;
    const normalizedEmail = this.normalizeEmail(email);
    if (!normalizedEmail) return [];
    const source = includeArchived ? this.getAllStudentsRaw() : this.getStudents();
    return source.filter(student => this.normalizeEmail(student.email) === normalizedEmail);
  },
  findStudentByEmail(email, options = {}) {
    const students = this.findStudentsByEmail(email, options);
    if (!students.length) return null;
    const ranked = [...students].sort((a, b) => {
      if (Boolean(a.archived) !== Boolean(b.archived)) return a.archived ? 1 : -1;
      if (Boolean(a.password) !== Boolean(b.password)) return a.password ? -1 : 1;
      return String(b.updatedAt || b.createdAt || '').localeCompare(String(a.updatedAt || a.createdAt || ''));
    });
    return ranked[0] || null;
  },
  emailExists(email, excludeId = null) {
    const normalizedEmail = this.normalizeEmail(email);
    if (!normalizedEmail) return false;
    return this.getAllStudentsRaw().some(student =>
      student.id !== excludeId &&
      this.normalizeEmail(student.email) === normalizedEmail
    );
  },
  addStudent(data) {
    const studentId = this.normalizeStudentId(data.studentId);
    const email = data.email ? this.normalizeEmail(data.email) : '';
    if (this.studentExists(studentId)) {
      throw new Error('Student ID already exists.');
    }
    if (email && this.emailExists(email)) {
      throw new Error('Student email already exists.');
    }
    const students = [...this.getAllStudentsRaw()];
    const newStudent = {
      id: this.generateId(),
      ...data,
      studentId,
      email,
    };
    students.push(newStudent);
    this._write(this.KEYS.students, students);
    FirebaseSync.syncDoc('students', newStudent);
    return newStudent;
  },
  updateStudent(id, updates) {
    const currentStudent = this.getStudentById(id);
    if (!currentStudent) return;

    const hasStudentIdUpdate = Object.prototype.hasOwnProperty.call(updates, 'studentId');
    const hasEmailUpdate = Object.prototype.hasOwnProperty.call(updates, 'email');
    const nextStudentId = hasStudentIdUpdate ? this.normalizeStudentId(updates.studentId) : this.normalizeStudentId(currentStudent.studentId);
    const nextEmail = hasEmailUpdate ? this.normalizeEmail(updates.email) : this.normalizeEmail(currentStudent.email);

    if (nextStudentId && this.studentExists(nextStudentId, id)) {
      throw new Error('Student ID already exists.');
    }
    if (nextEmail && this.emailExists(nextEmail, id)) {
      throw new Error('Student email already exists.');
    }

    const students = this.getAllStudentsRaw().map(student => student.id === id ? {
      ...student,
      ...updates,
      studentId: nextStudentId,
      email: hasEmailUpdate ? nextEmail : student.email,
    } : student);
    this._write(this.KEYS.students, students);
    const updated = students.find(s => s.id === id);
    if (updated) FirebaseSync.syncDoc('students', updated);
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
      FirebaseSync.syncDoc('sessions', updatedSession);
      return updatedSession;
    });
    this._write(this.KEYS.sessions, sessions);

    const logs = this.getLogs().map(log => {
      if (log.studentId !== previousStudentId) return log;
      const updatedLog = { ...log, studentId: nextStudent.studentId };
      FirebaseSync.syncDoc('logs', updatedLog);
      return updatedLog;
    });
    this._write(this.KEYS.logs, logs);
  },
  archiveStudent(id) {
    const students = this.getAllStudentsRaw().map(s => s.id === id ? { ...s, archived: true, archivedAt: new Date().toISOString() } : s);
    this._write(this.KEYS.students, students);
    const archived = students.find(s => s.id === id);
    if (archived) FirebaseSync.syncDoc('students', archived);
  },
  restoreStudent(id) {
    const students = this.getAllStudentsRaw().map(s => s.id === id ? { ...s, archived: false, archivedAt: null } : s);
    this._write(this.KEYS.students, students);
    const restored = students.find(s => s.id === id);
    if (restored) FirebaseSync.syncDoc('students', restored);
  },
  deleteStudent(id) {
    const students = this.getAllStudentsRaw().filter(s => s.id !== id);
    this._write(this.KEYS.students, students);
    FirebaseSync.deleteDoc('students', id);
  },
  studentExists(studentId, excludeId = null) {
    const normalizedStudentId = this.normalizeStudentId(studentId);
    if (!normalizedStudentId) return false;
    return this.getAllStudentsRaw().some(student =>
      student.id !== excludeId &&
      this.normalizeStudentId(student.studentId) === normalizedStudentId
    );
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
    FirebaseSync.syncDoc('subjects', newSubject);
    return newSubject;
  },
  updateSubject(id, updates) {
    const subjects = this.getSubjects().map(s => s.id === id ? { ...s, ...updates } : s);
    this._write(this.KEYS.subjects, subjects);
    const updated = subjects.find(s => s.id === id);
    if (updated) FirebaseSync.syncDoc('subjects', updated);
  },
  deleteSubject(id) {
    const subjects = this.getSubjects().filter(s => s.id !== id);
    this._write(this.KEYS.subjects, subjects);
    FirebaseSync.deleteDoc('subjects', id);
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
    FirebaseSync.syncDoc('exams', newExam);
    return newExam;
  },
  updateExam(id, updates) {
    const exams = this.getExams().map(e => e.id === id ? { ...e, ...updates } : e);
    this._write(this.KEYS.exams, exams);
    const updated = exams.find(e => e.id === id);
    if (updated) FirebaseSync.syncDoc('exams', updated);
  },
  deleteExam(id) {
    const exams = this.getExams().filter(e => e.id !== id);
    this._write(this.KEYS.exams, exams);
    FirebaseSync.deleteDoc('exams', id);
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
    FirebaseSync.syncDoc('sessions', newSession);
    return newSession;
  },
  updateSession(id, updates) {
    const sessions = this.getSessions().map(s => s.id === id ? { ...s, ...updates } : s);
    this._write(this.KEYS.sessions, sessions);
    const updated = sessions.find(s => s.id === id);
    if (updated) FirebaseSync.syncDoc('sessions', updated);
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
    FirebaseSync.syncDoc('logs', newLog);
  },
  getLogsBySession(sessionId) {
    return this.getLogs().filter(l => l.sessionId === sessionId);
  },
};

// Auto-initialize on load (seeds localStorage defaults; Firebase data overwrites on firebaseReady)
DB.init();
window.addEventListener('storage', e => {
  if (e.key) DB.clearCacheKey(e.key);
  else DB.clearCache();
});

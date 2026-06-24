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

  init() {
    // Settings
    if (!localStorage.getItem(this.KEYS.settings)) {
      localStorage.setItem(this.KEYS.settings, JSON.stringify({
        schoolName: 'Pamantasan ng Lungsod ng Pasig',
        logoUrl: 'https://plpasig.edu.ph/wp-content/uploads/2023/01/cropped-logo120.png',
        adminName: 'Administrator',
        adminEmail: 'admin@school.edu',
      }));
    }

    // Admins
    if (!localStorage.getItem(this.KEYS.admins)) {
      localStorage.setItem(this.KEYS.admins, JSON.stringify([
        { id: 'admin1', username: 'admin', password: 'admin123', name: 'Administrator', email: 'admin@school.edu' }
      ]));
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
    return JSON.parse(localStorage.getItem(this.KEYS.settings)) || {};
  },
  updateSettings(updates) {
    const current = this.getSettings();
    const next = { ...current, ...updates };
    localStorage.setItem(this.KEYS.settings, JSON.stringify(next));
    FirebaseSync.syncSettings(next);
  },

  // ---- Admins ----
  getAdmins() {
    return JSON.parse(localStorage.getItem(this.KEYS.admins)) || [];
  },
  getAdmin(username) {
    return this.getAdmins().find(a => a.username === username) || null;
  },
  updateAdmin(id, updates) {
    const admins = this.getAdmins().map(a => a.id === id ? { ...a, ...updates } : a);
    localStorage.setItem(this.KEYS.admins, JSON.stringify(admins));
    const updated = admins.find(a => a.id === id);
    if (updated) FirebaseSync.syncDoc('admins', updated);
  },

  // ---- Students ----
  getStudents() {
    return (JSON.parse(localStorage.getItem(this.KEYS.students)) || []).filter(s => !s.archived);
  },
  getAllStudentsRaw() {
    return JSON.parse(localStorage.getItem(this.KEYS.students)) || [];
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
    const students = this.getStudents();
    const newStudent = { id: this.generateId(), ...data };
    students.push(newStudent);
    localStorage.setItem(this.KEYS.students, JSON.stringify(students));
    FirebaseSync.syncDoc('students', newStudent);
    return newStudent;
  },
  updateStudent(id, updates) {
    const students = this.getStudents().map(s => s.id === id ? { ...s, ...updates } : s);
    localStorage.setItem(this.KEYS.students, JSON.stringify(students));
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
      };
      FirebaseSync.syncDoc('sessions', updatedSession);
      return updatedSession;
    });
    localStorage.setItem(this.KEYS.sessions, JSON.stringify(sessions));

    const logs = this.getLogs().map(log => {
      if (log.studentId !== previousStudentId) return log;
      const updatedLog = { ...log, studentId: nextStudent.studentId };
      FirebaseSync.syncDoc('logs', updatedLog);
      return updatedLog;
    });
    localStorage.setItem(this.KEYS.logs, JSON.stringify(logs));
  },
  archiveStudent(id) {
    const students = this.getAllStudentsRaw().map(s => s.id === id ? { ...s, archived: true, archivedAt: new Date().toISOString() } : s);
    localStorage.setItem(this.KEYS.students, JSON.stringify(students));
    const archived = students.find(s => s.id === id);
    if (archived) FirebaseSync.syncDoc('students', archived);
  },
  restoreStudent(id) {
    const students = this.getAllStudentsRaw().map(s => s.id === id ? { ...s, archived: false, archivedAt: null } : s);
    localStorage.setItem(this.KEYS.students, JSON.stringify(students));
    const restored = students.find(s => s.id === id);
    if (restored) FirebaseSync.syncDoc('students', restored);
  },
  deleteStudent(id) {
    const students = this.getAllStudentsRaw().filter(s => s.id !== id);
    localStorage.setItem(this.KEYS.students, JSON.stringify(students));
    FirebaseSync.deleteDoc('students', id);
  },
  studentExists(studentId) {
    return this.getStudents().some(s => s.studentId === studentId);
  },

  // ---- Subjects ----
  getSubjects() {
    return JSON.parse(localStorage.getItem(this.KEYS.subjects)) || [];
  },
  getSubject(id) {
    return this.getSubjects().find(s => s.id === id) || null;
  },
  addSubject(data) {
    const subjects = this.getSubjects();
    const newSubject = { id: this.generateId(), createdAt: new Date().toISOString(), ...data };
    subjects.push(newSubject);
    localStorage.setItem(this.KEYS.subjects, JSON.stringify(subjects));
    FirebaseSync.syncDoc('subjects', newSubject);
    return newSubject;
  },
  updateSubject(id, updates) {
    const subjects = this.getSubjects().map(s => s.id === id ? { ...s, ...updates } : s);
    localStorage.setItem(this.KEYS.subjects, JSON.stringify(subjects));
    const updated = subjects.find(s => s.id === id);
    if (updated) FirebaseSync.syncDoc('subjects', updated);
  },
  deleteSubject(id) {
    const subjects = this.getSubjects().filter(s => s.id !== id);
    localStorage.setItem(this.KEYS.subjects, JSON.stringify(subjects));
    FirebaseSync.deleteDoc('subjects', id);
  },

  // ---- Exams ----
  getExams() {
    return JSON.parse(localStorage.getItem(this.KEYS.exams)) || [];
  },
  getExam(id) {
    return this.getExams().find(e => e.id === id) || null;
  },
  getExamByCode(code) {
    return this.getExams().find(e => e.code === code.toUpperCase()) || null;
  },
  addExam(data) {
    const exams = this.getExams();
    const newExam = { id: this.generateId(), createdAt: new Date().toISOString(), questions: [], ...data };
    exams.push(newExam);
    localStorage.setItem(this.KEYS.exams, JSON.stringify(exams));
    FirebaseSync.syncDoc('exams', newExam);
    return newExam;
  },
  updateExam(id, updates) {
    const exams = this.getExams().map(e => e.id === id ? { ...e, ...updates } : e);
    localStorage.setItem(this.KEYS.exams, JSON.stringify(exams));
    const updated = exams.find(e => e.id === id);
    if (updated) FirebaseSync.syncDoc('exams', updated);
  },
  deleteExam(id) {
    const exams = this.getExams().filter(e => e.id !== id);
    localStorage.setItem(this.KEYS.exams, JSON.stringify(exams));
    FirebaseSync.deleteDoc('exams', id);
  },
  getActiveExams() {
    return this.getExams().filter(e => e.status === 'active');
  },

  // ---- Sessions ----
  getSessions() {
    return JSON.parse(localStorage.getItem(this.KEYS.sessions)) || [];
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
    const sessions = this.getSessions();
    const newSession = { id: this.generateId(), ...data };
    sessions.push(newSession);
    localStorage.setItem(this.KEYS.sessions, JSON.stringify(sessions));
    FirebaseSync.syncDoc('sessions', newSession);
    return newSession;
  },
  updateSession(id, updates) {
    const sessions = this.getSessions().map(s => s.id === id ? { ...s, ...updates } : s);
    localStorage.setItem(this.KEYS.sessions, JSON.stringify(sessions));
    const updated = sessions.find(s => s.id === id);
    if (updated) FirebaseSync.syncDoc('sessions', updated);
  },

  // ---- Logs ----
  getLogs() {
    return JSON.parse(localStorage.getItem(this.KEYS.logs)) || [];
  },
  addLog(data) {
    const logs = this.getLogs();
    const newLog = { id: this.generateId(), timestamp: new Date().toISOString(), ...data };
    logs.push(newLog);
    localStorage.setItem(this.KEYS.logs, JSON.stringify(logs));
    FirebaseSync.syncDoc('logs', newLog);
  },
  getLogsBySession(sessionId) {
    return this.getLogs().filter(l => l.sessionId === sessionId);
  },
};

// Auto-initialize on load (seeds localStorage defaults; Firebase data overwrites on firebaseReady)
DB.init();

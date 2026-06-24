// ============================================================
// AUTH - Session management
// ============================================================

const Auth = {
  adminLogin(username, password) {
    const admin = DB.getAdmin(username);
    if (!admin) return { success: false, message: 'Invalid username or password.' };
    if (admin.password !== password) return { success: false, message: 'Invalid username or password.' };
    const session = { id: admin.id, username: admin.username, name: admin.name, email: admin.email, loginAt: new Date().toISOString() };
    sessionStorage.setItem('acs_admin_session', JSON.stringify(session));
    return { success: true, admin: session };
  },

  // --- New email-based student auth ---

  checkStudentEmail(email) {
    const e = email.trim().toLowerCase();
    const students = DB.getStudents();
    const student = students.find(s => s.email && s.email.toLowerCase() === e);
    if (!student) return { exists: false };
    if (!student.password) return { exists: true, needsSetup: true };
    return { exists: true, hasPassword: true };
  },

  studentLoginWithPassword(email, password) {
    const e = email.trim().toLowerCase();
    const students = DB.getStudents();
    const student = students.find(s => s.email && s.email.toLowerCase() === e);
    if (!student) return { success: false, message: 'No account found with this email.' };
    if (!student.password) return { success: false, message: 'Account setup incomplete. Please set up your account first.' };
    if (student.password !== password) return { success: false, message: 'Incorrect password. Please try again.' };
    const session = {
      studentId: student.studentId,
      studentName: student.name,
      yearLevel: student.yearLevel || '',
      section: student.section || '',
      email: student.email,
      loginAt: new Date().toISOString(),
    };
    sessionStorage.setItem('acs_student_session', JSON.stringify(session));
    return { success: true, session };
  },

  studentFirstSetup(email, studentId, password, fullName) {
    const e = email.trim().toLowerCase();
    const sid = studentId.trim().toUpperCase();
    const displayName = (fullName || '').trim();

    if (password.length < 6) return { success: false, message: 'Password must be at least 6 characters.' };

    // Check: is this email already fully registered?
    const students = DB.getStudents();
    const byEmail = students.find(s => s.email && s.email.toLowerCase() === e && s.password);
    if (byEmail) return { success: false, message: 'An account already exists with this email. Please sign in instead.' };

    // Look for existing student record by student ID
    const byId = students.find(s => s.studentId === sid);

    let student;
    if (byId) {
      // Existing student — link email + set password; update name if provided and still default
      const updates = { email: e, password };
      if (displayName && (byId.name === byId.studentId || !byId.name)) updates.name = displayName;
      DB.updateStudent(byId.id, updates);
      student = { ...byId, ...updates };
    } else {
      // New student — auto-create record
      const idMatch = sid.match(/^(\d{2})-\d{5}$/);
      if (!idMatch) return { success: false, message: 'Invalid Student ID format (use YY-NNNNN, e.g. 23-00218).' };
      const yr = parseInt(idMatch[1]);
      const currentYear = new Date().getFullYear();
      const diff = currentYear - (2000 + yr);
      const yearLevels = ['1st Year', '2nd Year', '3rd Year', '4th Year'];
      const yearLevel = yearLevels[Math.max(0, Math.min(diff, 3))];
      const name = displayName || sid;
      student = DB.addStudent({ studentId: sid, name, email: e, password, yearLevel, section: '', enrolledSubjects: [] });
    }

    const session = {
      studentId: student.studentId,
      studentName: student.name,
      yearLevel: student.yearLevel || '',
      section: student.section || '',
      email: e,
      loginAt: new Date().toISOString(),
    };
    sessionStorage.setItem('acs_student_session', JSON.stringify(session));
    return { success: true, session };
  },

  // Legacy: studentSetup used by old exam.js entry form
  studentSetup(studentId, examCode) {
    if (!studentId || !studentId.trim()) return { success: false, message: 'Student ID is required.' };
    if (!examCode || !examCode.trim()) return { success: false, message: 'Exam code is required.' };

    const student = DB.getStudent(studentId.trim().toUpperCase());
    if (!student) return { success: false, message: 'Student ID not found. Please contact your instructor.' };

    const exam = DB.getExamByCode(examCode.trim().toUpperCase());
    if (!exam) return { success: false, message: 'Invalid exam code.' };
    if (exam.status === 'draft') return { success: false, message: 'This exam is not yet ready.' };
    if (exam.status === 'closed' || exam.status === 'archived') {
      // Allow through if student has a submitted session — they can view their result
      const sid = studentId.trim().toUpperCase();
      const existing = DB.getStudentSession(exam.id, sid);
      if (existing && existing.submitted) {
        const studentInfo = student;
        const session = {
          studentId: studentInfo.studentId,
          studentName: studentInfo.name,
          yearLevel: studentInfo.yearLevel || '',
          section: studentInfo.section || '',
          examCode: examCode.trim().toUpperCase(),
          examId: exam.id,
          setupAt: new Date().toISOString(),
        };
        sessionStorage.setItem('acs_student_session', JSON.stringify(session));
        return { success: true, session, exam };
      }
      return { success: false, message: 'This exam has already ended.' };
    }

    const studentInfo = student;
    const session = {
      studentId: studentInfo.studentId,
      studentName: studentInfo.name,
      yearLevel: studentInfo.yearLevel || '',
      section: studentInfo.section || '',
      examCode: examCode.trim().toUpperCase(),
      examId: exam.id,
      setupAt: new Date().toISOString(),
    };
    sessionStorage.setItem('acs_student_session', JSON.stringify(session));
    return { success: true, session, exam };
  },

  getAdminSession() {
    try { return JSON.parse(sessionStorage.getItem('acs_admin_session')); } catch { return null; }
  },

  getStudentSession() {
    try { return JSON.parse(sessionStorage.getItem('acs_student_session')); } catch { return null; }
  },

  clearAdminSession() {
    sessionStorage.removeItem('acs_admin_session');
  },

  clearStudentSession() {
    sessionStorage.removeItem('acs_student_session');
  },

  requireAdmin() {
    if (!this.getAdminSession()) {
      window.location.href = 'index.html';
      return false;
    }
    return true;
  },

  requireStudent() {
    if (!this.getStudentSession()) {
      window.location.href = 'index.html';
      return false;
    }
    return true;
  },
};

// Expose as global for ES-module consumers (React)
window.Auth = Auth;

// ============================================================
// AUTH - Session management
// ============================================================

const Auth = {
  ADMIN_RESET_KEY: 'acs_admin_reset',
  STUDENT_VERIFY_KEY: 'acs_student_email_verify',

  adminLogin(username, password) {
    const admin = DB.getAdmin(username);
    if (!admin) return { success: false, message: 'Invalid username or password.' };
    if (admin.password !== password) return { success: false, message: 'Invalid username or password.' };
    const session = { id: admin.id, username: admin.username, name: admin.name, email: admin.email, loginAt: new Date().toISOString() };
    sessionStorage.setItem('acs_admin_session', JSON.stringify(session));
    return { success: true, admin: session };
  },

  beginAdminPasswordReset(email) {
    const e = email.trim().toLowerCase();
    const admin = DB.getAdmins().find(a => a.email && a.email.toLowerCase() === e);
    if (!admin) return { success: false, message: 'No professor account found with that email address.' };

    const code = String(Math.floor(100000 + Math.random() * 900000));
    const payload = {
      adminId: admin.id,
      email: e,
      code,
      verified: false,
      createdAt: Date.now(),
      expiresAt: Date.now() + (10 * 60 * 1000),
    };
    sessionStorage.setItem(this.ADMIN_RESET_KEY, JSON.stringify(payload));
    return {
      success: true,
      email: e,
      previewCode: code,
      message: 'Verification code generated. Enter the 6-digit code to continue.',
    };
  },

  verifyAdminResetCode(email, code) {
    const pending = this.getAdminPasswordReset();
    const normalizedEmail = email.trim().toLowerCase();
    const normalizedCode = String(code || '').trim();
    if (!pending || pending.email !== normalizedEmail) {
      return { success: false, message: 'Reset session not found. Please request a new code.' };
    }
    if (Date.now() > pending.expiresAt) {
      sessionStorage.removeItem(this.ADMIN_RESET_KEY);
      return { success: false, message: 'That verification code has expired. Please request a new one.' };
    }
    if (pending.code !== normalizedCode) {
      return { success: false, message: 'Incorrect verification code. Please try again.' };
    }

    sessionStorage.setItem(this.ADMIN_RESET_KEY, JSON.stringify({
      ...pending,
      verified: true,
      verifiedAt: Date.now(),
    }));
    return { success: true };
  },

  completeAdminPasswordReset(email, password) {
    const pending = this.getAdminPasswordReset();
    const normalizedEmail = email.trim().toLowerCase();
    if (!pending || pending.email !== normalizedEmail) {
      return { success: false, message: 'Reset session not found. Please request a new code.' };
    }
    if (Date.now() > pending.expiresAt) {
      sessionStorage.removeItem(this.ADMIN_RESET_KEY);
      return { success: false, message: 'That verification code has expired. Please request a new one.' };
    }
    if (!pending.verified) {
      return { success: false, message: 'Please verify the 6-digit code first.' };
    }
    if (!password || password.length < 6) {
      return { success: false, message: 'Password must be at least 6 characters.' };
    }

    const admin = DB.getAdmins().find(a => a.id === pending.adminId);
    if (!admin) {
      sessionStorage.removeItem(this.ADMIN_RESET_KEY);
      return { success: false, message: 'Professor account not found.' };
    }

    DB.updateAdmin(admin.id, { password });
    sessionStorage.removeItem(this.ADMIN_RESET_KEY);
    return { success: true, username: admin.username };
  },

  getAdminPasswordReset() {
    try { return JSON.parse(sessionStorage.getItem(this.ADMIN_RESET_KEY)); } catch { return null; }
  },

  clearAdminPasswordReset() {
    sessionStorage.removeItem(this.ADMIN_RESET_KEY);
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

  beginStudentEmailVerification(email) {
    const e = email.trim().toLowerCase();
    if (!e.endsWith('@plpasig.edu.ph')) {
      return { success: false, message: 'Only @plpasig.edu.ph email addresses are allowed.' };
    }

    const studentStatus = this.checkStudentEmail(e);
    const code = String(Math.floor(100000 + Math.random() * 900000));
    const payload = {
      email: e,
      code,
      verified: false,
      hasPassword: !!studentStatus.hasPassword,
      needsSetup: !!studentStatus.needsSetup || !studentStatus.exists,
      createdAt: Date.now(),
      expiresAt: Date.now() + (10 * 60 * 1000),
    };
    sessionStorage.setItem(this.STUDENT_VERIFY_KEY, JSON.stringify(payload));
    return {
      success: true,
      email: e,
      previewCode: code,
      hasPassword: payload.hasPassword,
      needsSetup: payload.needsSetup,
      message: 'Verification code generated. Enter the 6-digit code to continue.',
    };
  },

  verifyStudentEmailCode(email, code) {
    const pending = this.getStudentEmailVerification();
    const normalizedEmail = email.trim().toLowerCase();
    const normalizedCode = String(code || '').trim();
    if (!pending || pending.email !== normalizedEmail) {
      return { success: false, message: 'Verification session not found. Please request a new code.' };
    }
    if (Date.now() > pending.expiresAt) {
      sessionStorage.removeItem(this.STUDENT_VERIFY_KEY);
      return { success: false, message: 'That verification code has expired. Please request a new one.' };
    }
    if (pending.code !== normalizedCode) {
      return { success: false, message: 'Incorrect verification code. Please try again.' };
    }
    const verified = { ...pending, verified: true, verifiedAt: Date.now() };
    sessionStorage.setItem(this.STUDENT_VERIFY_KEY, JSON.stringify(verified));
    return {
      success: true,
      hasPassword: !!verified.hasPassword,
      needsSetup: !!verified.needsSetup,
    };
  },

  getStudentEmailVerification() {
    try { return JSON.parse(sessionStorage.getItem(this.STUDENT_VERIFY_KEY)); } catch { return null; }
  },

  clearStudentEmailVerification() {
    sessionStorage.removeItem(this.STUDENT_VERIFY_KEY);
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
      yearSection: student.yearSection || '',
      department: student.department || '',
      program: student.program || '',
      email: student.email,
      loginAt: new Date().toISOString(),
    };
    sessionStorage.setItem('acs_student_session', JSON.stringify(session));
    return { success: true, session };
  },

  studentFirstSetup(email, studentId, password, fullName, yearSection, department, program) {
    const e = email.trim().toLowerCase();
    const sid = studentId.trim().toUpperCase();
    const displayName = (fullName || '').trim();
    const normalizedYearSection = (yearSection || '').trim().toUpperCase();
    const yearSectionMatch = normalizedYearSection.match(/^([1-4])-([A-Z])$/);
    const selectedDepartment = (department || '').trim();
    const selectedProgram = (program || '').trim().toUpperCase();

    if (password.length < 6) return { success: false, message: 'Password must be at least 6 characters.' };
    if (!yearSectionMatch) return { success: false, message: 'Year & section must use the format 3-B.' };
    if (!selectedDepartment) return { success: false, message: 'Department is required.' };
    if (!selectedProgram) return { success: false, message: 'Program is required.' };

    const yearMap = { '1': '1st Year', '2': '2nd Year', '3': '3rd Year', '4': '4th Year' };
    const parsedYearLevel = yearMap[yearSectionMatch[1]] || '';
    const parsedSection = `Section ${yearSectionMatch[2]}`;

    // Check: is this email already fully registered?
    const students = DB.getStudents();
    const byEmail = students.find(s => s.email && s.email.toLowerCase() === e && s.password);
    if (byEmail) return { success: false, message: 'An account already exists with this email. Please sign in instead.' };

    // Look for existing student record by student ID
    const byId = students.find(s => s.studentId === sid);

    let student;
    if (byId) {
      // Existing student — link email + set password; update name if provided and still default
      const updates = { email: e, password, yearLevel: parsedYearLevel, section: parsedSection, yearSection: normalizedYearSection, department: selectedDepartment, program: selectedProgram };
      if (displayName && (byId.name === byId.studentId || !byId.name)) updates.name = displayName;
      DB.updateStudent(byId.id, updates);
      student = { ...byId, ...updates };
    } else {
      // New student — auto-create record
      const idMatch = sid.match(/^(\d{2})-\d{5}$/);
      if (!idMatch) return { success: false, message: 'Invalid Student ID format (use YY-NNNNN, e.g. 23-00218).' };
      const name = displayName || sid;
      student = DB.addStudent({ studentId: sid, name, email: e, password, yearLevel: parsedYearLevel, section: parsedSection, yearSection: normalizedYearSection, department: selectedDepartment, program: selectedProgram, enrolledSubjects: [] });
    }

    const session = {
      studentId: student.studentId,
      studentName: student.name,
      yearLevel: student.yearLevel || '',
      section: student.section || '',
      yearSection: student.yearSection || normalizedYearSection,
      department: student.department || selectedDepartment,
      program: student.program || selectedProgram,
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
    try {
      const session = JSON.parse(sessionStorage.getItem('acs_student_session'));
      if (!session) return null;
      const student = session.studentId ? DB.getStudent(session.studentId) : null;
      if (!student) return session;
      return {
        ...session,
        email: session.email || student.email || '',
        yearLevel: session.yearLevel || student.yearLevel || '',
        section: session.section || student.section || '',
        yearSection: session.yearSection || student.yearSection || '',
        department: session.department || student.department || '',
        program: session.program || student.program || '',
      };
    } catch { return null; }
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

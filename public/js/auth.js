// ============================================================
// AUTH - Session management
// ============================================================

const Auth = {
  ADMIN_RESET_KEY: 'acs_admin_reset',
  STUDENT_VERIFY_KEY: 'acs_student_email_verify',
  STUDENT_RESET_KEY: 'acs_student_reset',

  async _post(path, payload) {
    let response;
    try {
      response = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload || {}),
      });
    } catch (error) {
      return { success: false, message: error instanceof Error ? error.message : 'Unable to reach the authentication server.' };
    }

    const data = await response.json().catch(() => ({}));
    if (!response.ok || data?.success === false) {
      return {
        success: false,
        message: data?.message || 'Unable to complete the request right now.',
      };
    }
    return data;
  },

  _postKeepalive(path, payload) {
    fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload || {}),
      keepalive: true,
    }).catch(() => {});
  },

  async adminLogin(username, password) {
    const result = await this._post('/api/auth/professor/login', { username, password });
    if (!result.success) return result;
    sessionStorage.setItem('acs_admin_session', JSON.stringify(result.admin));
    return result;
  },

  async beginAdminPasswordReset(email) {
    return this._post('/api/auth/professor/reset/request', { email });
  },

  async verifyAdminResetCode(email, code) {
    return this._post('/api/auth/professor/reset/verify', { email, code });
  },

  async completeAdminPasswordReset(email, password) {
    return this._post('/api/auth/professor/reset/complete', { email, password });
  },

  async verifyAdminPassword(admin, password) {
    return !!(await this._post('/api/auth/professor/verify', {
      id: admin?.id || null,
      password,
    }))?.success;
  },

  async changeProfessorPassword(id, currentPassword, newPassword) {
    return this._post('/api/auth/professor/change-password', {
      id,
      currentPassword,
      newPassword,
    });
  },

  async saveProfessorAccount(id, data) {
    return this._post('/api/auth/professor/save', {
      id: id || null,
      ...data,
    });
  },

  async deleteProfessorAccount(id) {
    return this._post('/api/auth/professor/delete', { id });
  },

  async validateAdminSession() {
    const result = await this._post('/api/auth/professor/session', {});
    if (!result?.success || !result.admin) {
      this.clearAdminSession();
      return null;
    }
    sessionStorage.setItem('acs_admin_session', JSON.stringify(result.admin));
    return result.admin;
  },

  getAdminPasswordReset() {
    try { return JSON.parse(sessionStorage.getItem(this.ADMIN_RESET_KEY)); } catch { return null; }
  },

  clearAdminPasswordReset() {
    sessionStorage.removeItem(this.ADMIN_RESET_KEY);
  },

  // --- New email-based student auth ---

  async checkStudentEmail(email) {
    const result = await this._post('/api/auth/student/status', { email });
    if (result && !Object.prototype.hasOwnProperty.call(result, 'success')) {
      return { success: true, ...result };
    }
    return result;
  },

  async beginStudentEmailVerification(email) {
    return this._post('/api/auth/student/verification/request', { email });
  },

  async verifyStudentEmailCode(email, code) {
    return this._post('/api/auth/student/verification/verify', { email, code });
  },

  getStudentEmailVerification() {
    try { return JSON.parse(sessionStorage.getItem(this.STUDENT_VERIFY_KEY)); } catch { return null; }
  },

  clearStudentEmailVerification() {
    sessionStorage.removeItem(this.STUDENT_VERIFY_KEY);
  },

  async beginStudentPasswordReset(email) {
    return this._post('/api/auth/student/reset/request', { email });
  },

  async verifyStudentResetCode(email, code) {
    return this._post('/api/auth/student/reset/verify', { email, code });
  },

  async completeStudentPasswordReset(email, password) {
    return this._post('/api/auth/student/reset/complete', { email, password });
  },

  async verifyStudentPassword(student, password) {
    return !!(await this._post('/api/auth/student/verify', {
      studentId: student?.studentId || '',
      password,
    }))?.success;
  },

  async changeStudentPassword(studentId, currentPassword, newPassword) {
    return this._post('/api/auth/student/change-password', {
      studentId,
      currentPassword,
      newPassword,
    });
  },

  async validateStudentSession() {
    const result = await this._post('/api/auth/student/session', {});
    if (!result?.success || !result.session) {
      this.clearStudentSession();
      return null;
    }
    sessionStorage.setItem('acs_student_session', JSON.stringify(result.session));
    return result.session;
  },

  getStudentPasswordReset() {
    try { return JSON.parse(sessionStorage.getItem(this.STUDENT_RESET_KEY)); } catch { return null; }
  },

  clearStudentPasswordReset() {
    sessionStorage.removeItem(this.STUDENT_RESET_KEY);
  },

  async studentLoginWithPassword(email, password) {
    const result = await this._post('/api/auth/student/login', { email, password });
    if (!result.success) return result;
    sessionStorage.setItem('acs_student_session', JSON.stringify(result.session));
    return result;
  },

  async studentFirstSetup(email, studentId, password, fullName, yearSection, department, program) {
    const result = await this._post('/api/auth/student/setup', {
      email,
      studentId,
      password,
      fullName,
      yearSection,
      department,
      program,
    });
    if (!result.success) return result;
    sessionStorage.setItem('acs_student_session', JSON.stringify(result.session));
    return result;
  },

  // Legacy: studentSetup used by old exam.js entry form
  studentSetup(studentId, examCode) {
    if (!studentId || !studentId.trim()) return { success: false, message: 'Student ID is required.' };
    if (!examCode || !examCode.trim()) return { success: false, message: 'Exam access code is required.' };

    const student = DB.getStudent(studentId.trim().toUpperCase());
    if (!student) return { success: false, message: 'Student ID not found. Please contact your instructor.' };

    const exam = DB.getExamByCode(examCode.trim().toUpperCase());
    if (!exam) return { success: false, message: 'Invalid exam access code.' };
    if (!(student.enrolledSubjects || []).includes(exam.subjectId)) {
      return { success: false, message: 'You are not enrolled in the course for this exam.' };
    }
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
    try {
      const session = JSON.parse(sessionStorage.getItem('acs_admin_session'));
      if (!session) return null;
      if (!session.id) return session;
      const admins = DB.getAdmins();
      // Empty list almost always means the professors table just hasn't been pulled
      // yet (e.g. very early at boot) — don't punish a valid session for a cold
      // cache. Once the list IS populated and the id genuinely isn't in it, the
      // account was deleted out from under this tab.
      if (!admins.length) return session;
      const admin = admins.find(a => a.id === session.id);
      if (!admin) return session;
      return {
        ...session,
        username: admin.username || session.username,
        name: admin.name || session.name,
        email: admin.email || session.email || '',
        department: admin.department || session.department || '',
      };
    } catch { return null; }
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
    this._postKeepalive('/api/auth/professor/logout', {});
  },

  clearStudentSession() {
    sessionStorage.removeItem('acs_student_session');
    this._postKeepalive('/api/auth/student/logout', {});
  },

  requireAdmin() {
    if (!this.getAdminSession()) {
      window.location.href = 'index.html';
      return false;
    }
    return true;
  },

  // ---- System Admin (sysadmin) ----
  async sysAdminLogin(username, password) {
    const result = await this._post('/api/auth/sysadmin/login', { username, password });
    if (!result.success) return result;
    sessionStorage.setItem('acs_sysadmin_session', JSON.stringify(result.session));
    return result;
  },

  async verifySysAdminPassword(password) {
    return !!(await this._post('/api/auth/sysadmin/verify', {
      password,
    }))?.success;
  },

  async changeSysAdminPassword(currentPassword, newPassword) {
    return this._post('/api/auth/sysadmin/change-password', {
      currentPassword,
      newPassword,
    });
  },

  async saveSysAdminProfile(data) {
    return this._post('/api/auth/sysadmin/profile/save', data);
  },

  async saveSystemSettings(data) {
    return this._post('/api/auth/settings/save', data);
  },

  async refreshAdminsFromSupabase() {
    return DB.refreshAdminsFromSupabase?.();
  },

  async refreshStudentRecord(studentId) {
    return DB.getStudentByStudentIdAsync?.(studentId, { fallbackLocal: true });
  },

  async refreshStudentEmail(id, studentId, email) {
    return DB.ensureStudentEmailInSupabase?.({ id, studentId, email });
  },

  async refreshStudentSessionFromRecord(studentId) {
    const session = this.getStudentSession();
    const student = await DB.getStudentByStudentIdAsync?.(studentId, { fallbackLocal: true });
    if (!session || !student) return student || null;

    const nextSession = {
      ...session,
      studentId: student.studentId,
      studentName: student.name || session.studentName,
      yearLevel: student.yearLevel || '',
      section: student.section || '',
      yearSection: student.yearSection || '',
      department: student.department || '',
      program: student.program || '',
      email: student.email || session.email || '',
    };
    sessionStorage.setItem('acs_student_session', JSON.stringify(nextSession));
    return student;
  },

  async refreshSysAdminSession() {
    const session = await this.validateSysAdminSession();
    return session ? { success: true, session } : { success: false, message: 'System administrator session not found.' };
  },

  getSysAdminSession() {
    try { return JSON.parse(sessionStorage.getItem('acs_sysadmin_session')); } catch { return null; }
  },

  async validateSysAdminSession() {
    const result = await this._post('/api/auth/sysadmin/session', {});
    if (!result?.success || !result.session) {
      this.clearSysAdminSession();
      return null;
    }
    sessionStorage.setItem('acs_sysadmin_session', JSON.stringify(result.session));
    return result.session;
  },

  clearSysAdminSession() {
    sessionStorage.removeItem('acs_sysadmin_session');
    this._postKeepalive('/api/auth/sysadmin/logout', {});
  },

  requireSysAdmin() {
    if (!this.getSysAdminSession()) {
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

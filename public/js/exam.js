// ============================================================
// EXAM APP - Student Exam Logic
// ============================================================

const ExamApp = {
  session: null,            // DB session object
  exam: null,               // DB exam object
  warnings: 0,
  timerInterval: null,
  pollInterval: null,
  anticheatListeners: [],
  answers: {},              // { questionId: value }
  questionOrder: [],        // shuffled question list
  currentQuestionIndex: 0, // index of currently displayed question
  markedForReview: new Set(), // set of question indices marked for review
  timeRemaining: 0,
  _blurTimer: null,         // debounce timer for window blur
  _countdownInterval: null, // 10-second return-window countdown
  _warningReadTimer: null,  // 3-second read timer after student returns
  _inReadCountdown: false,  // true while the 3-second read overlay is showing
  _lastWarningTime: null,
  _cameraStream: null,      // MediaStream from camera
  _snapInterval: null,      // periodic snapshot interval
  _cameraPrompting: false,  // true while camera permission dialog is open
  _motionInterval: null,    // motion detection interval
  _prevFrameData: null,
  _slowFrameData: null,
  _slowFrameCount: 0,
  _noMotionSec: 0,
  _MOTION_THRESHOLD: 10,
  _PRESENCE_THRESHOLD: 5,
  _NO_MOTION_WARN: 20,
  _faceModel: null,
  _faceModelReady: false,
  _motionBlocked: false,    // true if exam is blocked due to no person detected
  _brightnessBaseline: null, // luminance baseline recorded at exam start
  _darkSeconds: 0,           // consecutive seconds below brightness threshold
  _brightnessWarningIssued: false, // prevent repeated brightness warnings
  _dashInterval: null,      // dashboard poll interval
  _fullscreenInteractionGraceUntil: 0,
  _pendingFullscreenRecovery: null,
  _fullscreenVerifyTimer: null,
  _recentClipboardShortcut: null,
  _intentionalFullscreenExit: false,

  _repairStudentEmail(studentSession) {
    if (!studentSession?.studentId || !studentSession?.email) return;
    DB.ensureStudentEmailInSupabase({
      studentId: studentSession.studentId,
      email: studentSession.email,
    }).catch(error => {
      console.warn('[Supabase] Unable to repair student email:', error.message || error);
    });
  },

  _recordActivity(type, detail) {
    if (!this.session) return null;
    const session = DB.getSession(this.session.id);
    if (!session) return null;

    const activity = {
      type,
      detail,
      timestamp: new Date().toISOString(),
    };
    const activities = [...(session.activities || []), activity];
    DB.updateSession(this.session.id, { activities });

    if (this.exam?.id) {
      DB.addLog({
        sessionId: this.session.id,
        studentId: this.session.studentId,
        examId: this.exam.id,
        type,
        details: detail,
      });
    }

    return activity;
  },

  _isFullscreenActive() {
    return !!(document.fullscreenElement || document.webkitFullscreenElement);
  },

  _scheduleFullscreenEnforcement(delayMs = 350) {
    if (this._fullscreenVerifyTimer) clearTimeout(this._fullscreenVerifyTimer);
    this._fullscreenVerifyTimer = setTimeout(() => {
      this._fullscreenVerifyTimer = null;
      if (!this._isFullscreenActive()) this._showFullscreenLock();
    }, delayMs);
  },

  _portalIcon(name, options = {}) {
    const size = options.size || 14;
    const stroke = options.stroke || 'currentColor';
    const icons = {
      arrowLeft: `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${stroke}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/><path d="M21 12H9"/></svg>`,
      arrowRight: `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${stroke}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12h12"/><path d="m15 6 6 6-6 6"/></svg>`,
      camera: `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${stroke}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 7l-7 5 7 5V7z"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/></svg>`,
      users: `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${stroke}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>`,
      clipboard: `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${stroke}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="8" y="2" width="8" height="4" rx="1" ry="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/></svg>`,
      check: `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${stroke}" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>`,
      x: `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${stroke}" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>`,
      checkCircle: `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${stroke}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 12l2 2 4-4"/><circle cx="12" cy="12" r="10"/></svg>`,
    };
    const svg = icons[name] || '';
    return `<span aria-hidden="true" style="display:inline-flex;align-items:center;justify-content:center;width:${size}px;height:${size}px;flex:0 0 ${size}px;">${svg}</span>`;
  },

  _portalLabel(iconName, label, options = {}) {
    const icon = this._portalIcon(iconName, options);
    const safeLabel = _esc(String(label || ''));
    const gap = options.gap || 6;

    return options.trailing
      ? `<span style="display:inline-flex;align-items:center;gap:${gap}px;"><span>${safeLabel}</span>${icon}</span>`
      : `<span style="display:inline-flex;align-items:center;gap:${gap}px;">${icon}<span>${safeLabel}</span></span>`;
  },

  _formatExamCardDate(value) {
    const date = value ? new Date(value) : null;
    if (!date || Number.isNaN(date.getTime())) return 'Date unavailable';
    return date.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  },

  _formatExamCardDateTime(value) {
    const date = value ? new Date(value) : null;
    if (!date || Number.isNaN(date.getTime())) return 'Date unavailable';
    return date.toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  },

  _submittedDetailIcon(type) {
    const icons = {
      student: '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>',
      exam: '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>',
      date: '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>',
    };
    return icons[type] || icons.exam;
  },

  _isEditableTarget(target) {
    if (!target || typeof target.matches !== 'function') return false;
    return target.matches('input, textarea, [contenteditable="true"], [contenteditable=""], .essay-textarea');
  },

  _markClipboardShortcut(type) {
    this._recentClipboardShortcut = { type, time: Date.now() };
  },

  _consumeRecentClipboardShortcut(type, maxAgeMs = 400) {
    const recent = this._recentClipboardShortcut;
    if (!recent || recent.type !== type) return false;
    const isFresh = Date.now() - recent.time <= maxAgeMs;
    if (isFresh) {
      this._recentClipboardShortcut = null;
      return true;
    }
    return false;
  },

  _ensureToastContainer() {
    let container = document.getElementById('toast-container');
    if (!container) {
      container = document.createElement('div');
      container.id = 'toast-container';
      document.body.appendChild(container);
    }
    return container;
  },

  _showToast(message, type = 'success', options = {}) {
    const icons = {
      success: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>',
      error: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>',
      warning: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
      info: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>',
    };
    const container = this._ensureToastContainer();
    const toast = document.createElement('div');
    const variant = options.variant || 'default';
    toast.className = `toast ${type}${variant === 'settings' ? ' toast-settings' : ''}`;
    toast.innerHTML = variant === 'settings'
      ? `<span class="toast-settings-icon">${icons[type] || icons.info}</span><span class="toast-message">${_esc(message)}</span>`
      : `<span class="toast-icon">${icons[type] || icons.info}</span><span class="toast-message">${_esc(message)}</span>`;
    container.appendChild(toast);
    setTimeout(() => {
      toast.classList.add('removing');
      setTimeout(() => toast.remove(), 350);
    }, 3500);
  },

  _readPortalRoute() {
    const params = new URLSearchParams(window.location.search);
    const portal = params.get('portal');
    const courseId = params.get('course');
    const courseTab = params.get('courseTab');

    if (portal === 'settings') return { view: 'settings' };
    if (portal === 'course' && courseId) {
      return {
        view: 'course',
        courseId,
        courseTab: ['exams', 'people'].includes(courseTab) ? courseTab : 'exams',
      };
    }
    return { view: 'home' };
  },

  _writePortalRoute(route = { view: 'home' }) {
    const url = new URL(window.location.href);
    if (route.view === 'settings') {
      url.searchParams.set('portal', 'settings');
      url.searchParams.delete('course');
      url.searchParams.delete('courseTab');
    } else if (route.view === 'course' && route.courseId) {
      url.searchParams.set('portal', 'course');
      url.searchParams.set('course', route.courseId);
      url.searchParams.set('courseTab', ['people', 'exams'].includes(route.courseTab) ? route.courseTab : 'exams');
    } else {
      url.searchParams.delete('portal');
      url.searchParams.delete('course');
      url.searchParams.delete('courseTab');
    }
    window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`);
  },

  _refreshPortalIdentity(sess) {
    if (!sess) return;
    const name = sess.studentName || sess.studentId || 'Student';
    const initial = name.charAt(0).toUpperCase() || 'S';

    const topbarAvatar = document.getElementById('portal-topbar-avatar');
    const topbarName = document.getElementById('portal-topbar-name');
    const footerAvatar = document.getElementById('portal-avatar');
    const footerName = document.getElementById('portal-footer-name');
    const footerMeta = document.getElementById('portal-footer-id');

    if (topbarAvatar) topbarAvatar.textContent = initial;
    if (topbarName) topbarName.textContent = name;
    if (footerAvatar) footerAvatar.textContent = initial;
    if (footerName) footerName.textContent = name;
    if (footerMeta) footerMeta.textContent = this._formatFooterMeta(sess);
  },

  // ============================================================
  // INIT
  // ============================================================
  init() {
    const studentSession = Auth.getStudentSession();

    if (!studentSession) {
      // No session at all — redirect to login
      window.location.href = 'index.html';
      return;
    }

    this._repairStudentEmail(studentSession);

    // If no exam code selected yet, show dashboard
    if (!studentSession.examCode) {
      this.showDashboard(studentSession);
      return;
    }

    // We have an examCode — proceed with exam flow
    this._startExamFlow(studentSession);
  },

  _startExamFlow(studentSession) {
    // Stop any running dashboard poll
    if (this._dashInterval) { clearInterval(this._dashInterval); this._dashInterval = null; }

    const exam = DB.getExamByCode(studentSession.examCode);
    if (!exam) {
      // Exam code invalid — clear it and go back to dashboard
      const sess = { ...studentSession };
      delete sess.examCode;
      delete sess.examId;
      sessionStorage.setItem('acs_student_session', JSON.stringify(sess));
      this.showDashboard(sess);
      return;
    }

    this.exam = exam;

    // Check if there's an existing DB session for this student+exam
    const existingSession = DB.getStudentSession(exam.id, studentSession.studentId);

    if (existingSession && existingSession.submitted) {
      this.session = existingSession;
      this._showSubmitted(false);
      return;
    }

    if (existingSession && !existingSession.submitted) {
      this.session = existingSession;
      this.warnings = existingSession.warnings || 0;
      this.answers = existingSession.answers || {};
    }

    if (exam.status === 'draft') {
      this._showError('This exam is not yet available. Please wait for your instructor.');
      return;
    }

    if (exam.status === 'ready') {
      this._renderWaitingInfo(studentSession, exam);
      this.showState('waiting');
      this.startWaitingPoll();
      return;
    }

    if (exam.status === 'active') {
      if (!this.session) {
        const student = DB.getStudent(studentSession.studentId);
        this.session = DB.addSession({
          examId: exam.id,
          examCode: exam.code,
          studentId: studentSession.studentId,
          studentName: studentSession.studentName || studentSession.studentId,
          yearLevel: studentSession.yearLevel || (student ? student.yearLevel : ''),
          section: studentSession.section || (student ? student.section : ''),
          startTime: new Date().toISOString(),
          endTime: null,
          answers: {},
          warnings: 0,
          activities: [],
          score: null,
          maxScore: exam.questions.reduce((sum, q) => sum + q.points, 0),
          submitted: false,
          autoSubmitted: false,
          scoreReleased: false,
        });
      }
      this.startExam();
      return;
    }

    if (exam.status === 'closed' || exam.status === 'archived') {
      this._showError('This exam has ended and is no longer accepting submissions.');
      return;
    }

    this.showDashboard(studentSession);
  },

  // ============================================================
  // STUDENT DASHBOARD
  // ============================================================
  // ── Portal UI helpers ──────────────────────────────────
  showPortalTab(tab) {
    ['home','settings'].forEach(t => {
      const el = document.getElementById('portal-tab-' + t);
      if (el) el.classList.toggle('hidden', t !== tab);
      const nav = document.getElementById('pnav-' + t);
      if (nav) nav.classList.toggle('active', t === tab);
    });
    // Clear any course highlight when switching tabs via nav
    document.querySelectorAll('.portal-subject-item').forEach(el => el.classList.remove('active'));

    // Also hide course tab when navigating away
    const courseTab = document.getElementById('portal-tab-course');
    if (courseTab) courseTab.classList.add('hidden');

    const titles = { home: 'Home', settings: 'Settings' };
    const titleEl = document.getElementById('portal-topbar-title');
    if (titleEl) titleEl.textContent = titles[tab] || tab;

    this._writePortalRoute({ view: tab === 'settings' ? 'settings' : 'home' });
    if (tab === 'settings') this._loadSettingsForm();
  },

  _loadSettingsForm() {
    const sess = Auth.getStudentSession();
    if (!sess) return;
    this._repairStudentEmail(sess);
    const student = DB.getStudent(sess.studentId);
    const nameEl = document.getElementById('stg-name');
    if (nameEl) nameEl.value = sess.studentName || sess.studentId;
    const emailEl = document.getElementById('stg-email');
    if (emailEl) emailEl.textContent = sess.email || '—';
    const sidEl = document.getElementById('stg-studentid');
    if (sidEl) sidEl.value = sess.studentId || '';
    const yearSectionEl = document.getElementById('stg-year-section');
    if (yearSectionEl) yearSectionEl.value = sess.yearSection || (student ? (student.yearSection || '') : '');
    const departmentEl = document.getElementById('stg-department');
    if (departmentEl) departmentEl.value = sess.department || (student ? (student.department || '') : '');
    const programEl = document.getElementById('stg-program');
    if (programEl) programEl.value = sess.program || (student ? (student.program || '') : '');
    // clear messages
    ['stg-profile-msg','stg-pass-msg'].forEach(id => { const el = document.getElementById(id); if (el) el.textContent = ''; });
    ['stg-cur-pass','stg-new-pass','stg-confirm-pass'].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
  },

  async saveStudentProfile() {
    const sess = Auth.getStudentSession();
    if (!sess) return;
    const name = (document.getElementById('stg-name').value || '').trim();
    const studentId = (document.getElementById('stg-studentid').value || '').trim().toUpperCase();
    const yearSection = (document.getElementById('stg-year-section').value || '').trim().toUpperCase();
    const department = (document.getElementById('stg-department').value || '').trim();
    const program = (document.getElementById('stg-program').value || '').trim().toUpperCase();
    const msgEl = document.getElementById('stg-profile-msg');
    if (msgEl) msgEl.textContent = '';
    if (!name) { this._showToast('Name cannot be empty.', 'error', { variant: 'settings' }); return; }
    if (!studentId) { this._showToast('Student ID cannot be empty.', 'error', { variant: 'settings' }); return; }
    if (!/^(\d{2})-\d{5}$/.test(studentId)) {
      this._showToast('Student ID must be in YY-NNNNN format.', 'error', { variant: 'settings' });
      return;
    }

    const student = DB.getStudent(sess.studentId);
    if (!student) {
      this._showToast('Student record not found.', 'error', { variant: 'settings' });
      return;
    }

    const duplicate = DB.getStudent(studentId);
    if (duplicate && duplicate.id !== student.id) {
      this._showToast('That Student ID is already assigned to another account.', 'error', { variant: 'settings' });
      return;
    }

    const yearSectionMatch = yearSection.match(/^([1-4])-([A-Z])$/);
    if (!yearSectionMatch) { this._showToast('Year & section must use the format 3-B.', 'error', { variant: 'settings' }); return; }
    if (!department) { this._showToast('Please select your department.', 'error', { variant: 'settings' }); return; }
    if (!program) { this._showToast('Please enter your program.', 'error', { variant: 'settings' }); return; }
    const yearMap = { '1': '1st Year', '2': '2nd Year', '3': '3rd Year', '4': '4th Year' };
    const yearLevel = yearMap[yearSectionMatch[1]] || '';
    const section = `Section ${yearSectionMatch[2]}`;
    const updates = { name, studentId, yearLevel, section, yearSection, department, program };
    if (sess.email) updates.email = sess.email;
    DB.updateStudent(student.id, updates);
    if (sess.email) {
      await DB.ensureStudentEmailInSupabase({
        id: student.id,
        studentId,
        email: sess.email,
      }).catch(error => {
        console.warn('[Supabase] Unable to persist student email from profile save:', error.message || error);
      });
    }
    const updatedStudent = { ...student, ...updates };
    DB.syncStudentReferences(sess.studentId, updatedStudent);

    // Update session details
    const updated = {
      ...sess,
      studentId,
      studentName: name,
      yearLevel,
      section,
      yearSection,
      department,
      program,
    };
    sessionStorage.setItem('acs_student_session', JSON.stringify(updated));
    this._refreshPortalIdentity(updated);
    this._renderDashboard(updated);

    if (this.session && this.session.studentId === sess.studentId) {
      this.session = {
        ...this.session,
        studentId,
        studentName: name,
        yearLevel,
        section,
        yearSection,
        department,
        program,
      };
    }

    this._showToast('Profile updated successfully.', 'success', { variant: 'settings' });
  },

  _formatFooterMeta(sess) {
    if (!sess) return '';
    return [sess.studentId, sess.yearSection || [sess.yearLevel, sess.section].filter(Boolean).join(' / '), sess.program].filter(Boolean).join(' · ');
  },

  async saveStudentPassword() {
    const sess = Auth.getStudentSession();
    if (!sess) return;
    const cur     = document.getElementById('stg-cur-pass').value;
    const next    = document.getElementById('stg-new-pass').value;
    const confirm = document.getElementById('stg-confirm-pass').value;
    const msgEl   = document.getElementById('stg-pass-msg');
    if (msgEl) msgEl.textContent = '';

    if (!cur || !next || !confirm) { this._showToast('All fields are required.', 'error', { variant: 'settings' }); return; }
    if (next.length < 6) { this._showToast('New password must be at least 6 characters.', 'error', { variant: 'settings' }); return; }
    if (next !== confirm) { this._showToast('Passwords do not match.', 'error', { variant: 'settings' }); return; }

    const student = DB.getStudent(sess.studentId);
    if (!student) { this._showToast('Student record not found.', 'error', { variant: 'settings' }); return; }
    if (student.password !== cur) { this._showToast('Current password is incorrect.', 'error', { variant: 'settings' }); return; }

    const passwordUpdates = { password: next };
    if (sess.email) passwordUpdates.email = sess.email;
    DB.updateStudent(student.id, passwordUpdates);
    if (sess.email) {
      await DB.ensureStudentEmailInSupabase({
        id: student.id,
        studentId: student.studentId,
        email: sess.email,
      }).catch(error => {
        console.warn('[Supabase] Unable to persist student email from password save:', error.message || error);
      });
    }
    ['stg-cur-pass','stg-new-pass','stg-confirm-pass'].forEach(id => { document.getElementById(id).value = ''; });
    this._showToast('Password changed successfully.', 'success', { variant: 'settings' });
  },

  _chipColors: ['#1d4ed8','#7c3aed','#d97706','#dc2626','#0d9488','#be185d','#ea580c','#0284c7'],
  _chipColor(str) {
    let h = 0;
    for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) & 0xffffffff;
    return this._chipColors[Math.abs(h) % this._chipColors.length];
  },

  _renderSidebarCourses(enrolledSubjects) {
    const container = document.getElementById('portal-nav-courses');
    if (!container) return;
    container.innerHTML = enrolledSubjects.map(s => {
      const letter = (s.name || s.code || '?').charAt(0).toUpperCase();
      const color  = this._chipColor(s.id);
      return `<div class="portal-subject-item" id="psi-${s.id}" data-label="${_esc(s.name)}" onclick="ExamApp.scrollToCourse('${s.id}')">
        <div class="portal-subject-chip" style="background:${color};">${letter}</div>
        <span class="portal-subject-label">${_esc(s.name)}</span>
      </div>`;
    }).join('');
  },

  scrollToCourse(subjId) {
    this.showCourseView(subjId);
  },

  // ── Course view ─────────────────────────────────────────
  _currentCourseId: null,

  showCourseView(subjId) {
    const subj = DB.getSubjects().find(s => s.id === subjId);
    if (!subj) return;
    this._currentCourseId = subjId;

    // Switch all tabs to hidden, show course
    ['home','settings','course'].forEach(t => {
      const el = document.getElementById('portal-tab-' + t);
      if (el) el.classList.toggle('hidden', t !== 'course');
    });
    // Clear nav highlights, highlight sidebar item
    ['pnav-home','pnav-settings'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.classList.remove('active');
    });
    document.querySelectorAll('.portal-subject-item').forEach(el => el.classList.remove('active'));
    const sideItem = document.getElementById('psi-' + subjId);
    if (sideItem) sideItem.classList.add('active');

    // Topbar breadcrumb
    const titleEl = document.getElementById('portal-topbar-title');
    if (titleEl) {
      titleEl.innerHTML = `<span class="topbar-breadcrumb">
        <button class="topbar-breadcrumb-link" onclick="ExamApp.showPortalTab('home')">Home</button>
        <span class="topbar-breadcrumb-sep">›</span>
        <span class="topbar-breadcrumb-current">${_esc(subj.name)}</span>
      </span>`;
    }

    // Build banner
    const color = this._chipColor(subjId);
    const bannerEl = document.getElementById('course-banner');
    if (bannerEl) {
      bannerEl.style.background = `linear-gradient(135deg, ${color} 0%, ${color}cc 60%, ${color}99 100%)`;
      const sess2 = Auth.getStudentSession();
      const allExamsForBanner = DB.getExams().filter(e => e.subjectId === subjId);
      const activeCount    = allExamsForBanner.filter(e => e.status === 'active').length;
      const submittedCount = allExamsForBanner.filter(e => {
        const s = DB.getStudentSession(e.id, sess2.studentId);
        return s && s.submitted;
      }).length;
      const totalVisible = allExamsForBanner.filter(e => e.status !== 'draft').length;
      const deco = (subj.code || subj.name || '?').charAt(0).toUpperCase();
      bannerEl.innerHTML = `
        <div class="course-banner-deco-circle c1"></div>
        <div class="course-banner-deco-circle c2"></div>
        <div class="course-banner-deco-circle c3"></div>
        <div class="course-banner-deco-letter">${deco}</div>
        <div class="course-banner-inner">
          <div class="course-banner-title">${_esc(subj.name)}</div>
          <div class="course-banner-code">${_esc(subj.code)}</div>
          <div class="course-banner-stats">
            <div class="course-stat"><div class="course-stat-value">${totalVisible}</div><div class="course-stat-label">Exams</div></div>
            <div class="course-stat"><div class="course-stat-value">${activeCount}</div><div class="course-stat-label">Active</div></div>
            <div class="course-stat"><div class="course-stat-value">${submittedCount}</div><div class="course-stat-label">Submitted</div></div>
          </div>
        </div>`;
    }

    const route = this._readPortalRoute();
    const preferredTab = route.view === 'course' && route.courseId === subjId
      ? route.courseTab || 'exams'
      : 'exams';
    this.showCourseTab(preferredTab);
  },

  showCourseTab(tab) {
    ['exams','people'].forEach(t => {
      const el = document.getElementById('course-tab-' + t);
      if (el) el.classList.toggle('hidden', t !== tab);
      const btn = document.getElementById('ctab-' + t);
      if (btn) btn.classList.toggle('active', t === tab);
    });
    if (tab === 'exams')  this._renderCourseExams();
    if (tab === 'people') this._renderCoursePeople();
    if (this._currentCourseId) {
      this._writePortalRoute({ view: 'course', courseId: this._currentCourseId, courseTab: tab });
    }
  },

  _renderCourseExams() {
    const sess   = Auth.getStudentSession();
    const subjId = this._currentCourseId;
    const listEl = document.getElementById('course-tab-exams');
    if (!listEl) return;

    const allExams = DB.getExams().filter(e => e.subjectId === subjId && e.status !== 'draft');
    if (!allExams.length) {
      listEl.innerHTML = `<div class="dash-empty">
        <div class="dash-empty-icon"><svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg></div>
        <div class="dash-empty-title">No Exams Yet</div>
        <div class="dash-empty-sub">Your instructor hasn't posted any exams yet.<br><span style="font-size:12px;color:#c0c7d0;">Active, upcoming, and previous/inactive exams will appear here.</span></div>
      </div>`;
      return;
    }

    const groups = [
      { label: 'Active Now',              statuses: ['active'],            iconClass: 'icon-active',  cardClass: 'status-active' },
      { label: 'Upcoming',                statuses: ['ready'],             iconClass: 'icon-waiting', cardClass: 'status-waiting' },
      { label: 'Previous / Inactive Exams', statuses: ['closed','archived'], iconClass: '',           cardClass: 'status-closed' },
    ];

    let html = '';
    groups.forEach(g => {
      const exams = allExams.filter(e => g.statuses.includes(e.status));
      if (!exams.length) return;

      html += `<div class="course-exam-group">
        <div class="course-group-label">
          <span class="course-group-label-text">${g.label}</span>
          <div class="course-group-label-line"></div>
        </div>`;

      exams.forEach(e => {
        const dbSess = DB.getStudentSession(e.id, sess.studentId);
        let panelHtml = '';
        let stateHtml = '';
        let accentLabel = g.label;
        const primaryDate = dbSess?.submitted
          ? (dbSess.endTime || dbSess.startTime || e.closedAt || e.startedAt || e.createdAt)
          : (e.startedAt || e.createdAt);

        const chips = [
          `<span class="course-meta-chip">${this._portalLabel('clipboard', this._formatExamCardDate(primaryDate), { size: 13, gap: 6 })}</span>`,
          `<span class="course-meta-chip">${e.questions.length} questions</span>`,
          `<span class="course-meta-chip">${e.timeLimit} min</span>`,
        ];
        if (e.requireCamera) {
          chips.push(`<span class="course-meta-chip chip-camera">${this._portalLabel('camera', 'Camera Proctored', { size: 13, gap: 5 })}</span>`);
        }

        if (dbSess && dbSess.submitted) {
          const pct = dbSess.maxScore ? Math.round(dbSess.score / dbSess.maxScore * 100) : 0;
          const scoreHtml = dbSess.scoreReleased
            ? `<span style="font-weight:700;color:#0f2d1a;">${dbSess.score}/${dbSess.maxScore}</span> <span style="color:#9ca3af;">(${pct}%)</span>`
            : `<span style="color:#9ca3af;font-size:12px;">Awaiting result</span>`;
          accentLabel = 'Completed';
          stateHtml = `<span class="course-exam-state state-submitted">${this._portalIcon('checkCircle', { size: 12, stroke: '#4b5563' })}<span>Submitted</span></span>`;
          panelHtml = `<div class="course-exam-panel panel-submitted">
            <div class="course-exam-panel-top">
              ${stateHtml}
              <div class="course-exam-panel-date">${this._formatExamCardDateTime(dbSess.endTime || dbSess.startTime || e.closedAt || e.startedAt || e.createdAt)}</div>
              <div class="course-exam-panel-note">${scoreHtml}</div>
            </div>
            <button class="course-exam-cta course-exam-cta-secondary" onclick="ExamApp.dashSelectExam('${e.code}')"><span>View Result</span>${this._portalIcon('arrowRight', { size: 14, stroke: 'currentColor' })}</button>
          </div>`;
        } else if (e.status === 'active') {
          accentLabel = 'Active';
          stateHtml = `<span class="course-exam-state state-live"><span class="course-exam-state-dot"></span><span>Active Now</span></span>`;
          panelHtml = `<div class="course-exam-panel panel-live">
            <div class="course-exam-panel-top">
              ${stateHtml}
              <div class="course-exam-panel-date">${this._formatExamCardDateTime(e.startedAt || e.createdAt)}</div>
              <div class="course-exam-panel-note">You can enter this exam right now.</div>
            </div>
            <button class="course-exam-cta course-exam-cta-primary" onclick="ExamApp.dashSelectExam('${e.code}')"><span>Take Exam</span>${this._portalIcon('arrowRight', { size: 14, stroke: 'currentColor' })}</button>
          </div>`;
        } else if (e.status === 'ready') {
          accentLabel = 'Scheduled';
          stateHtml = `<span class="course-exam-state state-ready">Scheduled</span>`;
          panelHtml = `<div class="course-exam-panel panel-ready">
            <div class="course-exam-panel-top">
              ${stateHtml}
              <div class="course-exam-panel-date">${this._formatExamCardDateTime(e.createdAt)}</div>
              <div class="course-exam-panel-note">This exam room is ready and waiting for activation.</div>
            </div>
            <button class="course-exam-cta course-exam-cta-secondary" onclick="ExamApp.dashSelectExam('${e.code}')"><span>Join Room</span>${this._portalIcon('arrowRight', { size: 14, stroke: 'currentColor' })}</button>
          </div>`;
        } else if (e.status === 'closed') {
          accentLabel = 'Closed';
          stateHtml = `<span class="course-exam-state state-closed">Closed</span>`;
          panelHtml = `<div class="course-exam-panel panel-closed">
            <div class="course-exam-panel-top">
              ${stateHtml}
              <div class="course-exam-panel-date">${this._formatExamCardDateTime(e.closedAt || e.updatedAt || e.createdAt)}</div>
              <div class="course-exam-panel-note">This exam is no longer accepting submissions.</div>
            </div>
            ${dbSess
              ? `<button class="course-exam-cta course-exam-cta-secondary" onclick="ExamApp.dashSelectExam('${e.code}')"><span>View Result</span>${this._portalIcon('arrowRight', { size: 14, stroke: 'currentColor' })}</button>`
              : `<button class="course-exam-cta course-exam-cta-secondary" disabled style="opacity:0.55;cursor:not-allowed;"><span>Closed</span></button>`}
          </div>`;
        } else {
          accentLabel = 'Draft';
          stateHtml = `<span class="course-exam-state state-closed">Draft</span>`;
          panelHtml = `<div class="course-exam-panel panel-closed">
            <div class="course-exam-panel-top">
              ${stateHtml}
              <div class="course-exam-panel-date">${this._formatExamCardDateTime(e.createdAt)}</div>
              <div class="course-exam-panel-note">This exam is not yet available.</div>
            </div>
          </div>`;
        }

        html += `<div class="course-exam-card ${g.cardClass}">
          <div class="course-exam-shell">
            <div class="course-exam-card-left">
              <div class="course-exam-icon ${g.iconClass}">
                <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>
              </div>
              <div class="course-exam-copy">
              <div class="course-exam-kicker">${_esc(accentLabel)}</div>
              <div class="course-exam-title">${_esc(e.title)}</div>
              <div class="course-exam-meta">${chips.join('')}</div>
              ${e.description ? `<div class="course-exam-desc">${_esc(e.description)}</div>` : ''}
            </div>
            </div>
            <div class="course-exam-actions-pane">${panelHtml}</div>
          </div>
        </div>`;
      });

      html += `</div>`;
    });

    listEl.innerHTML = html;
  },

  _renderCoursePeople() {
    const subjId = this._currentCourseId;
    const sess   = Auth.getStudentSession();
    const listEl = document.getElementById('course-tab-people');
    if (!listEl) return;

    const settings = DB.getSettings();
    const students = DB.getStudents().filter(s => (s.enrolledSubjects || []).includes(subjId));

    const teacherColor = '#0f2d1a';
    const teacherLetter = (settings.adminName || 'A').charAt(0).toUpperCase();

    let html = `
      <div class="people-section">
        <div class="dash-section-label">Teachers</div>
        <div class="people-card-list">
          <div class="people-card">
            <div class="people-avatar" style="background:${teacherColor};">${teacherLetter}</div>
            <div>
              <div class="people-name">${_esc(settings.adminName || 'Administrator')}</div>
              <div class="people-meta">${_esc(settings.adminEmail || '')}</div>
            </div>
          </div>
        </div>
      </div>

      <div class="people-section">
        <div class="dash-section-label">Classmates (${students.length})</div>
        <div class="people-card-list">`;

    if (!students.length) {
      html += `<div class="dash-no-exams">No students enrolled yet.</div>`;
    } else {
      students.forEach(s => {
        const isSelf = s.studentId === sess.studentId;
        const color  = this._chipColor(s.id);
        const letter = (s.name || '?').charAt(0).toUpperCase();
        html += `<div class="people-card">
          <div class="people-avatar" style="background:${color};">${letter}</div>
          <div>
            <div class="people-name">${_esc(s.name)}${isSelf ? '<span class="people-you-badge">You</span>' : ''}</div>
            <div class="people-meta">${_esc(s.studentId)}${s.yearLevel ? ' · ' + _esc(s.yearLevel) : ''}${s.section ? ' · ' + _esc(s.section) : ''}</div>
          </div>
        </div>`;
      });
    }

    html += `</div></div>`;
    listEl.innerHTML = html;
  },

  // ── Main showDashboard ──────────────────────────────────
  showDashboard(studentSession) {
    const sess = studentSession || Auth.getStudentSession();
    if (!sess) { window.location.href = 'index.html'; return; }

    this.showState('dashboard');

    // Logo from settings
    const settings = DB.getSettings();
    const logoEl = document.getElementById('portal-logo');
    if (logoEl && settings.logoUrl) logoEl.src = settings.logoUrl;

    this._refreshPortalIdentity(sess);

    // Greeting
    const name = sess.studentName || sess.studentId;
    const greetEl = document.getElementById('dash-greeting');
    if (greetEl) {
      const hr = new Date().getHours();
      const greet = hr < 12 ? 'Good morning' : hr < 17 ? 'Good afternoon' : 'Good evening';
      const firstName = name.split(/[,\s]/)[0];
      const dateStr = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
      greetEl.innerHTML = `<div class="dash-greeting-text">${greet}, ${_esc(firstName)}!</div><div class="dash-greeting-sub">${dateStr}</div>`;
    }

    // Input listeners (set once)
    const codeInput = document.getElementById('dash-exam-code-input');
    if (codeInput && !codeInput._ls) {
      codeInput._ls = true;
      codeInput.addEventListener('input', e => e.target.value = e.target.value.toUpperCase());
      codeInput.addEventListener('keydown', e => { if (e.key === 'Enter') this.dashEnterExamCode(); });
    }
    const enrollInput = document.getElementById('dash-enroll-code');
    if (enrollInput && !enrollInput._ls) {
      enrollInput._ls = true;
      enrollInput.addEventListener('input', e => e.target.value = e.target.value.toUpperCase());
      enrollInput.addEventListener('keydown', e => { if (e.key === 'Enter') this.dashEnrollCourse(); });
    }

    this._renderDashboard(sess);
    if (this._dashInterval) clearInterval(this._dashInterval);
    this._dashInterval = setInterval(() => this._renderDashboard(Auth.getStudentSession()), 5000);

    const route = this._readPortalRoute();
    if (route.view === 'settings') {
      this.showPortalTab('settings');
      return;
    }
    if (route.view === 'course') {
      const student = DB.getStudent(sess.studentId);
      const enrolled = student?.enrolledSubjects || [];
      if (enrolled.includes(route.courseId)) {
        this.showCourseView(route.courseId);
        return;
      }
    }
    this.showPortalTab('home');
  },

  _renderDashboard(sess) {
    if (!sess) return;
    const student = DB.getStudent(sess.studentId);
    const enrolledIds = (student && student.enrolledSubjects) ? student.enrolledSubjects : [];
    const allSubjects = DB.getSubjects();
    const enrolledSubjects = allSubjects.filter(s => enrolledIds.includes(s.id));
    const allExams = DB.getExams();
    const listEl = document.getElementById('dash-subjects-list');
    if (!listEl) return;

    let html = '';

    // Update sidebar courses list
    this._renderSidebarCourses(enrolledSubjects);

    if (!enrolledSubjects.length) {
      html += `<div class="dash-empty">
        <div class="dash-empty-icon"><svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg></div>
        <div class="dash-empty-title">No Enrolled Courses Yet</div>
        <div class="dash-empty-sub">Use the "Enroll in a Course" field above, or enter an exam code directly.</div>
      </div>`;
      listEl.innerHTML = html;
      return;
    }

    // Audience filter: returns true if the exam is visible to this student
    const audienceMatch = (e) => {
      const years = e.targetYearLevels || [];
      const sections = e.targetSections || [];
      if (years.length > 0 && sess.yearLevel && !years.includes(sess.yearLevel)) return false;
      if (sections.length > 0 && sess.section) {
        const match = sections.some(s => s.toLowerCase() === sess.section.toLowerCase());
        if (!match) return false;
      }
      return true;
    };

    // Collect active exams across all enrolled subjects to show highlighted at top
    const activeExams = [];
    enrolledSubjects.forEach(subj => {
      allExams.filter(e => e.subjectId === subj.id && e.status === 'active' && audienceMatch(e)).forEach(e => {
        const dbSession = DB.getStudentSession(e.id, sess.studentId);
        if (!dbSession || !dbSession.submitted) {
          activeExams.push({ exam: e, subject: subj });
        }
      });
    });

    // Active exam banners (if any)
    if (activeExams.length) {
      html += `<div class="dash-section-label">Active Now</div>`;
      activeExams.forEach(({ exam: e, subject: subj }) => {
        const camTag = e.requireCamera
          ? `<span style="color:rgba(255,255,255,0.7);font-weight:600;">${this._portalLabel('camera', 'Camera required', { size: 13, gap: 5, stroke: 'rgba(255,255,255,0.8)' })}</span>`
          : '';
        html += `
          <div class="dash-active-banner">
            <div class="dash-active-banner-left">
              <div class="dash-active-live"><span class="dash-active-live-dot"></span>Live</div>
              <div class="dash-active-exam-title">${_esc(e.title)}</div>
              <div class="dash-active-exam-meta">${_esc(subj.name)} &nbsp;·&nbsp; ${e.questions.length} questions &nbsp;·&nbsp; ${e.timeLimit} min ${camTag ? '&nbsp;·&nbsp;' + camTag : ''}</div>
            </div>
            <button class="btn-take-exam" onclick="ExamApp.dashSelectExam('${e.code}')">${this._portalLabel('arrowRight', 'Take Exam', { trailing: true, gap: 8, stroke: '#ffffff' })}</button>
          </div>`;
      });
    }

    // My Courses section
    html += `<div class="dash-section-label" style="margin-top:${activeExams.length ? '8px' : '0'};">My Courses</div>`;

    enrolledSubjects.forEach(subj => {
      const subjectExams = allExams.filter(e => {
        if (e.subjectId !== subj.id) return false;
        if (!audienceMatch(e)) return false;
        if (['active','ready','closed'].includes(e.status)) return true;
        // Also show draft exams if the student has a submitted session (they can view results)
        if (e.status === 'draft') {
          const s = DB.getStudentSession(e.id, sess.studentId);
          return s && s.submitted;
        }
        return false;
      });

      const examsHtml = subjectExams.length ? subjectExams.map(e => {
        const dbSession = DB.getStudentSession(e.id, sess.studentId);
        let actionHtml = '', statusHtml = '';

        if (dbSession && dbSession.submitted) {
          statusHtml = `<span class="badge badge-secondary" style="font-size:10px;">Submitted</span>`;
          actionHtml = `<button class="btn btn-secondary btn-sm" onclick="ExamApp.dashSelectExam('${e.code}')">View Result</button>`;
        } else if (e.status === 'active') {
          statusHtml = `<span class="badge badge-success" style="font-size:10px;display:inline-flex;align-items:center;gap:5px;"><span style="width:7px;height:7px;border-radius:50%;background:currentColor;animation:pulse 1.5s infinite;display:inline-block;"></span><span>Active</span></span>`;
          actionHtml = `<button class="btn btn-primary btn-sm" onclick="ExamApp.dashSelectExam('${e.code}')">Take Exam</button>`;
        } else if (e.status === 'ready') {
          statusHtml = `<span class="badge badge-info" style="font-size:10px;">Waiting</span>`;
          actionHtml = `<button class="btn btn-secondary btn-sm" onclick="ExamApp.dashSelectExam('${e.code}')">Join Room</button>`;
        } else if (e.status === 'closed') {
          statusHtml = `<span class="badge badge-secondary" style="font-size:10px;">Closed</span>`;
          actionHtml = `<button class="btn btn-secondary btn-sm" style="opacity:0.5;cursor:not-allowed;" disabled>Closed</button>`;
        }

        const metaParts = [
          `<span>${_esc(`${e.questions.length} questions`)}</span>`,
          `<span>${_esc(`${e.timeLimit} min`)}</span>`,
        ];
        if (e.requireCamera) metaParts.push(this._portalLabel('camera', 'Camera', { size: 13, gap: 5 }));
        if ((e.targetYearLevels||[]).length || (e.targetSections||[]).length) {
          const abbr = { '1st Year':'Y1','2nd Year':'Y2','3rd Year':'Y3','4th Year':'Y4' };
          const yrs = (e.targetYearLevels||[]).map(y => abbr[y]||y).join('/');
          const secs = (e.targetSections||[]).join('/');
          metaParts.push(this._portalLabel('users', [yrs, secs].filter(Boolean).join(' · '), { size: 13, gap: 5 }));
        }

        return `<div class="dash-exam-row">
          <div style="min-width:0;flex:1;">
            <div class="dash-exam-title">${_esc(e.title)}</div>
            <div class="dash-exam-meta">
              ${metaParts.map((p, i) => i === 0 ? p : `<span class="dash-exam-meta-dot"></span>${p}`).join('')}
            </div>
          </div>
          <div class="dash-exam-actions">
            ${statusHtml}
            ${actionHtml}
          </div>
        </div>`;
      }).join('')
      : `<div class="dash-no-exams">
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#d1d5db" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
          No active exams for this course right now.
        </div>`;

      const chipColor = this._chipColor(subj.id);
      html += `<div class="dash-subject-card" id="course-card-${subj.id}">
        <div class="dash-subject-header">
          <div class="dash-subject-icon" style="background:linear-gradient(135deg,${chipColor},${chipColor}cc);">
            <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>
          </div>
          <div>
            <div class="dash-subject-name">${_esc(subj.name)}</div>
            <span class="dash-subject-code">${_esc(subj.code)}</span>
          </div>
        </div>
        ${examsHtml}
      </div>`;
    });

    listEl.innerHTML = html;
  },

  dashSelectExam(examCode) {
    if (this._dashInterval) { clearInterval(this._dashInterval); this._dashInterval = null; }
    // Remember where to return after the exam (course view or home)
    this._returnCourseId = this._currentCourseId || null;
    const sess = Auth.getStudentSession();
    const updated = { ...sess, examCode };
    sessionStorage.setItem('acs_student_session', JSON.stringify(updated));
    this.exam = null; this.session = null; this.warnings = 0; this.answers = {};
    this._startExamFlow(updated);
  },

  dashEnterExamCode() {
    const code = (document.getElementById('dash-exam-code-input').value || '').trim().toUpperCase();
    if (!code) return;
    const exam = DB.getExamByCode(code);
    if (!exam) {
      const el = document.getElementById('dash-exam-code-input');
      el.style.borderColor = '#dc2626';
      el.placeholder = 'Invalid code — try again';
      setTimeout(() => { el.style.borderColor = ''; el.placeholder = 'e.g. EXAM01'; }, 2000);
      return;
    }
    this.dashSelectExam(code);
  },

  dashEnrollCourse() {
    const code = (document.getElementById('dash-enroll-code').value || '').trim().toUpperCase();
    const msgEl = document.getElementById('dash-enroll-msg');
    if (!code) { msgEl.textContent = 'Please enter an enrollment code.'; msgEl.style.color = '#dc2626'; return; }

    const subjects = DB.getSubjects();
    const subject = subjects.find(s => s.enrollmentCode === code);
    if (!subject) { msgEl.textContent = 'Invalid code. Please check with your instructor.'; msgEl.style.color = '#dc2626'; return; }

    const sess = Auth.getStudentSession();
    const student = DB.getStudent(sess.studentId);
    if (student) {
      const enrolled = student.enrolledSubjects || [];
      if (enrolled.includes(subject.id)) {
        msgEl.textContent = `You're already enrolled in "${subject.name}".`;
        msgEl.style.color = '#6b7280';
      } else {
        DB.updateStudent(student.id, { enrolledSubjects: [...enrolled, subject.id] });
        msgEl.textContent = `Successfully enrolled in "${subject.name}"!`;
        msgEl.style.color = '#15803d';
        document.getElementById('dash-enroll-code').value = '';
        this._renderDashboard(sess);
      }
    } else {
      msgEl.textContent = 'Student record not found. Please contact your instructor.';
      msgEl.style.color = '#dc2626';
    }
  },

  dashSignOut() {
    const modal = document.getElementById('confirm-logout-modal');
    if (modal) {
      modal.classList.remove('hidden');
      return;
    }
    if (this._dashInterval) { clearInterval(this._dashInterval); this._dashInterval = null; }
    Auth.clearStudentSession();
    window.location.href = 'index.html';
  },

  cancelLogout() {
    document.getElementById('confirm-logout-modal')?.classList.add('hidden');
  },

  confirmLogout() {
    this.cancelLogout();
    if (this._dashInterval) { clearInterval(this._dashInterval); this._dashInterval = null; }
    Auth.clearStudentSession();
    window.location.href = 'index.html';
  },

  // ============================================================
  // STATE MACHINE
  // ============================================================
  showState(name) {
    ['dashboard', 'entry', 'waiting', 'exam', 'submitted', 'review'].forEach(s => {
      const el = document.getElementById('state-' + s);
      if (el) el.classList.add('hidden');
    });
    const target = document.getElementById('state-' + name);
    if (target) target.classList.remove('hidden');
  },

  _showError(msg) {
    // If student has a session, go back to their dashboard with the error shown briefly
    const sess = Auth.getStudentSession();
    if (sess) {
      const updated = { ...sess };
      delete updated.examCode;
      delete updated.examId;
      sessionStorage.setItem('acs_student_session', JSON.stringify(updated));
      this.showDashboard(updated);
      // Show error as a transient banner in the dashboard
      const msgEl = document.getElementById('dash-enroll-msg');
      if (msgEl) {
        msgEl.textContent = msg;
        msgEl.style.color = '#dc2626';
        setTimeout(() => { if (msgEl.textContent === msg) { msgEl.textContent = ''; } }, 5000);
      }
    } else {
      this.showState('entry');
      const errEl = document.getElementById('entry-error');
      if (errEl) { errEl.textContent = msg; errEl.style.display = 'block'; }
    }
  },

  _setupEntryHandlers() {
    const sidInput = document.getElementById('entry-student-id');
    const codeInput = document.getElementById('entry-exam-code');
    if (sidInput) {
      sidInput.addEventListener('input', e => e.target.value = e.target.value.toUpperCase());
      sidInput.addEventListener('keydown', e => { if (e.key === 'Enter') codeInput && codeInput.focus(); });
    }
    if (codeInput) {
      codeInput.addEventListener('input', e => e.target.value = e.target.value.toUpperCase());
      codeInput.addEventListener('keydown', e => { if (e.key === 'Enter') this.submitEntry(); });
    }
  },

  // ============================================================
  // ENTRY FORM
  // ============================================================
  submitEntry() {
    const studentId = (document.getElementById('entry-student-id').value || '').trim().toUpperCase();
    const examCode = (document.getElementById('entry-exam-code').value || '').trim().toUpperCase();
    const errEl = document.getElementById('entry-error');
    if (errEl) errEl.style.display = 'none';

    if (!studentId || !examCode) {
      if (errEl) { errEl.textContent = 'Please enter your Student ID and Exam Code.'; errEl.style.display = 'block'; }
      return;
    }

    const result = Auth.studentSetup(studentId, examCode);
    if (!result.success) {
      if (errEl) { errEl.textContent = result.message; errEl.style.display = 'block'; }
      return;
    }

    // Re-init with new session
    this.init();
  },

  // ============================================================
  // WAITING ROOM
  // ============================================================
  _renderWaitingInfo(studentSession, exam) {
    const box = document.getElementById('waiting-info-box');
    if (box) {
      box.innerHTML = `
        <div class="info-row"><span class="info-label">Student</span><span class="info-value">${_esc(studentSession.studentName || studentSession.studentId)}</span></div>
        <div class="info-row"><span class="info-label">Exam</span><span class="info-value">${_esc(exam.title)}</span></div>
        <div class="info-row"><span class="info-label">Exam Code</span><span class="info-value">${_esc(exam.code)}</span></div>
        <div class="info-row"><span class="info-label">Time Limit</span><span class="info-value">${exam.timeLimit} minutes</span></div>
        <div class="info-row"><span class="info-label">Questions</span><span class="info-value">${exam.questions.length}</span></div>
      `;
    }
  },

  startWaitingPoll() {
    this.stopPoll();
    this.pollInterval = setInterval(() => {
      const latestExam = DB.getExam(this.exam.id);
      if (!latestExam) return;
      this.exam = latestExam;

      if (latestExam.status === 'active') {
        this.stopPoll();
        const studentSession = Auth.getStudentSession();
        const student = studentSession ? DB.getStudent(studentSession.studentId) : null;
        if (!this.session) {
          const existingSession = DB.getStudentSession(this.exam.id, studentSession.studentId);
          if (existingSession && !existingSession.submitted) {
            this.session = existingSession;
            this.warnings = existingSession.warnings || 0;
            this.answers = existingSession.answers || {};
          } else if (!existingSession) {
            this.session = DB.addSession({
              examId: this.exam.id,
              examCode: this.exam.code,
              studentId: studentSession.studentId,
              studentName: studentSession.studentName || studentSession.studentId,
              yearLevel: studentSession.yearLevel || (student ? student.yearLevel : ''),
              section: studentSession.section || (student ? student.section : ''),
              startTime: new Date().toISOString(),
              endTime: null,
              answers: {},
              warnings: 0,
              activities: [],
              score: null,
              maxScore: this.exam.questions.reduce((sum, q) => sum + q.points, 0),
              submitted: false,
              autoSubmitted: false,
              scoreReleased: false,
            });
          }
        }
        this.startExam();
      } else if (latestExam.status === 'closed' || latestExam.status === 'archived') {
        this.stopPoll();
        this.returnToLogin(); // return to dashboard
      }
    }, 3000);
  },

  stopPoll() {
    if (this.pollInterval) { clearInterval(this.pollInterval); this.pollInterval = null; }
  },

  // ============================================================
  // ACTIVE EXAM
  // ============================================================
  startExam() {
    this._rememberTrustedInteraction(2000);
    this.requestFullscreen();
    this.initAntiCheat();
    this.startTimer();
    this.renderQuestions();
    this.showState('exam');
    this._scheduleFullscreenEnforcement();

    // Initialize camera if exam requires it
    if (this.exam && this.exam.requireCamera) {
      this.initCamera();
    }

    // Update header
    const subject = this.exam.subjectId ? DB.getSubject(this.exam.subjectId) : null;
    document.getElementById('exam-header-title').textContent = this.exam.title;
    document.getElementById('exam-header-subject').textContent = subject ? subject.name : '';

    // Student info strip
    if (this.session) {
      document.getElementById('exam-student-info').textContent =
        `${_esc(this.session.studentName)} | ${_esc(this.session.studentId)}` +
        (this.session.yearLevel ? ` | ${_esc(this.session.yearLevel)}` : '') +
        (this.session.section ? ` - ${_esc(this.session.section)}` : '');
    }

    this._updateAnsweredStatus();
    document.getElementById('warning-num').textContent = this.warnings;
  },

  // ============================================================
  // FULLSCREEN
  // ============================================================
  requestFullscreen() {
    const el = document.documentElement;
    try {
      if (this._isFullscreenActive()) return Promise.resolve(true);
      if (el.requestFullscreen) {
        return Promise.resolve(el.requestFullscreen())
          .then(() => this._isFullscreenActive())
          .catch(() => false);
      }
      if (el.webkitRequestFullscreen) {
        el.webkitRequestFullscreen();
        return Promise.resolve(this._isFullscreenActive());
      }
    } catch (e) { /* silently fail */ }
    return Promise.resolve(false);
  },

  _rememberTrustedInteraction(durationMs = 1400) {
    this._fullscreenInteractionGraceUntil = Date.now() + durationMs;
  },

  _hasRecentTrustedInteraction() {
    return Date.now() <= (this._fullscreenInteractionGraceUntil || 0);
  },

  _attemptGracefulFullscreenRecovery() {
    this._showFullscreenLock();
    this._reenterFullscreen();

    if (this._pendingFullscreenRecovery) clearTimeout(this._pendingFullscreenRecovery);
    this._pendingFullscreenRecovery = setTimeout(() => {
      this._pendingFullscreenRecovery = null;
      if (!this._isFullscreenActive() && !this._intentionalFullscreenExit) {
        this.issueWarning('fullscreen_exit', 'Fullscreen mode exited');
        this._showFullscreenLock();
      }
    }, 700);
  },

  _showFullscreenLock() {
    let overlay = document.getElementById('fs-lock-overlay');

    const doReturn = () => {
      if (overlay && overlay._cdTimer) clearInterval(overlay._cdTimer);
      this.requestFullscreen().then(() => {
        if (overlay && this._isFullscreenActive()) overlay.style.display = 'none';
      });
    };

    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'fs-lock-overlay';
      overlay.innerHTML = `
        <div style="text-align:center;padding:40px 32px;max-width:400px;">
          <div style="width:64px;height:64px;border-radius:50%;background:rgba(255,255,255,0.1);display:flex;align-items:center;justify-content:center;margin:0 auto 20px;">
            <svg xmlns="http://www.w3.org/2000/svg" width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
          </div>
          <h2 style="font-size:22px;font-weight:800;color:#fff;margin-bottom:10px;">Fullscreen Required</h2>
          <p style="font-size:14px;color:rgba(255,255,255,0.7);margin-bottom:24px;line-height:1.6;">
            This exam must be taken in fullscreen mode.<br>
            Exiting fullscreen has been recorded as a violation.
          </p>
          <button id="fs-return-btn" style="background:#fff;color:#0f2d1a;border:none;padding:12px 32px;border-radius:10px;font-size:15px;font-weight:800;cursor:pointer;font-family:inherit;">
            Return to Fullscreen
          </button>
        </div>`;
      overlay.style.cssText = 'position:fixed;inset:0;background:#060e08;z-index:999999;display:flex;align-items:center;justify-content:center;';
      document.body.appendChild(overlay);
      document.getElementById('fs-return-btn').onclick = doReturn;
    } else {
      overlay.style.display = 'flex';
      const btn = document.getElementById('fs-return-btn');
      if (btn) btn.onclick = doReturn;
    }

    // Attempt immediate fullscreen re-entry; button is fallback if browser blocks it
    if (this.warnings < 3) doReturn();
  },

  _hideFullscreenLock() {
    const overlay = document.getElementById('fs-lock-overlay');
    if (overlay) overlay.style.display = 'none';
  },

  _reenterFullscreen() {
    this.requestFullscreen();
  },

  // ============================================================
  // ANTI-CHEAT
  // ============================================================
  initAntiCheat() {
    this.destroyAntiCheat();

    // ── Window blur (focus lost to another app) ──────────────────
    // Use 250ms delay so that pressing Alt/Win/Ctrl alone (which causes a
    // momentary blur) does NOT trigger a warning. Only a real app switch
    // that persists beyond 250ms counts.
    const blurHandler = () => {
      if (this._blurTimer) clearTimeout(this._blurTimer);
      this._blurTimer = setTimeout(() => {
        this._blurTimer = null;
        if (!document.hasFocus()) {
          if (this._inReadCountdown) {
            // Left during read countdown — cancel read, restart 10s auto-submit
            this._cancelReadCountdown();
            this.startCountdown(10);
          } else {
            this.issueWarning('window_blur', 'Another application was opened');
          }
        }
      }, 250);
    };
    window.addEventListener('blur', blurHandler);

    // ── Window focus restored ────────────────────────────────────
    const focusHandler = () => {
      if (this._blurTimer) { clearTimeout(this._blurTimer); this._blurTimer = null; }
      this.cancelCountdown(); // student came back — cancel the 10s, start 3s read
    };
    window.addEventListener('focus', focusHandler);

    // ── Tab switch (document hidden) ─────────────────────────────
    const visHandler = () => {
      if (document.hidden) {
        if (this._inReadCountdown) {
          // Left during read countdown — cancel read, restart 10s auto-submit
          this._cancelReadCountdown();
          this.startCountdown(10);
        } else {
          this.issueWarning('tab_switch', 'Tab or window switched');
        }
      } else {
        this.cancelCountdown(); // student returned to tab
      }
    };
    document.addEventListener('visibilitychange', visHandler);

    // ── Copy / cut ───────────────────────────────────────────────
    const copyHandler = e => {
      const action = e.type === 'cut' ? 'cut' : 'copy';
      const editable = this._isEditableTarget(e.target);
      const viaShortcut = this._consumeRecentClipboardShortcut(action);

      if (!editable) e.preventDefault();
      if (!viaShortcut) {
        this._recordActivity('copy_attempt', `Copy/cut action attempt detected (${action})`);
      }
    };
    document.addEventListener('copy', copyHandler);
    document.addEventListener('cut', copyHandler);

    // ── Paste & selection blocked silently ──────────────────────
    const pasteHandler = e => {
      const editable = this._isEditableTarget(e.target);
      const viaShortcut = this._consumeRecentClipboardShortcut('paste');
      if (!editable) {
        e.preventDefault();
      }
      if (!viaShortcut) {
        this._recordActivity('paste_attempt', 'Paste attempt detected');
      }
    };
    document.addEventListener('paste', pasteHandler);

    const selectHandler = e => {
      if (!this._isEditableTarget(e.target)) e.preventDefault();
    };
    document.addEventListener('selectstart', selectHandler);

    // ── Right-click ──────────────────────────────────────────────
    const rcHandler = e => e.preventDefault();
    document.addEventListener('contextmenu', rcHandler);

    // ── Fullscreen change ────────────────────────────────────────
    // ── Fullscreen change ────────────────────────────────────────
    const fsHandler = () => {
      if (!this._isFullscreenActive()) {
        // Always issue a violation — issueWarning handles _cancelReadCountdown internally
        this.issueWarning('fullscreen_exit', 'Fullscreen mode exited');
        this._showFullscreenLock();
      } else {
        if (this._pendingFullscreenRecovery) {
          clearTimeout(this._pendingFullscreenRecovery);
          this._pendingFullscreenRecovery = null;
        }
        this._hideFullscreenLock();
        this.cancelCountdown();
      }
    };
    document.addEventListener('fullscreenchange', fsHandler);
    document.addEventListener('webkitfullscreenchange', fsHandler);

    const trustedInteractionHandler = e => {
      const control = e.target.closest?.(
        '[data-exam-control="true"], .nav-q-btn, .mcq-option, .tf-btn, .checkbox-option, .essay-textarea, .id-input, .form-control, .examv2-mark-review'
      );
      if (control) this._rememberTrustedInteraction();
    };
    document.addEventListener('pointerdown', trustedInteractionHandler);
    document.addEventListener('focusin', trustedInteractionHandler);

    // ── Keyboard shortcuts blocked ───────────────────────────────
    const keyHandler = e => {
      if (e.key === 'PrintScreen') e.preventDefault();
      if (e.key === 'F11') { e.preventDefault(); } // block fullscreen toggle
      if (e.key === 'Escape') {
        // If exam is running and fullscreen is active, prevent escape from exiting
        if (this._isFullscreenActive()) {
          e.preventDefault();
        }
      }
      if ((e.ctrlKey || e.metaKey) && ['c','v','x','a','p','u','s'].includes(e.key.toLowerCase())) {
        const key = e.key.toLowerCase();
        const editable = this._isEditableTarget(e.target);

        if (key === 'c') {
          this._markClipboardShortcut('copy');
          this._recordActivity('ctrl_c_attempt', 'Ctrl+C shortcut attempt detected');
        } else if (key === 'v') {
          this._markClipboardShortcut('paste');
          this._recordActivity('ctrl_v_attempt', 'Ctrl+V shortcut attempt detected');
        } else if (key === 'x') {
          this._markClipboardShortcut('cut');
        }

        if (!editable) {
          e.preventDefault();
        }
      }
    };
    document.addEventListener('keydown', keyHandler);

    this.anticheatListeners = [
      ['blur',               window,   blurHandler],
      ['focus',              window,   focusHandler],
      ['visibilitychange',   document, visHandler],
      ['copy',               document, copyHandler],
      ['cut',                document, copyHandler],
      ['paste',              document, pasteHandler],
      ['selectstart',        document, selectHandler],
      ['contextmenu',        document, rcHandler],
      ['fullscreenchange',   document, fsHandler],
      ['webkitfullscreenchange', document, fsHandler],
      ['pointerdown',        document, trustedInteractionHandler],
      ['focusin',            document, trustedInteractionHandler],
      ['keydown',            document, keyHandler],
    ];
  },

  // ============================================================
  // CAMERA
  // ============================================================
  async initCamera() {
    const container = document.getElementById('camera-container');
    const video = document.getElementById('camera-feed');
    const statusText = document.getElementById('camera-status-text');
    const blockedMsg = document.getElementById('camera-blocked-msg');
    if (!container || !video) return;

    container.style.display = '';
    this._cameraPrompting = true;

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { width: 320, height: 240, facingMode: 'user' }, audio: false });
      this._cameraPrompting = false;
      this._cameraStream = stream;
      video.srcObject = stream;
      if (statusText) statusText.textContent = 'Monitoring';
      if (blockedMsg) blockedMsg.style.display = 'none';

      // Wait for video to be ready then check for presence before starting
      video.onloadeddata = () => {
        if (statusText) statusText.textContent = 'Loading face detection...';
        // Load BlazeFace model if available, then start detection
        if (window.blazeface) {
          window.blazeface.load().then(model => {
            this._faceModel = model;
            this._faceModelReady = true;
            if (statusText) statusText.textContent = 'Face detection ready';
          }).catch(() => {
            this._faceModelReady = false;
          }).finally(() => {
            setTimeout(() => this._checkInitialPresence(video), 500);
          });
        } else {
          setTimeout(() => this._checkInitialPresence(video), 1500);
        }
      };
    } catch (err) {
      this._cameraPrompting = false;
      if (statusText) statusText.textContent = 'Camera denied';
      if (blockedMsg) blockedMsg.style.display = 'flex';
      this._recordActivity('camera_denied', 'Camera permission denied: ' + err.message);
    }
  },

  _checkInitialPresence(video) {
    // Capture initial frame — if no motion baseline, just start monitoring
    const canvas = document.getElementById('camera-canvas');
    if (!canvas || video.readyState < 2) { this._startMotionDetection(video); return; }
    canvas.width = 160; canvas.height = 120;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(video, 0, 0, 160, 120);
    const initData = new Uint8ClampedArray(ctx.getImageData(0, 0, 160, 120).data);
    this._prevFrameData = initData;
    this._slowFrameData = initData;
    this._slowFrameCount = 0;
    this._startMotionDetection(video);
  },

  _startMotionDetection(video) {
    if (this._motionInterval) clearInterval(this._motionInterval);
    this._noMotionSec = 0;
    this._brightnessBaseline = null; // reset baseline so first frames calibrate it
    this._darkSeconds = 0;
    this._brightnessWarningIssued = false;
    this._motionInterval = setInterval(() => {
      if (this._faceModelReady && this._faceModel) {
        this._detectFace(video);
      } else {
        this._detectMotion(video);
      }
    }, 600);

    // Start periodic snapshot for admin live monitoring (every 8 seconds)
    if (this._snapInterval) clearInterval(this._snapInterval);
    this._snapInterval = setInterval(() => this.captureSnapshot(), 8000);
    // Capture one immediately so the grid shows something right away
    setTimeout(() => this.captureSnapshot(), 1500);
  },

  _detectMotion(video) {
    const canvas = document.getElementById('camera-canvas');
    if (!canvas || !video || video.readyState < 2 || !this._cameraStream) return;

    canvas.width = 160; canvas.height = 120;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(video, 0, 0, 160, 120);
    const frame = ctx.getImageData(0, 0, 160, 120).data;

    if (!this._prevFrameData || this._prevFrameData.length !== frame.length) {
      this._prevFrameData = new Uint8ClampedArray(frame);
      this._slowFrameData = new Uint8ClampedArray(frame);
      this._slowFrameCount = 0;
      return;
    }

    const pixelCount = frame.length / 4;

    // Fast diff vs previous frame — detects movement (threshold above sensor noise)
    let fastDiff = 0;
    for (let i = 0; i < frame.length; i += 4) {
      fastDiff += (Math.abs(frame[i]   - this._prevFrameData[i])   +
                   Math.abs(frame[i+1] - this._prevFrameData[i+1]) +
                   Math.abs(frame[i+2] - this._prevFrameData[i+2])) / 3;
    }
    const fastAvg = fastDiff / pixelCount;

    // Slow diff vs frame from ~10s ago — detects still presence (breathing, micro-movements)
    let slowDiff = 0;
    for (let i = 0; i < frame.length; i += 4) {
      slowDiff += (Math.abs(frame[i]   - this._slowFrameData[i])   +
                   Math.abs(frame[i+1] - this._slowFrameData[i+1]) +
                   Math.abs(frame[i+2] - this._slowFrameData[i+2])) / 3;
    }
    const slowAvg = slowDiff / pixelCount;

    // Update references
    this._prevFrameData = new Uint8ClampedArray(frame);  // fast: every frame
    this._slowFrameCount = (this._slowFrameCount || 0) + 1;
    if (this._slowFrameCount >= 20) {  // slow: every ~10s (20 ticks × 0.5s)
      this._slowFrameData = new Uint8ClampedArray(frame);
      this._slowFrameCount = 0;
    }

    // Ambient brightness check (runs every frame)
    this._checkAmbientBrightness(frame, pixelCount);

    // Person detected if EITHER clear movement OR subtle change vs 10s-ago frame
    const avgDiff = Math.max(fastAvg, slowAvg);

    const statusText = document.getElementById('camera-status-text');

    const detected = fastAvg >= this._MOTION_THRESHOLD || slowAvg >= this._PRESENCE_THRESHOLD;
    if (detected) {
      // Motion/presence detected — reset timer
      this._noMotionSec = 0;
      this._motionBlocked = false;
      if (statusText) statusText.textContent = 'Person detected';
      this._clearMotionWarning();
    } else {
      // No significant motion
      this._noMotionSec += 0.5;
      const remaining = Math.max(0, this._NO_MOTION_WARN - this._noMotionSec);
      if (statusText) statusText.textContent = `No person (${Math.ceil(remaining)}s)`;

      if (this._noMotionSec >= this._NO_MOTION_WARN && !this._motionBlocked) {
        this._handleNoMotion();
      }
    }
  },

  async _detectFace(video) {
    if (!this._faceModel || !video || video.readyState < 2 || !this._cameraStream) return;
    const statusText = document.getElementById('camera-status-text');
    const canvas = document.getElementById('camera-canvas');
    try {
      const predictions = await this._faceModel.estimateFaces(video, false);

      // Draw video + face boxes on canvas
      if (canvas) {
        canvas.width = video.videoWidth || 320;
        canvas.height = video.videoHeight || 240;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        predictions.forEach(pred => {
          const [x1, y1] = pred.topLeft;
          const [x2, y2] = pred.bottomRight;
          ctx.strokeStyle = '#00e676';
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.roundRect ? ctx.roundRect(x1, y1, x2-x1, y2-y1, 4) : ctx.rect(x1, y1, x2-x1, y2-y1);
          ctx.stroke();
          // Label
          ctx.fillStyle = '#00e676';
          ctx.font = 'bold 11px sans-serif';
          ctx.fillText('Person', x1, y1 > 14 ? y1 - 4 : y1 + 14);
        });
      }

      if (predictions.length > 0) {
        this._noMotionSec = 0;
        this._motionBlocked = false;
        if (statusText) statusText.textContent = 'Person detected';
        this._clearMotionWarning();
      } else {
        this._noMotionSec += 0.6;
        const remaining = Math.max(0, this._NO_MOTION_WARN - this._noMotionSec);
        if (statusText) statusText.textContent = `No person (${Math.ceil(remaining)}s)`;
        if (this._noMotionSec >= this._NO_MOTION_WARN && !this._motionBlocked) {
          this._handleNoMotion();
        }
      }
    } catch(e) {
      // Model error — fall back to motion detection silently
      this._detectMotion(video);
    }
  },

  _handleNoMotion() {
    if (this._motionBlocked) return;
    this._motionBlocked = true;

    // Issue 1 warning (no blocking overlay — 3 warnings auto-submit)
    this.issueWarning('no_person', 'No person detected in camera frame');
  },

  _clearMotionWarning() {
    const overlay = document.getElementById('motion-warning-overlay');
    if (overlay) overlay.style.display = 'none';
    this._motionBlocked = false;
  },

  // ── Relative brightness detection ────────────────────────────
  // Establishes a luminance baseline at exam start, then flags when
  // brightness drops below 75% of that baseline. This detects the
  // student dimming their screen regardless of room lighting conditions.
  _checkAmbientBrightness(frameData, pixelCount) {
    let lum = 0;
    for (let i = 0; i < frameData.length; i += 4) {
      lum += 0.299 * frameData[i] + 0.587 * frameData[i + 1] + 0.114 * frameData[i + 2];
    }
    const avgLuminance = lum / pixelCount; // 0–255

    // First reading: record baseline (needs > 20 luminance to be useful)
    if (this._brightnessBaseline === null) {
      if (avgLuminance > 20) this._brightnessBaseline = avgLuminance;
      return;
    }

    // Slowly update baseline upward only (room gets brighter = new normal)
    if (avgLuminance > this._brightnessBaseline) {
      this._brightnessBaseline = avgLuminance * 0.05 + this._brightnessBaseline * 0.95;
    }

    // Only run check if baseline is meaningful (> 20 = camera can see something)
    if (this._brightnessBaseline < 20) return;

    // Flag when current brightness drops below 75% of the baseline
    const ratio = avgLuminance / this._brightnessBaseline;
    const statusText = document.getElementById('camera-status-text');

    if (ratio < 0.75) {
      this._darkSeconds += 0.6;
      if (statusText && this._darkSeconds < 10) {
        const pct = Math.round(ratio * 100);
        statusText.textContent = `⚠ Brightness ${pct}% (${Math.ceil(10 - this._darkSeconds)}s)`;
      }
      if (this._darkSeconds >= 10 && !this._brightnessWarningIssued) {
        this._brightnessWarningIssued = true;
        this.issueWarning('low_brightness', 'Screen brightness dropped below 75% — please restore your display brightness');
      }
    } else {
      if (this._darkSeconds > 0) {
        this._darkSeconds = 0;
        this._brightnessWarningIssued = false;
        if (statusText) statusText.textContent = '● Monitoring';
      }
    }
  },

  // Keep captureSnapshot for admin monitoring thumbnails (less frequent)
  captureSnapshot() {
    const video = document.getElementById('camera-feed');
    const canvas = document.getElementById('camera-canvas');
    if (!video || !canvas || !this._cameraStream || !this.session) return;
    if (video.readyState < 2) return;
    try {
      // 320×240 for live grid; mirror the image so it looks natural
      canvas.width = 320; canvas.height = 240;
      const ctx = canvas.getContext('2d');
      ctx.save(); ctx.scale(-1, 1);
      ctx.drawImage(video, -320, 0, 320, 240);
      ctx.restore();
      const imageData = canvas.toDataURL('image/jpeg', 0.6);
      const session = DB.getSession(this.session.id);
      if (!session) return;
      // Keep only the latest snapshot (index 0) — admin grid reads [0]
      DB.updateSession(this.session.id, {
        cameraSnapshots: [{ timestamp: new Date().toISOString(), imageData }],
      });
    } catch(e) {}
  },

  stopCamera() {
    this._cameraPrompting = false;
    if (this._motionInterval) { clearInterval(this._motionInterval); this._motionInterval = null; }
    if (this._snapInterval)   { clearInterval(this._snapInterval);   this._snapInterval = null; }
    this._prevFrameData = null;
    this._noMotionSec = 0;
    this._motionBlocked = false;
    if (this._cameraStream) {
      this._cameraStream.getTracks().forEach(t => t.stop());
      this._cameraStream = null;
    }
    const container = document.getElementById('camera-container');
    if (container) container.style.display = 'none';
  },

  destroyAntiCheat() {
    if (this._blurTimer) { clearTimeout(this._blurTimer); this._blurTimer = null; }
    if (this._pendingFullscreenRecovery) {
      clearTimeout(this._pendingFullscreenRecovery);
      this._pendingFullscreenRecovery = null;
    }
    this._fullscreenInteractionGraceUntil = 0;
    this._intentionalFullscreenExit = false;
    this.cancelCountdown(false);
    this.anticheatListeners.forEach(([event, target, handler]) => {
      target.removeEventListener(event, handler);
    });
    this.anticheatListeners = [];
    this.stopCamera();
  },

  // ============================================================
  // COUNTDOWN (10-second auto-submit window)
  // ============================================================
  startCountdown(totalSeconds) {
    this.cancelCountdown(false); // clear previous without hiding overlay

    const numEl    = document.getElementById('cd-num');
    const circleEl = document.getElementById('cd-circle');
    const wrapEl   = document.getElementById('warning-countdown-wrap');
    const circumference = 163.36; // 2 * PI * 26

    if (wrapEl) wrapEl.style.display = '';

    let remaining = totalSeconds;

    const updateUI = () => {
      if (numEl) numEl.textContent = remaining;
      if (circleEl) {
        // Drain the ring as time runs out
        const offset = circumference * (totalSeconds - remaining) / totalSeconds;
        circleEl.style.strokeDashoffset = offset;
      }
    };

    updateUI();

    this._countdownInterval = setInterval(() => {
      remaining--;
      updateUI();
      if (remaining <= 0) {
        clearInterval(this._countdownInterval);
        this._countdownInterval = null;
        // Update overlay to show submitting message
        const msgEl = document.getElementById('warning-overlay-msg');
        const subEl = document.getElementById('warning-overlay-sub');
        if (msgEl) msgEl.textContent = 'Time expired. Submitting your exam now...';
        if (subEl) subEl.textContent = '';
        if (wrapEl) wrapEl.style.display = 'none';
        setTimeout(() => this.submitExam('auto'), 1500);
      }
    }, 1000);
  },

  cancelCountdown(hideOverlay = true) {
    // If the 3-second read countdown is already running (started by an earlier
    // cancelCountdown call from the same return event pair), don't interrupt it —
    // just stop the 10s interval if it somehow still exists and bail out.
    if (this._inReadCountdown) {
      if (this._countdownInterval) {
        clearInterval(this._countdownInterval);
        this._countdownInterval = null;
      }
      return;
    }

    const hadCountdown = !!this._countdownInterval;
    if (this._countdownInterval) {
      clearInterval(this._countdownInterval);
      this._countdownInterval = null;
    }

    const wrapEl = document.getElementById('warning-countdown-wrap');
    if (wrapEl) wrapEl.style.display = 'none';

    if (hideOverlay && hadCountdown && this.warnings < 3) {
      // Student returned — keep overlay for 3s so they can read the warning
      this._startReadCountdown(3);
    }
  },

  _cancelReadCountdown() {
    if (this._warningReadTimer) {
      clearTimeout(this._warningReadTimer);
      this._warningReadTimer = null;
    }
    this._inReadCountdown = false;
    const wrapEl = document.getElementById('warning-countdown-wrap');
    if (wrapEl) wrapEl.style.display = 'none';
    // Restore the original countdown message for next time
    const msgEl = document.getElementById('warning-countdown-msg');
    if (msgEl) msgEl.textContent = 'Return to this window or your exam will be auto-submitted';
  },

  _startReadCountdown(totalSeconds) {
    const overlay      = document.getElementById('warning-overlay');
    const wrapEl       = document.getElementById('warning-countdown-wrap');
    const msgEl        = document.getElementById('warning-countdown-msg');
    const cdNum        = document.getElementById('cd-num');
    const cdCircle     = document.getElementById('cd-circle');
    const circumference = 163.36;

    if (!overlay || !wrapEl) return;

    this._inReadCountdown = true;
    if (msgEl) msgEl.textContent = 'Read this warning. The exam will resume shortly.';

    // Reset ring to full
    if (cdCircle) cdCircle.style.strokeDashoffset = '0';
    if (cdNum) cdNum.textContent = totalSeconds;
    wrapEl.style.display = '';

    let remaining = totalSeconds;

    const tick = () => {
      remaining--;
      if (cdNum) cdNum.textContent = remaining;
      if (cdCircle) {
        cdCircle.style.strokeDashoffset =
          String(circumference * (totalSeconds - remaining) / totalSeconds);
      }
      if (remaining <= 0) {
        this._inReadCountdown = false;
        this._warningReadTimer = null;
        wrapEl.style.display = 'none';
        overlay.style.display = 'none';
        return;
      }
      this._warningReadTimer = setTimeout(tick, 1000);
    };

    this._warningReadTimer = setTimeout(tick, 1000);
  },

  issueWarning(type, detail) {
    if (!this.session) return;
    if (this.warnings >= 3) return;
    if (type === 'fullscreen_exit') {
      if (this._intentionalFullscreenExit) {
        this._intentionalFullscreenExit = false;
        return;
      }
      if (this._hasRecentTrustedInteraction()) {
        this._attemptGracefulFullscreenRecovery();
        return;
      }
    }
    if (this._cameraPrompting) return; // camera permission dialog open — not a violation

    // Clear any in-progress read countdown so the new warning takes over cleanly
    this._cancelReadCountdown();

    // Debounce: prevent double-firing within 1500ms (blur + visibilitychange fire together)
    const now = Date.now();
    if (this._lastWarningTime && (now - this._lastWarningTime) < 1500) return;
    this._lastWarningTime = now;

    this.warnings++;

    this._recordActivity(type, detail);
    DB.updateSession(this.session.id, { warnings: this.warnings });

    // Update warning badge in header
    const warningNumEl = document.getElementById('warning-num');
    if (warningNumEl) warningNumEl.textContent = this.warnings;
    const warningCountDisplay = document.getElementById('warning-count-display');
    if (warningCountDisplay) {
      warningCountDisplay.className = 'warning-count warning-level-' + this.warnings;
    }

    this.showWarningOverlay(type, detail);

    if (this.warnings >= 3) {
      // 3 strikes — auto-submit after overlay reads
      setTimeout(() => this.submitExam('auto'), 3000);
      return;
    }

    // Focus-loss violations start a 10-second return window
    const focusLoss = ['window_blur', 'tab_switch', 'fullscreen_exit'];
    if (focusLoss.includes(type)) {
      this.startCountdown(10);
    }
  },

  showWarningOverlay(type, detail) {
    const overlay  = document.getElementById('warning-overlay');
    const msgEl    = document.getElementById('warning-overlay-msg');
    const countEl  = document.getElementById('warning-overlay-count');
    const subEl    = document.getElementById('warning-overlay-sub');
    const titleEl  = document.getElementById('warning-overlay-title');
    if (!overlay) return;

    const messages = {
      tab_switch:      'You switched to another tab or window.',
      window_blur:     'Another application was detected in front of the exam.',
      copy_attempt:    'Copying or cutting content is not allowed.',
      fullscreen_exit: 'You exited fullscreen mode.',
      screenshot:      'Screenshot attempt detected.',
      no_person:       'No person detected in the camera frame.',
      low_brightness:  'Your camera feed is too dark — please ensure adequate lighting.',
    };

    msgEl.textContent  = messages[type] || detail;
    countEl.textContent = this.warnings;

    // Update pips
    for (let i = 1; i <= 3; i++) {
      const pip = document.getElementById('wpip-' + i);
      if (pip) pip.classList.toggle('active', i <= this.warnings);
    }

    overlay.className = 'warning-level-' + this.warnings;

    if (this.warnings >= 3) {
      titleEl.textContent = 'FINAL WARNING!';
      subEl.textContent   = 'Maximum violations reached. Your exam is being submitted now.';
    } else {
      titleEl.textContent = 'WARNING!';
      subEl.textContent   = (3 - this.warnings) + ' warning' + (3 - this.warnings !== 1 ? 's' : '') + ' remaining before auto-submit.';
    }

    // Shake animation
    const content = document.getElementById('warning-overlay-content');
    if (content) {
      content.classList.remove('warning-shake');
      void content.offsetWidth;
      content.classList.add('warning-shake');
    }

    overlay.style.display = '';

    // Non-focus violations auto-hide after 4s (copy/screenshot — no return needed)
    const focusLoss = ['window_blur', 'tab_switch', 'fullscreen_exit'];
    if (!focusLoss.includes(type) && this.warnings < 3) {
      setTimeout(() => { overlay.style.display = 'none'; }, 4000);
    }
  },

  // ============================================================
  // TIMER
  // ============================================================
  startTimer() {
    this.stopTimer();

    const session = DB.getSession(this.session.id);
    let startTime;
    if (session && session.startTime) {
      startTime = new Date(session.startTime).getTime();
    } else {
      // Fresh start (retake after reset) — record start time now
      startTime = Date.now();
      DB.updateSession(this.session.id, { startTime: new Date(startTime).toISOString() });
    }
    const totalSeconds = this.exam.timeLimit * 60;
    const elapsed = Math.floor((Date.now() - startTime) / 1000);
    this.timeRemaining = Math.max(0, totalSeconds - elapsed);

    if (this.timeRemaining <= 0) {
      this.submitExam('timeout');
      return;
    }

    const timerEl = document.getElementById('exam-timer');
    const display = document.getElementById('timer-display');

    const tick = () => {
      if (this.timeRemaining <= 0) {
        this.stopTimer();
        this.submitExam('timeout');
        return;
      }

      display.textContent = this.formatTime(this.timeRemaining);

      // Warning when 5 minutes or less remain
      if (this.timeRemaining <= 300) {
        timerEl.classList.add('timer-warning');
      } else {
        timerEl.classList.remove('timer-warning');
      }

      this.timeRemaining--;
    };

    tick();
    this.timerInterval = setInterval(tick, 1000);
  },

  stopTimer() {
    if (this.timerInterval) { clearInterval(this.timerInterval); this.timerInterval = null; }
  },

  formatTime(seconds) {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
  },

  // ============================================================
  // RENDER QUESTIONS
  // ============================================================
  renderQuestions() {
    const questions = [...this.exam.questions];
    if (this.exam.shuffleQuestions) this.shuffle(questions);
    this.questionOrder = questions;
    this.currentQuestionIndex = 0;
    this.markedForReview = new Set();

    // Render all cards (hidden), show first via showQuestion
    const container = document.getElementById('questions-container');
    container.innerHTML = questions.map((q, idx) => this._renderQuestion(q, idx)).join('');

    // Restore previously answered questions
    questions.forEach((q, idx) => {
      const savedAns = this.answers[q.id];
      if (savedAns !== undefined) this._restoreAnswer(q, idx, savedAns);
    });

    // Build nav grid and show question 0
    this._buildNavGrid();
    this.showQuestion(0);
  },

  _renderQuestion(q, idx) {
    let answerHtml = '';

    if (q.type === 'mcq') {
      answerHtml = this._renderMCQ(q, idx);
    } else if (q.type === 'tf') {
      answerHtml = this._renderTF(q, idx);
    } else if (q.type === 'identification') {
      answerHtml = this._renderIdentification(q, idx);
    } else if (q.type === 'essay') {
      answerHtml = this._renderEssay(q, idx);
    } else if (q.type === 'coding') {
      answerHtml = this._renderCoding(q, idx);
    } else if (q.type === 'enumeration') {
      answerHtml = this._renderEnumeration(q, idx);
    } else if (q.type === 'matching') {
      answerHtml = this._renderMatching(q, idx);
    }

    const typeLabels = { mcq:'Multiple Choice', tf:'True / False', identification:'Identification', essay:'Essay', enumeration:'Enumeration', matching:'Matching Type', coding:'Coding' };

    const imgHtml = q.imageUrl
      ? `<div class="question-img-wrap"><img src="${_escAttr(q.imageUrl)}" alt="Question image" class="question-img" onerror="this.parentElement.style.display='none'" /></div>`
      : '';

    const requiredBadge = q.required !== false
      ? `<span class="q-required-badge">Required</span>`
      : '';

    return `
      <div class="question-card" id="qcard-${q.id}" data-qid="${q.id}" style="display:none;">
        <div class="question-header">
          <div class="question-num">${idx + 1}</div>
          <div class="question-content">${_escText(q.content)}${requiredBadge}</div>
          <div class="question-points">${q.points} pt${q.points !== 1 ? 's' : ''}</div>
        </div>
        ${imgHtml}
        <div class="question-type-label">${typeLabels[q.type] || q.type}</div>
        <div class="question-answer-area">${answerHtml}</div>
      </div>
    `;
  },

  _renderMCQ(q, idx) {
    const options = [...q.options];
    if (this.exam.shuffleAnswers) this.shuffle(options);
    const letters = ['A','B','C','D','E','F'];

    return `<div class="mcq-options" id="mcq-${q.id}">` +
      options.map((opt, oi) => `
        <div class="mcq-option" id="mcq-opt-${q.id}-${oi}" data-exam-control="true" data-qid="${q.id}" data-val="${_escAttr(opt)}" onclick="ExamApp.selectMCQ('${q.id}', '${_escAttr(opt)}')">
          <div class="mcq-option-letter">${letters[oi] || (oi+1)}</div>
          <span class="mcq-option-text">${_escText(opt)}</span>
        </div>
      `).join('') +
      `</div>`;
  },

  _renderTF(q, idx) {
    return `<div class="tf-options" id="tf-${q.id}">
      <div class="tf-btn tf-true" data-exam-control="true" id="tf-${q.id}-true" onclick="ExamApp.selectTF('${q.id}', 'True')">
        <span class="tf-icon">
          <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
        </span>
        <span class="tf-label">True</span>
      </div>
      <div class="tf-btn tf-false" data-exam-control="true" id="tf-${q.id}-false" onclick="ExamApp.selectTF('${q.id}', 'False')">
        <span class="tf-icon">
          <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </span>
        <span class="tf-label">False</span>
      </div>
    </div>`;
  },

  _renderIdentification(q, idx) {
    return `<input type="text" class="id-input" id="id-input-${q.id}" data-exam-control="true" placeholder="Type your answer here..."
      autocomplete="off" autocorrect="off" autocapitalize="characters" spellcheck="false"
      oninput="ExamApp.handleIdentificationInput(event, '${q.id}')" />`;
  },

  _renderEnumeration(q, idx) {
    const count = (q.answers||[]).length || 3;
    const rows = Array.from({length: count}, (_, i) => `
      <div style="display:flex;align-items:center;gap:8px;">
        <span style="font-size:13px;color:#9ca3af;font-weight:700;min-width:22px;">${i+1}.</span>
        <input type="text" class="form-control" id="enum-${q.id}-${i}" data-exam-control="true" placeholder="Item ${i+1}"
          autocomplete="off" spellcheck="true"
          oninput="ExamApp.handleEnumInput(event,'${q.id}',${count})" style="flex:1;" />
      </div>`).join('');
    return `<div style="display:flex;flex-direction:column;gap:8px;">${rows}</div>
      <div style="font-size:11px;color:#9ca3af;margin-top:6px;">List all ${count} items. Each correct item earns partial points.</div>`;
  },

  _renderMatching(q, idx) {
    const pairs = q.pairs || [];
    // Show shuffled matches on the right
    const matches = [...pairs.map(p=>p.match)].sort(()=>Math.random()-0.5);
    return `<div style="display:flex;flex-direction:column;gap:8px;">
      ${pairs.map((p,pi)=>`
        <div style="display:grid;grid-template-columns:1fr auto 1fr;gap:10px;align-items:center;">
          <div style="background:#f3f4f6;border-radius:8px;padding:8px 12px;font-size:13px;font-weight:600;">${_esc(p.term)}</div>
          <div style="color:#9ca3af;font-size:16px;display:flex;align-items:center;justify-content:center;">${this._portalIcon('arrowRight', { size: 14, stroke: '#9ca3af' })}</div>
          <select class="form-control" id="match-${q.id}-${pi}" data-exam-control="true"
            onchange="ExamApp.handleMatchInput(event,'${q.id}',${pairs.length})"
            style="font-size:13px;">
            <option value="">— Select —</option>
            ${matches.map(m=>`<option value="${_escAttr(m)}">${_esc(m)}</option>`).join('')}
          </select>
        </div>`).join('')}
    </div>`;
  },

  _renderEssay(q, idx) {
    const minW = q.minWords || 0;
    const note = minW > 0 ? `Minimum ${minW} words required.` : 'Write a detailed response.';
    return `
      <textarea class="essay-textarea" id="essay-input-${q.id}" data-exam-control="true" placeholder="Write your answer here..."
        autocomplete="off" spellcheck="true"
        oninput="ExamApp.handleEssayInput(event, '${q.id}', ${minW})"
      ></textarea>
      <div class="essay-meta">
        <span class="essay-hint">${note}</span>
        <span class="essay-chars" id="essay-count-${q.id}">0 words</span>
      </div>`;
  },

  _renderCoding(q, idx) {
    const langLabels = { python:'Python', javascript:'JavaScript', java:'Java', cpp:'C++', c:'C', php:'PHP' };
    const lang = q.language || 'python';
    const starter = q.starterCode || '';
    const expectedHtml = q.expectedOutput
      ? `<div class="coding-expected-wrap">
          <div class="coding-section-label">Expected Output</div>
          <pre class="coding-expected-pre">${_escText(q.expectedOutput)}</pre>
        </div>` : '';
    return `
      ${expectedHtml}
      <div class="coding-editor-shell">
        <div class="coding-editor-header">
          <span class="coding-lang-badge">${_escText(langLabels[lang] || lang)}</span>
          <span class="coding-editor-hint">Write your solution — use Shift+Enter for new lines</span>
        </div>
        <textarea id="coding-textarea-${q.id}" class="coding-cm-source" style="display:none;">${_escText(starter)}</textarea>
        <div id="coding-cm-${q.id}" class="coding-cm-wrap"></div>
      </div>`;
  },

  _initCodeEditors() {
    const LANG_MODE = { python:'python', javascript:'javascript', java:'clike', cpp:'clike', c:'clike', php:'php' };
    this.questionOrder.forEach(q => {
      if (q.type !== 'coding') return;
      const wrap = document.getElementById('coding-cm-' + q.id);
      const src  = document.getElementById('coding-textarea-' + q.id);
      if (!wrap || !src || wrap.dataset.cmInit) return;
      wrap.dataset.cmInit = '1';

      if (!window.CodeMirror) {
        // Fallback: plain textarea if CodeMirror not loaded
        src.style.display = '';
        src.style.cssText = 'width:100%;min-height:200px;font-family:monospace;font-size:13px;padding:12px;border:1px solid #e5e7eb;border-radius:8px;background:#1e1e2e;color:#cdd6f4;';
        src.oninput = () => ExamApp.selectAnswer(q.id, src.value);
        if (this.answers[q.id]) src.value = this.answers[q.id];
        return;
      }

      const cm = window.CodeMirror(wrap, {
        value: (this.answers[q.id] !== undefined ? this.answers[q.id] : src.value) || '',
        mode: LANG_MODE[q.language || 'python'] || 'python',
        theme: 'dracula',
        lineNumbers: true,
        indentUnit: 4,
        tabSize: 4,
        indentWithTabs: q.language === 'python' ? false : true,
        lineWrapping: false,
        autofocus: false,
        extraKeys: {
          'Tab': (cm) => cm.replaceSelection('    '),
          'Shift-Tab': 'indentLess',
        },
      });
      cm.on('change', () => {
        ExamApp.selectAnswer(q.id, cm.getValue());
      });
      wrap._cm = cm;
    });
  },

  // ============================================================
  // RESTORE ANSWERS (on resume)
  // ============================================================
  _restoreAnswer(q, idx, value) {
    if (q.type === 'mcq') {
      const opts = document.querySelectorAll(`[data-qid="${q.id}"].mcq-option`);
      opts.forEach(opt => {
        if (opt.getAttribute('data-val') === value) opt.classList.add('selected');
      });
    } else if (q.type === 'tf') {
      const trueBtn = document.getElementById(`tf-${q.id}-true`);
      const falseBtn = document.getElementById(`tf-${q.id}-false`);
      if (trueBtn && falseBtn) {
        if (value === 'True') trueBtn.classList.add('selected');
        else if (value === 'False') falseBtn.classList.add('selected');
      }
    } else if (q.type === 'identification') {
      const input = document.getElementById(`id-input-${q.id}`);
      if (input) input.value = value;
    } else if (q.type === 'essay') {
      const ta = document.getElementById(`essay-input-${q.id}`);
      if (ta) {
        ta.value = value;
        const wordCount = value.trim() ? value.trim().split(/\s+/).length : 0;
        const countEl = document.getElementById('essay-count-' + q.id);
        if (countEl) countEl.textContent = wordCount + ' word' + (wordCount !== 1 ? 's' : '');
      }
    } else if (q.type === 'coding') {
      // CodeMirror restore is handled in _initCodeEditors; just set the textarea backup
      const ta = document.getElementById(`coding-textarea-${q.id}`);
      if (ta) ta.value = value;
      const cmWrap = document.getElementById(`coding-cm-${q.id}`);
      if (cmWrap?._cm) cmWrap._cm.setValue(value);
    }
    const card = document.getElementById(`qcard-${q.id}`);
    if (card) card.classList.add('answered');
  },

  // ============================================================
  // ANSWER SELECTION
  // ============================================================
  selectMCQ(questionId, value) {
    // Deselect all options for this question
    document.querySelectorAll(`[data-qid="${questionId}"].mcq-option`).forEach(opt => {
      opt.classList.remove('selected');
    });
    // Select clicked
    const clicked = document.querySelector(`[data-qid="${questionId}"][data-val="${CSS.escape(value)}"]`);
    if (clicked) clicked.classList.add('selected');
    this.selectAnswer(questionId, value);
  },

  selectTF(questionId, value) {
    const trueBtn = document.getElementById(`tf-${questionId}-true`);
    const falseBtn = document.getElementById(`tf-${questionId}-false`);
    if (trueBtn) trueBtn.classList.toggle('selected', value === 'True');
    if (falseBtn) falseBtn.classList.toggle('selected', value === 'False');
    this.selectAnswer(questionId, value);
  },

  handleIdentificationInput(event, questionId) {
    const val = event.target.value.toUpperCase();
    event.target.value = val;
    this.selectAnswer(questionId, val);
  },

  handleEnumInput(event, questionId, count) {
    // Collect all enum inputs for this question
    const items = [];
    for (let i = 0; i < count; i++) {
      const el = document.getElementById(`enum-${questionId}-${i}`);
      items.push(el ? el.value.trim() : '');
    }
    this.selectAnswer(questionId, items.join('\n'));
  },

  handleMatchInput(event, questionId, pairCount) {
    // Collect all match selects for this question
    const matched = {};
    for (let i = 0; i < pairCount; i++) {
      const el = document.getElementById(`match-${questionId}-${i}`);
      matched[i] = el ? el.value : '';
    }
    this.selectAnswer(questionId, JSON.stringify(matched));
  },

  handleEssayInput(event, questionId, minWords) {
    const val = event.target.value;
    const wordCount = val.trim() ? val.trim().split(/\s+/).length : 0;
    const countEl = document.getElementById('essay-count-' + questionId);
    if (countEl) {
      countEl.textContent = wordCount + ' word' + (wordCount !== 1 ? 's' : '');
      countEl.style.color = minWords > 0 && wordCount < minWords ? '#dc2626' : '#6b7280';
    }
    this.selectAnswer(questionId, val);
  },

  selectAnswer(questionId, value) {
    this.answers[questionId] = value;
    const card = document.getElementById(`qcard-${questionId}`);
    if (card) {
      card.classList.toggle('answered', !!value);
      if (value) card.classList.remove('q-required-missing');
    }
    this.autoSave();
    this._updateAnsweredStatus();
  },

  autoSave() {
    if (!this.session) return;
    DB.updateSession(this.session.id, { answers: this.answers });
  },

  // ── Single-question navigation ───────────────────────────────

  _buildNavGrid() {
    const grid = document.getElementById('question-nav-grid');
    if (!grid) return;
    grid.innerHTML = this.questionOrder.map((q, idx) =>
      `<button type="button" class="nav-q-btn" data-exam-control="true" id="nav-q-${idx}" onclick="ExamApp.showQuestion(${idx})">${idx + 1}</button>`
    ).join('');
    this._updateNavGrid();
  },

  showQuestion(idx) {
    const questions = this.questionOrder;
    if (!questions.length) return;
    idx = Math.max(0, Math.min(idx, questions.length - 1));
    this.currentQuestionIndex = idx;

    questions.forEach((q, i) => {
      const card = document.getElementById(`qcard-${q.id}`);
      if (card) card.style.display = i === idx ? '' : 'none';
    });

    const prevBtn = document.getElementById('btn-prev');
    const nextBtn = document.getElementById('btn-next');
    if (prevBtn) prevBtn.disabled = idx === 0;
    if (nextBtn) nextBtn.disabled = idx === questions.length - 1;

    const cb = document.getElementById('mark-review-cb');
    if (cb) cb.checked = this.markedForReview.has(idx);

    const wrap = document.querySelector('.examv2-main');
    if (wrap) wrap.scrollTop = 0;

    // Initialize CodeMirror for any coding questions now visible
    requestAnimationFrame(() => this._initCodeEditors());

    this._updateNavGrid();
  },

  _updateNavGrid() {
    this.questionOrder.forEach((q, idx) => {
      const btn = document.getElementById(`nav-q-${idx}`);
      if (!btn) return;
      btn.className = 'nav-q-btn';
      const isAnswered = this.answers[q.id] !== undefined && this.answers[q.id] !== '' && this.answers[q.id] !== null;
      if (idx === this.currentQuestionIndex) {
        btn.classList.add('current');
        if (isAnswered) btn.classList.add('answered');
      } else if (this.markedForReview.has(idx)) {
        btn.classList.add('review');
      } else if (isAnswered) {
        btn.classList.add('answered');
      }
    });
  },

  nextQuestion() {
    if (this.currentQuestionIndex < this.questionOrder.length - 1) {
      this.showQuestion(this.currentQuestionIndex + 1);
    }
  },

  prevQuestion() {
    if (this.currentQuestionIndex > 0) {
      this.showQuestion(this.currentQuestionIndex - 1);
    }
  },

  toggleMarkReview() {
    const idx = this.currentQuestionIndex;
    if (this.markedForReview.has(idx)) {
      this.markedForReview.delete(idx);
    } else {
      this.markedForReview.add(idx);
    }
    this._updateNavGrid();
    this._updateAnsweredStatus();
  },

  // ────────────────────────────────────────────────────────────

  _updateAnsweredStatus() {
    const total = this.questionOrder.length;
    const answered = Object.values(this.answers).filter(v => v !== null && v !== undefined && v !== '').length;
    const review = this.markedForReview ? this.markedForReview.size : 0;
    const skipped = total - answered;

    const el = (id, val) => { const e = document.getElementById(id); if (e) e.textContent = val; };
    el('stat-total', total);
    el('stat-answered', answered);
    el('stat-review', review);
    el('stat-skipped', Math.max(0, skipped));

    // Legacy support
    const pct = total > 0 ? Math.round((answered / total) * 100) : 0;
    const progressBar = document.getElementById('exam-progress-bar');
    if (progressBar) progressBar.style.width = pct + '%';
    const statusEl = document.getElementById('exam-answered-status');
    if (statusEl) statusEl.textContent = `${answered} of ${total} answered`;
    const submitProgress = document.getElementById('submit-progress');
    if (submitProgress) submitProgress.innerHTML = `<strong>${answered}</strong> of <strong>${total}</strong> questions answered`;

    this._updateNavGrid && this._updateNavGrid();
  },

  // ============================================================
  // SUBMIT
  // ============================================================
  confirmSubmit() {
    this._rememberTrustedInteraction(1800);
    // Check required questions first — block submission if any are unanswered
    const unansweredRequired = this.questionOrder.filter(q =>
      q.required !== false &&
      (this.answers[q.id] === null || this.answers[q.id] === undefined || this.answers[q.id] === '')
    );

    if (unansweredRequired.length > 0) {
      // Highlight the unanswered required question cards
      this.questionOrder.forEach(q => {
        const card = document.getElementById('qcard-' + q.id);
        if (card) card.classList.remove('q-required-missing');
      });
      unansweredRequired.forEach(q => {
        const card = document.getElementById('qcard-' + q.id);
        if (card) card.classList.add('q-required-missing');
      });
      // Navigate to the first missing question
      const firstIdx = this.questionOrder.findIndex(q => q.id === unansweredRequired[0].id);
      if (firstIdx >= 0) this.showQuestion(firstIdx);

      const n = unansweredRequired.length;
      this._showRequiredError(`${n} required question${n !== 1 ? 's' : ''} must be answered before submitting.`);
      return;
    }

    // Clear any previous highlights
    this.questionOrder.forEach(q => {
      const card = document.getElementById('qcard-' + q.id);
      if (card) card.classList.remove('q-required-missing');
    });

    const total = this.questionOrder.length;
    const answered = Object.values(this.answers).filter(v => v !== null && v !== undefined && v !== '').length;
    const unanswered = total - answered;

    let msg = 'Are you sure you want to submit your exam?';
    if (unanswered > 0) {
      msg = `You have ${unanswered} unanswered question${unanswered !== 1 ? 's' : ''}. Are you sure you want to submit? Unanswered questions will receive 0 points.`;
    }

    document.getElementById('confirm-submit-msg').textContent = msg;
    document.getElementById('confirm-submit-modal').classList.remove('hidden');
  },

  _showRequiredError(msg) {
    let el = document.getElementById('required-error-toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'required-error-toast';
      el.className = 'required-error-toast';
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(el._hideTimer);
    el._hideTimer = setTimeout(() => el.classList.remove('show'), 4000);
  },

  cancelSubmit() {
    document.getElementById('confirm-submit-modal').classList.add('hidden');
  },

  showReview() {
    const sess = this.session ? DB.getSession(this.session.id) : null;
    const exam = this.exam;
    if (!sess || !exam) return;

    this.showState('review');
    const titleEl = document.getElementById('review-exam-title');
    if (titleEl) titleEl.textContent = exam.title;
    const nameEl = document.getElementById('review-student-name');
    if (nameEl) nameEl.textContent = sess.studentName + ' · ' + sess.studentId;
    const scoreEl = document.getElementById('review-score-chip');
    if (scoreEl) {
      const pct = sess.maxScore ? Math.round(sess.score / sess.maxScore * 100) : 0;
      scoreEl.textContent = `${sess.score}/${sess.maxScore} — ${pct}%`;
      scoreEl.style.background = pct >= 75 ? 'rgba(21,128,61,0.8)' : pct >= 60 ? 'rgba(217,119,6,0.8)' : 'rgba(220,38,38,0.8)';
    }

    const container = document.getElementById('review-container');
    if (!container) return;

    if (nameEl) nameEl.textContent = `${sess.studentName} - ${sess.studentId}`;
    const totalScore = Number(sess.score || 0);
    const maxScore = Number(sess.maxScore || 0);
    const pct = maxScore ? Math.round(totalScore / maxScore * 100) : 0;
    if (scoreEl) {
      scoreEl.removeAttribute('style');
      scoreEl.className = `review-score-chip ${pct >= 75 ? 'score-high' : pct >= 60 ? 'score-mid' : 'score-low'}`;
      scoreEl.innerHTML = `
        <div class="review-score-chip-stats">
          <span id="review-score-value">${totalScore}/${maxScore}</span>
          <span class="review-score-chip-divider"></span>
          <span id="review-score-pct">${pct}%</span>
        </div>
        <div class="review-score-chip-label">Total Score</div>
      `;
    }

    const typeLabel = { mcq: 'MCQ', tf: 'T/F', identification: 'ID', enumeration: 'Enumeration', matching: 'Matching', essay: 'Essay' };

    container.innerHTML = exam.questions.map((q, idx) => {
      const ans = (sess.answers || {})[q.id];
      let resultHtml = '';

      if (q.type === 'essay') {
        resultHtml = `
          <div class="review-answer-group">
            <div class="review-answer-row review-answer-row-stack">
              <div class="review-answer-label">Your answer</div>
              <div class="review-answer-essay">${_esc(ans || '(no answer)')}</div>
            </div>
            <div class="review-answer-note">Essay responses are reviewed manually by your instructor.</div>
          </div>`;
      } else if (q.type === 'enumeration') {
        const expected = q.answers || [];
        const studentItemsRaw = (ans || '').split('\n').map((s) => s.trim()).filter(Boolean);
        const studentItems = studentItemsRaw.map((s) => s.toUpperCase());
        const matched = expected.filter((e) => studentItems.includes(e.toUpperCase()));
        resultHtml = `
          <div class="review-answer-group">
            <div class="review-answer-row">
              <div class="review-answer-label">Your answer</div>
              <div class="review-answer-value ${studentItemsRaw.length ? 'is-neutral' : 'is-empty'}">${studentItemsRaw.length ? `${studentItemsRaw.length} item(s) submitted` : '(no answer)'}</div>
            </div>
            <div class="review-enum-list">
              ${expected.map((e, i) => {
                const got = studentItems.includes(e.toUpperCase());
                const studentValue = studentItemsRaw[i] || '';
                return `<div class="review-enum-item ${got ? 'is-correct' : 'is-wrong'}">
                  <span class="review-enum-icon">${this._portalIcon(got ? 'check' : 'x', { size: 14, stroke: got ? '#15803d' : '#dc2626' })}</span>
                  <div class="review-enum-copy">
                    <div class="review-enum-expected">${_esc(e)}</div>
                    ${!got && studentValue ? `<div class="review-enum-student">You wrote: ${_esc(studentValue)}</div>` : ''}
                  </div>
                </div>`;
              }).join('')}
            </div>
            <div class="review-answer-note">${matched.length}/${expected.length} correct item(s)</div>
          </div>`;
      } else if (q.type === 'matching') {
        const pairs = q.pairs || [];
        const studentAns = (() => { try { return JSON.parse(ans || '{}'); } catch { return {}; } })();
        resultHtml = `
          <div class="review-answer-group">
            <div class="review-matching-list">
              ${pairs.map((p, pi) => {
                const studentValue = studentAns[pi] || '';
                const correct = studentValue.toUpperCase() === p.match.toUpperCase();
                return `<div class="review-matching-item ${correct ? 'is-correct' : 'is-wrong'}">
                  <div class="review-matching-term">${_esc(p.term)}</div>
                  <div class="review-matching-arrow">${this._portalIcon('arrowRight', { size: 14, stroke: '#8fa0b6' })}</div>
                  <div class="review-matching-answer">
                    <div class="review-matching-student">${_esc(studentValue || '(no answer)')}</div>
                    ${!correct ? `<div class="review-matching-correct">Correct: ${_esc(p.match)}</div>` : ''}
                  </div>
                </div>`;
              }).join('')}
            </div>
          </div>`;
      } else {
        const correct = ans && ans.toString().trim().toUpperCase() === (q.correctAnswer || '').toString().trim().toUpperCase();
        const answerClass = !ans ? 'is-empty' : correct ? 'is-correct' : 'is-wrong';
        resultHtml = `
          <div class="review-answer-group">
            <div class="review-answer-row">
              <div class="review-answer-label">Your answer</div>
              <div class="review-answer-value ${answerClass}">
                <span>${_esc(ans || '(no answer)')}</span>
                ${ans ? `<span class="review-answer-status-icon">${this._portalIcon(correct ? 'check' : 'x', { size: 14, stroke: correct ? '#15803d' : '#dc2626' })}</span>` : ''}
              </div>
            </div>
            <div class="review-answer-row">
              <div class="review-answer-label">Correct answer</div>
              <div class="review-answer-value is-correct">${_esc(q.correctAnswer || '-')}</div>
            </div>
          </div>`;
      }

      return `<article class="review-question-card">
        <div class="review-question-header">
          <div class="review-question-number">${idx + 1}</div>
          <div class="review-question-main">
            <div class="review-question-topline">
              <h3 class="review-question-title">${_esc(q.content)}</h3>
              <span class="review-question-type">${_esc(typeLabel[q.type] || q.type)}</span>
            </div>
            ${q.imageUrl ? `<img src="${q.imageUrl}" alt="Question illustration" class="review-question-image" />` : ''}
            ${resultHtml}
          </div>
        </div>
      </article>`;
    }).join('');
    return;

    container.innerHTML = exam.questions.map((q, idx) => {
      const ans = (sess.answers || {})[q.id];
      let resultHtml = '';

      if (q.type === 'essay') {
        resultHtml = `
          <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:12px;margin-top:8px;font-size:13px;line-height:1.6;white-space:pre-wrap;">${_esc(ans||'(no answer)')}</div>
          <div style="font-size:12px;color:#9ca3af;margin-top:6px;font-style:italic;">Essay — manually graded by instructor.</div>`;
      } else if (q.type === 'enumeration') {
        const expected = q.answers || [];
        const studentItems = (ans||'').split('\n').map(s=>s.trim().toUpperCase()).filter(Boolean);
        const matched = expected.filter(e => studentItems.includes(e.toUpperCase()));
        resultHtml = `
          <div style="margin-top:8px;display:flex;flex-direction:column;gap:4px;">
            ${expected.map((e,i) => {
              const got = studentItems.includes(e.toUpperCase());
              return `<div style="display:flex;align-items:center;gap:8px;font-size:13px;">
                <span style="color:${got?'#15803d':'#dc2626'};font-size:16px;display:inline-flex;align-items:center;justify-content:center;">${this._portalIcon(got ? 'check' : 'x', { size: 14, stroke: got ? '#15803d' : '#dc2626' })}</span>
                <span>${_esc(e)}</span>
                ${!got && studentItems[i] ? `<span style="color:#9ca3af;font-size:12px;">(you wrote: ${_esc(studentItems[i]||'—')})</span>`:''}
              </div>`;
            }).join('')}
          </div>
          <div style="font-size:12px;color:#6b7280;margin-top:6px;">${matched.length}/${expected.length} correct</div>`;
      } else if (q.type === 'matching') {
        const pairs = q.pairs || [];
        const studentAns = (() => { try { return JSON.parse(ans||'{}'); } catch { return {}; } })();
        resultHtml = `
          <div style="margin-top:8px;display:flex;flex-direction:column;gap:6px;">
            ${pairs.map((p,pi) => {
              const correct = (studentAns[pi]||'').toUpperCase() === p.match.toUpperCase();
              return `<div style="display:grid;grid-template-columns:1fr 24px 1fr;gap:8px;align-items:center;font-size:13px;">
                <div style="background:#f9fafb;border-radius:6px;padding:6px 10px;">${_esc(p.term)}</div>
                <div style="text-align:center;color:${correct?'#15803d':'#dc2626'};font-weight:700;display:flex;align-items:center;justify-content:center;">${this._portalIcon(correct ? 'check' : 'x', { size: 14, stroke: correct ? '#15803d' : '#dc2626' })}</div>
                <div style="background:${correct?'#f0fdf4':'#fef2f2'};border-radius:6px;padding:6px 10px;border:1px solid ${correct?'#bbf7d0':'#fecaca'};">
                  ${_esc(studentAns[pi]||'(no answer)')}
                  ${!correct ? `<span style="color:#9ca3af;font-size:11px;display:inline-flex;align-items:center;gap:4px;">${this._portalIcon('arrowRight', { size: 11, stroke: '#9ca3af' })}<span>${_esc(p.match)}</span></span>` : ''}
                </div>
              </div>`;
            }).join('')}
          </div>`;
      } else {
        const correct = ans && ans.toString().trim().toUpperCase() === (q.correctAnswer||'').toString().trim().toUpperCase();
        const color = !ans ? '#9ca3af' : correct ? '#15803d' : '#dc2626';
        resultHtml = `
          <div style="margin-top:8px;display:flex;flex-direction:column;gap:6px;">
            <div style="display:flex;align-items:center;gap:8px;font-size:13px;">
              <span style="font-weight:700;color:#6b7280;min-width:90px;">Your answer:</span>
              <span style="color:${color};font-weight:600;">${_esc(ans||'(no answer)')}</span>
              ${ans ? `<span style="font-size:16px;display:inline-flex;align-items:center;justify-content:center;">${this._portalIcon(correct ? 'check' : 'x', { size: 14, stroke: correct ? '#15803d' : '#dc2626' })}</span>` : ''}
            </div>
            ${!correct ? `<div style="display:flex;align-items:center;gap:8px;font-size:13px;">
              <span style="font-weight:700;color:#6b7280;min-width:90px;">Correct:</span>
              <span style="color:#15803d;font-weight:600;">${_esc(q.correctAnswer)}</span>
            </div>` : ''}
          </div>`;
      }

      const typeColors = { mcq:'#3b82f6',tf:'#8b5cf6',identification:'#f59e0b',enumeration:'#0d9488',matching:'#dc2626',essay:'#0f2d1a' };
      const typeLabel  = { mcq:'MCQ',tf:'T/F',identification:'ID',enumeration:'Enum',matching:'Match',essay:'Essay' };
      return `<div style="background:#fff;border-radius:14px;padding:18px 20px;margin-bottom:12px;box-shadow:0 1px 4px rgba(0,0,0,0.07);">
        <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:10px;margin-bottom:10px;">
          <div style="font-size:14px;font-weight:700;color:#111827;flex:1;line-height:1.4;">
            <span style="display:inline-block;width:26px;height:26px;border-radius:50%;background:${typeColors[q.type]||'#6b7280'};color:#fff;font-size:11px;font-weight:800;text-align:center;line-height:26px;margin-right:8px;flex-shrink:0;">${idx+1}</span>
            ${_esc(q.content)}
          </div>
          <div style="font-size:10px;font-weight:700;background:${typeColors[q.type]||'#6b7280'}22;color:${typeColors[q.type]||'#6b7280'};padding:2px 8px;border-radius:20px;white-space:nowrap;">${typeLabel[q.type]||q.type}</div>
        </div>
        ${q.imageUrl?`<img src="${q.imageUrl}" style="max-width:100%;border-radius:8px;margin-bottom:10px;" />`:''}
        ${resultHtml}
      </div>`;
    }).join('');
  },

  returnToLogin() {
    const sess = Auth.getStudentSession();
    if (sess) {
      const updated = { ...sess };
      delete updated.examCode;
      delete updated.examId;
      sessionStorage.setItem('acs_student_session', JSON.stringify(updated));
      this.exam = null; this.session = null; this.warnings = 0; this.answers = {};

      // Return to course view if that's where they came from, otherwise home
      if (this._returnCourseId) {
        this.showDashboard(updated); // init sidebar/greeting once
        this.showCourseView(this._returnCourseId);
      } else {
        this.showDashboard(updated);
      }
    } else {
      window.location.href = 'index.html';
    }
  },

  submitExam(trigger) {
    document.getElementById('confirm-submit-modal').classList.add('hidden');

    this.stopTimer();
    this.destroyAntiCheat(); // also calls stopCamera()
    this.stopPoll();
    this._intentionalFullscreenExit = true;

    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
    } else if (document.webkitFullscreenElement) {
      document.webkitExitFullscreen && document.webkitExitFullscreen();
    }

    // Hide warning overlay if showing
    const overlay = document.getElementById('warning-overlay');
    if (overlay) overlay.style.display = 'none';

    // Calculate score
    const score = this.calculateScore();

    if (this.session) {
      DB.updateSession(this.session.id, {
        submitted: true,
        autoSubmitted: trigger === 'auto' || trigger === 'timeout',
        endTime: new Date().toISOString(),
        answers: this.answers,
        score: score.earned,
        maxScore: score.max,
      });

      if (trigger === 'timeout') {
        DB.addLog({ sessionId: this.session.id, studentId: this.session.studentId, examId: this.exam.id, type: 'timeout', details: 'Auto-submitted: time expired' });
      } else if (trigger === 'auto') {
        DB.addLog({ sessionId: this.session.id, studentId: this.session.studentId, examId: this.exam.id, type: 'auto_submit', details: 'Auto-submitted: max warnings reached' });
      }
    }

    this._showSubmitted(true);
  },

  _showSubmitted(freshSubmit) {
    this.showState('submitted');

    const session = this.session ? DB.getSession(this.session.id) : null;
    const titleEl  = document.getElementById('submitted-title');
    const msgEl    = document.getElementById('submitted-msg');
    const iconWrap = document.getElementById('submitted-icon-wrap');
    const autoNote = document.getElementById('submitted-auto-note');

    if (freshSubmit) {
      // Immediately after submitting
      if (session && session.autoSubmitted) {
        iconWrap.innerHTML = _submittedIcon('auto');
        iconWrap.className = 'submitted-icon-wrap auto';
        titleEl.textContent = 'Exam Auto-Submitted';
        msgEl.textContent = 'Your exam was automatically submitted due to policy violations or time expiry.';
      } else {
        iconWrap.innerHTML = _submittedIcon('success');
        iconWrap.className = 'submitted-icon-wrap success';
        titleEl.textContent = 'Exam Submitted!';
        msgEl.textContent = 'Your answers have been submitted successfully. You may now close this window.';
      }
    } else {
      // Returning student — already completed
      iconWrap.innerHTML = _submittedIcon('success');
      iconWrap.className = 'submitted-icon-wrap done';
      titleEl.textContent = 'Exam Already Completed';
      msgEl.textContent = 'You have already submitted your answers for this exam.';
    }

    // Student info box
    const box = document.getElementById('submitted-info-box');
    if (box && session) {
      const submittedAt = formatDateTime(session.endTime);
      box.innerHTML = `
        <div class="submitted-detail-row">
          <div class="submitted-detail-label"><span class="submitted-detail-icon">${this._submittedDetailIcon('student')}</span><span>Student</span></div>
          <div class="submitted-detail-value">${_esc(session.studentName)}</div>
        </div>
        <div class="submitted-detail-row">
          <div class="submitted-detail-label"><span class="submitted-detail-icon">${this._submittedDetailIcon('exam')}</span><span>Exam</span></div>
          <div class="submitted-detail-value">${_esc(this.exam ? this.exam.title : '')}</div>
        </div>
        <div class="submitted-detail-row">
          <div class="submitted-detail-label"><span class="submitted-detail-icon">${this._submittedDetailIcon('date')}</span><span>Submitted At</span></div>
          <div class="submitted-detail-value">${submittedAt}</div>
        </div>
      `;
    }
    if (autoNote) {
      if (session && session.autoSubmitted) {
        autoNote.classList.remove('hidden');
        autoNote.innerHTML = `
          <span class="submitted-auto-badge">${this._portalIcon('checkCircle', { size: 13, stroke: 'currentColor' })}<span>Auto-Submitted</span></span>
          <span class="submitted-auto-text">Your answers were submitted automatically.</span>
        `;
      } else {
        autoNote.classList.add('hidden');
        autoNote.innerHTML = '';
      }
    }

    // Score section
    const scoreDisplay  = document.getElementById('score-display');
    const scorePending  = document.getElementById('score-pending');

    if (session && session.scoreReleased && session.score !== null) {
      scoreDisplay.classList.remove('hidden');
      scorePending.classList.add('hidden');
      const pct = session.maxScore ? Math.round((session.score / session.maxScore) * 100) : 0;
      document.getElementById('score-value').textContent = `${session.score} / ${session.maxScore}`;
      document.getElementById('score-pct').textContent   = `${pct}% — ${_scoreLabel(pct)}`;
      const bar = document.getElementById('score-bar-fill');
      if (bar) bar.style.width = pct + '%';
    } else if (!freshSubmit) {
      scoreDisplay.classList.add('hidden');
      scorePending.classList.remove('hidden');
    } else {
      scoreDisplay.classList.add('hidden');
      scorePending.classList.add('hidden');
    }

    // Show "Review Answers" button if exam allows it
    const reviewBtn = document.getElementById('btn-review-answers');
    if (reviewBtn) {
      const examObj = this.exam || (session ? DB.getExam(session.examId) : null);
      reviewBtn.style.display = (examObj && examObj.allowReview) ? '' : 'none';
    }
  },

  // ============================================================
  // SCORING
  // ============================================================
  calculateScore() {
    let earned = 0;
    let max = 0;
    const questions = this.exam ? this.exam.questions : [];

    for (const q of questions) {
      max += q.points;
      if (q.type === 'essay') continue; // manual grading

      const ans = this.answers[q.id];
      if (!ans || ans.toString().trim() === '') continue;

      if (q.type === 'enumeration') {
        const expected = (q.answers || []).map(a => a.toUpperCase());
        const given    = ans.split('\n').map(s => s.trim().toUpperCase()).filter(Boolean);
        const correct  = expected.filter(e => given.includes(e)).length;
        if (q.partialScoring === false) {
          if (correct === expected.length) earned += q.points;
        } else {
          earned += expected.length > 0 ? Math.round((correct / expected.length) * q.points) : 0;
        }
      } else if (q.type === 'matching') {
        const pairs = q.pairs || [];
        let studentAns = {};
        try { studentAns = JSON.parse(ans); } catch {}
        const correct = pairs.filter((p,i) => (studentAns[i]||'').toUpperCase() === p.match.toUpperCase()).length;
        earned += pairs.length > 0 ? Math.round((correct / pairs.length) * q.points) : 0;
      } else {
        const studentAns = ans.toString().trim().toUpperCase();
        const correctAns = (q.correctAnswer || '').toString().trim().toUpperCase();
        if (studentAns === correctAns) earned += q.points;
      }
    }

    return { earned, max };
  },

  // ============================================================
  // SHUFFLE (Fisher-Yates)
  // ============================================================
  shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  },
};

// ============================================================
// HELPERS
// ============================================================
function _esc(str) {
  if (str === null || str === undefined) return '';
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function _escText(str) {
  return _esc(str);
}

function _escAttr(str) {
  if (str === null || str === undefined) return '';
  return String(str).replace(/"/g,'&quot;').replace(/'/g,'&#39;').replace(/\\/g,'\\\\');
}

function _submittedIcon(type) {
  if (type === 'success') {
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>`;
  }
  if (type === 'auto') {
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`;
  }
  // 'done' — returning student
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 8 12 12"/><path d="M12 16h.01"/></svg>`;
}

function _scoreLabel(pct) {
  if (pct >= 95) return 'Excellent!';
  if (pct >= 85) return 'Very Good';
  if (pct >= 75) return 'Good';
  if (pct >= 60) return 'Satisfactory';
  return 'Needs Improvement';
}

function formatDateTime(iso) {
  if (!iso) return '—';
  try { return new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' }); }
  catch { return iso; }
}

// ============================================================
// BOOT
// ============================================================
document.addEventListener('dbReady', () => ExamApp.init());


// Expose as global for ES-module consumers (React)
window.ExamApp = ExamApp;

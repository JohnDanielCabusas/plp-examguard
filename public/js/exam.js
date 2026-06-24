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
  _dashInterval: null,      // dashboard poll interval

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

    if (tab === 'settings') this._loadSettingsForm();
  },

  _loadSettingsForm() {
    const sess = Auth.getStudentSession();
    if (!sess) return;
    const student = DB.getStudent(sess.studentId);
    const nameEl = document.getElementById('stg-name');
    if (nameEl) nameEl.value = sess.studentName || sess.studentId;
    const emailEl = document.getElementById('stg-email');
    if (emailEl) emailEl.textContent = sess.email || '—';
    const sidEl = document.getElementById('stg-studentid');
    if (sidEl) sidEl.value = sess.studentId || '';
    const yrEl = document.getElementById('stg-year');
    if (yrEl) yrEl.value = sess.yearLevel || (student ? (student.yearLevel || '') : '');
    const secEl = document.getElementById('stg-section');
    if (secEl) secEl.value = sess.section || (student ? (student.section || '') : '');
    // clear messages
    ['stg-profile-msg','stg-pass-msg'].forEach(id => { const el = document.getElementById(id); if (el) el.textContent = ''; });
    ['stg-cur-pass','stg-new-pass','stg-confirm-pass'].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
  },

  saveStudentProfile() {
    const sess = Auth.getStudentSession();
    if (!sess) return;
    const name = (document.getElementById('stg-name').value || '').trim();
    const studentId = (document.getElementById('stg-studentid').value || '').trim().toUpperCase();
    const yearLevel = (document.getElementById('stg-year').value || '').trim();
    const section = (document.getElementById('stg-section').value || '').trim();
    const msgEl = document.getElementById('stg-profile-msg');
    if (!name) { msgEl.textContent = 'Name cannot be empty.'; msgEl.style.color = '#dc2626'; return; }
    if (!studentId) { msgEl.textContent = 'Student ID cannot be empty.'; msgEl.style.color = '#dc2626'; return; }
    if (!/^(\d{2})-\d{5}$/.test(studentId)) {
      msgEl.textContent = 'Student ID must be in YY-NNNNN format.';
      msgEl.style.color = '#dc2626';
      return;
    }

    const student = DB.getStudent(sess.studentId);
    if (!student) {
      msgEl.textContent = 'Student record not found.';
      msgEl.style.color = '#dc2626';
      return;
    }

    const duplicate = DB.getStudent(studentId);
    if (duplicate && duplicate.id !== student.id) {
      msgEl.textContent = 'That Student ID is already assigned to another account.';
      msgEl.style.color = '#dc2626';
      return;
    }

    const updates = { name, studentId, yearLevel, section };
    DB.updateStudent(student.id, updates);
    const updatedStudent = { ...student, ...updates };
    DB.syncStudentReferences(sess.studentId, updatedStudent);

    // Update session details
    const updated = {
      ...sess,
      studentId,
      studentName: name,
      yearLevel,
      section,
    };
    sessionStorage.setItem('acs_student_session', JSON.stringify(updated));
    document.getElementById('portal-footer-name').textContent = name;
    document.getElementById('portal-avatar').textContent = name.charAt(0).toUpperCase();
    document.getElementById('portal-footer-id').textContent = this._formatFooterMeta(updated);

    if (this.session && this.session.studentId === sess.studentId) {
      this.session = {
        ...this.session,
        studentId,
        studentName: name,
        yearLevel,
        section,
      };
    }

    msgEl.textContent = 'Profile saved!';
    msgEl.style.color = '#15803d';
    setTimeout(() => { msgEl.textContent = ''; }, 3000);
  },

  _formatFooterMeta(sess) {
    if (!sess) return '';
    return [sess.studentId, sess.yearLevel, sess.section].filter(Boolean).join(' · ');
  },

  saveStudentPassword() {
    const sess = Auth.getStudentSession();
    if (!sess) return;
    const cur     = document.getElementById('stg-cur-pass').value;
    const next    = document.getElementById('stg-new-pass').value;
    const confirm = document.getElementById('stg-confirm-pass').value;
    const msgEl   = document.getElementById('stg-pass-msg');

    if (!cur || !next || !confirm) { msgEl.textContent = 'All fields are required.'; msgEl.style.color = '#dc2626'; return; }
    if (next.length < 6) { msgEl.textContent = 'New password must be at least 6 characters.'; msgEl.style.color = '#dc2626'; return; }
    if (next !== confirm) { msgEl.textContent = 'Passwords do not match.'; msgEl.style.color = '#dc2626'; return; }

    const student = DB.getStudent(sess.studentId);
    if (!student) { msgEl.textContent = 'Student record not found.'; msgEl.style.color = '#dc2626'; return; }
    if (student.password !== cur) { msgEl.textContent = 'Current password is incorrect.'; msgEl.style.color = '#dc2626'; return; }

    DB.updateStudent(student.id, { password: next });
    msgEl.textContent = 'Password changed successfully!';
    msgEl.style.color = '#15803d';
    ['stg-cur-pass','stg-new-pass','stg-confirm-pass'].forEach(id => { document.getElementById(id).value = ''; });
    setTimeout(() => { msgEl.textContent = ''; }, 3000);
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

    // Default to exams tab
    this.showCourseTab('exams');
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
  },

  _renderCourseExams() {
    const sess   = Auth.getStudentSession();
    const subjId = this._currentCourseId;
    const listEl = document.getElementById('course-tab-exams');
    if (!listEl) return;

    const allExams = DB.getExams().filter(e => e.subjectId === subjId && e.status !== 'draft');
    if (!allExams.length) {
      listEl.innerHTML = `<div class="dash-empty">
        <div class="dash-empty-icon">📋</div>
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
        let rightHtml = '';

        const chips = [
          `<span class="course-meta-chip">${e.questions.length} questions</span>`,
          `<span class="course-meta-chip">${e.timeLimit} min</span>`,
        ];
        if (e.requireCamera) chips.push(`<span class="course-meta-chip chip-camera">📷 Camera</span>`);

        if (dbSess && dbSess.submitted) {
          const pct = dbSess.maxScore ? Math.round(dbSess.score / dbSess.maxScore * 100) : 0;
          const scoreHtml = dbSess.scoreReleased
            ? `<span style="font-weight:700;color:#0f2d1a;">${dbSess.score}/${dbSess.maxScore}</span> <span style="color:#9ca3af;">(${pct}%)</span>`
            : `<span style="color:#9ca3af;font-size:12px;">Awaiting result</span>`;
          rightHtml = `<div style="display:flex;flex-direction:column;align-items:flex-end;gap:6px;">
            <span class="badge badge-secondary" style="font-size:10px;">✓ Submitted</span>
            <div style="font-size:13px;">${scoreHtml}</div>
            <button class="btn btn-secondary btn-sm" onclick="ExamApp.dashSelectExam('${e.code}')">View</button>
          </div>`;
        } else if (e.status === 'active') {
          rightHtml = `<div style="display:flex;align-items:center;gap:10px;">
            <span style="display:inline-flex;align-items:center;gap:5px;font-size:12px;font-weight:700;color:#15803d;">
              <span style="width:7px;height:7px;border-radius:50%;background:#15803d;animation:pulse 1.2s infinite;display:inline-block;"></span>Live
            </span>
            <button class="btn-course-take" onclick="ExamApp.dashSelectExam('${e.code}')">Take Exam →</button>
          </div>`;
        } else if (e.status === 'ready') {
          rightHtml = `<div style="display:flex;align-items:center;gap:10px;">
            <span class="badge badge-info" style="font-size:10px;">Scheduled</span>
            <button class="btn btn-secondary btn-sm" onclick="ExamApp.dashSelectExam('${e.code}')">Join Room</button>
          </div>`;
        } else if (e.status === 'closed') {
          rightHtml = `<span class="badge badge-secondary" style="font-size:10px;">Closed</span>`;
          if (dbSess) rightHtml += ` <button class="btn btn-secondary btn-sm" onclick="ExamApp.dashSelectExam('${e.code}')">View</button>`;
        } else {
          rightHtml = `<span class="badge badge-secondary" style="font-size:10px;opacity:0.6;">Draft</span>`;
        }

        html += `<div class="course-exam-card ${g.cardClass}">
          <div class="course-exam-card-left">
            <div class="course-exam-icon ${g.iconClass}">
              <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>
            </div>
            <div>
              <div class="course-exam-title">${_esc(e.title)}</div>
              <div class="course-exam-meta">${chips.join('')}</div>
            </div>
          </div>
          <div class="dash-exam-actions" style="flex-shrink:0;">${rightHtml}</div>
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
    this.showPortalTab('home');

    // Logo from settings
    const settings = DB.getSettings();
    const logoEl = document.getElementById('portal-logo');
    if (logoEl && settings.logoUrl) logoEl.src = settings.logoUrl;

    // Sidebar footer
    const name = sess.studentName || sess.studentId;
    const avatarEl = document.getElementById('portal-avatar');
    if (avatarEl) avatarEl.textContent = name.charAt(0).toUpperCase();
    const fnEl = document.getElementById('portal-footer-name');
    if (fnEl) fnEl.textContent = name;
    const fidEl = document.getElementById('portal-footer-id');
    if (fidEl) fidEl.textContent = this._formatFooterMeta(sess);

    // Greeting
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
        <div class="dash-empty-icon">📚</div>
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
        const camTag = e.requireCamera ? '<span style="color:rgba(255,255,255,0.7);font-weight:600;">📷 Camera required</span>' : '';
        html += `
          <div class="dash-active-banner">
            <div class="dash-active-banner-left">
              <div class="dash-active-live"><span class="dash-active-live-dot"></span>Live</div>
              <div class="dash-active-exam-title">${_esc(e.title)}</div>
              <div class="dash-active-exam-meta">${_esc(subj.name)} &nbsp;·&nbsp; ${e.questions.length} questions &nbsp;·&nbsp; ${e.timeLimit} min ${camTag ? '&nbsp;·&nbsp;' + camTag : ''}</div>
            </div>
            <button class="btn-take-exam" onclick="ExamApp.dashSelectExam('${e.code}')">Take Exam →</button>
          </div>`;
      });
    }

    // My Courses section
    html += `<div class="dash-section-label" style="margin-top:${activeExams.length ? '8px' : '0'};">My Courses</div>`;

    enrolledSubjects.forEach(subj => {
      const subjectExams = allExams.filter(e =>
        e.subjectId === subj.id &&
        ['active','ready','closed'].includes(e.status) &&
        audienceMatch(e)
      );

      const examsHtml = subjectExams.length ? subjectExams.map(e => {
        const dbSession = DB.getStudentSession(e.id, sess.studentId);
        let actionHtml = '', statusHtml = '';

        if (dbSession && dbSession.submitted) {
          statusHtml = `<span class="badge badge-secondary" style="font-size:10px;">Submitted</span>`;
          actionHtml = `<button class="btn btn-secondary btn-sm" onclick="ExamApp.dashSelectExam('${e.code}')">View Result</button>`;
        } else if (e.status === 'active') {
          statusHtml = `<span class="badge badge-success" style="font-size:10px;animation:pulse 1.5s infinite;">● Active</span>`;
          actionHtml = `<button class="btn btn-primary btn-sm" onclick="ExamApp.dashSelectExam('${e.code}')">Take Exam</button>`;
        } else if (e.status === 'ready') {
          statusHtml = `<span class="badge badge-info" style="font-size:10px;">Waiting</span>`;
          actionHtml = `<button class="btn btn-secondary btn-sm" onclick="ExamApp.dashSelectExam('${e.code}')">Join Room</button>`;
        } else if (e.status === 'closed') {
          statusHtml = `<span class="badge badge-secondary" style="font-size:10px;">Closed</span>`;
          actionHtml = `<button class="btn btn-secondary btn-sm" style="opacity:0.5;cursor:not-allowed;" disabled>Closed</button>`;
        }

        const metaParts = [`${e.questions.length} questions`, `${e.timeLimit} min`];
        if (e.requireCamera) metaParts.push('📷 Camera');
        if ((e.targetYearLevels||[]).length || (e.targetSections||[]).length) {
          const abbr = { '1st Year':'Y1','2nd Year':'Y2','3rd Year':'Y3','4th Year':'Y4' };
          const yrs = (e.targetYearLevels||[]).map(y => abbr[y]||y).join('/');
          const secs = (e.targetSections||[]).join('/');
          metaParts.push('👥 ' + [yrs, secs].filter(Boolean).join(' · '));
        }

        return `<div class="dash-exam-row">
          <div style="min-width:0;flex:1;">
            <div class="dash-exam-title">${_esc(e.title)}</div>
            <div class="dash-exam-meta">
              ${metaParts.map((p, i) => i === 0 ? `<span>${_esc(p)}</span>` : `<span class="dash-exam-meta-dot"></span><span>${_esc(p)}</span>`).join('')}
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
    this.requestFullscreen();
    this.initAntiCheat();
    this.startTimer();
    this.renderQuestions();
    this.showState('exam');

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
    try {
      if (document.documentElement.requestFullscreen) {
        document.documentElement.requestFullscreen().catch(() => {});
      } else if (document.documentElement.webkitRequestFullscreen) {
        document.documentElement.webkitRequestFullscreen();
      }
    } catch (e) { /* silently fail */ }
  },

  _showFullscreenLock() {
    let overlay = document.getElementById('fs-lock-overlay');

    const doReturn = () => {
      if (overlay._cdTimer) clearInterval(overlay._cdTimer);
      const el = document.documentElement;
      const req = el.requestFullscreen || el.webkitRequestFullscreen;
      if (req) req.call(el).then(() => { overlay.style.display = 'none'; }).catch(() => {});
    };

    const startCountdown = () => {
      let secs = 3;
      const cdEl = document.getElementById('fs-countdown');
      if (cdEl) cdEl.textContent = secs;
      if (overlay._cdTimer) clearInterval(overlay._cdTimer);
      overlay._cdTimer = setInterval(() => {
        secs--;
        const el = document.getElementById('fs-countdown');
        if (el) el.textContent = secs;
        if (secs <= 0) { clearInterval(overlay._cdTimer); doReturn(); }
      }, 1000);
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
          <p style="font-size:14px;color:rgba(255,255,255,0.7);margin-bottom:12px;line-height:1.6;">
            This exam must be taken in fullscreen mode.<br>
            Exiting fullscreen has been recorded as a violation.
          </p>
          <p style="font-size:13px;color:rgba(255,255,255,0.5);margin-bottom:24px;">
            Returning automatically in <span id="fs-countdown" style="font-weight:800;color:#fff;">3</span>s&hellip;
          </p>
          <button id="fs-return-btn" style="background:#fff;color:#0f2d1a;border:none;padding:12px 32px;border-radius:10px;font-size:15px;font-weight:800;cursor:pointer;font-family:inherit;">
            Return to Fullscreen
          </button>
        </div>`;
      overlay.style.cssText = 'position:fixed;inset:0;background:#060e08;z-index:999999;display:flex;align-items:center;justify-content:center;';
      document.body.appendChild(overlay);
      document.getElementById('fs-return-btn').addEventListener('click', doReturn);
    } else {
      overlay.style.display = 'flex';
      const btn = document.getElementById('fs-return-btn');
      if (btn) { btn.onclick = null; btn.addEventListener('click', doReturn); }
    }

    startCountdown();
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
      e.preventDefault();
      this.issueWarning('copy_attempt', 'Copying content detected');
    };
    document.addEventListener('copy', copyHandler);
    document.addEventListener('cut', copyHandler);

    // ── Paste & selection blocked silently ──────────────────────
    const pasteHandler = e => {
      if (!e.target.matches('input, textarea')) e.preventDefault();
    };
    document.addEventListener('paste', pasteHandler);

    const selectHandler = e => {
      if (!e.target.matches('input, textarea')) e.preventDefault();
    };
    document.addEventListener('selectstart', selectHandler);

    // ── Right-click ──────────────────────────────────────────────
    const rcHandler = e => e.preventDefault();
    document.addEventListener('contextmenu', rcHandler);

    // ── Fullscreen change ────────────────────────────────────────
    const fsHandler = () => {
      if (!document.fullscreenElement && !document.webkitFullscreenElement) {
        // Log the violation
        if (this._inReadCountdown) {
          this._cancelReadCountdown();
          this.startCountdown(10);
        } else {
          this.issueWarning('fullscreen_exit', 'Fullscreen mode exited');
        }
        // Show lock screen — student must click the button (requires user gesture)
        this._showFullscreenLock();
      } else {
        this._hideFullscreenLock();
        this.cancelCountdown();
      }
    };
    document.addEventListener('fullscreenchange', fsHandler);
    document.addEventListener('webkitfullscreenchange', fsHandler);

    // ── Keyboard shortcuts blocked ───────────────────────────────
    const keyHandler = e => {
      if (e.key === 'PrintScreen') e.preventDefault();
      if (e.key === 'F11') { e.preventDefault(); } // block fullscreen toggle
      if (e.key === 'Escape') {
        // If exam is running and fullscreen is active, prevent escape from exiting
        if (document.fullscreenElement || document.webkitFullscreenElement) {
          e.preventDefault();
        }
      }
      if ((e.ctrlKey || e.metaKey) && ['c','v','x','a','p','u','s'].includes(e.key.toLowerCase())) {
        if (!e.target.matches('input, textarea')) e.preventDefault();
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
      if (statusText) statusText.textContent = '● Monitoring';
      if (blockedMsg) blockedMsg.style.display = 'none';

      // Wait for video to be ready then check for presence before starting
      video.onloadeddata = () => {
        if (statusText) statusText.textContent = '⏳ Loading face detection…';
        // Load BlazeFace model if available, then start detection
        if (window.blazeface) {
          window.blazeface.load().then(model => {
            this._faceModel = model;
            this._faceModelReady = true;
            if (statusText) statusText.textContent = '● Face detection ready';
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
      if (this.session) {
        const session = DB.getSession(this.session.id);
        if (session) {
          const activities = [...(session.activities||[]), { type:'camera_denied', detail:'Camera permission denied: '+err.message, timestamp:new Date().toISOString() }];
          DB.updateSession(this.session.id, { activities });
        }
      }
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
    this._motionInterval = setInterval(() => {
      if (this._faceModelReady && this._faceModel) {
        this._detectFace(video);
      } else {
        this._detectMotion(video);
      }
    }, 600);
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

    // Person detected if EITHER clear movement OR subtle change vs 10s-ago frame
    const avgDiff = Math.max(fastAvg, slowAvg);

    const statusText = document.getElementById('camera-status-text');

    const detected = fastAvg >= this._MOTION_THRESHOLD || slowAvg >= this._PRESENCE_THRESHOLD;
    if (detected) {
      // Motion/presence detected — reset timer
      this._noMotionSec = 0;
      this._motionBlocked = false;
      if (statusText) statusText.textContent = `● Person detected`;
      this._clearMotionWarning();
    } else {
      // No significant motion
      this._noMotionSec += 0.5;
      const remaining = Math.max(0, this._NO_MOTION_WARN - this._noMotionSec);
      if (statusText) statusText.textContent = `⚠ No person (${Math.ceil(remaining)}s)`;

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
        if (statusText) statusText.textContent = `● Person detected`;
        this._clearMotionWarning();
      } else {
        this._noMotionSec += 0.6;
        const remaining = Math.max(0, this._NO_MOTION_WARN - this._noMotionSec);
        if (statusText) statusText.textContent = `⚠ No person (${Math.ceil(remaining)}s)`;
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

    // Log the event
    if (this.session) {
      const session = DB.getSession(this.session.id);
      if (session) {
        const activities = [...(session.activities||[]), { type:'no_person', detail:'No person detected in camera frame', timestamp:new Date().toISOString() }];
        DB.updateSession(this.session.id, { activities });
      }
    }

    // Show the motion warning overlay
    const overlay = document.getElementById('motion-warning-overlay');
    if (overlay) overlay.style.display = '';

    // Issue a warning as violation
    this.issueWarning('no_person', 'No person detected in camera frame');
  },

  _clearMotionWarning() {
    const overlay = document.getElementById('motion-warning-overlay');
    if (overlay) overlay.style.display = 'none';
    this._motionBlocked = false;
  },

  // Keep captureSnapshot for admin monitoring thumbnails (less frequent)
  captureSnapshot() {
    const video = document.getElementById('camera-feed');
    const canvas = document.getElementById('camera-canvas');
    if (!video || !canvas || !this._cameraStream || !this.session) return;
    if (video.readyState < 2) return;
    try {
      canvas.width = 160; canvas.height = 120;
      const ctx = canvas.getContext('2d');
      ctx.save(); ctx.scale(-1,1);
      ctx.drawImage(video, -160, 0, 160, 120);
      ctx.restore();
      const imageData = canvas.toDataURL('image/jpeg', 0.5);
      const session = DB.getSession(this.session.id);
      if (!session) return;
      const snaps = session.cameraSnapshots || [];
      snaps.push({ timestamp: new Date().toISOString(), imageData });
      if (snaps.length > 5) snaps.splice(0, snaps.length-5);
      DB.updateSession(this.session.id, { cameraSnapshots: snaps });
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
    if (this._cameraPrompting) return; // camera permission dialog open — not a violation

    // Clear any in-progress read countdown so the new warning takes over cleanly
    this._cancelReadCountdown();

    // Debounce: prevent double-firing within 1500ms (blur + visibilitychange fire together)
    const now = Date.now();
    if (this._lastWarningTime && (now - this._lastWarningTime) < 1500) return;
    this._lastWarningTime = now;

    this.warnings++;

    const session = DB.getSession(this.session.id);
    if (!session) return;
    const activities = [...(session.activities || []), { type, detail, timestamp: new Date().toISOString() }];
    DB.updateSession(this.session.id, { warnings: this.warnings, activities });

    DB.addLog({
      sessionId: this.session.id,
      studentId: this.session.studentId,
      examId: this.exam.id,
      type,
      details: detail,
    });

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
      tab_switch:     'You switched to another tab or window.',
      window_blur:    'Another application was detected in front of the exam.',
      copy_attempt:   'Copying or cutting content is not allowed.',
      fullscreen_exit:'You exited fullscreen mode.',
      screenshot:     'Screenshot attempt detected.',
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

    const container = document.getElementById('questions-container');
    container.innerHTML = questions.map((q, idx) => this._renderQuestion(q, idx)).join('');

    // Restore previously answered questions
    questions.forEach((q, idx) => {
      const savedAns = this.answers[q.id];
      if (savedAns !== undefined) {
        this._restoreAnswer(q, idx, savedAns);
      }
    });
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
    } else if (q.type === 'enumeration') {
      answerHtml = this._renderEnumeration(q, idx);
    } else if (q.type === 'matching') {
      answerHtml = this._renderMatching(q, idx);
    }

    const typeLabels = { mcq:'Multiple Choice', tf:'True / False', identification:'Identification', essay:'Essay', enumeration:'Enumeration', matching:'Matching Type' };

    const imgHtml = q.imageUrl
      ? `<div class="question-img-wrap"><img src="${_escAttr(q.imageUrl)}" alt="Question image" class="question-img" onerror="this.parentElement.style.display='none'" /></div>`
      : '';

    const requiredBadge = q.required !== false
      ? `<span class="q-required-badge">Required</span>`
      : '';

    return `
      <div class="question-card" id="qcard-${q.id}" data-qid="${q.id}">
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

    return `<div class="mcq-options" id="mcq-${q.id}">` +
      options.map((opt, oi) => `
        <div class="mcq-option" id="mcq-opt-${q.id}-${oi}" data-qid="${q.id}" data-val="${_escAttr(opt)}" onclick="ExamApp.selectMCQ('${q.id}', '${_escAttr(opt)}')">
          <div class="mcq-option-bullet"></div>
          <span>${_escText(opt)}</span>
        </div>
      `).join('') +
      `</div>`;
  },

  _renderTF(q, idx) {
    return `<div class="tf-options" id="tf-${q.id}">
      <div class="tf-btn tf-true" id="tf-${q.id}-true" onclick="ExamApp.selectTF('${q.id}', 'True')">
        <span class="tf-icon">
          <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
        </span>
        <span class="tf-label">True</span>
      </div>
      <div class="tf-btn tf-false" id="tf-${q.id}-false" onclick="ExamApp.selectTF('${q.id}', 'False')">
        <span class="tf-icon">
          <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </span>
        <span class="tf-label">False</span>
      </div>
    </div>`;
  },

  _renderIdentification(q, idx) {
    return `<input type="text" class="id-input" id="id-input-${q.id}" placeholder="Type your answer here..."
      autocomplete="off" autocorrect="off" autocapitalize="characters" spellcheck="false"
      oninput="ExamApp.handleIdentificationInput(event, '${q.id}')" />`;
  },

  _renderEnumeration(q, idx) {
    const count = (q.answers||[]).length || 3;
    const rows = Array.from({length: count}, (_, i) => `
      <div style="display:flex;align-items:center;gap:8px;">
        <span style="font-size:13px;color:#9ca3af;font-weight:700;min-width:22px;">${i+1}.</span>
        <input type="text" class="form-control" id="enum-${q.id}-${i}" placeholder="Item ${i+1}"
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
          <div style="color:#9ca3af;font-size:16px;">→</div>
          <select class="form-control" id="match-${q.id}-${pi}"
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
      <textarea class="essay-textarea" id="essay-input-${q.id}" placeholder="Write your answer here..."
        autocomplete="off" spellcheck="true"
        oninput="ExamApp.handleEssayInput(event, '${q.id}', ${minW})"
      ></textarea>
      <div class="essay-meta">
        <span class="essay-hint">${note}</span>
        <span class="essay-chars" id="essay-count-${q.id}">0 words</span>
      </div>`;
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

  _updateAnsweredStatus() {
    const total = this.questionOrder.length;
    const answered = Object.values(this.answers).filter(v => v !== null && v !== undefined && v !== '').length;
    const pct = total > 0 ? Math.round((answered / total) * 100) : 0;

    const progressBar = document.getElementById('exam-progress-bar');
    if (progressBar) progressBar.style.width = pct + '%';

    const statusEl = document.getElementById('exam-answered-status');
    if (statusEl) statusEl.textContent = `${answered} of ${total} answered`;

    const submitProgress = document.getElementById('submit-progress');
    if (submitProgress) {
      submitProgress.innerHTML = `<strong>${answered}</strong> of <strong>${total}</strong> questions answered`;
    }
  },

  // ============================================================
  // SUBMIT
  // ============================================================
  confirmSubmit() {
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
      // Scroll to the first missing one
      const firstCard = document.getElementById('qcard-' + unansweredRequired[0].id);
      if (firstCard) firstCard.scrollIntoView({ behavior: 'smooth', block: 'center' });

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
                <span style="color:${got?'#15803d':'#dc2626'};font-size:16px;">${got?'✓':'✗'}</span>
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
                <div style="text-align:center;color:${correct?'#15803d':'#dc2626'};font-weight:700;">${correct?'✓':'✗'}</div>
                <div style="background:${correct?'#f0fdf4':'#fef2f2'};border-radius:6px;padding:6px 10px;border:1px solid ${correct?'#bbf7d0':'#fecaca'};">
                  ${_esc(studentAns[pi]||'(no answer)')}
                  ${!correct?`<span style="color:#9ca3af;font-size:11px;"> → ${_esc(p.match)}</span>`:''}
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
              ${ans ? `<span style="font-size:16px;">${correct?'✓':'✗'}</span>` : ''}
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
      iconWrap.innerHTML = _submittedIcon('done');
      iconWrap.className = 'submitted-icon-wrap done';
      titleEl.textContent = 'Exam Already Completed';
      msgEl.textContent = 'You have already submitted your answers for this exam.';
    }

    // Student info box
    const box = document.getElementById('submitted-info-box');
    if (box && session) {
      box.innerHTML = `
        <div class="info-row"><span class="info-label">Student</span><span class="info-value">${_esc(session.studentName)}</span></div>
        <div class="info-row"><span class="info-label">Exam</span><span class="info-value">${_esc(this.exam ? this.exam.title : '')}</span></div>
        <div class="info-row"><span class="info-label">Submitted At</span><span class="info-value">${formatDateTime(session.endTime)}</span></div>
        ${session.autoSubmitted ? '<div class="info-row"><span class="info-value badge badge-warning">Auto-Submitted</span></div>' : ''}
      `;
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
document.addEventListener('firebaseReady', () => ExamApp.init());


// Expose as global for ES-module consumers (React)
window.ExamApp = ExamApp;

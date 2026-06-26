// ============================================================
// SUPABASE SYNC  —  Real-time Supabase backend
// ============================================================
// Replaces firebase-sync.js.
// Requires window.supabase to be set before init() is called.
// window.supabase is set by src/lib/supabaseBootstrap.js which
// runs as part of the React bundle (before any useEffect fires).
// ============================================================

const SupabaseSync = {
  _client: null,
  _channel: null,
  _readyEmitted: false,

  _writeLocal(key, value) {
    localStorage.setItem(key, JSON.stringify(value));
    window.DB?.clearCacheKey?.(key);
  },

  // ── Public: call once per page load (from React useEffect) ──
  async init() {
    this._emitReady();

    const client = window.supabase;
    if (!client) {
      console.warn('[SupabaseSync] Supabase client not available. Running in localStorage-only mode.');
      return;
    }
    this._client = client;

    try {
      await this._pullFromSupabase();
      this._setupListeners();
    } catch (e) {
      console.warn('[SupabaseSync] Error loading data from Supabase:', e.message || e);
    }
  },

  // ── Pull all tables into localStorage ──────────────────────
  async _pullFromSupabase() {
    const c = this._client;
    const [
      { data: settings },
      { data: admins },
      { data: students },
      { data: subjects },
      { data: exams },
      { data: sessions },
      { data: logs },
    ] = await Promise.all([
      c.from('settings').select('*').eq('id', 'main').maybeSingle(),
      c.from('admins').select('*'),
      c.from('students').select('*'),
      c.from('subjects').select('*').order('created_at'),
      c.from('exams').select('*').order('created_at'),
      c.from('sessions').select('*').order('created_at'),
      c.from('logs').select('*').order('created_at'),
    ]);

    // First-run: if Supabase is empty, push local seeds up instead of wiping them
    const isEmpty = !admins?.length && !subjects?.length && !exams?.length;
    if (isEmpty) {
      await this._seedToSupabase();
      return;
    }

    // Supabase has data — overwrite localStorage with it
    if (settings)        this._writeLocal('acs_settings',  this._dbToJsSettings(settings));
    if (admins?.length)  this._writeLocal('acs_admins',    admins.map(r => this._dbToJsAdmin(r)));
    if (students?.length) this._writeLocal('acs_students', students.map(r => this._dbToJsStudent(r)));
    if (subjects?.length) this._writeLocal('acs_subjects', subjects.map(r => this._dbToJsSubject(r)));
    if (exams?.length)   this._writeLocal('acs_exams',     exams.map(r => this._dbToJsExam(r)));
    if (sessions?.length) this._writeLocal('acs_sessions', sessions.map(r => this._dbToJsSession(r)));
    if (logs?.length)    this._writeLocal('acs_logs',      logs.map(r => this._dbToJsLog(r)));
  },

  // ── Seed Supabase from localStorage on first run ────────────
  async _seedToSupabase() {
    const c = this._client;

    const settings = this._local('acs_settings');
    if (settings) {
      await c.from('settings').upsert(this._jsToDbSettings(settings));
    }

    // Order matters: subjects before exams (FK constraint)
    const seedings = [
      ['admins',   'acs_admins',   r => this._jsToDbAdmin(r)],
      ['students', 'acs_students', r => this._jsToDbStudent(r)],
      ['subjects', 'acs_subjects', r => this._jsToDbSubject(r)],
      ['exams',    'acs_exams',    r => this._jsToDbExam(r)],
      ['sessions', 'acs_sessions', r => this._jsToDbSession(r)],
      ['logs',     'acs_logs',     r => this._jsToDbLog(r)],
    ];

    for (const [table, lsKey, normalizer] of seedings) {
      const items = this._localArray(lsKey);
      if (items.length) {
        const { error } = await c.from(table).upsert(items.map(normalizer));
        if (error) console.warn(`[SupabaseSync] seed ${table}:`, error.message);
      }
    }
  },

  // ── Realtime listeners ─────────────────────────────────────
  _setupListeners() {
    const c = this._client;

    const applyChange = (table, lsKey, normalizer) => (payload) => {
      const { eventType, new: row, old } = payload;
      const current = (() => { try { return JSON.parse(localStorage.getItem(lsKey)) || []; } catch { return []; } })();

      if (table === 'settings') {
        if (row) this._writeLocal(lsKey, normalizer(row));
        return;
      }
      if (eventType === 'DELETE') {
        this._writeLocal(lsKey, current.filter(r => r.id !== old.id));
      } else {
        const normalized = normalizer(row);
        const idx = current.findIndex(r => r.id === normalized.id);
        if (idx >= 0) { current[idx] = normalized; this._writeLocal(lsKey, current); }
        else { this._writeLocal(lsKey, [...current, normalized]); }
      }
    };

    this._channel = c.channel('acs-realtime')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'settings' },
        applyChange('settings', 'acs_settings', r => this._dbToJsSettings(r)))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'admins' },
        applyChange('admins', 'acs_admins', r => this._dbToJsAdmin(r)))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'students' },
        applyChange('students', 'acs_students', r => this._dbToJsStudent(r)))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'subjects' },
        applyChange('subjects', 'acs_subjects', r => this._dbToJsSubject(r)))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'exams' },
        applyChange('exams', 'acs_exams', r => this._dbToJsExam(r)))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'sessions' },
        applyChange('sessions', 'acs_sessions', r => this._dbToJsSession(r)))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'logs' },
        applyChange('logs', 'acs_logs', r => this._dbToJsLog(r)))
      .subscribe();
  },

  // ── Write helpers ───────────────────────────────────────────

  syncSettings(data) {
    if (!this._client) return;
    this._client.from('settings').upsert(this._jsToDbSettings(data))
      .then(({ error }) => { if (error) console.error('[SupabaseSync] syncSettings:', error.message); });
  },

  syncDoc(table, data) {
    if (!this._client || !data?.id) return;
    const row = this._jsToDb(table, data);
    if (!row) return;
    this._client.from(table).upsert(row)
      .then(({ error }) => { if (error) console.error(`[SupabaseSync] syncDoc(${table}):`, error.message); });
  },

  deleteDoc(table, id) {
    if (!this._client || !id) return;
    this._client.from(table).delete().eq('id', id)
      .then(({ error }) => { if (error) console.error(`[SupabaseSync] deleteDoc(${table}):`, error.message); });
  },

  // ── JS → DB normalizers ─────────────────────────────────────

  _jsToDbSettings(d) {
    return {
      id: 'main',
      school_name: d.schoolName || '',
      logo_url: d.logoUrl || null,
      department: d.department || null,
      admin_name: d.adminName || null,
      admin_email: d.adminEmail || null,
    };
  },

  _jsToDbAdmin(d) {
    return {
      id: d.id,
      username: d.username,
      password: d.password,
      name: d.name,
      email: d.email || null,
    };
  },

  _jsToDbStudent(d) {
    return {
      id: d.id,
      student_id: d.studentId,
      name: d.name,
      email: d.email || null,
      password: d.password || null,
      year_level: d.yearLevel || null,
      section: d.section || null,
      year_section: d.yearSection || null,
      department: d.department || null,
      program: d.program || null,
      enrolled_subjects: Array.isArray(d.enrolledSubjects) ? d.enrolledSubjects : [],
      archived: !!d.archived,
      archived_at: d.archivedAt || null,
    };
  },

  _jsToDbSubject(d) {
    return {
      id: d.id,
      code: d.code,
      name: d.name,
      description: d.description || null,
      year_level: d.yearLevel || null,
      sections: Array.isArray(d.sections) ? d.sections : [],
      enrollment_code: d.enrollmentCode || null,
      color: d.color || null,
      archived: !!d.archived,
      archived_at: d.archivedAt || null,
    };
  },

  _jsToDbExam(d) {
    return {
      id: d.id,
      subject_id: d.subjectId,
      title: d.title,
      description: d.description || null,
      time_limit: d.timeLimit || 60,
      code: d.code || '',
      status: d.status || 'draft',
      shuffle_questions: !!d.shuffleQuestions,
      shuffle_answers: !!d.shuffleAnswers,
      require_camera: !!d.requireCamera,
      require_ai_detection: !!d.requireAIDetection,
      allow_review: !!d.allowReview,
      scoring_released: !!d.scoringReleased,
      questions: Array.isArray(d.questions) ? d.questions : [],
      target_year_levels: Array.isArray(d.targetYearLevels) ? d.targetYearLevels : [],
      target_sections: Array.isArray(d.targetSections) ? d.targetSections : [],
      started_at: d.startedAt || null,
      closed_at: d.closedAt || null,
    };
  },

  _jsToDbSession(d) {
    return {
      id: d.id,
      exam_id: d.examId,
      exam_code: d.examCode || null,
      student_id: d.studentId,
      student_name: d.studentName,
      year_level: d.yearLevel || null,
      section: d.section || null,
      year_section: d.yearSection || null,
      department: d.department || null,
      program: d.program || null,
      start_time: d.startTime || null,
      end_time: d.endTime || null,
      answers: d.answers || {},
      warnings: d.warnings || 0,
      activities: Array.isArray(d.activities) ? d.activities : [],
      score: d.score ?? null,
      max_score: d.maxScore ?? null,
      submitted: !!d.submitted,
      auto_submitted: !!d.autoSubmitted,
      score_released: !!d.scoreReleased,
      camera_snapshots: Array.isArray(d.cameraSnapshots) ? d.cameraSnapshots : [],
    };
  },

  _jsToDbLog(d) {
    return {
      id: d.id,
      session_id: d.sessionId || null,
      student_id: d.studentId || null,
      exam_id: d.examId || null,
      type: d.type,
      details: d.details || null,
      timestamp: d.timestamp || new Date().toISOString(),
    };
  },

  _jsToDb(table, data) {
    switch (table) {
      case 'admins':   return this._jsToDbAdmin(data);
      case 'students': return this._jsToDbStudent(data);
      case 'subjects': return this._jsToDbSubject(data);
      case 'exams':    return this._jsToDbExam(data);
      case 'sessions': return this._jsToDbSession(data);
      case 'logs':     return this._jsToDbLog(data);
      default: return null;
    }
  },

  // ── DB → JS normalizers ─────────────────────────────────────

  _dbToJsSettings(r) {
    return {
      schoolName: r.school_name || '',
      logoUrl: r.logo_url || '',
      department: r.department || '',
      adminName: r.admin_name || '',
      adminEmail: r.admin_email || '',
    };
  },

  _dbToJsAdmin(r) {
    return {
      id: r.id,
      username: r.username,
      password: r.password,
      name: r.name,
      email: r.email || '',
      createdAt: r.created_at || null,
    };
  },

  _dbToJsStudent(r) {
    return {
      id: r.id,
      studentId: r.student_id,
      name: r.name,
      email: r.email || '',
      password: r.password || '',
      yearLevel: r.year_level || '',
      section: r.section || '',
      yearSection: r.year_section || '',
      department: r.department || '',
      program: r.program || '',
      enrolledSubjects: Array.isArray(r.enrolled_subjects) ? r.enrolled_subjects : [],
      archived: !!r.archived,
      archivedAt: r.archived_at || null,
      createdAt: r.created_at || null,
    };
  },

  _dbToJsSubject(r) {
    return {
      id: r.id,
      code: r.code,
      name: r.name,
      description: r.description || '',
      yearLevel: r.year_level || '',
      sections: Array.isArray(r.sections) ? r.sections : [],
      enrollmentCode: r.enrollment_code || '',
      color: r.color || '',
      archived: !!r.archived,
      archivedAt: r.archived_at || null,
      createdAt: r.created_at || null,
    };
  },

  _dbToJsExam(r) {
    return {
      id: r.id,
      subjectId: r.subject_id,
      title: r.title,
      description: r.description || '',
      timeLimit: r.time_limit,
      code: r.code,
      status: r.status,
      shuffleQuestions: !!r.shuffle_questions,
      shuffleAnswers: !!r.shuffle_answers,
      requireCamera: !!r.require_camera,
      requireAIDetection: !!r.require_ai_detection,
      allowReview: !!r.allow_review,
      scoringReleased: !!r.scoring_released,
      questions: Array.isArray(r.questions) ? r.questions : [],
      targetYearLevels: Array.isArray(r.target_year_levels) ? r.target_year_levels : [],
      targetSections: Array.isArray(r.target_sections) ? r.target_sections : [],
      startedAt: r.started_at || null,
      closedAt: r.closed_at || null,
      createdAt: r.created_at || null,
    };
  },

  _dbToJsSession(r) {
    return {
      id: r.id,
      examId: r.exam_id,
      examCode: r.exam_code || '',
      studentId: r.student_id,
      studentName: r.student_name,
      yearLevel: r.year_level || '',
      section: r.section || '',
      yearSection: r.year_section || '',
      department: r.department || '',
      program: r.program || '',
      startTime: r.start_time || null,
      endTime: r.end_time || null,
      answers: r.answers || {},
      warnings: r.warnings || 0,
      activities: Array.isArray(r.activities) ? r.activities : [],
      score: r.score ?? null,
      maxScore: r.max_score ?? null,
      submitted: !!r.submitted,
      autoSubmitted: !!r.auto_submitted,
      scoreReleased: !!r.score_released,
      cameraSnapshots: Array.isArray(r.camera_snapshots) ? r.camera_snapshots : [],
      createdAt: r.created_at || null,
    };
  },

  _dbToJsLog(r) {
    return {
      id: r.id,
      sessionId: r.session_id || null,
      studentId: r.student_id || null,
      examId: r.exam_id || null,
      type: r.type,
      details: r.details || '',
      timestamp: r.timestamp || r.created_at || null,
    };
  },

  // ── Utils ───────────────────────────────────────────────────

  _local(key) {
    try { return JSON.parse(localStorage.getItem(key)); } catch { return null; }
  },
  _localArray(key) {
    try { return JSON.parse(localStorage.getItem(key)) || []; } catch { return []; }
  },

  _emitReady() {
    if (this._readyEmitted) return;
    this._readyEmitted = true;
    document.dispatchEvent(new Event('dbReady'));
  },
};

window.SupabaseSync = SupabaseSync;

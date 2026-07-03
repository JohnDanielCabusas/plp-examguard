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
  _initPromise: null,
  _deferredHydrationPromise: null,
  _readyEmitted: false,
  _sessionAiDetectionsSupported: true,

  _writeLocal(key, value) {
    window.DB?._write?.(key, value);
  },

  // ── Public: call once per page load (from React useEffect) ──
  async init() {
    if (this._initPromise) return this._initPromise;

    this._initPromise = (async () => {
      const client = window.supabase;
      if (!client) {
        console.warn('[SupabaseSync] Supabase client not available. Running with in-memory defaults only.');
        this._emitReady();
        return;
      }
      this._client = client;

      try {
        await this._pullFromSupabase();
        this._setupListeners();
      } catch (e) {
        console.warn('[SupabaseSync] Error loading data from Supabase:', e.message || e);
      } finally {
        this._emitReady();
        this._hydrateDeferredTables();
      }
    })();

    return this._initPromise;
  },

  // ── Pull all tables into the in-memory cache ───────────────
  async _pullFromSupabase() {
    const c = this._client;
    const [
      { data: settings },
      { data: superadmin },
      { data: admins },
      { data: students },
      { data: subjects },
      { data: exams },
      { data: sessions },
    ] = await Promise.all([
      c.from('settings').select('*').eq('id', 'main').maybeSingle(),
      c.from('superadmin').select('id, username, name, email, department').eq('id', 'main').maybeSingle(),
      c.from('professors').select('id, username, name, email, department, created_at'),
      c.from('students').select('id, student_id, name, email, year_level, section, year_section, department, program, enrolled_subjects, owner_admin_id, archived, archived_at, created_at, updated_at'),
      c.from('subjects').select('*').order('created_at'),
      c.from('exams').select('*').order('created_at'),
      c.from('sessions').select('*').order('created_at'),
    ]);

    // First-run: if Supabase is empty, push local seeds up instead of wiping them
    const isEmpty = !admins?.length && !subjects?.length && !exams?.length;
    if (isEmpty) {
      await this._seedToSupabase();
      return;
    }

    // Supabase has data — overwrite the in-memory cache with it
    if (settings) this._writeLocal('acs_settings', this._dbToJsSettings(settings));
    if (superadmin) this._writeLocal('acs_sysadmin', this._dbToJsSysAdmin(superadmin));
    this._writeLocal('acs_professors', (admins || []).map(r => this._dbToJsAdmin(r)));
    this._writeLocal('acs_students', (students || []).map(r => this._dbToJsStudent(r)));
    this._writeLocal('acs_subjects', (subjects || []).map(r => this._dbToJsSubject(r)));
    this._writeLocal('acs_exams', (exams || []).map(r => this._dbToJsExam(r)));
    this._writeLocal('acs_sessions', (sessions || []).map(r => this._dbToJsSession(r)));
  },
  async _hydrateDeferredTables() {
    if (this._deferredHydrationPromise || !this._client) return this._deferredHydrationPromise;

    this._deferredHydrationPromise = (async () => {
      try {
        const { data: logs } = await this._client
          .from('logs')
          .select('*')
          .order('created_at');
        this._writeLocal('acs_logs', (logs || []).map(r => this._dbToJsLog(r)));
      } catch (e) {
        console.warn('[SupabaseSync] Error hydrating deferred tables:', e.message || e);
      }
    })();

    return this._deferredHydrationPromise;
  },

  // ── Seed Supabase from in-memory defaults on first run ─────
  async _seedToSupabase() {
    const c = this._client;

    const settings = this._local('acs_settings');
    if (settings) {
      await c.from('settings').upsert(this._jsToDbSettings(settings));
    }

    const sysAdmin = this._local('acs_sysadmin');
    if (sysAdmin) {
      await c.from('superadmin').upsert(this._jsToDbSysAdmin(sysAdmin));
    }

    // Order matters: subjects before exams (FK constraint)
    const seedings = [
      ['professors', 'acs_professors', r => this._jsToDbAdmin(r)],
      ['students', 'acs_students', r => this._jsToDbStudent(r)],
      ['subjects', 'acs_subjects', r => this._jsToDbSubject(r)],
      ['exams',    'acs_exams',    r => this._jsToDbExam(r)],
      ['sessions', 'acs_sessions', r => this._jsToDbSession(r)],
      ['logs',     'acs_logs',     r => this._jsToDbLog(r)],
    ];

    for (const [table, lsKey, normalizer] of seedings) {
      const items = this._localArray(lsKey);
      if (items.length) {
        let rows = items.map(normalizer);
        let { error } = await c.from(table).upsert(rows);
        if (error && this._isMissingSessionAiDetectionsError(table, error)) {
          this._sessionAiDetectionsSupported = false;
          rows = rows.map(row => this._withoutSessionAiDetections(row));
          ({ error } = await c.from(table).upsert(rows));
        }
        if (error) console.warn(`[SupabaseSync] seed ${table}:`, error.message);
      }
    }
  },

  // ── Realtime listeners ─────────────────────────────────────
  _setupListeners() {
    const c = this._client;
    if (this._channel) return;

    const applyChange = (table, lsKey, normalizer) => (payload) => {
      const { eventType, new: row, old } = payload;
      const currentValue = window.DB?._read?.(lsKey, []);
      const current = Array.isArray(currentValue) ? [...currentValue] : [];

      if (table === 'settings') {
        if (row) {
          const normalized = normalizer(row);
          // Preserve claudeApiKey from localStorage if DB doesn't have it yet
          // (column may not exist in older schema deployments)
          if (!normalized.claudeApiKey) {
            const existing = window.DB?._read?.(lsKey, null);
            if (existing && existing.claudeApiKey) {
              normalized.claudeApiKey = existing.claudeApiKey;
            }
          }
          this._writeLocal(lsKey, normalized);
        }
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

  syncSysAdmin(data) {
    if (!this._client) return;
    this._client.from('superadmin').upsert(this._jsToDbSysAdmin(data))
      .then(({ error }) => { if (error) console.error('[SupabaseSync] syncSysAdmin:', error.message); });
  },

  syncDoc(table, data) {
    if (!this._client || !data?.id) return;
    const row = this._jsToDb(table, data);
    if (!row) return;
    // onConflict:'id' ensures we always UPDATE existing rows by primary key,
    // avoiding false conflicts on unique columns like exams.code
    this._client.from(table).upsert(row, { onConflict: 'id' })
      .then(async ({ error }) => {
        if (error && this._isMissingSessionAiDetectionsError(table, error)) {
          this._sessionAiDetectionsSupported = false;
          const fallbackRow = this._withoutSessionAiDetections(row);
          const { error: retryError } = await this._client.from(table).upsert(fallbackRow, { onConflict: 'id' });
          if (!retryError) return;
          error = retryError;
        }

        // Subjects: local ID diverged from Supabase (e.g. stale localStorage after DB reset).
        // Fetch the real Supabase ID by the unique (owner_admin_id, code) pair, fix local cache,
        // then retry the upsert with the correct ID.
        if (error && table === 'subjects' && error.code === '23505') {
          const { data: existing } = await this._client.from('subjects')
            .select('id')
            .eq('code', row.code)
            .eq('owner_admin_id', row.owner_admin_id)
            .maybeSingle();
          if (existing && existing.id !== row.id) {
            const subjects = window.DB?._read?.('acs_subjects', []);
            const idx = subjects.findIndex(s => s.id === data.id);
            if (idx >= 0) {
              subjects[idx] = { ...subjects[idx], id: existing.id };
              window.DB?._write?.('acs_subjects', subjects);
            }
            const { error: fixError } = await this._client.from('subjects')
              .upsert({ ...row, id: existing.id }, { onConflict: 'id' });
            if (!fixError) return;
            error = fixError;
          }
        }

        if (error) {
          console.error(`[SupabaseSync] syncDoc(${table}):`, error.message);
          // Surface sync failures as a visible warning
          const ev = new CustomEvent('supabaseSyncError', { detail: { table, message: error.message } });
          document.dispatchEvent(ev);
        }
      });
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
      claude_api_key: d.claudeApiKey || null,
    };
  },

  _jsToDbSysAdmin(d) {
    return {
      id: 'main',
      username: d.username,
      name: d.name || 'System Administrator',
      email: d.email || null,
      department: d.department || null,
    };
  },

  _dbToJsSysAdmin(r) {
    return {
      username: r.username,
      name: r.name || 'System Administrator',
      email: r.email || '',
      department: r.department || '',
    };
  },

  _jsToDbAdmin(d) {
    return {
      id: d.id,
      username: d.username,
      name: d.name,
      email: d.email || null,
      department: d.department || null,
    };
  },

  _jsToDbStudent(d) {
    return {
      id: d.id,
      student_id: d.studentId,
      name: d.name,
      email: d.email || null,
      year_level: d.yearLevel || null,
      section: d.section || null,
      year_section: d.yearSection || null,
      department: d.department || null,
      program: d.program || null,
      enrolled_subjects: Array.isArray(d.enrolledSubjects) ? d.enrolledSubjects : [],
      owner_admin_id: d.ownerAdminId || null,
      archived: !!d.archived,
      archived_at: d.archivedAt || null,
    };
  },

  _jsToDbSubject(d) {
    const yearLevels = Array.isArray(d.yearLevels) ? d.yearLevels.filter(Boolean) : [];
    return {
      id: d.id,
      code: d.code,
      name: d.name,
      description: d.description || null,
      year_level: yearLevels.length ? yearLevels.join(', ') : (d.yearLevel || null),
      sections: Array.isArray(d.sections) ? d.sections : [],
      enrollment_code: d.enrollmentCode || null,
      color: typeof d.courseColor === 'number' ? String(d.courseColor) : (d.color || null),
      owner_admin_id: d.ownerAdminId || null,
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
      code: d.code || ('D-' + (d.id || '').slice(-8).toUpperCase()),
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
      owner_admin_id: d.ownerAdminId || null,
      started_at: d.startedAt || null,
      closed_at: d.closedAt || null,
    };
  },

  _jsToDbSession(d) {
    const row = {
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
      owner_admin_id: d.ownerAdminId || null,
    };
    if (this._sessionAiDetectionsSupported !== false) {
      row.ai_detections = d.aiDetections || {};
    }
    return row;
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
      owner_admin_id: d.ownerAdminId || null,
    };
  },

  _jsToDb(table, data) {
    switch (table) {
      case 'professors': return this._jsToDbAdmin(data);
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
      claudeApiKey: r.claude_api_key || '',
    };
  },

  _dbToJsAdmin(r) {
    return {
      id: r.id,
      username: r.username,
      name: r.name,
      email: r.email || '',
      department: r.department || '',
      createdAt: r.created_at || null,
    };
  },

  _dbToJsStudent(r) {
    return {
      id: r.id,
      studentId: r.student_id,
      name: r.name,
      email: r.email || '',
      yearLevel: r.year_level || '',
      section: r.section || '',
      yearSection: r.year_section || '',
      department: r.department || '',
      program: r.program || '',
      enrolledSubjects: Array.isArray(r.enrolled_subjects) ? r.enrolled_subjects : [],
      ownerAdminId: r.owner_admin_id || '',
      archived: !!r.archived,
      archivedAt: r.archived_at || null,
      createdAt: r.created_at || null,
    };
  },

  _dbToJsSubject(r) {
    const parsedYearLevels = String(r.year_level || '')
      .split(',')
      .map(value => value.trim())
      .filter(Boolean);
    return {
      id: r.id,
      code: r.code,
      name: r.name,
      description: r.description || '',
      yearLevel: parsedYearLevels[0] || r.year_level || '',
      yearLevels: parsedYearLevels,
      sections: Array.isArray(r.sections) ? r.sections : [],
      enrollmentCode: r.enrollment_code || '',
      courseColor: (r.color !== null && r.color !== '' && !isNaN(Number(r.color))) ? Number(r.color) : undefined,
      ownerAdminId: r.owner_admin_id || '',
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
      ownerAdminId: r.owner_admin_id || '',
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
      aiDetections: r.ai_detections || {},
      cameraSnapshots: Array.isArray(r.camera_snapshots) ? r.camera_snapshots : [],
      ownerAdminId: r.owner_admin_id || '',
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
      ownerAdminId: r.owner_admin_id || '',
    };
  },

  // ── Utils ───────────────────────────────────────────────────

  _local(key) {
    return window.DB?._read?.(key, null) ?? null;
  },
  _localArray(key) {
    const value = window.DB?._read?.(key, []);
    return Array.isArray(value) ? value : [];
  },

  _isMissingSessionAiDetectionsError(table, error) {
    const message = String(error?.message || '');
    return table === 'sessions' && message.includes(`Could not find the 'ai_detections' column`);
  },

  _withoutSessionAiDetections(row) {
    const next = { ...row };
    delete next.ai_detections;
    return next;
  },

  _emitReady() {
    if (this._readyEmitted) return;
    this._readyEmitted = true;
    document.dispatchEvent(new Event('dbReady'));
  },
};

window.SupabaseSync = SupabaseSync;

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
  // Serialize writes per table/id so rapid local edits (for example absent -> present ->
  // draft -> ready on the same exam) cannot reach Supabase out of order and resurrect
  // stale state on other clients.
  _docSyncChains: new Map(),
  // Exam IDs whose excluded_student_ids value is known to NOT have made it to Supabase yet
  // (e.g. PostgREST's schema cache was briefly stale and rejected the column). While an id
  // is in this set, realtime/pull updates for that exam must not trust the incoming
  // excluded_student_ids value — it would just echo back the stale server-side copy and
  // clobber the correct local one. Cleared once a write that includes the field succeeds.
  _examIdsWithUnsyncedExclusions: new Set(),

  _writeLocal(key, value) {
    window.DB?._write?.(key, value);
  },

  // Lets the UI react to a realtime push the instant it lands, instead of
  // waiting for the next section poll — see admin.js's 'acsDataChanged' listener.
  _notifyDataChanged(table) {
    if (typeof document === 'undefined') return;
    document.dispatchEvent(new CustomEvent('acsDataChanged', { detail: { table } }));
  },

  _getSessions() {
    return {
      admin: window.Auth?.getAdminSession?.() || null,
      sysadmin: window.Auth?.getSysAdminSession?.() || null,
      student: window.Auth?.getStudentSession?.() || null,
    };
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

  async initPublic() {
    if (this._initPromise) return this._initPromise;

    this._initPromise = (async () => {
      const client = window.supabase;
      if (!client) {
        this._emitReady();
        return;
      }
      this._client = client;

      try {
        const { data: settings } = await client
          .from('settings')
          .select('id, school_name, logo_url, department, admin_name, admin_email')
          .eq('id', 'main')
          .maybeSingle();
        if (settings) this._writeLocal('acs_settings', this._dbToJsSettings(settings));
      } catch (e) {
        console.warn('[SupabaseSync] Error loading public settings:', e.message || e);
      } finally {
        this._emitReady();
      }
    })();

    return this._initPromise;
  },

  // ── Pull all tables into the in-memory cache ───────────────
  // Students are visible to a professor either because the professor's own
  // record created them (owner_admin_id) or — the common case for self-service
  // enrollment — because they joined one of this professor's courses via an
  // enrollment code, which only appends to their enrolled_subjects array and
  // never reassigns owner_admin_id (a student can be enrolled with multiple
  // professors at once, so a single-owner column can't express "mine"). Filter
  // on both so a student who joined a *different* professor's course first
  // still shows up here once they enroll in this professor's course too.
  _studentsQueryForAdmin(c, adminId, subjectIds) {
    const cols = 'id, student_id, name, email, year_level, section, year_section, department, program, enrolled_subjects, owner_admin_id, archived, archived_at, created_at, updated_at';
    const query = c.from('students').select(cols);
    if (!subjectIds || !subjectIds.length) return query.eq('owner_admin_id', adminId);
    // enrolled_subjects is jsonb, so PostgREST's array-overlap ("ov") operator doesn't
    // apply to it (jsonb has no && operator) — use one jsonb-containment ("cs") clause
    // per subject id instead, OR'd together with the owner_admin_id check.
    const subjectClauses = subjectIds.map(id => `enrolled_subjects.cs.["${id}"]`);
    return query.or([`owner_admin_id.eq.${adminId}`, ...subjectClauses].join(','));
  },

  async _pullFromSupabase() {
    const c = this._client;
    const { admin, sysadmin, student } = this._getSessions();

    if (admin?.id && !sysadmin) {
      const [
        { data: settings },
        { data: admins },
        { data: subjects },
        { data: exams },
        { data: sessions },
      ] = await Promise.all([
        c.from('settings').select('*').eq('id', 'main').maybeSingle(),
        c.from('professors').select('id, username, name, email, department, created_at').eq('id', admin.id),
        c.from('subjects').select('*').eq('owner_admin_id', admin.id).order('created_at'),
        c.from('exams').select('*').eq('owner_admin_id', admin.id).order('created_at'),
        c.from('sessions').select('*').eq('owner_admin_id', admin.id).order('created_at'),
      ]);
      const { data: students } = await this._studentsQueryForAdmin(c, admin.id, (subjects || []).map(s => s.id));

      if (settings) this._writeLocal('acs_settings', this._dbToJsSettings(settings));
      this._writeLocal('acs_professors', (admins || []).map(r => this._dbToJsAdmin(r)));
      this._writeLocal('acs_students', (students || []).map(r => this._dbToJsStudent(r)));
      this._writeLocal('acs_subjects', (subjects || []).map(r => this._dbToJsSubject(r)));
      this._writeLocal('acs_exams', this._dbToJsExamsPreservingLocal(exams));
      this._writeLocal('acs_sessions', (sessions || []).map(r => this._dbToJsSession(r)));
      return;
    }

    if (student?.studentId && !sysadmin) {
      const { data: settings } = await c
        .from('settings')
        .select('id, school_name, logo_url, department, admin_name, admin_email')
        .eq('id', 'main')
        .maybeSingle();

      const { data: studentRow } = await c
        .from('students')
        .select('id, student_id, name, email, year_level, section, year_section, department, program, enrolled_subjects, owner_admin_id, archived, archived_at, created_at, updated_at')
        .eq('student_id', student.studentId)
        .maybeSingle();

      const enrolledSubjectIds = Array.isArray(studentRow?.enrolled_subjects) ? studentRow.enrolled_subjects : [];
      const [{ data: subjects }, { data: sessions }] = await Promise.all([
        enrolledSubjectIds.length
          ? c.from('subjects').select('*').in('id', enrolledSubjectIds).order('created_at')
          : Promise.resolve({ data: [] }),
        c.from('sessions').select('*').eq('student_id', student.studentId).order('created_at'),
      ]);
      const subjectIds = (subjects || []).map(subjectRow => subjectRow.id);
      const { data: exams } = subjectIds.length
        ? await c.from('exams').select('*').in('subject_id', subjectIds).order('created_at')
        : { data: [] };

      if (settings) this._writeLocal('acs_settings', this._dbToJsSettings(settings));
      this._writeLocal('acs_students', studentRow ? [this._dbToJsStudent(studentRow)] : []);
      this._writeLocal('acs_subjects', (subjects || []).map(r => this._dbToJsSubject(r)));
      this._writeLocal('acs_exams', this._dbToJsExamsPreservingLocal(exams));
      this._writeLocal('acs_sessions', (sessions || []).map(r => this._dbToJsSession(r)));
      return;
    }

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
    this._writeLocal('acs_exams', this._dbToJsExamsPreservingLocal(exams));
    this._writeLocal('acs_sessions', (sessions || []).map(r => this._dbToJsSession(r)));
  },

  // Normalizes exam rows from Supabase, but preserves the locally-known
  // excludedStudentIds instead of letting the pull silently wipe/revert it, whenever
  // either (a) this Supabase project's schema doesn't have the column yet (pre-migration),
  // or (b) a prior write for that exam is known not to have persisted the field (see
  // _examIdsWithUnsyncedExclusions in syncDoc()).
  _dbToJsExamsPreservingLocal(rawRows) {
    const existingById = new Map(this._localArray('acs_exams').map(e => [e.id, e]));
    return (rawRows || []).map(r => {
      const normalized = this._dbToJsExam(r);
      if (!('excluded_student_ids' in r) || this._examIdsWithUnsyncedExclusions.has(normalized.id)) {
        const prior = existingById.get(normalized.id);
        if (prior && Array.isArray(prior.excludedStudentIds)) {
          normalized.excludedStudentIds = prior.excludedStudentIds;
        }
      }
      return normalized;
    });
  },
  async _hydrateDeferredTables() {
    if (this._deferredHydrationPromise || !this._client) return this._deferredHydrationPromise;

    this._deferredHydrationPromise = (async () => {
      try {
        const { admin, sysadmin, student } = this._getSessions();
        let query = this._client
          .from('logs')
          .select('*')
          .order('created_at');
        if (admin?.id && !sysadmin) query = query.eq('owner_admin_id', admin.id);
        if (student?.studentId && !sysadmin && !admin?.id) query = query.eq('student_id', student.studentId);
        const { data: logs } = await query;
        this._writeLocal('acs_logs', (logs || []).map(r => this._dbToJsLog(r)));
      } catch (e) {
        console.warn('[SupabaseSync] Error hydrating deferred tables:', e.message || e);
      }
      await this.refreshProfessorActivityLog();
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
        if (error && this._isMissingExamExcludedStudentIdsError(table, error)) {
          rows.forEach(row => this._examIdsWithUnsyncedExclusions.add(row.id));
          rows = rows.map(row => this._withoutExamExcludedStudentIds(row));
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
    const { admin, sysadmin } = this._getSessions();
    const ownerFilter = admin?.id && !sysadmin ? `owner_admin_id=eq.${admin.id}` : null;
    const professorFilter = admin?.id && !sysadmin ? `id=eq.${admin.id}` : null;

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
      // Students table has no per-professor filter (see subscription below — a
      // student can be enrolled with multiple professors, which the "eq owner_admin_id"
      // filter Realtime supports can't express), so every professor's browser receives
      // every change to this table. Enforce visibility here, client-side, before any
      // row touches local cache/UI: this professor may see the row either because they
      // own it directly or because it's enrolled in one of their own courses.
      if (table === 'students' && admin?.id && !sysadmin) {
        if (eventType === 'DELETE') {
          this._writeLocal(lsKey, current.filter(r => r.id !== old.id));
          this._notifyDataChanged(table);
          return;
        }
        const mySubjectIds = new Set((window.DB?.getSubjects?.() || []).map(s => s.id));
        const enrolledSubjectIds = Array.isArray(row?.enrolled_subjects) ? row.enrolled_subjects : [];
        const visible = row?.owner_admin_id === admin.id || enrolledSubjectIds.some(id => mySubjectIds.has(id));
        if (!visible) {
          // Not (or no longer) visible to this professor — drop it if it was cached.
          const idx = current.findIndex(r => r.id === row?.id);
          if (idx >= 0) this._writeLocal(lsKey, current.filter(r => r.id !== row.id));
          this._notifyDataChanged(table);
          return;
        }
        const normalized = normalizer(row);
        const idx = current.findIndex(r => r.id === normalized.id);
        if (idx >= 0) { current[idx] = normalized; this._writeLocal(lsKey, current); }
        else { this._writeLocal(lsKey, [...current, normalized]); }
        this._notifyDataChanged(table);
        return;
      }
      if (eventType === 'DELETE') {
        this._writeLocal(lsKey, current.filter(r => r.id !== old.id));
      } else {
        const normalized = normalizer(row);
        // Exams: preserve locally-known excludedStudentIds if either (a) this Supabase
        // project's schema doesn't have the column yet (pre-migration), or (b) our last
        // write for this exam is known to have failed to persist that field (e.g. a
        // temporarily stale PostgREST schema cache) — in both cases the incoming row's
        // value is stale/wrong and would clobber the correct local one. See syncDoc().
        if (table === 'exams' && row && (!('excluded_student_ids' in row) || this._examIdsWithUnsyncedExclusions.has(normalized.id))) {
          const prior = current.find(r => r.id === normalized.id);
          if (prior && Array.isArray(prior.excludedStudentIds)) {
            normalized.excludedStudentIds = prior.excludedStudentIds;
          }
        }
        const idx = current.findIndex(r => r.id === normalized.id);
        if (idx >= 0) { current[idx] = normalized; this._writeLocal(lsKey, current); }
        else { this._writeLocal(lsKey, [...current, normalized]); }
      }
      this._notifyDataChanged(table);
    };

    this._channel = c.channel('acs-realtime')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'settings' },
        applyChange('settings', 'acs_settings', r => this._dbToJsSettings(r)))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'subjects', ...(ownerFilter ? { filter: ownerFilter } : {}) },
        applyChange('subjects', 'acs_subjects', r => this._dbToJsSubject(r)))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'exams', ...(ownerFilter ? { filter: ownerFilter } : {}) },
        applyChange('exams', 'acs_exams', r => this._dbToJsExam(r)))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'sessions', ...(ownerFilter ? { filter: ownerFilter } : {}) },
        applyChange('sessions', 'acs_sessions', r => this._dbToJsSession(r)))
      // No ownerFilter here — a student can belong to more than one professor
      // (see applyChange's own visibility check above), which a single-column
      // Realtime filter can't express, so this table is subscribed unfiltered.
      .on('postgres_changes', { event: '*', schema: 'public', table: 'students' },
        applyChange('students', 'acs_students', r => this._dbToJsStudent(r)))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'professors', ...(professorFilter ? { filter: professorFilter } : {}) },
        applyChange('professors', 'acs_professors', r => this._dbToJsAdmin(r)))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'logs', ...(ownerFilter ? { filter: ownerFilter } : {}) },
        applyChange('logs', 'acs_logs', r => this._dbToJsLog(r)))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'professor_activity_log' },
        applyChange('professor_activity_log', 'acs_professor_activity_log', r => this._dbToJsProfessorActivityLog(r)))
      .subscribe();
  },

  // ── Refresh helpers ─────────────────────────────────────────

  async refreshSubjects() {
    if (!this._client) return;
    const { admin, sysadmin } = this._getSessions();
    let query = this._client.from('subjects').select('*');
    if (admin?.id && !sysadmin) query = query.eq('owner_admin_id', admin.id);
    const { data: subjects } = await query;
    if (subjects) {
      this._writeLocal('acs_subjects', subjects.map(r => this._dbToJsSubject(r)));
    }
  },

  async refreshExams() {
    if (!this._client) return;
    const { admin, sysadmin } = this._getSessions();
    let query = this._client.from('exams').select('*');
    if (admin?.id && !sysadmin) query = query.eq('owner_admin_id', admin.id);
    const { data: exams } = await query;
    if (exams) {
      this._writeLocal('acs_exams', this._dbToJsExamsPreservingLocal(exams));
    }
  },

  // Sessions carry submitted/answers/warnings state that professors mutate
  // (e.g. "Allow Retake") and students mutate while taking an exam — both
  // sides need this refetched, not just re-rendered from a stale cache, in
  // case the realtime socket silently dropped.
  async refreshSessions() {
    if (!this._client) return;
    const { admin, sysadmin, student } = this._getSessions();
    let query = this._client.from('sessions').select('*');
    if (admin?.id && !sysadmin) query = query.eq('owner_admin_id', admin.id);
    else if (student?.studentId && !sysadmin) query = query.eq('student_id', student.studentId);
    const { data: sessions } = await query;
    if (sessions) {
      this._writeLocal('acs_sessions', sessions.map(r => this._dbToJsSession(r)));
    }
  },

  async refreshStudents() {
    if (!this._client) return;
    const { admin, sysadmin, student } = this._getSessions();
    const cols = 'id, student_id, name, email, year_level, section, year_section, department, program, enrolled_subjects, owner_admin_id, archived, archived_at, created_at, updated_at';
    if (admin?.id && !sysadmin) {
      const mySubjectIds = (window.DB?.getSubjects?.() || []).map(s => s.id);
      const { data } = await this._studentsQueryForAdmin(this._client, admin.id, mySubjectIds);
      if (data) this._writeLocal('acs_students', data.map(r => this._dbToJsStudent(r)));
      return;
    }
    if (student?.studentId && !sysadmin) {
      const { data: ownRow } = await this._client.from('students').select(cols).eq('student_id', student.studentId).maybeSingle();
      const enrolledSubjectIds = Array.isArray(ownRow?.enrolled_subjects) ? ownRow.enrolled_subjects : [];
      const { data: classmates } = enrolledSubjectIds.length
        ? await this._client.from('students').select(cols).overlaps('enrolled_subjects', enrolledSubjectIds)
        : { data: ownRow ? [ownRow] : [] };
      this._writeLocal('acs_students', (classmates || []).map(r => this._dbToJsStudent(r)));
      return;
    }
    const { data } = await this._client.from('students').select(cols);
    if (data) this._writeLocal('acs_students', data.map(r => this._dbToJsStudent(r)));
  },

  async refreshProfessors() {
    if (!this._client) return;
    const { admin, sysadmin } = this._getSessions();
    let query = this._client.from('professors').select('id, username, name, email, department, created_at');
    if (admin?.id && !sysadmin) query = query.eq('id', admin.id);
    const { data } = await query;
    if (data) this._writeLocal('acs_professors', data.map(r => this._dbToJsAdmin(r)));
  },

  async refreshProfessorActivityLog() {
    if (!this._client) return;
    try {
      const { data } = await this._client
        .from('professor_activity_log')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(200);
      this._writeLocal('acs_professor_activity_log', (data || []).map(r => this._dbToJsProfessorActivityLog(r)));
    } catch (e) {
      console.warn('[SupabaseSync] Error refreshing professor activity log:', e.message || e);
    }
  },

  // Records one professor activity entry (course/exam/student change made
  // from the professor's own admin panel). Insert-only — there is nothing to
  // upsert/reconcile, unlike syncDoc().
  logProfessorActivity({ professorId, professorName, action, entityType, entityName, details } = {}) {
    if (!this._client || !action) return;
    const row = {
      id: window.DB?.generateId?.() || `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`,
      professor_id: professorId || null,
      professor_name: professorName || 'Unknown',
      action,
      entity_type: entityType || null,
      entity_name: entityName || null,
      details: details || null,
    };
    this._client.from('professor_activity_log').insert(row)
      .then(({ error }) => { if (error) console.error('[SupabaseSync] logProfessorActivity:', error.message); });
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

  _docSyncKey(table, id) {
    return `${table}:${id}`;
  },

  _enqueueDocSync(table, id, task) {
    const key = this._docSyncKey(table, id);
    const previous = this._docSyncChains.get(key) || Promise.resolve();
    const next = previous
      .catch(() => {})
      .then(task)
      .finally(() => {
        if (this._docSyncChains.get(key) === next) this._docSyncChains.delete(key);
      });
    this._docSyncChains.set(key, next);
    return next;
  },

  syncDoc(table, data) {
    if (!this._client || !data?.id) return;
    const row = this._jsToDb(table, data);
    if (!row) return;
    this._enqueueDocSync(table, data.id, async () => {
      // Professors are only ever CREATED server-side (server/auth-service.cjs), which
      // hashes and sets the required `password` column. Client-side syncs of a
      // professor (e.g. a professor editing their own settings) never carry a
      // password, so an upsert here would fall through to an INSERT — missing
      // `password` — and violate the NOT NULL constraint if the row doesn't already
      // exist (deleted, or never created). A plain UPDATE can only ever touch an
      // existing row, so a missing/deleted professor just becomes a harmless no-op.
      let error;
      if (table === 'professors') {
        ({ error } = await this._client.from(table).update(row).eq('id', data.id));
      } else {
        // onConflict:'id' ensures we always UPDATE existing rows by primary key,
        // avoiding false conflicts on unique columns like exams.code
        ({ error } = await this._client.from(table).upsert(row, { onConflict: 'id' }));
      }
      if (!error && table === 'exams') {
        // This write included excluded_student_ids and Postgres accepted it —
        // the row is now authoritative again, so trust future echoes of it.
        this._examIdsWithUnsyncedExclusions.delete(row.id);
      }

      if (error && this._isMissingSessionAiDetectionsError(table, error)) {
        this._sessionAiDetectionsSupported = false;
        const fallbackRow = this._withoutSessionAiDetections(row);
        const { error: retryError } = await this._client.from(table).upsert(fallbackRow, { onConflict: 'id' });
        if (!retryError) return;
        error = retryError;
      }

      if (error && this._isMissingExamExcludedStudentIdsError(table, error)) {
        // PostgREST's schema cache is (probably temporarily) out of sync with the real
        // table — don't give up on this field forever, just skip it for THIS write and
        // keep trying on every future save until it succeeds. Meanwhile, mark this exam
        // so realtime/pull echoes don't clobber the correct local value with Supabase's
        // stale copy of excluded_student_ids.
        this._examIdsWithUnsyncedExclusions.add(row.id);
        const fallbackRow = this._withoutExamExcludedStudentIds(row);
        const { error: retryError } = await this._client.from(table).upsert(fallbackRow, { onConflict: 'id' });
        if (!retryError) {
          // The rest of the exam saved, but the present/absent list specifically did NOT
          // reach Supabase this time — say so, instead of letting the generic "saved"
          // toast imply students on other devices already see the change. Also keep
          // retrying in the background so it self-heals without needing another save.
          document.dispatchEvent(new CustomEvent('supabaseSyncError', {
            detail: {
              table,
              message: 'Attendance change saved on this device, but has not synced online yet — students on other devices may not see it until it does. Retrying automatically…',
            },
          }));
          this._scheduleExamExclusionRetry(row.id);
          return;
        }
        error = retryError;
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
      school_year: d.schoolYear || null,
      enrollment_code: d.enrollmentCode || null,
      color: typeof d.courseColor === 'number' ? String(d.courseColor) : (d.color || null),
      owner_admin_id: d.ownerAdminId || null,
      archived: !!d.archived,
      archived_at: d.archivedAt || null,
    };
  },

  _jsToDbExam(d) {
    const row = {
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
      excluded_student_ids: Array.isArray(d.excludedStudentIds) ? d.excludedStudentIds : [],
    };
    return row;
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
      schoolYear: r.school_year || '',
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
      excludedStudentIds: Array.isArray(r.excluded_student_ids) ? r.excluded_student_ids : [],
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

  _dbToJsProfessorActivityLog(r) {
    return {
      id: r.id,
      professorId: r.professor_id || '',
      professorName: r.professor_name || '',
      action: r.action,
      entityType: r.entity_type || '',
      entityName: r.entity_name || '',
      details: r.details || '',
      createdAt: r.created_at || null,
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

  _isMissingExamExcludedStudentIdsError(table, error) {
    const message = String(error?.message || '');
    return table === 'exams' && message.includes(`Could not find the 'excluded_student_ids' column`);
  },

  _withoutExamExcludedStudentIds(row) {
    const next = { ...row };
    delete next.excluded_student_ids;
    return next;
  },

  // Keeps retrying (with backoff) to write excluded_student_ids for one exam whose last
  // attempt hit a stale PostgREST schema cache, so a professor's present/absent change
  // self-heals onto Supabase without needing another unrelated save to trigger a retry.
  _scheduleExamExclusionRetry(examId, attempt = 1) {
    if (attempt > 5) return; // give up for now — the next real save will try again anyway
    const delay = Math.min(30000, 3000 * attempt);
    setTimeout(async () => {
      if (!this._client || !this._examIdsWithUnsyncedExclusions.has(examId)) return;
      const exam = window.DB?.getExam?.(examId);
      if (!exam) return;
      const row = this._jsToDbExam(exam);
      const { error } = await this._client.from('exams').upsert(row, { onConflict: 'id' });
      if (!error) {
        this._examIdsWithUnsyncedExclusions.delete(examId);
        return;
      }
      if (this._isMissingExamExcludedStudentIdsError('exams', error)) {
        this._scheduleExamExclusionRetry(examId, attempt + 1);
      }
    }, delay);
  },

  _emitReady() {
    if (this._readyEmitted) return;
    this._readyEmitted = true;
    document.dispatchEvent(new Event('dbReady'));
  },
};

window.SupabaseSync = SupabaseSync;

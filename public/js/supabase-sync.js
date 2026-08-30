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
  _sessionEssayGradesSupported: true,
  _sessionAiDetectionsSupported: true,
  _sessionCameraSnapshotsSupported: true,
  _examPoliciesSupported: true,
  _examCameraExemptSupported: true,
  _examObjectMonitoringSupported: true,
  // Set false the first time a messages write/read fails because the table
  // doesn't exist yet (schema-bootstrap.sql not applied). Keeps the chat feature
  // from spamming sync-error toasts on databases that pre-date it.
  _messagesSupported: true,
  _lastSyncErrorKey: '',
  _lastSyncErrorAt: 0,
  _crossTabChannel: null,
  _crossTabListenerBound: false,
  _tabId: `tab-${Math.random().toString(36).slice(2)}`,
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

  _normalizeObjectMonitoring(value) {
    const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    return {
      enabled: !!source.enabled,
      mode: 'enforce',
      allowSecondaryComputer: false,
      allowBooks: false,
    };
  },

  _writeLocal(key, value) {
    window.DB?._write?.(key, value);
  },

  _getCrossTabSignalKey() {
    return 'acs_rt_signal';
  },

  _isSessionVisibleToCurrentContext(session) {
    if (!session) return false;
    const { admin, sysadmin, student } = this._getSessions();
    if (sysadmin) return true;
    if (admin?.id) return !session.ownerAdminId || session.ownerAdminId === admin.id;
    if (student?.studentId) return session.studentId === student.studentId;
    return true;
  },

  _handleCrossTabSignal(payload) {
    if (!payload || payload.senderId === this._tabId) return;
    const { table, row, eventType } = payload;
    if (table !== 'sessions') return;

    const currentValue = window.DB?._read?.('acs_sessions', []);
    const current = Array.isArray(currentValue) ? [...currentValue] : [];

    if (eventType === 'DELETE') {
      this._writeLocal('acs_sessions', current.filter(session => session.id !== row?.id));
      this._notifyDataChanged('sessions');
      return;
    }

    if (!row || !this._isSessionVisibleToCurrentContext(row)) return;
    const prior = current.find(session => session.id === row.id);
    const nextRow = this._mergeIncomingSessionWithLocal(row, prior);
    const index = current.findIndex(session => session.id === nextRow.id);
    if (index >= 0) current[index] = nextRow;
    else current.push(nextRow);
    this._writeLocal('acs_sessions', current);
    this._notifyDataChanged('sessions');
  },

  _setupCrossTabSignals() {
    if (this._crossTabListenerBound || typeof window === 'undefined') return;
    this._crossTabListenerBound = true;

    if (typeof BroadcastChannel !== 'undefined') {
      this._crossTabChannel = new BroadcastChannel('acs-realtime-sync');
      this._crossTabChannel.addEventListener('message', (event) => {
        this._handleCrossTabSignal(event.data);
      });
    }

    window.addEventListener('storage', (event) => {
      if (event.key !== this._getCrossTabSignalKey() || !event.newValue) return;
      try {
        this._handleCrossTabSignal(JSON.parse(event.newValue));
      } catch (_) {}
    });
  },

  broadcastLocalChange(table, row, eventType = 'UPSERT') {
    if (typeof window === 'undefined') return;
    const payload = {
      senderId: this._tabId,
      table,
      row,
      eventType,
      timestamp: Date.now(),
    };

    try {
      this._crossTabChannel?.postMessage(payload);
    } catch (_) {}

    try {
      localStorage.setItem(this._getCrossTabSignalKey(), JSON.stringify(payload));
    } catch (_) {}
  },

  _toUserErrorMessage(error, fallback = 'Unable to sync with the server right now.', context = 'sync') {
    return window.AppErrorUtils?.toUserMessage?.(error, fallback, { context }) || fallback;
  },

  _isConnectivityIssue(error) {
    return !!window.AppErrorUtils?.isConnectivityIssue?.(error);
  },

  _emitSyncError(table, error, fallback = 'Unable to sync with the server right now.') {
    if (typeof document === 'undefined') return;
    const message = this._toUserErrorMessage(error, fallback, 'sync');
    const connectivityIssue = this._isConnectivityIssue(error) || this._isConnectivityIssue(message);
    const key = `${table || 'sync'}:${message}`;
    const now = Date.now();
    if (key === this._lastSyncErrorKey && (now - this._lastSyncErrorAt) < 15000) return;
    this._lastSyncErrorKey = key;
    this._lastSyncErrorAt = now;
    document.dispatchEvent(new CustomEvent('supabaseSyncError', {
      detail: {
        table,
        message,
        connectivityIssue,
      },
    }));
  },

  // Lets the UI react to a realtime push the instant it lands, instead of
  // waiting for the next section poll — see admin.js's 'acsDataChanged' listener.
  _notifyDataChanged(table) {
    if (typeof document === 'undefined') return;
    document.dispatchEvent(new CustomEvent('acsDataChanged', { detail: { table } }));
  },

  _getSessionSnapshotTimestamp(snapshots) {
    if (!Array.isArray(snapshots) || !snapshots.length) return 0;
    return snapshots.reduce((latest, snapshot) => {
      const time = snapshot?.timestamp ? new Date(snapshot.timestamp).getTime() : 0;
      return Number.isFinite(time) ? Math.max(latest, time) : latest;
    }, 0);
  },

  _messageListSignature(messages) {
    return JSON.stringify((Array.isArray(messages) ? messages : []).map(message => ([
      message?.id || '',
      message?.ownerAdminId || '',
      message?.professorId || '',
      message?.studentId || '',
      message?.examId || '',
      message?.sessionId || '',
      message?.senderRole || '',
      message?.type || '',
      message?.reportCategory || '',
      message?.body || '',
      message?.readAt || '',
      message?.createdAt || '',
    ])));
  },

  _mergeSessionSnapshots(priorSnapshots, incomingSnapshots) {
    const allSnapshots = [...(Array.isArray(priorSnapshots) ? priorSnapshots : []), ...(Array.isArray(incomingSnapshots) ? incomingSnapshots : [])]
      .filter(snapshot => snapshot && snapshot.imageData);
    if (!allSnapshots.length) return [];

    const byNewest = (a, b) => new Date(b?.timestamp || 0).getTime() - new Date(a?.timestamp || 0).getTime();
    const liveSnapshot = allSnapshots
      .filter(snapshot => (snapshot?.kind || 'live') === 'live')
      .sort(byNewest)[0] || null;

    const seen = new Set();
    const violationSnapshots = allSnapshots
      .filter(snapshot => snapshot?.kind === 'violation')
      .sort(byNewest)
      .filter(snapshot => {
        const key = `${snapshot.timestamp || ''}|${snapshot.violationType || ''}|${snapshot.warningCount || ''}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .slice(0, 8);

    return liveSnapshot ? [liveSnapshot, ...violationSnapshots] : violationSnapshots;
  },

  _isSessionResetState(session) {
    if (!session) return false;
    const answers = session.answers && typeof session.answers === 'object' ? Object.keys(session.answers) : [];
    const activities = Array.isArray(session.activities) ? session.activities : [];
    return !session.submitted
      && !session.startTime
      && !session.endTime
      && (session.score === null || typeof session.score === 'undefined')
      && !answers.length
      && !activities.length
      && !(session.warnings || 0);
  },

  _mergeIncomingSessionWithLocal(incoming, prior) {
    if (!prior) return incoming;

    const merged = { ...prior, ...incoming };
    if (this._isSessionResetState(incoming)) return merged;

    const priorActivities = Array.isArray(prior.activities) ? prior.activities : [];
    const incomingActivities = Array.isArray(incoming.activities) ? incoming.activities : [];
    if (priorActivities.length > incomingActivities.length) {
      merged.activities = priorActivities;
    }

    const priorWarnings = Number(prior.warnings || 0);
    const incomingWarnings = Number(incoming.warnings || 0);
    if (priorWarnings > incomingWarnings && priorActivities.length >= incomingActivities.length) {
      merged.warnings = priorWarnings;
    }

    const priorSnapshots = Array.isArray(prior.cameraSnapshots) ? prior.cameraSnapshots : [];
    const incomingSnapshots = Array.isArray(incoming.cameraSnapshots) ? incoming.cameraSnapshots : [];
    if (priorSnapshots.length || incomingSnapshots.length) {
      merged.cameraSnapshots = this._mergeSessionSnapshots(priorSnapshots, incomingSnapshots);
    }

    return merged;
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
        this._setupCrossTabSignals();
      } catch (e) {
        console.warn('[SupabaseSync] Error loading data from Supabase:', e.message || e);
        this._emitSyncError('connection', e, 'Unable to load the latest data right now.');
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
      await this._pullMessages({ ownerAdminId: admin.id });
      await this._pullExamShares({ professorId: admin.id });
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
      await this._pullMessages({ studentId: student.studentId });
      this._writeLocal('acs_exam_shares', []);
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
    await this._pullExamShares();
  },

  // Loads the in-exam chat messages visible to the current viewer: a professor
  // sees every message scoped to them (owner_admin_id), a student sees only their
  // own thread (student_id). Silently no-ops if the table isn't deployed yet.
  async _pullMessages({ ownerAdminId, studentId } = {}) {
    if (!this._client || this._messagesSupported === false) return false;
    try {
      let query = this._client.from('messages').select('*').order('created_at');
      if (ownerAdminId) query = query.eq('owner_admin_id', ownerAdminId);
      else if (studentId) query = query.eq('student_id', studentId);
      const { data, error } = await query;
      if (error) {
        if (this._isMissingMessagesTableError(error)) this._messagesSupported = false;
        return false;
      }
      const nextMessages = (data || []).map(r => this._dbToJsMessage(r));
      const currentMessages = this._localArray('acs_messages');
      const changed = this._messageListSignature(currentMessages) !== this._messageListSignature(nextMessages);
      this._writeLocal('acs_messages', nextMessages);
      if (changed) this._notifyDataChanged('messages');
      return changed;
    } catch (e) {
      if (this._isMissingMessagesTableError(e)) this._messagesSupported = false;
      return false;
    }
  },

  async _pullExamShares({ professorId } = {}) {
    if (!this._client) return;
    const { admin, sysadmin } = this._getSessions();
    const scopedProfessorId = professorId || admin?.id || null;
    if (!scopedProfessorId && !sysadmin) {
      this._writeLocal('acs_exam_shares', []);
      return;
    }
    try {
      let query = this._client.from('exam_shares').select('*').order('created_at', { ascending: false });
      if (scopedProfessorId && !sysadmin) {
        query = query.or(`sender_professor_id.eq.${scopedProfessorId},recipient_professor_id.eq.${scopedProfessorId}`);
      }
      const { data, error } = await query;
      if (error) return;
      this._writeLocal('acs_exam_shares', (data || []).map(r => this._dbToJsExamShare(r)));
    } catch {
      // The feature is optional until the exam-sharing SQL migration is applied.
    }
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
      if (!('camera_exempt_student_ids' in r)) {
        const prior = existingById.get(normalized.id);
        if (prior && Array.isArray(prior.cameraExemptStudentIds)) {
          normalized.cameraExemptStudentIds = prior.cameraExemptStudentIds;
        }
      }
      if (!('exam_policies' in r)) {
        const prior = existingById.get(normalized.id);
        if (prior && Array.isArray(prior.examPolicies)) {
          normalized.examPolicies = prior.examPolicies;
        }
      }
      if (!('object_monitoring' in r)) {
        const prior = existingById.get(normalized.id);
        if (prior?.objectMonitoring && typeof prior.objectMonitoring === 'object') {
          normalized.objectMonitoring = this._normalizeObjectMonitoring(prior.objectMonitoring);
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
      ['exam_shares', 'acs_exam_shares', r => this._jsToDbExamShare(r)],
    ];

    for (const [table, lsKey, normalizer] of seedings) {
      const items = this._localArray(lsKey);
      if (items.length) {
        let rows = items.map(normalizer);
        let { error } = await c.from(table).upsert(rows);
        while (error) {
          if (this._isMissingSessionEssayGradesError(table, error) && this._sessionEssayGradesSupported !== false) {
            this._sessionEssayGradesSupported = false;
            rows = rows.map(row => this._withoutSessionEssayGrades(row));
            ({ error } = await c.from(table).upsert(rows));
            if (!error) break;
            continue;
          }
          if (this._isMissingSessionAiDetectionsError(table, error) && this._sessionAiDetectionsSupported !== false) {
            this._sessionAiDetectionsSupported = false;
            rows = rows.map(row => this._withoutSessionAiDetections(row));
            ({ error } = await c.from(table).upsert(rows));
            if (!error) break;
            continue;
          }
          if (this._isMissingSessionCameraSnapshotsError(table, error) && this._sessionCameraSnapshotsSupported !== false) {
            this._sessionCameraSnapshotsSupported = false;
            rows = rows.map(row => this._withoutSessionCameraSnapshots(row));
            ({ error } = await c.from(table).upsert(rows));
            if (!error) break;
            continue;
          }
          if (this._isMissingExamCameraExemptError(table, error) && this._examCameraExemptSupported !== false) {
            this._examCameraExemptSupported = false;
            rows = rows.map(row => this._withoutExamCameraExempt(row));
            ({ error } = await c.from(table).upsert(rows));
            if (!error) break;
            continue;
          }
          if (this._isMissingExamPoliciesError(table, error) && this._examPoliciesSupported !== false) {
            this._examPoliciesSupported = false;
            rows = rows.map(row => this._withoutExamPolicies(row));
            ({ error } = await c.from(table).upsert(rows));
            if (!error) break;
            continue;
          }
          if (this._isMissingExamExcludedStudentIdsError(table, error)) {
            rows.forEach(row => this._examIdsWithUnsyncedExclusions.add(row.id));
            rows = rows.map(row => this._withoutExamExcludedStudentIds(row));
            ({ error } = await c.from(table).upsert(rows));
          }
          break;
        }
        if (error) console.warn(`[SupabaseSync] seed ${table}:`, error.message);
      }
    }
  },

  // ── Realtime listeners ─────────────────────────────────────
  _setupListeners() {
    const c = this._client;
    if (this._channel) return;
    const { admin, sysadmin, student } = this._getSessions();
    const ownerFilter = admin?.id && !sysadmin ? `owner_admin_id=eq.${admin.id}` : null;
    const professorFilter = admin?.id && !sysadmin ? `id=eq.${admin.id}` : null;
    // Chat is 1:1: a professor listens to every message scoped to them; a student
    // listens only to their own thread. Both use a single-column Realtime filter.
    const messagesFilter = admin?.id && !sysadmin
      ? `owner_admin_id=eq.${admin.id}`
      : (student?.studentId && !sysadmin ? `student_id=eq.${student.studentId}` : null);

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
      if (table === 'exam_shares' && admin?.id && !sysadmin) {
        if (eventType === 'DELETE') {
          this._writeLocal(lsKey, current.filter(r => r.id !== old.id));
          this._notifyDataChanged(table);
          return;
        }
        const visible = row?.sender_professor_id === admin.id || row?.recipient_professor_id === admin.id;
        if (!visible) {
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
        // Same protection for cameraExemptStudentIds (webcam exemption toggle from the
        // in-exam chat) — without this, a realtime echo from a pre-migration schema
        // would silently wipe the exemption back to [] right after it was set, which
        // looked like the "Re-enable webcam" toggle not sticking.
        if (table === 'exams' && row && !('camera_exempt_student_ids' in row)) {
          const prior = current.find(r => r.id === normalized.id);
          if (prior && Array.isArray(prior.cameraExemptStudentIds)) {
            normalized.cameraExemptStudentIds = prior.cameraExemptStudentIds;
          }
        }
        if (table === 'exams' && row && !('exam_policies' in row)) {
          const prior = current.find(r => r.id === normalized.id);
          if (prior && Array.isArray(prior.examPolicies)) {
            normalized.examPolicies = prior.examPolicies;
          }
        }
        if (table === 'exams' && row && !('object_monitoring' in row)) {
          const prior = current.find(r => r.id === normalized.id);
          if (prior?.objectMonitoring && typeof prior.objectMonitoring === 'object') {
            normalized.objectMonitoring = this._normalizeObjectMonitoring(prior.objectMonitoring);
          }
        }
        const nextRow = table === 'sessions'
          ? this._mergeIncomingSessionWithLocal(normalized, current.find(r => r.id === normalized.id))
          : normalized;
        const idx = current.findIndex(r => r.id === nextRow.id);
        if (idx >= 0) { current[idx] = nextRow; this._writeLocal(lsKey, current); }
        else { this._writeLocal(lsKey, [...current, nextRow]); }
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
      .on('postgres_changes', { event: '*', schema: 'public', table: 'messages', ...(messagesFilter ? { filter: messagesFilter } : {}) },
        applyChange('messages', 'acs_messages', r => this._dbToJsMessage(r)))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'exam_shares' },
        applyChange('exam_shares', 'acs_exam_shares', r => this._dbToJsExamShare(r)))
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

  async refreshExamShares() {
    await this._pullExamShares();
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
      const localSessions = this._localArray('acs_sessions');
      const localById = new Map(localSessions.map(session => [session.id, session]));
      const mergedSessions = sessions.map(row => {
        const normalized = this._dbToJsSession(row);
        return this._mergeIncomingSessionWithLocal(normalized, localById.get(normalized.id));
      });
      this._writeLocal('acs_sessions', mergedSessions);
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
      if (!ownRow) {
        this._writeLocal('acs_students', []);
        return;
      }

      let classmates = [ownRow];
      if (enrolledSubjectIds.length) {
        // enrolled_subjects is jsonb, so PostgREST's overlap operator is unreliable
        // here. Use one containment clause per subject and explicitly include the
        // current student so the portal never "loses" its own account record.
        const subjectClauses = enrolledSubjectIds.map(id => `enrolled_subjects.cs.["${id}"]`);
        const { data } = await this._client
          .from('students')
          .select(cols)
          .or([`student_id.eq.${student.studentId}`, ...subjectClauses].join(','));
        if (Array.isArray(data) && data.length) classmates = data;
      }

      const uniqueRows = Array.from(new Map(
        [ownRow, ...classmates].map(row => [row.id, row])
      ).values());
      this._writeLocal('acs_students', uniqueRows.map(r => this._dbToJsStudent(r)));
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
      .then(({ error }) => {
        if (!error) return;
        console.error('[SupabaseSync] logProfessorActivity:', error.message);
        this._emitSyncError('professor_activity_log', error, 'Unable to sync professor activity right now.');
      })
      .catch((error) => {
        console.error('[SupabaseSync] logProfessorActivity:', error.message || error);
        this._emitSyncError('professor_activity_log', error, 'Unable to sync professor activity right now.');
      });
  },

  // ── Write helpers ───────────────────────────────────────────

  syncSettings(data) {
    if (!this._client) return;
    this._client.from('settings').upsert(this._jsToDbSettings(data))
      .then(({ error }) => {
        if (!error) return;
        console.error('[SupabaseSync] syncSettings:', error.message);
        this._emitSyncError('settings', error, 'Unable to save settings online right now.');
      })
      .catch((error) => {
        console.error('[SupabaseSync] syncSettings:', error.message || error);
        this._emitSyncError('settings', error, 'Unable to save settings online right now.');
      });
  },

  syncSysAdmin(data) {
    if (!this._client) return;
    this._client.from('superadmin').upsert(this._jsToDbSysAdmin(data))
      .then(({ error }) => {
        if (!error) return;
        console.error('[SupabaseSync] syncSysAdmin:', error.message);
        this._emitSyncError('superadmin', error, 'Unable to save the administrator profile online right now.');
      })
      .catch((error) => {
        console.error('[SupabaseSync] syncSysAdmin:', error.message || error);
        this._emitSyncError('superadmin', error, 'Unable to save the administrator profile online right now.');
      });
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
    if (table === 'messages' && this._messagesSupported === false) return;
    const row = this._jsToDb(table, data);
    if (!row) return;
    this._enqueueDocSync(table, data.id, async () => {
      try {
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

        let retryRow = row;
        let retryError = error;
        while (retryError) {
          if (this._isMissingSessionEssayGradesError(table, retryError) && this._sessionEssayGradesSupported !== false) {
            this._sessionEssayGradesSupported = false;
            retryRow = this._withoutSessionEssayGrades(retryRow);
            ({ error: retryError } = await this._client.from(table).upsert(retryRow, { onConflict: 'id' }));
            if (!retryError) return;
            continue;
          }
          if (this._isMissingSessionAiDetectionsError(table, retryError) && this._sessionAiDetectionsSupported !== false) {
            this._sessionAiDetectionsSupported = false;
            retryRow = this._withoutSessionAiDetections(retryRow);
            ({ error: retryError } = await this._client.from(table).upsert(retryRow, { onConflict: 'id' }));
            if (!retryError) return;
            continue;
          }
          if (this._isMissingSessionCameraSnapshotsError(table, retryError) && this._sessionCameraSnapshotsSupported !== false) {
            this._sessionCameraSnapshotsSupported = false;
            retryRow = this._withoutSessionCameraSnapshots(retryRow);
            ({ error: retryError } = await this._client.from(table).upsert(retryRow, { onConflict: 'id' }));
            if (!retryError) return;
            continue;
          }
          if (this._isMissingExamCameraExemptError(table, retryError) && this._examCameraExemptSupported !== false) {
            this._examCameraExemptSupported = false;
            retryRow = this._withoutExamCameraExempt(retryRow);
            ({ error: retryError } = await this._client.from(table).upsert(retryRow, { onConflict: 'id' }));
            if (!retryError) return;
            continue;
          }
          if (this._isMissingExamPoliciesError(table, retryError) && this._examPoliciesSupported !== false) {
            this._examPoliciesSupported = false;
            retryRow = this._withoutExamPolicies(retryRow);
            ({ error: retryError } = await this._client.from(table).upsert(retryRow, { onConflict: 'id' }));
            if (!retryError) return;
            continue;
          }
          if (this._isMissingExamObjectMonitoringError(table, retryError) && this._examObjectMonitoringSupported !== false) {
            this._examObjectMonitoringSupported = false;
            retryRow = this._withoutExamObjectMonitoring(retryRow);
            ({ error: retryError } = await this._client.from(table).upsert(retryRow, { onConflict: 'id' }));
            if (!retryError) return;
            continue;
          }
          break;
        }
        error = retryError;

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

        if (error && table === 'messages' && this._isMissingMessagesTableError(error)) {
          // Chat table not deployed on this database yet — disable messaging quietly
          // instead of nagging the professor/student with sync-error toasts.
          this._messagesSupported = false;
          console.warn('[SupabaseSync] messages table not found — in-exam chat disabled until schema-bootstrap.sql is applied.');
          return;
        }

        if (error) {
          console.error(`[SupabaseSync] syncDoc(${table}):`, error.message);
          // Surface sync failures as a visible warning
          this._emitSyncError(table, error);
        }
      } catch (error) {
        if (table === 'messages' && this._isMissingMessagesTableError(error)) {
          this._messagesSupported = false;
          console.warn('[SupabaseSync] messages table not found — in-exam chat disabled until schema-bootstrap.sql is applied.');
          return;
        }
        console.error(`[SupabaseSync] syncDoc(${table}):`, error.message || error);
        this._emitSyncError(table, error);
      }
    });
  },

  async deleteDoc(table, id) {
    if (!this._client || !id) return;
    try {
      const { error } = await this._client.from(table).delete().eq('id', id);
      if (!error) return;
      console.error(`[SupabaseSync] deleteDoc(${table}):`, error.message);
      this._emitSyncError(table, error);
      throw error;
    } catch (error) {
      console.error(`[SupabaseSync] deleteDoc(${table}):`, error.message || error);
      this._emitSyncError(table, error);
      throw error;
    }
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
    const manageAccess = String(d.manageAccess || '').trim().toLowerCase() === 'everyone' ? 'everyone' : 'restrict';
    return {
      id: d.id,
      code: d.code,
      name: d.name,
      description: d.description || null,
      year_level: yearLevels.length ? yearLevels.join(', ') : (d.yearLevel || null),
      sections: Array.isArray(d.sections) ? d.sections : [],
      school_year: d.schoolYear || null,
      enrollment_code: d.enrollmentCode || null,
      manage_access: manageAccess,
      color: typeof d.courseColor === 'number' ? String(d.courseColor) : (d.color || null),
      owner_admin_id: d.ownerAdminId || null,
      archived: !!d.archived,
      archived_at: d.archivedAt || null,
    };
  },

  _jsToDbExam(d) {
    const normalizedCode = String(d.code || '').trim().toUpperCase();
    const row = {
      id: d.id,
      subject_id: d.subjectId,
      title: d.title,
      description: d.description || null,
      time_limit: d.timeLimit || 60,
      code: normalizedCode || null,
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
    if (this._examPoliciesSupported !== false) {
      row.exam_policies = Array.isArray(d.examPolicies)
        ? d.examPolicies.map(policy => String(policy ?? '').trim()).filter(Boolean)
        : [];
    }
    if (this._examCameraExemptSupported !== false) {
      row.camera_exempt_student_ids = Array.isArray(d.cameraExemptStudentIds) ? d.cameraExemptStudentIds : [];
    }
    if (this._examObjectMonitoringSupported !== false) {
      row.object_monitoring = {
        ...this._normalizeObjectMonitoring(d.objectMonitoring),
        enabled: !!d.requireCamera,
      };
    }
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
      submit_reason: d.submitReason || null,
      score_released: !!d.scoreReleased,
      camera_snapshots: Array.isArray(d.cameraSnapshots) ? d.cameraSnapshots : [],
      owner_admin_id: d.ownerAdminId || null,
    };
    if (this._sessionCameraSnapshotsSupported === false) {
      delete row.camera_snapshots;
    }
    if (this._sessionEssayGradesSupported !== false) {
      row.essay_grades = d.essayGrades || {};
    }
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

  _jsToDbMessage(d) {
    return {
      id: d.id,
      owner_admin_id: d.ownerAdminId || null,
      professor_id: d.professorId || null,
      student_id: d.studentId || null,
      exam_id: d.examId || null,
      session_id: d.sessionId || null,
      sender_role: d.senderRole || 'student',
      type: d.type || 'message',
      report_category: d.reportCategory || null,
      body: d.body || null,
      read_at: d.readAt || null,
    };
  },

  _jsToDbExamShare(d) {
    return {
      id: d.id,
      exam_id: d.examId || null,
      sender_professor_id: d.senderProfessorId || null,
      sender_professor_name: d.senderProfessorName || null,
      sender_email: d.senderEmail || null,
      recipient_professor_id: d.recipientProfessorId || null,
      recipient_professor_name: d.recipientProfessorName || null,
      recipient_email: d.recipientEmail || null,
      source_subject_id: d.sourceSubjectId || null,
      source_subject_code: d.sourceSubjectCode || null,
      source_subject_name: d.sourceSubjectName || null,
      exam_title: d.examTitle || null,
      share_mode: d.shareMode || 'clone_exam',
      message: d.message || null,
      status: d.status || 'pending',
      decline_reason: d.declineReason || null,
      recipient_seen_at: d.recipientSeenAt || null,
      responded_at: d.respondedAt || null,
      accepted_exam_id: d.acceptedExamId || null,
      accepted_subject_id: d.acceptedSubjectId || null,
      snapshot: d.snapshot && typeof d.snapshot === 'object' ? d.snapshot : {},
      created_at: d.createdAt || null,
      updated_at: d.updatedAt || null,
    };
  },

  _dbToJsMessage(r) {
    return {
      id: r.id,
      ownerAdminId: r.owner_admin_id || '',
      professorId: r.professor_id || '',
      studentId: r.student_id || '',
      examId: r.exam_id || '',
      sessionId: r.session_id || '',
      senderRole: r.sender_role || 'student',
      type: r.type || 'message',
      reportCategory: r.report_category || '',
      body: r.body || '',
      readAt: r.read_at || null,
      createdAt: r.created_at || null,
    };
  },

  _dbToJsExamShare(r) {
    return {
      id: r.id,
      examId: r.exam_id || '',
      senderProfessorId: r.sender_professor_id || '',
      senderProfessorName: r.sender_professor_name || '',
      senderEmail: r.sender_email || '',
      recipientProfessorId: r.recipient_professor_id || '',
      recipientProfessorName: r.recipient_professor_name || '',
      recipientEmail: r.recipient_email || '',
      sourceSubjectId: r.source_subject_id || '',
      sourceSubjectCode: r.source_subject_code || '',
      sourceSubjectName: r.source_subject_name || '',
      examTitle: r.exam_title || '',
      shareMode: r.share_mode || 'clone_exam',
      message: r.message || '',
      status: r.status || 'pending',
      declineReason: r.decline_reason || '',
      recipientSeenAt: r.recipient_seen_at || null,
      respondedAt: r.responded_at || null,
      acceptedExamId: r.accepted_exam_id || '',
      acceptedSubjectId: r.accepted_subject_id || '',
      snapshot: r.snapshot && typeof r.snapshot === 'object' ? r.snapshot : {},
      createdAt: r.created_at || null,
      updatedAt: r.updated_at || null,
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
      case 'messages': return this._jsToDbMessage(data);
      case 'exam_shares': return this._jsToDbExamShare(data);
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
    const manageAccess = String(r.manage_access || '').trim().toLowerCase() === 'everyone' ? 'everyone' : 'restrict';
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
      manageAccess,
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
      code: r.code || '',
      status: r.status,
      shuffleQuestions: !!r.shuffle_questions,
      shuffleAnswers: !!r.shuffle_answers,
      requireCamera: !!r.require_camera,
      requireAIDetection: !!r.require_ai_detection,
      allowReview: !!r.allow_review,
      scoringReleased: !!r.scoring_released,
      questions: Array.isArray(r.questions) ? r.questions : [],
      examPolicies: Array.isArray(r.exam_policies) ? r.exam_policies.map(policy => String(policy ?? '').trim()).filter(Boolean) : [],
      targetYearLevels: Array.isArray(r.target_year_levels) ? r.target_year_levels : [],
      targetSections: Array.isArray(r.target_sections) ? r.target_sections : [],
      excludedStudentIds: Array.isArray(r.excluded_student_ids) ? r.excluded_student_ids : [],
      cameraExemptStudentIds: Array.isArray(r.camera_exempt_student_ids) ? r.camera_exempt_student_ids : [],
      objectMonitoring: {
        ...this._normalizeObjectMonitoring(r.object_monitoring),
        enabled: !!r.require_camera,
      },
      ownerAdminId: r.owner_admin_id || '',
      startedAt: r.started_at || null,
      closedAt: r.closed_at || null,
      createdAt: r.created_at || null,
    };
  },

  _dbToJsSession(r) {
    const localSession = this._localArray('acs_sessions').find(session => session.id === r.id);
    const essayGrades = ('essay_grades' in r && this._sessionEssayGradesSupported !== false)
      ? this._normalizeSessionEssayGrades(r.essay_grades)
      : this._normalizeSessionEssayGrades(localSession?.essayGrades);
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
      submitReason: r.submit_reason || null,
      scoreReleased: !!r.score_released,
      essayGrades,
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

  _normalizeSessionEssayGrades(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  },

  _isMissingSessionEssayGradesError(table, error) {
    const message = String(error?.message || '');
    return table === 'sessions' && message.includes(`Could not find the 'essay_grades' column`);
  },

  _withoutSessionEssayGrades(row) {
    const next = { ...row };
    delete next.essay_grades;
    return next;
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

  _isMissingSessionCameraSnapshotsError(table, error) {
    const message = String(error?.message || '');
    return table === 'sessions' && message.includes(`Could not find the 'camera_snapshots' column`);
  },

  _withoutSessionCameraSnapshots(row) {
    const next = { ...row };
    delete next.camera_snapshots;
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

  _isMissingExamCameraExemptError(table, error) {
    const message = String(error?.message || '');
    return table === 'exams' && message.includes(`Could not find the 'camera_exempt_student_ids' column`);
  },

  _withoutExamCameraExempt(row) {
    const next = { ...row };
    delete next.camera_exempt_student_ids;
    return next;
  },

  _isMissingExamPoliciesError(table, error) {
    const message = String(error?.message || '');
    return table === 'exams' && message.includes(`Could not find the 'exam_policies' column`);
  },

  _withoutExamPolicies(row) {
    const next = { ...row };
    delete next.exam_policies;
    return next;
  },

  _isMissingExamObjectMonitoringError(table, error) {
    const message = String(error?.message || '');
    return table === 'exams' && message.includes(`Could not find the 'object_monitoring' column`);
  },

  _withoutExamObjectMonitoring(row) {
    const next = { ...row };
    delete next.object_monitoring;
    return next;
  },

  _isMissingMessagesTableError(error) {
    const message = String(error?.message || '').toLowerCase();
    return message.includes('messages') && (message.includes('does not exist') || message.includes('could not find the table') || message.includes('schema cache'));
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

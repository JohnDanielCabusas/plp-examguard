// ============================================================
// EXAM APP - Student Exam Logic
// ============================================================

const ENROLL_STATUS_ICONS = {
  info: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>',
  success: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>',
  error: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>',
};
function setEnrollStatus(el, text, variant, options = {}) {
  if (!el) return;
  if (el._statusTimer) {
    clearTimeout(el._statusTimer);
    el._statusTimer = null;
  }
  if (!text) { el.className = 'enroll-status'; el.innerHTML = ''; return; }
  el.className = `enroll-status ${variant}`;
  el.innerHTML = `${ENROLL_STATUS_ICONS[variant] || ENROLL_STATUS_ICONS.info}<span>${_esc(text)}</span>`;
  if (options.autoClearMs) {
    const expectedText = text;
    el._statusTimer = setTimeout(() => {
      if (el.textContent && el.textContent.includes(expectedText)) {
        setEnrollStatus(el, '', variant);
      }
    }, options.autoClearMs);
  }
}

const EXAM_EXTERNAL_ASSETS = new Map();

function loadExamScript(src) {
  if (EXAM_EXTERNAL_ASSETS.has(src)) return EXAM_EXTERNAL_ASSETS.get(src);
  const promise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error(`Unable to load ${src}`));
    document.head.appendChild(script);
  }).catch(error => {
    EXAM_EXTERNAL_ASSETS.delete(src);
    throw error;
  });
  EXAM_EXTERNAL_ASSETS.set(src, promise);
  return promise;
}

function loadExamStylesheet(href) {
  if (EXAM_EXTERNAL_ASSETS.has(href)) return EXAM_EXTERNAL_ASSETS.get(href);
  const promise = new Promise((resolve, reject) => {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = href;
    link.onload = () => resolve();
    link.onerror = () => reject(new Error(`Unable to load ${href}`));
    document.head.appendChild(link);
  }).catch(error => {
    EXAM_EXTERNAL_ASSETS.delete(href);
    throw error;
  });
  EXAM_EXTERNAL_ASSETS.set(href, promise);
  return promise;
}

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
  _examRuntimeStarted: false,
  _pendingReviewReopen: false,
  _blurTimer: null,         // debounce timer for window blur
  _visTimer: null,          // grace timer for tab-hidden (visibilitychange)
  _fsLossTimer: null,       // grace timer for fullscreen-exit — forgives transient display blips (e.g. brightness/HDR re-sync)
  _countdownInterval: null, // 10-second return-window countdown
  _warningReadTimer: null,  // 3-second read timer after student returns
  _inReadCountdown: false,  // true while the 3-second read overlay is showing
  _lastWarningTime: null,
  _warningCountdownTimer: null,
  _warningCountdownToken: 0,
  _warningCountdownDeadline: 0,
  _warningCountdownTotalSeconds: 0,
  _warningCountdownMode: null, // 'focus' | 'read' | 'info'
  _cameraStream: null,      // MediaStream from camera
  _snapInterval: null,      // periodic snapshot interval
  _violationClipRecorders: [],
  _violationClipSpawnTimer: null,
  _violationClipMimeType: '',
  _violationClipChunkMs: 1000,
  _violationClipSegmentMs: 10000,
  _violationClipOverlapMs: 5000,
  _cameraPrompting: false,  // true while camera permission dialog is open
  _motionInterval: null,    // motion detection interval
  _prevFrameData: null,
  _slowFrameData: null,
  _slowFrameCount: 0,
  _noMotionSec: 0,
  _MOTION_THRESHOLD: 10,
  _PRESENCE_THRESHOLD: 5,
  _NO_MOTION_WARN: 10,
  _NO_PERSON_GRACE_SEC: 2,
  _FACE_PRESENCE_CONFIRM_SEC: 1.2,
  _MULTIPLE_FACE_WARN_SEC: 3,
  _MULTIPLE_FACE_CONFIRM_SEC: 1.2,
  _LOOK_DOWN_WARN_SEC: 10,
  _LOOK_DOWN_CONFIRM_SEC: 1.2,
  _faceModel: null,
  _faceModelReady: false,
  _faceModelPromise: null,
  _codeEditorRuntimePromise: null,
  _faceDetectInFlight: false,
  _yoloMonitor: null,
  _yoloPhoneMonitor: null,
  _yoloPhoneStatus: null,
  _yoloPolicy: null,
  _yoloStatus: 'idle',
  _yoloStatusDetail: null,
  _yoloDetectedUntil: 0,
  _lastYoloResult: null,
  _yoloConfigSignature: '',
  _yoloPreloadPromise: null,
  _yoloStarting: false,
  _yoloStartGeneration: 0,
  _motionBlocked: false,    // true if exam is blocked due to no person detected
  _presenceConfirmSec: 0,
  _lastPresenceSeenAt: 0,
  _multipleFaceSeconds: 0,
  _multipleFaceWarningIssued: false,
  _secondaryFaceTrack: null,
  _lookDownSeconds: 0,
  _lookDownConfirmSeconds: 0,
  _lookDownWarningIssued: false,
  _facePoseBaseline: null,
  _facePoseBaselineSamples: 0,
  _latestFaceContext: null,
  _lastCameraDetectAt: 0,
  _brightnessBaseline: null, // luminance baseline recorded at exam start
  _darkSeconds: 0,           // consecutive seconds below brightness threshold
  _brightnessWarningIssued: false, // prevent repeated brightness warnings
  _MIN_LUMINANCE: 50,        // absolute minimum camera luminance (0–255) — below this the display is too dark for the professor to see
  _LOW_LIGHT_PROMPT_SEC: 3,  // seconds below minimum before the "turn up brightness" prompt appears
  _LOW_LIGHT_WARN_SEC: 20,   // seconds below minimum before a formal warning is issued
  _lowLightSeconds: 0,       // consecutive seconds below the absolute minimum
  _lowLightWarningIssued: false, // prevent repeated low-light strike warnings
  _BLACK_FRAME_LUMINANCE: 8, // nearly-black camera feed threshold; usually means the lens is covered or blocked
  _cameraObstructed: false,  // true when the stream is live but the camera view is fully blacked out
  _cameraObstructedSeconds: 0, // consecutive seconds of near-black camera frames
  _cameraWatchdog: null,     // interval verifying the camera stream stays live
  _cameraOffSeconds: 0,      // consecutive seconds with the webcam off/blocked
  _cameraOffWarningIssued: false, // prevent repeated camera-off strike warnings
  _cameraReacquiring: false, // true while attempting to re-open the camera
  _cameraRecoveryGraceUntil: 0, // short grace window after reacquiring before declaring the camera fully restored
  _CAMERA_OFF_WARN_SEC: 10,  // seconds with the camera off before a formal warning
  _brightnessCheckRound: 0,  // perceptual check: consecutive correct rounds
  _brightnessCheckFails: 0,  // perceptual check: failed attempts
  _brightnessCheckAnswer: null, // index of the tile holding the symbol
  _chatPollTimer: null,
  _sessionSyncTimer: null,
  _dashInterval: null,      // dashboard poll interval
  _courseInterval: null,    // course-view exams poll interval
  _fullscreenInteractionGraceUntil: 0,
  _pendingFullscreenRecovery: null,
  _fullscreenVerifyTimer: null,
  _fullscreenLockTimer: null,
  _fullscreenLockToken: 0,
  _fullscreenLockDeadline: 0,
  _fullscreenLockTotalSeconds: 0,
  _recentClipboardShortcut: null,
  _intentionalFullscreenExit: false,
  // ── Connectivity monitor ──
  _connectionState: 'online', // 'online' | 'weak' | 'offline'
  _connFailStreak: 0,         // consecutive failed probes (debounces flapping before declaring offline)
  _connCheckInterval: null,
  _connOnlineHandler: null,
  _connOfflineHandler: null,
  _CONN_PROBE_MS: 6000,       // how often to probe while the tab is open
  _CONN_TIMEOUT_MS: 4000,     // probe request timeout
  _CONN_WEAK_MS: 1500,        // probe latency above this = "weak" signal
  _pendingManualSubmit: false, // true if the student tried to submit while offline
  _refreshUnloadHandler: null,
  _refreshPageHideHandler: null,
  _refreshUnloadCleanupTimer: null,
  _portalDataChangedTimer: null,
  _remoteForceSubmitSessionId: null,
  _pendingCameraRequirementNotice: null,
  _lastHandledWebcamDecisionId: null,
  _REFRESH_AUTO_SUBMIT_KEY: 'acs_exam_refresh_auto_submit',

  _repairStudentEmail(studentSession) {
    if (!studentSession?.studentId || !studentSession?.email) return;
    DB.ensureStudentEmailInSupabase({
      studentId: studentSession.studentId,
      email: studentSession.email,
    }).catch(error => {
      console.warn('[Supabase] Unable to repair student email:', error.message || error);
    });
  },

  _calculateScoreFor(exam, answers = {}) {
    let earned = 0;
    let max = 0;
    const questions = exam ? (exam.questions || []) : [];

    for (const q of questions) {
      max += q.points;
      if (q.type === 'essay') continue;

      const ans = answers[q.id];
      if (!ans || ans.toString().trim() === '') continue;

      if (q.type === 'enumeration') {
        const expected = (q.answers || []).map(a => a.toUpperCase());
        const given = ans.split('\n').map(s => s.trim().toUpperCase()).filter(Boolean);
        const correct = expected.filter(e => given.includes(e)).length;
        if (q.partialScoring === false) {
          if (correct === expected.length) earned += q.points;
        } else {
          earned += expected.length > 0 ? Math.round((correct / expected.length) * q.points) : 0;
        }
      } else if (q.type === 'matching') {
        const pairs = q.pairs || [];
        let studentAns = {};
        try { studentAns = JSON.parse(ans); } catch {}
        const correct = pairs.filter((p, i) => (studentAns[i] || '').toUpperCase() === p.match.toUpperCase()).length;
        earned += pairs.length > 0 ? Math.round((correct / pairs.length) * q.points) : 0;
      } else if (q.type === 'checkbox') {
        let given = [];
        try { given = JSON.parse(ans) || []; } catch {}
        const correct = (q.correctAnswerIndices || []).slice().sort((a, b) => a - b);
        const sortedGiven = given.slice().sort((a, b) => a - b);
        const exactMatch = correct.length === sortedGiven.length && correct.every((v, i) => v === sortedGiven[i]);
        if (exactMatch) earned += q.points;
      } else {
        const studentAns = ans.toString().trim().toUpperCase();
        const correctAns = (q.correctAnswer || '').toString().trim().toUpperCase();
        if (studentAns === correctAns) earned += q.points;
      }
    }

    return { earned, max };
  },

  _disableRefreshProtection() {
    if (this._refreshUnloadHandler) {
      window.removeEventListener('beforeunload', this._refreshUnloadHandler);
      this._refreshUnloadHandler = null;
    }
    if (this._refreshPageHideHandler) {
      window.removeEventListener('pagehide', this._refreshPageHideHandler);
      this._refreshPageHideHandler = null;
    }
    if (this._refreshUnloadCleanupTimer) {
      clearTimeout(this._refreshUnloadCleanupTimer);
      this._refreshUnloadCleanupTimer = null;
    }
    try { sessionStorage.removeItem(this._REFRESH_AUTO_SUBMIT_KEY); } catch (_) {}
  },

  _buildRefreshAutoSubmitMarker() {
    const liveSession = this.session ? DB.getSession(this.session.id) : null;
    if (!this.exam || !liveSession || liveSession.submitted) return null;

    return {
      examId: this.exam.id,
      studentId: liveSession.studentId,
      sessionId: liveSession.id,
      timestamp: Date.now(),
      answers: { ...(this.answers || {}) },
      warnings: this.warnings || 0,
      session: {
        ...liveSession,
        answers: { ...(this.answers || {}) },
        warnings: this.warnings || 0,
      },
    };
  },

  _applyRefreshAutoSubmitMarker(marker) {
    if (!marker) return null;

    const exam = marker.examId ? DB.getExam(marker.examId) : null;
    let liveSession = marker.sessionId ? DB.getSession(marker.sessionId) : null;
    if (!liveSession && marker.examId && marker.studentId) {
      liveSession = DB.getStudentSession(marker.examId, marker.studentId);
    }
    const baseSession = liveSession || marker.session;
    if (!baseSession) return null;
    if (baseSession.submitted) return { exam, session: baseSession };

    const answers = marker.answers || baseSession.answers || {};
    const score = this._calculateScoreFor(exam, answers);
    const nextSession = {
      ...baseSession,
      answers,
      warnings: marker.warnings ?? baseSession.warnings ?? 0,
      submitted: true,
      autoSubmitted: true,
      submitReason: 'refresh',
      endTime: new Date().toISOString(),
      score: score.earned,
      maxScore: score.max || baseSession.maxScore || 0,
    };

    if (liveSession) {
      DB.updateSession(liveSession.id, nextSession);
    } else if (DB?.KEYS?.sessions && typeof DB._read === 'function' && typeof DB._write === 'function') {
      const sessions = [...DB._read(DB.KEYS.sessions, [])];
      const existingIndex = sessions.findIndex(s => s.id === nextSession.id);
      if (existingIndex >= 0) sessions[existingIndex] = nextSession;
      else sessions.push(nextSession);
      DB._write(DB.KEYS.sessions, sessions);
      window.SupabaseSync?.syncDoc?.('sessions', nextSession);
    }

    if (nextSession.id && exam?.id) {
      DB.addLog({
        sessionId: nextSession.id,
        studentId: nextSession.studentId,
        examId: exam.id,
        type: 'refresh_submit',
        details: 'Auto-submitted: exam page refresh or reload was confirmed',
      });
    }

    return { exam, session: nextSession };
  },

  _enableRefreshProtection() {
    if (this._refreshUnloadHandler) return;
    this._refreshUnloadHandler = (event) => {
      const marker = this._buildRefreshAutoSubmitMarker();
      if (!marker) return;

      try { sessionStorage.setItem(this._REFRESH_AUTO_SUBMIT_KEY, JSON.stringify(marker)); } catch (_) {}
      if (this._refreshUnloadCleanupTimer) clearTimeout(this._refreshUnloadCleanupTimer);
      this._refreshUnloadCleanupTimer = setTimeout(() => {
        try { sessionStorage.removeItem(this._REFRESH_AUTO_SUBMIT_KEY); } catch (_) {}
        this._refreshUnloadCleanupTimer = null;
      }, 1500);

      event.preventDefault();
      event.returnValue = 'Refreshing this exam will auto-submit your answers.';
      return event.returnValue;
    };
    window.addEventListener('beforeunload', this._refreshUnloadHandler);
    this._refreshPageHideHandler = () => {
      let marker = null;
      try { marker = JSON.parse(sessionStorage.getItem(this._REFRESH_AUTO_SUBMIT_KEY) || 'null'); } catch (_) {}
      if (!marker) return;
      this._applyRefreshAutoSubmitMarker(marker);
    };
    window.addEventListener('pagehide', this._refreshPageHideHandler);
  },

  _consumePendingRefreshAutoSubmit(studentSession) {
    let marker = null;
    try { marker = JSON.parse(sessionStorage.getItem(this._REFRESH_AUTO_SUBMIT_KEY) || 'null'); } catch (_) {}
    if (!marker) return null;
    try { sessionStorage.removeItem(this._REFRESH_AUTO_SUBMIT_KEY); } catch (_) {}

    if (!studentSession?.studentId) return null;
    if (marker.studentId && marker.studentId !== studentSession.studentId) return null;
    if (marker.timestamp && Date.now() - marker.timestamp > 120000) return null;
    return this._applyRefreshAutoSubmitMarker(marker);
  },

  _recordActivity(type, detail, metadata = null) {
    if (!this.session) return null;
    const session = DB.getSession(this.session.id);
    if (!session) return null;

    const activity = {
      type,
      detail,
      timestamp: new Date().toISOString(),
    };
    if (metadata && typeof metadata === 'object') activity.metadata = metadata;
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

  _notifyProfessorViolation(type, detail, warningCount, detectionMetadata = null) {
    if (!this.session?.id || !this.exam?.id) return Promise.resolve(null);

    const payload = {
      sessionId: this.session.id,
      examId: this.exam.id,
      studentId: this.session.studentId || '',
      studentName: this.session.studentName || '',
      violationType: type,
      detail,
      warningCount: Number(warningCount || 0),
    };
    if (detectionMetadata && typeof detectionMetadata === 'object') {
      payload.detectionMetadata = detectionMetadata;
    }

    return fetch('/api/monitor/violation', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      keepalive: true,
    }).then(async (response) => {
      if (response.ok) {
        const data = await response.json().catch(() => ({}));
        return data?.violation || null;
      }
      let message = '';
      try {
        const data = await response.json();
        message = data?.message || '';
      } catch (_) {}
      console.warn('[Monitor] Violation notify failed:', response.status, message || 'Unknown server error');
      return null;
    }).catch((error) => {
      console.warn('[Monitor] Unable to notify professor about violation:', error?.message || error);
      return null;
    });
  },

  _isCameraViolationType(type) {
    return [
      'no_person',
      'multiple_people',
      'look_down',
      'low_brightness',
      'camera_off',
      'restricted_phone',
      'secondary_computer',
      'restricted_book',
    ].includes(type);
  },

  _isReplayableCameraViolationType(type) {
    return this._isCameraViolationType(type);
  },

  _startViolationReplayBuffer() {
    this._stopViolationReplayBuffer();
    if (!this._cameraStream || typeof MediaRecorder === 'undefined') return;

    const mimeCandidates = ['video/webm;codecs=vp8', 'video/webm'];
    let mimeType = '';
    mimeCandidates.some((candidate) => {
      if (typeof MediaRecorder.isTypeSupported === 'function' && !MediaRecorder.isTypeSupported(candidate)) return false;
      mimeType = candidate;
      return true;
    });

    this._violationClipMimeType = mimeType;
    this._violationClipRecorders = [];

    try {
      this._startViolationReplaySegment();
      this._violationClipSpawnTimer = setInterval(
        () => {
          try {
            this._startViolationReplaySegment();
          } catch (error) {
            console.warn('[Monitor] Unable to rotate violation replay buffer:', error?.message || error);
          }
        },
        this._violationClipOverlapMs,
      );
    } catch (error) {
      console.warn('[Monitor] Unable to start violation replay buffer:', error?.message || error);
      if (this._violationClipSpawnTimer) clearInterval(this._violationClipSpawnTimer);
      this._violationClipSpawnTimer = null;
      this._violationClipMimeType = '';
      this._violationClipRecorders = [];
    }
  },

  _startViolationReplaySegment() {
    if (!this._cameraStream?.active || typeof MediaRecorder === 'undefined') return null;

    const recorder = this._violationClipMimeType
      ? new MediaRecorder(this._cameraStream, {
          mimeType: this._violationClipMimeType,
          videoBitsPerSecond: 320000,
        })
      : new MediaRecorder(this._cameraStream, { videoBitsPerSecond: 320000 });
    this._violationClipMimeType = recorder.mimeType || this._violationClipMimeType || 'video/webm';
    const segment = {
      recorder,
      chunks: [],
      startedAt: Date.now(),
      endedAt: 0,
      stopTimer: null,
      resolveFinished: null,
      finished: null,
    };
    segment.finished = new Promise((resolve) => {
      segment.resolveFinished = resolve;
    });

    recorder.ondataavailable = (event) => {
      if (event?.data?.size) segment.chunks.push(event.data);
    };
    recorder.onerror = () => segment.resolveFinished?.(null);
    recorder.onstop = () => {
      if (segment.stopTimer) clearTimeout(segment.stopTimer);
      segment.endedAt = segment.endedAt || Date.now();
      const blob = segment.chunks.length
        ? new Blob(segment.chunks, { type: recorder.mimeType || this._violationClipMimeType || 'video/webm' })
        : null;
      segment.resolveFinished?.(blob?.size ? blob : null);
      segment.resolveFinished = null;
      this._violationClipRecorders = this._violationClipRecorders.filter(item => item !== segment);
    };

    recorder.start(this._violationClipChunkMs);
    segment.stopTimer = setTimeout(() => {
      segment.endedAt = Date.now();
      if (recorder.state !== 'inactive') recorder.stop();
    }, this._violationClipSegmentMs);
    this._violationClipRecorders.push(segment);
    return segment;
  },

  _stopViolationReplayBuffer() {
    if (this._violationClipSpawnTimer) clearInterval(this._violationClipSpawnTimer);
    this._violationClipSpawnTimer = null;
    const segments = Array.isArray(this._violationClipRecorders)
      ? this._violationClipRecorders.slice()
      : [];
    this._violationClipRecorders = [];
    segments.forEach((segment) => {
      try {
        if (segment.stopTimer) clearTimeout(segment.stopTimer);
        segment.recorder.ondataavailable = null;
        segment.recorder.onstop = null;
        segment.resolveFinished?.(null);
        if (segment.recorder.state !== 'inactive') segment.recorder.stop();
      } catch (_) {}
    });
    this._violationClipMimeType = '';
  },

  _blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ''));
      reader.onerror = () => reject(reader.error || new Error('Unable to read replay clip.'));
      reader.readAsDataURL(blob);
    });
  },

  async _capturePreViolationReplayClip(type) {
    if (!this._isReplayableCameraViolationType(type)) return null;
    const triggeredAtMs = Date.now();
    const candidates = (Array.isArray(this._violationClipRecorders) ? this._violationClipRecorders : [])
      .filter(segment => segment?.recorder?.state === 'recording')
      .sort((a, b) => a.startedAt - b.startedAt);
    const segment = candidates[0];
    if (!segment) return null;

    segment.endedAt = triggeredAtMs;
    if (segment.stopTimer) clearTimeout(segment.stopTimer);
    try {
      segment.recorder.requestData?.();
      segment.recorder.stop();
    } catch (_) {
      return null;
    }

    const clipBlob = await segment.finished;
    if (!clipBlob?.size) return null;
    const clipStartedAtMs = Number(segment.startedAt || triggeredAtMs);
    const clipEndedAtMs = triggeredAtMs;
    const mimeType = clipBlob.type || this._violationClipMimeType || 'video/webm';

    if (!this._violationClipRecorders.some(item => item?.recorder?.state === 'recording')) {
      try { this._startViolationReplaySegment(); } catch (_) {}
    }

    return {
      evidenceType: 'pre_violation_webcam_clip',
      violationType: type,
      mimeType,
      clipStartedAt: new Date(clipStartedAtMs).toISOString(),
      clipEndedAt: new Date(clipEndedAtMs).toISOString(),
      triggeredAt: new Date(triggeredAtMs).toISOString(),
      durationMs: Math.min(10000, Math.max(0, clipEndedAtMs - clipStartedAtMs)),
      fileSizeBytes: clipBlob.size,
      clipBlob,
    };
  },

  async _persistViolationReplayEvidence(payload) {
    const response = await fetch('/api/monitor/violation-evidence', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data?.message || `Replay upload failed (${response.status}).`);
    }
    const data = await response.json().catch(() => ({}));
    return data?.evidence || null;
  },

  async _uploadViolationReplayEvidence(violation, clipPayload) {
    if (!violation?.id || !clipPayload || !this.session?.id || !this.exam?.id) return null;
    const basePayload = {
      violationEventId: violation.id,
      sessionId: this.session.id,
      examId: this.exam.id,
      studentId: this.session.studentId || '',
      evidenceType: clipPayload.evidenceType || 'pre_violation_webcam_clip',
      violationType: clipPayload.violationType,
      mimeType: clipPayload.mimeType || 'video/webm',
      clipStartedAt: clipPayload.clipStartedAt,
      clipEndedAt: clipPayload.clipEndedAt,
      triggeredAt: clipPayload.triggeredAt,
      durationMs: Number(clipPayload.durationMs || 0),
      fileSizeBytes: Number(clipPayload.fileSizeBytes || clipPayload.clipBlob?.size || 0),
    };

    try {
      const clipBase64 = clipPayload.clipBase64 || await this._blobToDataUrl(clipPayload.clipBlob);
      const payload = { ...basePayload, clipBase64 };
      let lastError = null;

      for (let attempt = 1; attempt <= 3; attempt += 1) {
        try {
          return await this._persistViolationReplayEvidence(payload);
        } catch (error) {
          lastError = error;
          if (attempt < 3) await new Promise(resolve => setTimeout(resolve, attempt * 750));
        }
      }

      throw lastError || new Error('Unable to save replay evidence.');
    } catch (error) {
      console.warn('[Monitor] Unable to upload replay evidence:', error?.message || error);
      return null;
    }
  },

  _captureCameraFrameData(detectionMetadata = null) {
    const video = document.getElementById('camera-feed');
    const canvas = document.getElementById('camera-canvas');
    if (!video || !canvas || !this._cameraStream || video.readyState < 2) return null;

    canvas.width = 320;
    canvas.height = 240;
    const ctx = canvas.getContext('2d');
    ctx.save();
    ctx.scale(-1, 1);
    ctx.drawImage(video, -320, 0, 320, 240);
    ctx.restore();
    const box = detectionMetadata?.boundingBox;
    if (box && Number(box.frameWidth) > 0 && Number(box.frameHeight) > 0) {
      const scaleX = 320 / Number(box.frameWidth);
      const scaleY = 240 / Number(box.frameHeight);
      const width = Number(box.width || 0) * scaleX;
      const height = Number(box.height || 0) * scaleY;
      const x = 320 - ((Number(box.x || 0) + Number(box.width || 0)) * scaleX);
      const y = Number(box.y || 0) * scaleY;
      ctx.strokeStyle = '#ef4444';
      ctx.lineWidth = 3;
      ctx.strokeRect(x, y, width, height);
      const label = String(detectionMetadata.objectLabel || detectionMetadata.objectClass || 'Restricted object');
      ctx.font = 'bold 11px sans-serif';
      const labelWidth = Math.min(310, ctx.measureText(label).width + 10);
      ctx.fillStyle = '#ef4444';
      ctx.fillRect(x, Math.max(0, y - 18), labelWidth, 18);
      ctx.fillStyle = '#fff';
      ctx.fillText(label, x + 5, Math.max(12, y - 5));
    }
    return canvas.toDataURL('image/jpeg', 0.6);
  },

  _buildCameraSnapshots(nextSnapshot) {
    if (!this.session || !nextSnapshot) return [];
    const session = DB.getSession(this.session.id);
    const existing = Array.isArray(session?.cameraSnapshots) ? session.cameraSnapshots.filter(Boolean) : [];
    const liveSnapshot = existing.find(s => (s?.kind || 'live') === 'live');
    const violationSnapshots = existing.filter(s => s?.kind === 'violation');
    const maxViolationSnapshots = 8;

    if ((nextSnapshot.kind || 'live') === 'live') {
      return [nextSnapshot, ...violationSnapshots.slice(0, maxViolationSnapshots)];
    }

    const nextViolations = [nextSnapshot, ...violationSnapshots].slice(0, maxViolationSnapshots);
    return liveSnapshot ? [liveSnapshot, ...nextViolations] : nextViolations;
  },

  _captureCameraViolationSnapshot(type, detail, warningCount, detectionMetadata = null) {
    if (!this.session || !this.exam?.requireCamera || !this._isCameraViolationType(type)) return null;
    return this.captureSnapshot({
      kind: 'violation',
      violationType: type,
      detail,
      warningCount,
      detectionMetadata,
      fallbackToLatest: true,
    });
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

  _startDeadlineCountdown({
    timerKey,
    tokenKey,
    deadlineKey,
    totalKey,
    totalSeconds,
    preserveExisting = false,
    onUpdate,
    onExpire,
  }) {
    const now = Date.now();
    const hasLiveCountdown = preserveExisting && this[deadlineKey] > now + 150;
    const deadline = hasLiveCountdown ? this[deadlineKey] : (now + (totalSeconds * 1000));
    const activeTotalSeconds = hasLiveCountdown ? (this[totalKey] || totalSeconds) : totalSeconds;

    if (this[timerKey]) {
      clearTimeout(this[timerKey]);
      this[timerKey] = null;
    }

    this[deadlineKey] = deadline;
    this[totalKey] = activeTotalSeconds;
    const token = ++this[tokenKey];
    const totalMs = activeTotalSeconds * 1000;

    const tick = () => {
      if (token !== this[tokenKey]) return;

      const msRemaining = Math.max(0, this[deadlineKey] - Date.now());
      const secondsRemaining = msRemaining > 0 ? Math.ceil(msRemaining / 1000) : 0;
      onUpdate?.(secondsRemaining, msRemaining, activeTotalSeconds, totalMs);

      if (msRemaining <= 0) {
        this[timerKey] = null;
        this[deadlineKey] = 0;
        this[totalKey] = 0;
        onExpire?.();
        return;
      }

      this[timerKey] = setTimeout(tick, Math.min(250, msRemaining));
    };

    tick();
  },

  _stopWarningCountdown({ hideWrap = false, resetMessage = false } = {}) {
    if (this._warningCountdownTimer) {
      clearTimeout(this._warningCountdownTimer);
      this._warningCountdownTimer = null;
    }
    this._warningCountdownToken++;
    this._warningCountdownDeadline = 0;
    this._warningCountdownTotalSeconds = 0;
    this._warningCountdownMode = null;

    const overlay = document.getElementById('warning-overlay');
    if (overlay?._countdownTimer) {
      clearInterval(overlay._countdownTimer);
      overlay._countdownTimer = null;
    }

    const wrapEl = document.getElementById('warning-countdown-wrap');
    if (hideWrap && wrapEl) wrapEl.style.display = 'none';

    if (resetMessage) {
      const msgEl = document.getElementById('warning-countdown-msg');
      if (msgEl) msgEl.textContent = 'Return to this window or your exam will be auto-submitted';
    }
  },

  _stopFullscreenLockCountdown() {
    if (this._fullscreenLockTimer) {
      clearTimeout(this._fullscreenLockTimer);
      this._fullscreenLockTimer = null;
    }
    this._fullscreenLockToken++;
    this._fullscreenLockDeadline = 0;
    this._fullscreenLockTotalSeconds = 0;
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
    const safeMessage = type === 'error'
      ? (window.AppErrorUtils?.toUserMessage?.(message, 'Something went wrong.', { context: options.context || 'general' }) || message)
      : message;
    const container = this._ensureToastContainer();
    const toast = document.createElement('div');
    const variant = options.variant || 'default';
    toast.className = `toast ${type}${variant === 'settings' ? ' toast-settings' : ''}`;
    toast.innerHTML = variant === 'settings'
      ? `<span class="toast-settings-icon">${icons[type] || icons.info}</span><span class="toast-message">${_esc(safeMessage)}</span>`
      : `<span class="toast-icon">${icons[type] || icons.info}</span><span class="toast-message">${_esc(safeMessage)}</span>`;
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
    const archived = params.get('archived') === '1';

    if (portal === 'settings') return { view: 'settings' };
    if (portal === 'archived') return { view: 'archived' };
    if (portal === 'course' && courseId) {
      return {
        view: 'course',
        courseId,
        courseTab: ['exams', 'people'].includes(courseTab) ? courseTab : 'exams',
        archived,
      };
    }
    return { view: 'home' };
  },

  _writePortalRoute(route = { view: 'home' }) {
    const url = new URL(window.location.href);
    if (route.view === 'settings') {
      url.searchParams.set('portal', 'settings');
      url.searchParams.delete('archived');
      url.searchParams.delete('course');
      url.searchParams.delete('courseTab');
    } else if (route.view === 'archived') {
      url.searchParams.set('portal', 'archived');
      url.searchParams.delete('archived');
      url.searchParams.delete('course');
      url.searchParams.delete('courseTab');
    } else if (route.view === 'course' && route.courseId) {
      url.searchParams.set('portal', 'course');
      url.searchParams.set('course', route.courseId);
      url.searchParams.set('courseTab', ['people', 'exams'].includes(route.courseTab) ? route.courseTab : 'exams');
      if (route.archived) url.searchParams.set('archived', '1');
      else url.searchParams.delete('archived');
    } else {
      url.searchParams.delete('portal');
      url.searchParams.delete('archived');
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

  _getDashboardGreetingName(sess) {
    const name = String(sess?.studentName || sess?.studentId || 'Student').trim();
    if (!name) return 'Student';

    const commaIndex = name.indexOf(',');
    if (commaIndex > 0) return name.slice(0, commaIndex).trim() || name;

    return name.split(/\s+/)[0] || name;
  },

  _renderDashboardGreeting(sess) {
    const greetEl = document.getElementById('dash-greeting');
    if (!greetEl) return;

    const hr = new Date().getHours();
    const greet = hr < 12 ? 'Good morning' : hr < 17 ? 'Good afternoon' : 'Good evening';
    const greetingName = this._getDashboardGreetingName(sess);
    const dateStr = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
    greetEl.innerHTML = `<div class="dash-greeting-text">${greet}, ${_esc(greetingName)}!</div><div class="dash-greeting-sub">${dateStr}</div>`;
  },

  _getPortalStudent(studentId) {
    const student = DB.getStudent(studentId);
    return student && !student.archived ? student : null;
  },

  _formatStudentSectionShort(student) {
    const yearSection = String(student?.yearSection || '').trim().toUpperCase();
    const yearSectionMatch = yearSection.match(/^[1-5]-(.+)$/);
    if (yearSectionMatch?.[1]) return yearSectionMatch[1].trim();
    return String(student?.section || '').replace(/^Section\s+/i, '').trim();
  },

  _isPortalStudentArchived(studentId) {
    return !!DB.getStudent(studentId)?.archived;
  },

  _renderCourseAccessRemovedState() {
    const listEl = document.getElementById('dash-subjects-list');
    if (!listEl) return;
    this._renderSidebarCourses([]);
    listEl.innerHTML = `<div class="dash-empty">
      <div class="dash-empty-icon"><svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><polyline points="21 8 21 21 3 21 3 8"/><rect x="1" y="3" width="22" height="5"/><line x1="10" y1="12" x2="14" y2="12"/></svg></div>
      <div class="dash-empty-title">Course Access Removed</div>
      <div class="dash-empty-sub">Your professor has temporarily archived your student record. Your enrolled courses and exams are hidden until that record is restored.</div>
    </div>`;
  },

  _isExamLockedByCode(exam) {
    return !!String(exam?.code || '').trim();
  },

  _resolveExamFromSession(studentSession) {
    if (!studentSession) return null;
    if (studentSession.examId) return DB.getExam(studentSession.examId);
    if (studentSession.examCode) return DB.getExamByCode(studentSession.examCode);
    return null;
  },

  _openExamDirectly(examId) {
    if (this._dashInterval) { clearInterval(this._dashInterval); this._dashInterval = null; }
    if (this._courseInterval) { clearInterval(this._courseInterval); this._courseInterval = null; }
    this._returnCourseId = this._currentCourseId || null;
    const sess = Auth.getStudentSession();
    const updated = { ...sess, examId };
    delete updated.examCode;
    sessionStorage.setItem('acs_student_session', JSON.stringify(updated));
    this.exam = null; this.session = null; this.warnings = 0; this.answers = {};
    this._startExamFlow(updated);
  },

  _promptForExamAccessCode(exam) {
    if (!exam) return;
    this._accessCodeExamId = exam.id;
    const modal = document.getElementById('exam-access-code-modal');
    const titleEl = document.getElementById('exam-access-code-title');
    const noteEl = document.getElementById('exam-access-code-note');
    const input = document.getElementById('exam-access-code-input');
    const msgEl = document.getElementById('exam-access-code-msg');
    if (titleEl) titleEl.textContent = `Enter access code for "${exam.title}"`;
    if (noteEl) {
      noteEl.textContent = exam.status === 'active'
        ? 'This exam is active now. Enter the access code from your professor to continue.'
        : 'This exam is ready. Enter the access code from your professor to open it.';
    }
    if (msgEl) setEnrollStatus(msgEl, '', 'info');
    if (input) {
      input.value = '';
      input.style.borderColor = '';
      input.placeholder = 'Enter exam access code';
    }
    if (modal) {
      modal.classList.remove('hidden');
      lockBodyScroll();
      requestAnimationFrame(() => input?.focus());
    }
  },

  closeExamAccessCodeModal() {
    this._accessCodeExamId = null;
    const modal = document.getElementById('exam-access-code-modal');
    const msgEl = document.getElementById('exam-access-code-msg');
    const input = document.getElementById('exam-access-code-input');
    if (msgEl) setEnrollStatus(msgEl, '', 'info');
    if (input) {
      input.value = '';
      input.style.borderColor = '';
      input.placeholder = 'Enter exam access code';
    }
    if (modal && !modal.classList.contains('hidden')) unlockBodyScroll();
    modal?.classList.add('hidden');
  },

  submitExamAccessCode() {
    const exam = this._accessCodeExamId ? DB.getExam(this._accessCodeExamId) : null;
    const input = document.getElementById('exam-access-code-input');
    const msgEl = document.getElementById('exam-access-code-msg');
    const code = String(input?.value || '').trim().toUpperCase();

    if (!exam || !input) {
      this.closeExamAccessCodeModal();
      return;
    }

    if (!code) {
      setEnrollStatus(msgEl, 'Please enter the exam access code.', 'error', { autoClearMs: 4000 });
      input.style.borderColor = '#dc2626';
      input.focus();
      return;
    }

    const expectedCode = String(exam.code || '').trim().toUpperCase();
    if (code !== expectedCode) {
      input.style.borderColor = '#dc2626';
      input.value = '';
      input.placeholder = 'Invalid code - try again';
      setEnrollStatus(msgEl, 'Invalid access code. Please check and try again.', 'error', { autoClearMs: 4000 });
      requestAnimationFrame(() => input.focus());
      setTimeout(() => {
        input.style.borderColor = '';
        input.placeholder = 'Enter exam access code';
      }, 2000);
      return;
    }

    input.style.borderColor = '';
    this.closeExamAccessCodeModal();
    this._openExamDirectly(exam.id);
  },

  handleExamAccessCodeKeydown(event) {
    if (event.key === 'Enter') {
      event.preventDefault();
      this.submitExamAccessCode();
    }
  },

  _isStudentEnrolledInExam(student, exam) {
    if (!student || student.archived || !exam?.subjectId) return false;
    return (student.enrolledSubjects || []).includes(exam.subjectId);
  },

  _isStudentAbsentForExam(student, exam) {
    if (!student || !exam) return false;
    return (exam.excludedStudentIds || []).includes(student.id);
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

    // If no exam has been selected yet, show dashboard
    if (!studentSession.examCode && !studentSession.examId) {
      this.showDashboard(studentSession);
      return;
    }

    // We have an exam target — proceed with exam flow
    this._startExamFlow(studentSession);
  },

  async _startExamFlow(studentSession) {
    // Stop any running dashboard/course-view poll
    if (this._dashInterval) { clearInterval(this._dashInterval); this._dashInterval = null; }
    if (this._courseInterval) { clearInterval(this._courseInterval); this._courseInterval = null; }

    const sync = window.SupabaseSync;
    await Promise.all([
      sync?.refreshExams?.(),
      sync?.refreshSessions?.(),
      sync?.refreshStudents?.(),
      sync?.refreshSubjects?.(),
    ]).catch(() => {});
    const refreshAutoSubmit = this._consumePendingRefreshAutoSubmit(studentSession);

    if (refreshAutoSubmit?.exam && refreshAutoSubmit?.session) {
      this.exam = refreshAutoSubmit.exam;
      this.session = refreshAutoSubmit.session;
      this.answers = refreshAutoSubmit.session.answers || {};
      this.warnings = refreshAutoSubmit.session.warnings || 0;
      this._showSubmitted(true);
      return;
    }

    const exam = this._resolveExamFromSession(studentSession);
    if (!exam) {
      // Exam target invalid — clear it and go back to dashboard
      const sess = { ...studentSession };
      delete sess.examCode;
      delete sess.examId;
      sessionStorage.setItem('acs_student_session', JSON.stringify(sess));
      this.showDashboard(sess);
      return;
    }

    this.exam = exam;
    this._preloadYoloObjectModel();

    const portalStudent = this._getPortalStudent(studentSession.studentId);
    if (!portalStudent) {
      this._showError(
        this._isPortalStudentArchived(studentSession.studentId)
          ? 'Your professor has temporarily removed your access to this course and its exams.'
          : 'Student record not found. Please contact your instructor.'
      );
      return;
    }

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

    if (!existingSession && !this._isStudentEnrolledInExam(portalStudent, exam)) {
      this._showError('You are not enrolled in the course for this exam. Please contact your instructor if this is a mistake.');
      return;
    }
    if (this._isStudentAbsentForExam(portalStudent, exam)) {
      this._showError('You have been marked absent for this exam. Please contact your instructor if this is a mistake.');
      return;
    }

    if (exam.status === 'ready') {
      this._renderWaitingInfo(studentSession, exam);
      this.showState('waiting');
      this.startWaitingPoll();
      return;
    }

    if (exam.status === 'active') {
      const examStartedAt = exam.startedAt ? new Date(exam.startedAt).getTime() : NaN;
      const examDurationMinutes = Number(exam.timeLimit);
      const examDeadline = Number.isFinite(examStartedAt) && Number.isFinite(examDurationMinutes) && examDurationMinutes > 0
        ? examStartedAt + examDurationMinutes * 60 * 1000
        : NaN;
      if (Number.isFinite(examDeadline) && Date.now() >= examDeadline) {
        const closedAt = new Date(examDeadline).toISOString();
        DB.updateExam(exam.id, { status: 'closed', closedAt });
        this.exam = { ...exam, status: 'closed', closedAt };
        if (this.session) this.submitExam('timeout');
        else this._showError('This exam has ended and is no longer accepting submissions.');
        return;
      }

      const launchActiveExam = () => {
        if (!this.session) {
          this.session = DB.addSession({
            examId: exam.id,
            examCode: exam.code,
            studentId: studentSession.studentId,
            studentName: studentSession.studentName || studentSession.studentId,
            yearLevel: studentSession.yearLevel || (portalStudent ? portalStudent.yearLevel : ''),
            section: studentSession.section || (portalStudent ? portalStudent.section : ''),
            startTime: null,
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
      };

      // A professor can revoke a student's temporary webcam exemption right when
      // granting a retake. Pull the latest exam row before a fresh attempt starts
      // so we don't relaunch using a stale cached exemption and leave the camera off.
      const needsFreshExamRules = !!(exam.requireCamera && (!this.session || !this.session.startTime));
      if (needsFreshExamRules && window.SupabaseSync?.refreshExams) {
        Promise.resolve(window.SupabaseSync.refreshExams())
          .catch(() => {})
          .then(() => {
            const latestExam = DB.getExam(exam.id);
            if (latestExam) this.exam = latestExam;
            launchActiveExam();
          });
        return;
      }

      launchActiveExam();
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
    // Leaving the course view (if any) — stop its poll.
    if (this._courseInterval) { clearInterval(this._courseInterval); this._courseInterval = null; }

    ['home','settings','archived'].forEach(t => {
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

    const titles = { home: 'Home', settings: 'Settings', archived: 'Archived Courses' };
    const titleEl = document.getElementById('portal-topbar-title');
    if (titleEl) titleEl.textContent = titles[tab] || tab;

    this._writePortalRoute({ view: tab === 'settings' ? 'settings' : tab === 'archived' ? 'archived' : 'home' });
    if (tab === 'settings') this._loadSettingsForm();
    if (tab === 'archived') this._renderArchivedCourses();

    // Restart dashboard poll when returning to home (was paused during course view)
    if (tab === 'home') {
      this._currentCourseId = null;
      this._currentCourseArchivedView = false;
      const sess = Auth.getStudentSession();
      this._renderDashboardGreeting(sess);
      this._renderDashboard(sess);
      if (!this._dashInterval) {
        this._dashInterval = setInterval(() => this._renderDashboard(Auth.getStudentSession()), 5000);
      }
    } else if (tab !== 'course') {
      this._currentCourseId = null;
      this._currentCourseArchivedView = false;
    }
  },

  _handlePortalDataChange(table) {
    if (!['subjects', 'students', 'exams', 'sessions'].includes(String(table || '').trim())) return;
    if (!document.getElementById('portal-main')) return;
    if (this.exam && this.session && !this.session.submitted) return;

    const sess = Auth.getStudentSession();
    if (!sess) return;

    clearTimeout(this._portalDataChangedTimer);
    this._portalDataChangedTimer = setTimeout(() => {
      const subject = this._currentCourseId ? DB.getSubjects().find(s => s.id === this._currentCourseId) : null;
      const student = this._getPortalStudent(sess.studentId);
      const enrolled = student?.enrolledSubjects || [];

      if (this._currentCourseId) {
        if (!subject || !enrolled.includes(this._currentCourseId)) {
          this.showPortalTab('home');
          return;
        }
        if (this._currentCourseArchivedView) {
          if (!subject.archived) {
            this.showPortalTab('home');
            return;
          }
          this.showCourseView(this._currentCourseId, { allowArchived: true });
          return;
        }
        if (subject.archived) {
          this.showPortalTab('home');
          return;
        }
        this.showCourseView(this._currentCourseId);
        return;
      }

      if (!document.getElementById('portal-tab-archived')?.classList.contains('hidden')) {
        this._renderArchivedCourses();
        return;
      }
      if (!document.getElementById('portal-tab-settings')?.classList.contains('hidden')) {
        this._loadSettingsForm();
        return;
      }
      this._renderDashboardGreeting(Auth.getStudentSession());
      this._renderDashboard(Auth.getStudentSession());
    }, 150);
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

    const yearSectionMatch = yearSection.match(/^([1-5])-([A-Z])$/);
    if (!yearSectionMatch) { this._showToast('Year & section must use the format 3-B.', 'error', { variant: 'settings' }); return; }
    if (!department) { this._showToast('Please select your department.', 'error', { variant: 'settings' }); return; }
    if (!program) { this._showToast('Please enter your program.', 'error', { variant: 'settings' }); return; }
    const yearMap = { '1': '1st Year', '2': '2nd Year', '3': '3rd Year', '4': '4th Year', '5': '5th Year' };
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
    this._renderDashboardGreeting(updated);
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
    const result = await Auth.changeStudentPassword(student.studentId, cur, next);
    if (!result?.success) { this._showToast(result?.message || 'Unable to change password right now.', 'error', { variant: 'settings' }); return; }
    if (sess.email) {
      await Auth.refreshStudentEmail(student.id, student.studentId, sess.email).catch(error => {
        console.warn('[Supabase] Unable to persist student email from password save:', error.message || error);
      });
    }
    await Auth.refreshStudentSessionFromRecord(student.studentId);
    ['stg-cur-pass','stg-new-pass','stg-confirm-pass'].forEach(id => { document.getElementById(id).value = ''; });
    this._showToast('Password changed successfully.', 'success', { variant: 'settings' });
  },

  _COURSE_COLORS: [
    { c1: '#0f2d1a', c2: '#1a4d2a' }, // Forest Green
    { c1: '#1e3a8a', c2: '#2563eb' }, // Ocean Blue
    { c1: '#4c1d95', c2: '#7c3aed' }, // Violet
    { c1: '#7f1d1d', c2: '#dc2626' }, // Crimson
    { c1: '#78350f', c2: '#d97706' }, // Amber
    { c1: '#0f766e', c2: '#14b8a6' }, // Teal
    { c1: '#881337', c2: '#e11d48' }, // Rose
    { c1: '#1e293b', c2: '#475569' }, // Slate
    { c1: '#312e81', c2: '#6366f1' }, // Indigo
    { c1: '#064e3b', c2: '#059669' }, // Emerald
    { c1: '#0c4a6e', c2: '#0284c7' }, // Sky
    { c1: '#701a75', c2: '#c026d3' }, // Fuchsia
  ],
  // Returns {c1, c2} for a subject — uses professor-chosen courseColor if set, else hashes the id
  _subjectColor(subj) {
    if (typeof subj.courseColor === 'number' && this._COURSE_COLORS[subj.courseColor]) {
      return this._COURSE_COLORS[subj.courseColor];
    }
    let h = 0;
    const id = subj.id || '';
    for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) & 0xffffffff;
    return this._COURSE_COLORS[Math.abs(h) % this._COURSE_COLORS.length];
  },
  _chipColor(str) {
    // Legacy: hash a string to a single hex color (used for student avatars)
    const palette = ['#1d4ed8','#7c3aed','#d97706','#dc2626','#0d9488','#be185d','#ea580c','#0284c7'];
    let h = 0;
    for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) & 0xffffffff;
    return palette[Math.abs(h) % palette.length];
  },

  _renderSidebarCourses(enrolledSubjects) {
    const container = document.getElementById('portal-nav-courses');
    if (!container) return;
    container.innerHTML = enrolledSubjects.map(s => {
      const letter = (s.name || s.code || '?').charAt(0).toUpperCase();
      const { c1, c2 } = this._subjectColor(s);
      return `<div class="portal-subject-item" id="psi-${s.id}" data-label="${_esc(s.name)}" onclick="ExamApp.scrollToCourse('${s.id}')">
        <div class="portal-subject-chip" style="background:linear-gradient(135deg,${c1},${c2});">${letter}</div>
        <span class="portal-subject-label">${_esc(s.name)}</span>
      </div>`;
    }).join('');
  },

  scrollToCourse(subjId) {
    this.showCourseView(subjId);
  },

  // ── Course view ─────────────────────────────────────────
  _currentCourseId: null,
  _currentCourseTab: 'exams',
  _currentCourseArchivedView: false,
  _accessCodeExamId: null,

  showCourseView(subjId, options = {}) {
    const subj = DB.getSubjects().find(s => s.id === subjId);
    const sess = Auth.getStudentSession();
    const student = sess ? this._getPortalStudent(sess.studentId) : null;
    const archivedView = !!(options.allowArchived && subj?.archived);
    const shouldShowCourseExam = (exam, studentId) => {
      if (!exam || exam.subjectId !== subjId) return false;
      if (exam.status !== 'draft') return true;
      const dbSession = DB.getStudentSession(exam.id, studentId);
      return !!dbSession?.submitted;
    };
    if (!subj || (subj.archived && !archivedView) || !student || !(student.enrolledSubjects || []).includes(subjId)) {
      this.showPortalTab('home');
      return;
    }
    this._currentCourseId = subjId;
    this._currentCourseArchivedView = archivedView;
    // Stop dashboard poll while in course view — it was re-rendering
    // every 5 seconds and destroying the tab active state
    if (this._dashInterval) { clearInterval(this._dashInterval); this._dashInterval = null; }

    // Switch all tabs to hidden, show course
    ['home','settings','archived','course'].forEach(t => {
      const el = document.getElementById('portal-tab-' + t);
      if (el) el.classList.toggle('hidden', t !== 'course');
    });
    // Clear nav highlights, highlight sidebar item
    ['pnav-home','pnav-settings','pnav-archived'].forEach(id => {
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
        <button class="topbar-breadcrumb-link" onclick="ExamApp.showPortalTab('${archivedView ? 'archived' : 'home'}')">${archivedView ? 'Archived Courses' : 'Home'}</button>
        <span class="topbar-breadcrumb-sep">›</span>
        <span class="topbar-breadcrumb-current">${_esc(subj.name)}</span>
      </span>`;
    }

    // Build banner
    const { c1, c2 } = this._subjectColor(subj);
    const bannerEl = document.getElementById('course-banner');
    if (bannerEl) {
      bannerEl.style.background = `linear-gradient(135deg, ${c1} 0%, ${c2} 100%)`;
      const sess2 = Auth.getStudentSession();
      const allExamsForBanner = DB.getExams().filter(e => shouldShowCourseExam(e, sess2.studentId));
      const activeCount    = allExamsForBanner.filter(e => e.status === 'active').length;
      const submittedCount = allExamsForBanner.filter(e => {
        const s = DB.getStudentSession(e.id, sess2.studentId);
        return s && s.submitted;
      }).length;
      const totalVisible = allExamsForBanner.length;
      const deco = (subj.code || subj.name || '?').charAt(0).toUpperCase();
      bannerEl.innerHTML = `
        <div class="course-banner-deco-circle c1"></div>
        <div class="course-banner-deco-circle c2"></div>
        <div class="course-banner-deco-circle c3"></div>
        <div class="course-banner-deco-letter">${deco}</div>
        ${archivedView
          ? `<span class="course-banner-unenroll-btn" style="cursor:default;pointer-events:none;opacity:0.95;">Archived</span>`
          : `<button type="button" class="course-banner-unenroll-btn" onclick="ExamApp.requestUnenroll('${subj.id}')" title="Unenroll from this course">Unenroll</button>`}
        <div class="course-banner-inner">
          <div class="course-banner-title">${_esc(subj.name)}</div>
          <div class="course-banner-code">${_esc(subj.code)}</div>
          ${subj.description ? `<div class="course-banner-desc">${_esc(subj.description)}</div>` : ''}
          <div class="course-banner-stats">
            <div class="course-stat"><div class="course-stat-value">${totalVisible}</div><div class="course-stat-label">Exams</div></div>
            <div class="course-stat"><div class="course-stat-value">${activeCount}</div><div class="course-stat-label">Active</div></div>
            <div class="course-stat"><div class="course-stat-value">${submittedCount}</div><div class="course-stat-label">Submitted</div></div>
          </div>
        </div>
        `;
    }

    const route = this._readPortalRoute();
    const preferredTab = route.view === 'course' && route.courseId === subjId
      ? route.courseTab || 'exams'
      : 'exams';
    this.showCourseTab(preferredTab);

    // Refresh exams/sessions/classmates from Supabase to catch anything missed by
    // realtime — e.g. a professor updating the audience restriction, marking someone
    // present/absent, or allowing a retake (which mutates a session, not an exam).
    const refreshCourseState = () => {
      const sync = window.SupabaseSync;
      Promise.all([
        sync?.refreshExams?.(),
        sync.refreshSessions?.(),
        sync.refreshSubjects?.(),
        sync.refreshStudents?.(),
        sync.refreshProfessors?.(),
      ]).then(() => {
        if (this._currentCourseId !== subjId) return; // user navigated away
        const sess2 = Auth.getStudentSession();
        // Re-apply the course color in case the professor changed it while this
        // student had the course open — subjects were just re-pulled above, but
        // the banner/sidebar chip color was otherwise only ever set once, at
        // showCourseView() open time.
        const freshSubj = DB.getSubjects().find(s => s.id === subjId);
        const student = sess2 ? this._getPortalStudent(sess2.studentId) : null;
        if (!freshSubj || !student || !(student.enrolledSubjects || []).includes(subjId) || (!this._currentCourseArchivedView && freshSubj.archived)) {
          this.showPortalTab('home');
          return;
        }
        if (freshSubj) {
          const { c1, c2 } = this._subjectColor(freshSubj);
          if (bannerEl) bannerEl.style.background = `linear-gradient(135deg, ${c1} 0%, ${c2} 100%)`;
          const enrolledIds = (student && student.enrolledSubjects) ? student.enrolledSubjects : [];
          const enrolledSubjects = DB.getSubjects().filter(s => enrolledIds.includes(s.id) && !s.archived);
          this._renderSidebarCourses(enrolledSubjects);
        }
        // Re-render banner stats
        const allExamsForBanner = DB.getExams().filter(e => shouldShowCourseExam(e, sess2.studentId));
        const activeCount    = allExamsForBanner.filter(e => e.status === 'active').length;
        const submittedCount = allExamsForBanner.filter(e => {
          const s = DB.getStudentSession(e.id, sess2.studentId);
          return s && s.submitted;
        }).length;
        const totalVisible = allExamsForBanner.length;
        const statEls = bannerEl?.querySelectorAll('.course-stat-value');
        if (statEls && statEls.length >= 3) {
          statEls[0].textContent = totalVisible;
          statEls[1].textContent = activeCount;
          statEls[2].textContent = submittedCount;
        }
        // Re-render whichever tab is currently open
        if (this._currentCourseTab === 'exams') this._renderCourseExams();
        else if (this._currentCourseTab === 'people') this._renderCoursePeople();
      }).catch(() => {});
    };

    refreshCourseState();

    // Keep polling while this course view stays open, so a professor's restriction/
    // attendance changes show up here without the student needing to manually refresh.
    if (this._courseInterval) clearInterval(this._courseInterval);
    this._courseInterval = setInterval(refreshCourseState, 5000);
  },

  showCourseTab(tab) {
    this._currentCourseTab = tab; // remember for any future re-renders
    ['exams','people'].forEach(t => {
      const el = document.getElementById('course-tab-' + t);
      if (el) el.classList.toggle('hidden', t !== tab);
      const btn = document.getElementById('ctab-' + t);
      if (!btn) return;
      btn.classList.toggle('active', t === tab);
      btn.style.color = t === tab ? '#0f2d1a' : '';
      btn.style.borderBottomColor = t === tab ? '#0f2d1a' : 'transparent';
      btn.style.fontWeight = t === tab ? '700' : '';
    });
    if (tab === 'exams')  this._renderCourseExams();
    if (tab === 'people') this._renderCoursePeople();
    if (this._currentCourseId) {
      this._writePortalRoute({ view: 'course', courseId: this._currentCourseId, courseTab: tab, archived: this._currentCourseArchivedView });
    }
  },

  _renderCourseExams() {
    const sess   = Auth.getStudentSession();
    const subjId = this._currentCourseId;
    const listEl = document.getElementById('course-tab-exams');
    if (!listEl) return;

    const student = this._getPortalStudent(sess.studentId);
    if (!student || !(student.enrolledSubjects || []).includes(subjId)) {
      this.showPortalTab('home');
      return;
    }
    const readOnlyArchivedCourse = !!this._currentCourseArchivedView;
    // Mirrors the join-time enforcement in _startExamFlow: a student is blocked from an
    // exam if they're marked absent — unless they already have a session (in progress or
    // submitted), which is grandfathered in.
    const isBlockedForStudent = (e) => {
      const dbSession = DB.getStudentSession(e.id, sess.studentId);
      if (dbSession?.submitted) return false;
      return this._isStudentAbsentForExam(student, e);
    };

    const allExams = DB.getExams().filter(e => {
      if (e.subjectId !== subjId) return false;
      if (e.status !== 'draft') return true;
      const dbSession = DB.getStudentSession(e.id, sess.studentId);
      return !!dbSession?.submitted;
    });
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
      { label: 'Previous / Inactive Exams', statuses: ['closed','archived','draft'], iconClass: '',           cardClass: 'status-closed' },
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
        const blocked = (e.status === 'active' || e.status === 'ready') && isBlockedForStudent(e);
        const requiresAccessCode = this._isExamLockedByCode(e);
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
        if (requiresAccessCode && !dbSess) {
          chips.push(`<span class="course-meta-chip">${this._portalLabel('clipboard', 'Access Code Required', { size: 13, gap: 5 })}</span>`);
        }

        if (dbSess && dbSess.submitted) {
          const pct = dbSess.maxScore ? Math.round(dbSess.score / dbSess.maxScore * 100) : 0;
          const submittedAt = this._formatExamCardDateTime(dbSess.endTime || dbSess.startTime || e.closedAt || e.startedAt || e.createdAt);
          const scoreHtml = dbSess.scoreReleased
            ? `<div class="course-exam-result-card">
                <div class="course-exam-result-row">
                  <span class="course-exam-result-label">Date</span>
                  <span class="course-exam-result-value">${submittedAt}</span>
                </div>
                <span class="course-exam-result-divider" aria-hidden="true"></span>
                <div class="course-exam-result-row course-exam-result-row-score">
                  <span class="course-exam-result-label">Score</span>
                  <div class="course-score-inline">
                    <span class="course-score-value">${dbSess.score}</span>
                    <span class="course-score-divider">/</span>
                    <span class="course-score-total">${dbSess.maxScore}</span>
                    <span class="course-score-percent">(${pct}%)</span>
                  </div>
                </div>
              </div>`
            : `<div class="course-exam-result-card course-exam-result-card-pending">
                <div class="course-exam-result-row">
                  <span class="course-exam-result-label">Date</span>
                  <span class="course-exam-result-value">${submittedAt}</span>
                </div>
                <span class="course-exam-result-divider" aria-hidden="true"></span>
                <div class="course-exam-result-row course-exam-result-row-score">
                  <span class="course-exam-result-label">Score</span>
                  <span class="course-score-pending">Awaiting result</span>
                </div>
              </div>`;
          accentLabel = 'Completed';
          stateHtml = `<span class="course-exam-state state-submitted">${this._portalIcon('checkCircle', { size: 12, stroke: '#4b5563' })}<span>Submitted</span></span>`;
          panelHtml = `<div class="course-exam-panel panel-submitted">
            <div class="course-exam-panel-top">
              ${scoreHtml}
            </div>
            <button class="course-exam-cta course-exam-cta-secondary" onclick="ExamApp._openExamDirectly('${e.id}')"><span>View Result</span>${this._portalIcon('arrowRight', { size: 14, stroke: 'currentColor' })}</button>
          </div>`;
        } else if (readOnlyArchivedCourse) {
          accentLabel = 'Archived';
          stateHtml = `<span class="course-exam-state state-closed">Archived Course</span>`;
          panelHtml = `<div class="course-exam-panel panel-closed">
            <div class="course-exam-panel-top">
              <div class="course-exam-panel-date">${this._formatExamCardDateTime(e.closedAt || e.updatedAt || e.createdAt)}</div>
              <div class="course-exam-panel-note">This course is archived. You can review results only for exams you already submitted.</div>
            </div>
            <button class="course-exam-cta course-exam-cta-secondary" disabled style="opacity:0.55;cursor:not-allowed;"><span>Unavailable</span></button>
          </div>`;
        } else if (blocked) {
          accentLabel = 'Absent';
          stateHtml = `<span class="course-exam-state state-closed">Absent</span>`;
          panelHtml = `<div class="course-exam-panel panel-closed">
            <div class="course-exam-panel-top">
              <div class="course-exam-panel-note">You've been marked absent for this exam.</div>
            </div>
            <button class="course-exam-cta course-exam-cta-secondary" disabled style="opacity:0.5;cursor:not-allowed;"><span>Not Available</span></button>
          </div>`;
        } else if (e.status === 'active') {
          accentLabel = 'Active';
          stateHtml = `<span class="course-exam-state state-live"><span class="course-exam-state-dot"></span><span>Active Now</span></span>`;
          panelHtml = `<div class="course-exam-panel panel-live">
            <div class="course-exam-panel-top">
              <div class="course-exam-panel-date">${this._formatExamCardDateTime(e.startedAt || e.createdAt)}</div>
              <div class="course-exam-panel-note">${requiresAccessCode ? 'This exam is locked until you enter the access code from your professor.' : 'You can enter this exam right now.'}</div>
            </div>
            <button class="course-exam-cta course-exam-cta-primary" onclick="${requiresAccessCode ? `ExamApp._promptForExamAccessCode(DB.getExam('${e.id}'))` : `ExamApp._openExamDirectly('${e.id}')`}"><span>${requiresAccessCode ? 'Enter Code' : 'Take Exam'}</span>${this._portalIcon('arrowRight', { size: 14, stroke: 'currentColor' })}</button>
          </div>`;
        } else if (e.status === 'ready') {
          accentLabel = 'Scheduled';
          stateHtml = `<span class="course-exam-state state-ready">Scheduled</span>`;
          panelHtml = `<div class="course-exam-panel panel-ready">
            <div class="course-exam-panel-top">
              <div class="course-exam-panel-date">${this._formatExamCardDateTime(e.createdAt)}</div>
              <div class="course-exam-panel-note">${requiresAccessCode ? 'This exam is ready, but it stays locked until you enter the access code.' : 'This exam room is ready and waiting for activation.'}</div>
            </div>
            <button class="course-exam-cta course-exam-cta-secondary" onclick="${requiresAccessCode ? `ExamApp._promptForExamAccessCode(DB.getExam('${e.id}'))` : `ExamApp._openExamDirectly('${e.id}')`}"><span>${requiresAccessCode ? 'Enter Code' : 'Join Room'}</span>${this._portalIcon('arrowRight', { size: 14, stroke: 'currentColor' })}</button>
          </div>`;
        } else if (e.status === 'closed') {
          accentLabel = 'Closed';
          stateHtml = `<span class="course-exam-state state-closed">Closed</span>`;
          panelHtml = `<div class="course-exam-panel panel-closed">
            <div class="course-exam-panel-top">
              <div class="course-exam-panel-date">${this._formatExamCardDateTime(e.closedAt || e.updatedAt || e.createdAt)}</div>
              <div class="course-exam-panel-note">This exam is no longer accepting submissions.</div>
            </div>
            ${dbSess
              ? `<button class="course-exam-cta course-exam-cta-secondary" onclick="ExamApp._openExamDirectly('${e.id}')"><span>View Result</span>${this._portalIcon('arrowRight', { size: 14, stroke: 'currentColor' })}</button>`
              : `<button class="course-exam-cta course-exam-cta-secondary" disabled style="opacity:0.55;cursor:not-allowed;"><span>Unavailable</span></button>`}
          </div>`;
        } else {
          accentLabel = 'Draft';
          stateHtml = `<span class="course-exam-state state-closed">Draft</span>`;
          panelHtml = `<div class="course-exam-panel panel-closed">
            <div class="course-exam-panel-top">
              <div class="course-exam-panel-date">${this._formatExamCardDateTime(e.createdAt)}</div>
              <div class="course-exam-panel-note">This exam is not yet available.</div>
            </div>
          </div>`;
        }

        const cardClass = blocked ? 'status-closed' : g.cardClass;
        const iconClass = blocked ? '' : g.iconClass;
        html += `<div class="course-exam-card ${cardClass}"${blocked ? ' style="opacity:0.7;"' : ''}>
          <div class="course-exam-shell">
            <div class="course-exam-card-left">
              <div class="course-exam-icon ${iconClass}">
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

    const subject = DB.getSubjects().find(s => s.id === subjId) || null;
    const settings = DB.getSettings();
    const professors = DB.getAdmins();
    const professor = professors.find(p => p.id === subject?.ownerAdminId) || null;
    const students = DB.getStudents().filter(s => (s.enrolledSubjects || []).includes(subjId));

    const teacherColor = '#0f2d1a';
    const teacherName = professor?.name || settings.adminName || 'Administrator';
    const teacherLetter = teacherName.charAt(0).toUpperCase();

    let html = `
      <div class="people-section">
        <div class="dash-section-label">Professor</div>
        <div class="people-card-list">
          <div class="people-card">
            <div class="people-avatar" style="background:${teacherColor};">${teacherLetter}</div>
            <div>
              <div class="people-name">${_esc(teacherName)}</div>
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
        const sectionShort = this._formatStudentSectionShort(s);
        html += `<div class="people-card">
          <div class="people-avatar" style="background:${color};">${letter}</div>
          <div>
            <div class="people-name">${_esc(s.name)}${isSelf ? '<span class="people-you-badge">You</span>' : ''}</div>
            <div class="people-meta">${_esc(s.studentId)}${s.yearLevel ? ' · ' + _esc(s.yearLevel) : ''}${sectionShort ? ' · ' + _esc(sectionShort) : ''}</div>
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
    this._disableRefreshProtection();

    // Leaving the course view (if any) — stop its poll.
    if (this._courseInterval) { clearInterval(this._courseInterval); this._courseInterval = null; }

    this.showState('dashboard');

    // Logo from settings
    const settings = DB.getSettings();
    const logoEl = document.getElementById('portal-logo');
    if (logoEl && settings.logoUrl) logoEl.src = settings.logoUrl;

    this._refreshPortalIdentity(sess);
    this._renderDashboardGreeting(sess);

    // Input listeners (set once)
    const codeInput = document.getElementById('exam-access-code-input');
    if (codeInput && !codeInput._ls) {
      codeInput._ls = true;
      codeInput.addEventListener('input', e => e.target.value = e.target.value.toUpperCase());
      codeInput.addEventListener('keydown', e => { if (e.key === 'Enter') this.submitExamAccessCode(); });
    }
    const enrollInput = document.getElementById('dash-enroll-code');
    if (enrollInput && !enrollInput._ls) {
      enrollInput._ls = true;
      enrollInput.addEventListener('input', e => e.target.value = e.target.value.toUpperCase());
      enrollInput.addEventListener('keydown', e => { if (e.key === 'Enter') this.dashEnrollCourse(); });
    }

    this._renderDashboard(sess);
    const sync = window.SupabaseSync;
    Promise.all([
      sync?.refreshExams?.(),
      sync?.refreshSessions?.(),
      sync?.refreshSubjects?.(),
      sync?.refreshStudents?.(),
      sync?.refreshProfessors?.(),
    ])
      .catch(() => {})
      .then(() => this._renderDashboard(Auth.getStudentSession()));
    if (this._dashInterval) clearInterval(this._dashInterval);
    // Re-fetch exams/sessions from Supabase on every tick (not just re-render the
    // local cache) so a professor flipping an exam to ready/active, or allowing a
    // retake, still shows up here even if the realtime socket silently dropped.
    this._dashInterval = setInterval(() => {
      Promise.all([
        sync?.refreshExams?.(),
        sync?.refreshSessions?.(),
        sync?.refreshSubjects?.(),
        sync?.refreshStudents?.(),
        sync?.refreshProfessors?.(),
      ])
        .catch(() => {})
        .then(() => this._renderDashboard(Auth.getStudentSession()));
    }, 5000);

    const route = this._readPortalRoute();
    if (route.view === 'settings') {
      this.showPortalTab('settings');
      return;
    }
    if (route.view === 'archived') {
      this.showPortalTab('archived');
      return;
    }
    if (route.view === 'course') {
      const student = this._getPortalStudent(sess.studentId);
      const enrolled = student?.enrolledSubjects || [];
      const courseSubj = DB.getSubjects().find(s => s.id === route.courseId);
      const canOpenActiveCourse = enrolled.includes(route.courseId) && courseSubj && !courseSubj.archived;
      const canOpenArchivedCourse = enrolled.includes(route.courseId) && courseSubj && courseSubj.archived && route.archived;
      if (canOpenActiveCourse || canOpenArchivedCourse) {
        this.showCourseView(route.courseId, { allowArchived: !!canOpenArchivedCourse });
        return;
      }
    }
    this.showPortalTab('home');
  },

  _renderDashboard(sess) {
    if (!sess) return;
    const rawStudent = DB.getStudent(sess.studentId);
    if (rawStudent?.archived) {
      this._renderCourseAccessRemovedState();
      return;
    }
    const student = this._getPortalStudent(sess.studentId);
    const enrolledIds = (student && student.enrolledSubjects) ? student.enrolledSubjects : [];
    const allSubjects = DB.getSubjects();
    const enrolledSubjects = allSubjects.filter(s => enrolledIds.includes(s.id) && !s.archived);
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
          <div class="dash-empty-sub">Use the "Enroll in a Course" field above. Exams that require a code will prompt you when you open them.</div>
        </div>`;
      listEl.innerHTML = html;
      return;
    }

    // Audience filter: returns true if the exam is visible to this student
    const audienceMatch = (e) => {
      // Already joined (in progress or submitted) — don't retroactively hide it if
      // the exclusion list changes after the fact.
      const dbSession = DB.getStudentSession(e.id, sess.studentId);
      if (dbSession?.submitted) return true;
      if (this._isStudentAbsentForExam(student, e)) return false;
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
        const requiresAccessCode = this._isExamLockedByCode(e);
        const metaItems = [
          `<span class="dash-meta-item">${_esc(subj.name)}</span>`,
          `<span class="dash-meta-item">${e.questions.length} question${e.questions.length === 1 ? '' : 's'}</span>`,
          `<span class="dash-meta-item">${e.timeLimit} min</span>`,
        ];
        if (e.requireCamera) {
          metaItems.push(`<span class="dash-meta-item">${this._portalLabel('camera', 'Camera required', { size: 12, gap: 5 })}</span>`);
        }
        const metaHtml = metaItems.join('<span class="dash-meta-divider"></span>');
        html += `
          <div class="dash-active-banner">
            <div class="dash-active-banner-left">
              <div class="dash-active-live"><span class="dash-active-live-dot"></span>Live</div>
              <div class="dash-active-exam-title">${_esc(e.title)}</div>
              <div class="dash-active-exam-meta">${metaHtml}</div>
            </div>
            <button class="btn-take-exam-pill" onclick="${requiresAccessCode ? `ExamApp._promptForExamAccessCode(DB.getExam('${e.id}'))` : `ExamApp._openExamDirectly('${e.id}')`}">
              <span class="btep-text">${requiresAccessCode ? 'Enter Code' : 'Take Exam'}</span>
              <span class="btep-icon">
                <svg width="16" height="19" viewBox="0 0 16 19" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <circle cx="1.61321" cy="1.61321" r="1.5" fill="#fff"/>
                  <circle cx="5.73583" cy="1.61321" r="1.5" fill="#fff"/>
                  <circle cx="5.73583" cy="5.5566" r="1.5" fill="#fff"/>
                  <circle cx="9.85851" cy="5.5566" r="1.5" fill="#fff"/>
                  <circle cx="9.85851" cy="9.5" r="1.5" fill="#fff"/>
                  <circle cx="13.9811" cy="9.5" r="1.5" fill="#fff"/>
                  <circle cx="5.73583" cy="13.4434" r="1.5" fill="#fff"/>
                  <circle cx="9.85851" cy="13.4434" r="1.5" fill="#fff"/>
                  <circle cx="1.61321" cy="17.3868" r="1.5" fill="#fff"/>
                  <circle cx="5.73583" cy="17.3868" r="1.5" fill="#fff"/>
                </svg>
              </span>
            </button>
          </div>`;
      });
    }

    const featuredActiveExamIds = new Set(activeExams.map(({ exam }) => exam.id));

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
        const requiresAccessCode = this._isExamLockedByCode(e);
        let actionHtml = '', statusHtml = '';

        if (dbSession && dbSession.submitted) {
          statusHtml = `<span class="badge badge-secondary" style="font-size:10px;">Submitted</span>`;
          actionHtml = `<button class="btn btn-secondary btn-sm" onclick="event.stopPropagation();ExamApp._openExamDirectly('${e.id}')">View Result</button>`;
        } else if (e.status === 'active') {
          statusHtml = `<span class="dash-exam-active-pill"><span class="dash-exam-active-dot"></span><span>ACTIVE</span></span>`;
          actionHtml = featuredActiveExamIds.has(e.id)
            ? ``
            : `<button class="btn btn-primary btn-sm" onclick="event.stopPropagation();${requiresAccessCode ? `ExamApp._promptForExamAccessCode(DB.getExam('${e.id}'))` : `ExamApp._openExamDirectly('${e.id}')`}">${requiresAccessCode ? 'Enter Code' : 'Take Exam'}</button>`;
        } else if (e.status === 'ready') {
          statusHtml = `<span class="badge badge-info" style="font-size:10px;">Waiting</span>`;
          actionHtml = `<button class="btn btn-secondary btn-sm" onclick="event.stopPropagation();${requiresAccessCode ? `ExamApp._promptForExamAccessCode(DB.getExam('${e.id}'))` : `ExamApp._openExamDirectly('${e.id}')`}">${requiresAccessCode ? 'Enter Code' : 'Join Room'}</button>`;
        } else if (e.status === 'closed') {
          statusHtml = `<span class="badge badge-secondary" style="font-size:10px;">Closed</span>`;
          actionHtml = `<button class="btn btn-secondary btn-sm" style="opacity:0.5;cursor:not-allowed;" disabled>Unavailable</button>`;
        }

        const metaParts = [
          `<span>${_esc(`${e.questions.length} questions`)}</span>`,
          `<span>${_esc(`${e.timeLimit} min`)}</span>`,
        ];
        if (e.requireCamera) metaParts.push(this._portalLabel('camera', 'Camera', { size: 13, gap: 5 }));
        if (requiresAccessCode && !dbSession) metaParts.push('Access code required');

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

      const { c1: sc1, c2: sc2 } = this._subjectColor(subj);
      html += `<div class="dash-subject-card dash-subject-card-clickable" id="course-card-${subj.id}" tabindex="0" role="button" onclick="ExamApp.showCourseView('${subj.id}')" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();ExamApp.showCourseView('${subj.id}');}">
        <div class="dash-subject-header">
          <div class="dash-subject-icon" style="background:linear-gradient(135deg,${sc1},${sc2});">
            <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>
          </div>
          <div style="flex:1;min-width:0;">
            <div class="dash-subject-name">${_esc(subj.name)}</div>
            <span class="dash-subject-code">${_esc(subj.code)}</span>
          </div>
          <button type="button" class="btn btn-secondary btn-sm dash-unenroll-btn" title="Unenroll from this course" onclick="event.stopPropagation();ExamApp.requestUnenroll('${subj.id}')">Unenroll</button>
        </div>
        ${examsHtml}
      </div>`;
    });

    listEl.innerHTML = html;
  },

  _renderArchivedCourses() {
    const render = () => {
      const sess = Auth.getStudentSession();
      if (!sess) return;
      const rawStudent = DB.getStudent(sess.studentId);
      const listEl = document.getElementById('archived-subjects-list');
      if (!listEl) return;
      if (rawStudent?.archived) {
        listEl.innerHTML = `<div class="dash-empty">
          <div class="dash-empty-icon"><svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><polyline points="21 8 21 21 3 21 3 8"/><rect x="1" y="3" width="22" height="5"/><line x1="10" y1="12" x2="14" y2="12"/></svg></div>
          <div class="dash-empty-title">Course Access Removed</div>
          <div class="dash-empty-sub">Your student record is archived right now, so course access is temporarily hidden.</div>
        </div>`;
        return;
      }
      const student = this._getPortalStudent(sess.studentId);
      const enrolledIds = (student && student.enrolledSubjects) ? student.enrolledSubjects : [];
      const archivedSubjects = DB.getSubjects().filter(s => enrolledIds.includes(s.id) && s.archived);

      if (!archivedSubjects.length) {
        listEl.innerHTML = `<div class="dash-empty">
          <div class="dash-empty-icon"><svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><polyline points="21 8 21 21 3 21 3 8"/><rect x="1" y="3" width="22" height="5"/><line x1="10" y1="12" x2="14" y2="12"/></svg></div>
          <div class="dash-empty-title">No Archived Courses</div>
          <div class="dash-empty-sub">Courses archived by your professor will appear here.</div>
        </div>`;
        return;
      }

      let html = '';
      archivedSubjects.forEach(subj => {
        const submittedCount = DB.getExams().filter(e => {
          if (e.subjectId !== subj.id) return false;
          const session = DB.getStudentSession(e.id, sess.studentId);
          return !!session?.submitted;
        }).length;
        html += `<div class="dash-subject-card dash-subject-card-clickable" style="opacity:0.85;" tabindex="0" role="button" onclick="ExamApp.showCourseView('${subj.id}', { allowArchived: true })" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();ExamApp.showCourseView('${subj.id}', { allowArchived: true });}">
          <div class="dash-subject-header">
            <div class="dash-subject-icon" style="background:linear-gradient(135deg,#9ca3af,#d1d5db);">
              <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="21 8 21 21 3 21 3 8"/><rect x="1" y="3" width="22" height="5"/><line x1="10" y1="12" x2="14" y2="12"/></svg>
            </div>
            <div style="flex:1;min-width:0;">
              <div class="dash-subject-name">${_esc(subj.name)}</div>
              <span class="dash-subject-code">${_esc(subj.code)}</span>
            </div>
            <span style="font-size:11px;font-weight:600;color:#9ca3af;background:#f3f4f6;border:1px solid #e5e7eb;border-radius:6px;padding:3px 8px;">Archived</span>
          </div>
          <div class="dash-no-exams" style="color:#9ca3af;">Open this course to review its exams${submittedCount ? ` and ${submittedCount === 1 ? 'view your result' : 'view your results'}` : ''}.</div>
        </div>`;
      });
      listEl.innerHTML = html;
    };

    // Show spinner immediately, then re-render after fresh Supabase fetch
    const listEl = document.getElementById('archived-subjects-list');
    if (listEl) listEl.innerHTML = `<div style="padding:20px;text-align:center;color:#9ca3af;font-size:13px;">Loading…</div>`;

    if (window.SupabaseSync?.refreshSubjects) {
      window.SupabaseSync.refreshSubjects().then(render);
    } else {
      render();
    }
  },

  dashSelectExam(examCode) {
    const exam = DB.getExamByCode(examCode);
    if (!exam) return;
    if (!this._isExamLockedByCode(exam)) {
      this._openExamDirectly(exam.id);
      return;
    }
    if (this._dashInterval) { clearInterval(this._dashInterval); this._dashInterval = null; }
    if (this._courseInterval) { clearInterval(this._courseInterval); this._courseInterval = null; }
    this._returnCourseId = this._currentCourseId || null;
    const sess = Auth.getStudentSession();
    const updated = { ...sess, examId: exam.id, examCode: String(exam.code || '').trim().toUpperCase() };
    sessionStorage.setItem('acs_student_session', JSON.stringify(updated));
    this.exam = null; this.session = null; this.warnings = 0; this.answers = {};
    this._startExamFlow(updated);
  },

  dashEnterExamCode() {
    this.submitExamAccessCode();
  },

  async dashEnrollCourse() {
    const code = (document.getElementById('dash-enroll-code').value || '').trim().toUpperCase();
    const msgEl = document.getElementById('dash-enroll-msg');
    if (!code) { setEnrollStatus(msgEl, 'Please enter an enrollment code.', 'error', { autoClearMs: 4000 }); return; }

    setEnrollStatus(msgEl, 'Checking code…', 'info');

    // Refresh local cache from Supabase first
    if (window.SupabaseSync?.refreshSubjects) {
      await window.SupabaseSync.refreshSubjects().catch(() => {});
    }

    let subject = DB.getSubjects().find(s => s.enrollmentCode === code && !s.archived);

    // Fallback: direct Supabase query by enrollment code (handles sync failures)
    if (!subject && window.SupabaseSync?._client) {
      const { data } = await window.SupabaseSync._client
        .from('subjects').select('*').eq('enrollment_code', code).maybeSingle();
      if (data && !data.archived) {
        subject = window.SupabaseSync._dbToJsSubject(data);
        const cached = window.DB._read('acs_subjects', []);
        const idx = cached.findIndex(s => s.id === subject.id);
        if (idx >= 0) cached[idx] = subject; else cached.push(subject);
        window.DB._write('acs_subjects', cached);
      }
    }

    if (!subject) { setEnrollStatus(msgEl, 'Invalid code. Please check with your instructor.', 'error', { autoClearMs: 4500 }); return; }

    const sess = Auth.getStudentSession();
    if (this._isPortalStudentArchived(sess.studentId)) {
      setEnrollStatus(msgEl, 'Your professor has temporarily removed your course access. Enrollment is disabled until you are restored.', 'error', { autoClearMs: 5500 });
      return;
    }
    const student = this._getPortalStudent(sess.studentId);
    if (student) {
      const enrolled = student.enrolledSubjects || [];
      if (enrolled.includes(subject.id)) {
        setEnrollStatus(msgEl, `You're already enrolled in "${subject.name}".`, 'info', { autoClearMs: 4000 });
      } else if (!DB.isStudentEligibleForCourse(student, subject)) {
        const years = Array.isArray(subject.yearLevels) && subject.yearLevels.length
          ? subject.yearLevels
          : (subject.yearLevel ? [subject.yearLevel] : []);
        const sections = (subject.sections || []).map(s => DB._normalizeSectionValue(s)).filter(Boolean);
        const reqParts = [];
        if (years.length) reqParts.push(years.join('/'));
        if (sections.length) reqParts.push('Section ' + sections.join('/'));
        const reqText = reqParts.length ? ` This course is only open to ${reqParts.join(', ')}.` : '';
        setEnrollStatus(msgEl, `Your year level/section doesn't match this course's requirements.${reqText} Please contact your instructor if this seems wrong.`, 'error', { autoClearMs: 5500 });
      } else {
        DB.updateStudent(student.id, { enrolledSubjects: [...enrolled, subject.id] });
        setEnrollStatus(msgEl, `Successfully enrolled in "${subject.name}"!`, 'success', { autoClearMs: 4000 });
        document.getElementById('dash-enroll-code').value = '';
        this._renderDashboard(sess);
      }
    } else {
      setEnrollStatus(msgEl, 'Student record not found. Please contact your instructor.', 'error', { autoClearMs: 5000 });
    }
  },

  dashSignOut() {
    const modal = document.getElementById('confirm-logout-modal');
    if (modal) {
      modal.classList.remove('hidden');
      lockBodyScroll();
      return;
    }
    if (this._dashInterval) { clearInterval(this._dashInterval); this._dashInterval = null; }
    if (this._courseInterval) { clearInterval(this._courseInterval); this._courseInterval = null; }
    Auth.clearStudentSession();
    window.location.href = 'index.html';
  },

  cancelLogout() {
    const modal = document.getElementById('confirm-logout-modal');
    if (modal && !modal.classList.contains('hidden')) unlockBodyScroll();
    modal?.classList.add('hidden');
  },

  showViolationsInfo() {
    const modal = document.getElementById('violations-info-modal');
    if (!modal) return;
    modal.classList.remove('hidden');
    lockBodyScroll();
  },

  closeViolationsInfo() {
    const modal = document.getElementById('violations-info-modal');
    if (modal && !modal.classList.contains('hidden')) unlockBodyScroll();
    modal?.classList.add('hidden');
  },

  confirmLogout() {
    this.cancelLogout();
    if (this._dashInterval) { clearInterval(this._dashInterval); this._dashInterval = null; }
    if (this._courseInterval) { clearInterval(this._courseInterval); this._courseInterval = null; }
    Auth.clearStudentSession();
    window.location.href = 'index.html';
  },

  _unenrollTargetId: null,

  requestUnenroll(subjId) {
    const subj = DB.getSubjects().find(s => s.id === subjId);
    if (!subj) return;
    this._unenrollTargetId = subjId;
    const msgEl = document.getElementById('confirm-unenroll-msg');
    if (msgEl) msgEl.textContent = `Unenroll from "${subj.name}"? You will lose access to its exams and materials unless you rejoin with an enrollment code.`;
    document.getElementById('confirm-unenroll-modal')?.classList.remove('hidden');
    lockBodyScroll();
  },

  cancelUnenroll() {
    this._unenrollTargetId = null;
    const modal = document.getElementById('confirm-unenroll-modal');
    if (modal && !modal.classList.contains('hidden')) unlockBodyScroll();
    modal?.classList.add('hidden');
  },

  confirmUnenroll() {
    const subjId = this._unenrollTargetId;
    const sess = Auth.getStudentSession();
    if (!subjId || !sess) { this.cancelUnenroll(); return; }
    const student = DB.getStudent(sess.studentId);
    if (!student) { this.cancelUnenroll(); return; }
    const updated = (student.enrolledSubjects || []).filter(id => id !== subjId);
    DB.updateStudent(student.id, { enrolledSubjects: updated });
    this.cancelUnenroll();
    this._showToast('You have been unenrolled from the course.', 'success');
    if (this._currentCourseId === subjId) this.showPortalTab('home');
    this._renderDashboard(sess);
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

    // Defensive: the floating exam tools (zoom/violations-info) live inside
    // #state-exam but must never leak onto other screens (e.g. dashboard
    // after a mid-exam refresh), so tie their visibility directly to the
    // active state rather than relying solely on the ancestor's display.
    const tools = document.getElementById('exam-tools-container');
    if (tools) tools.style.display = name === 'exam' ? '' : 'none';

    // The in-exam chat stays available on the active exam screen AND after the
    // student has submitted, so they can still reach their professor (and see
    // replies) about a submitted attempt.
    const chatAllowed = (name === 'exam' || name === 'submitted') && !!this.exam && !!this.session;
    const chatFab = document.getElementById('exam-chat-fab');
    if (chatFab) chatFab.style.display = chatAllowed ? '' : 'none';
    if (chatAllowed) {
      this._startChatSyncPolling();
      this._refreshChatMessagesFromSync();
    }
    else this._stopChatSyncPolling();
    if (!chatAllowed) {
      const chatPanel = document.getElementById('exam-chat-panel');
      if (chatPanel) chatPanel.style.display = 'none';
    }

    // Same leak as above, but for the proctoring camera widget: it must
    // never keep rendering (or keep the webcam stream open) once the
    // student is off the exam screen, e.g. after a mid-exam refresh routes
    // straight to 'submitted' or back to 'dashboard'.
    if (name !== 'exam') this.stopCamera();
  },

  _showError(msg) {
    this._disableRefreshProtection();
    // If student has a session, go back to their dashboard with the error shown briefly
    const sess = Auth.getStudentSession();
    if (sess) {
      const updated = { ...sess };
      delete updated.examCode;
      delete updated.examId;
      sessionStorage.setItem('acs_student_session', JSON.stringify(updated));
      this.showDashboard(updated);
      this._showToast(msg, 'error');
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
      if (errEl) { errEl.textContent = 'Please enter your Student ID and Access Code.'; errEl.style.display = 'block'; }
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
        <div class="info-row"><span class="info-label">${this._isExamLockedByCode(exam) ? 'Access Code' : 'Access'}</span><span class="info-value">${this._isExamLockedByCode(exam) ? _esc(exam.code) : 'Unlocked'}</span></div>
        <div class="info-row"><span class="info-label">Time Limit</span><span class="info-value">${exam.timeLimit} minutes</span></div>
        <div class="info-row"><span class="info-label">Questions</span><span class="info-value">${exam.questions.length}</span></div>
      `;
    }
  },

  startWaitingPoll() {
    this._stopSessionSyncPolling();
    this.stopPoll();
    this.pollInterval = setInterval(async () => {
      // Re-fetch from Supabase, not just the local cache, so the exam still
      // auto-starts here even if the realtime socket silently dropped.
      const sync = window.SupabaseSync;
      await Promise.all([sync?.refreshExams?.(), sync?.refreshSessions?.()]).catch(() => {});
      const latestExam = DB.getExam(this.exam.id);
      if (!latestExam) return;
      this.exam = latestExam;
      this._preloadYoloObjectModel();
      const studentSession = Auth.getStudentSession();
      const portalStudent = studentSession ? this._getPortalStudent(studentSession.studentId) : null;
      const existingSession = studentSession ? DB.getStudentSession(this.exam.id, studentSession.studentId) : null;

      if (this._isStudentAbsentForExam(portalStudent, latestExam) && !existingSession?.submitted) {
        this.stopPoll();
        this._showError('You have been marked absent for this exam. Please contact your instructor if this is a mistake.');
        return;
      }

      if (latestExam.status === 'active') {
        this.stopPoll();
        if (!this.session) {
          if (existingSession && !existingSession.submitted) {
            this.session = existingSession;
            this.warnings = existingSession.warnings || 0;
            this.answers = existingSession.answers || {};
          } else if (!existingSession) {
            const student = studentSession ? DB.getStudent(studentSession.studentId) : null;
            this.session = DB.addSession({
              examId: this.exam.id,
              examCode: this.exam.code,
              studentId: studentSession.studentId,
              studentName: studentSession.studentName || studentSession.studentId,
              yearLevel: studentSession.yearLevel || (student ? student.yearLevel : ''),
              section: studentSession.section || (student ? student.section : ''),
              startTime: null,
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
    this._prepareExamShell();
    this._webcamConsentAccepted = false;
    this._cameraRequired = false;
    if (this._shouldShowExamPolicies()) {
      this._requestExamPolicies();
      return;
    }
    this._continueExamLaunch();
  },

  _prepareExamShell() {
    this.showState('exam');

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

    // In-exam chat: let the student message their professor during the exam.
    this._ensureChatUI();
    this._renderChatMessages();
    this._updateChatBadge();
  },

  _getExamPolicies() {
    if (!this.exam || !Array.isArray(this.exam.examPolicies)) return [];
    return this.exam.examPolicies
      .map(policy => String(policy ?? '').trim())
      .filter(Boolean);
  },

  _shouldShowExamPolicies() {
    if (!this.session) return false;
    const session = DB.getSession(this.session.id);
    const activities = Array.isArray(session?.activities) ? session.activities : [];
    const hasAcknowledgedPolicies = activities.some(activity => activity?.type === 'exam_policies_acknowledged');
    return !hasAcknowledgedPolicies || !session?.startTime;
  },

  _requestExamPolicies() {
    const customPolicies = this._getExamPolicies();
    const modal = document.getElementById('exam-policies-modal');
    const list = document.getElementById('exam-policies-modal-list');
    const empty = document.getElementById('exam-policies-modal-empty');
    const professorCard = document.getElementById('exam-policies-modal-professor-card');
    const professorLine = document.getElementById('exam-policies-modal-professor');
    if (!modal || !list || !empty) {
      this._continueExamLaunch();
      return;
    }

    if (this.session) {
      const liveSession = DB.getSession(this.session.id);
      if (liveSession?.startTime) DB.updateSession(this.session.id, { startTime: null });
    }

    list.innerHTML = customPolicies.map(rule => `<li>${_esc(rule)}</li>`).join('');
    empty.style.display = customPolicies.length ? 'none' : '';
    if (professorLine) {
      const professor = DB.getAdminById(this.exam?.ownerAdminId);
      const professorName = String(professor?.name || DB.getSettings?.().adminName || '').trim();
      professorLine.textContent = professorName;
      if (professorCard) {
        professorCard.style.display = professorName ? '' : 'none';
      } else {
        professorLine.style.display = professorName ? '' : 'none';
      }
    }
    modal.classList.remove('hidden');
    lockBodyScroll();
  },

  acceptExamPolicies() {
    const modal = document.getElementById('exam-policies-modal');
    if (modal && !modal.classList.contains('hidden')) unlockBodyScroll();
    modal?.classList.add('hidden');
    const count = this._getExamPolicies().length;
    this._recordActivity('exam_policies_acknowledged', `Student acknowledged ${count} exam rule${count === 1 ? '' : 's'}`);
    this._continueExamLaunch();
  },

  exitExamPolicies() {
    const modal = document.getElementById('exam-policies-modal');
    if (modal && !modal.classList.contains('hidden')) unlockBodyScroll();
    modal?.classList.add('hidden');
    this.returnToLogin();
  },

  _continueExamLaunch() {
    const cameraExempt = this.session && DB.isStudentCameraExempt(this.exam?.id, this.session.studentId);
    this._cameraRequired = !!(this.exam && this.exam.requireCamera && !cameraExempt);
    if (this._cameraRequired && !this._webcamConsentAccepted) {
      this._requestWebcamConsent();
      return;
    }
    this._beginExamRuntime();
  },

  _beginExamRuntime() {
    if (this._examRuntimeStarted) return;
    this._examRuntimeStarted = true;
    this._remoteForceSubmitSessionId = null;
    this._rememberTrustedInteraction(2000);
    this._enableRefreshProtection();
    this._initConnectionMonitor();
    this._startSessionSyncPolling();
    this.requestFullscreen();
    this.initAntiCheat();
    this.startTimer();
    this.renderQuestions();
    this._restoreFontScale();
    this._scheduleFullscreenEnforcement();

    if (this._cameraRequired && this._webcamConsentAccepted) {
      this.initCamera();
    }
    // Verify display brightness with a perceptual check at the start of every
    // exam — the camera's ambient-light monitor only catches a dim screen
    // after the fact, so this check still runs even when the camera is on.
    this._startBrightnessCheck();
  },

  _ensureCameraMonitoringActive() {
    if (!this._cameraRequired || this._cameraStream || this._cameraReacquiring) return;
    this.initCamera();
  },

  _ensureCameraRequirementNoticeModal() {
    let modal = document.getElementById('camera-requirement-modal');
    if (modal) return modal;

    modal = document.createElement('div');
    modal.id = 'camera-requirement-modal';
    modal.className = 'modal-backdrop hidden';
    modal.innerHTML = `
      <div class="modal-dialog modal-sm">
        <div class="modal-body confirm-dialog">
          <div class="confirm-icon" id="camera-requirement-icon" style="background:#e8f5ec;">
            <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#0f5132" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M23 7l-7 5 7 5V7z" />
              <rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
            </svg>
          </div>
          <div class="confirm-title" id="camera-requirement-title">Camera Requirement Updated</div>
          <div class="confirm-message" id="camera-requirement-message">Your professor updated your webcam requirement.</div>
          <div class="confirm-actions">
            <button type="button" class="btn btn-primary examv2-interactive" id="camera-requirement-action-btn">Continue</button>
          </div>
        </div>
      </div>`;
    document.body.appendChild(modal);

    const actionBtn = modal.querySelector('#camera-requirement-action-btn');
    if (actionBtn) actionBtn.onclick = () => this.acknowledgeCameraRequirementNotice();

    return modal;
  },

  _showCameraRequirementNotice(mode) {
    this._pendingCameraRequirementNotice = mode;
    const modal = this._ensureCameraRequirementNoticeModal();
    const icon = document.getElementById('camera-requirement-icon');
    const title = document.getElementById('camera-requirement-title');
    const message = document.getElementById('camera-requirement-message');
    const actionBtn = document.getElementById('camera-requirement-action-btn');

    if (mode === 'disabled') {
      if (icon) {
        icon.style.background = '#e8f5ec';
        icon.innerHTML = `
          <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#0f5132" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M23 7l-7 5 7 5V7z" />
            <rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
          </svg>`;
      }
      if (title) title.textContent = 'Webcam Requirement Turned Off';
      if (message) message.textContent = 'Your professor allowed you to continue this exam without webcam monitoring. Your camera has been turned off.';
      if (actionBtn) actionBtn.textContent = 'Continue Exam';
    } else {
      if (icon) {
        icon.style.background = '#fff7e6';
        icon.innerHTML = `
          <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#9a6700" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M23 7l-7 5 7 5V7z" />
            <rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
            <path d="M12 9v4" />
            <path d="M12 17h.01" />
          </svg>`;
      }
      if (title) title.textContent = 'Webcam Requirement Turned Back On';
      if (message) message.textContent = 'Your professor requires webcam monitoring again. Turn your webcam back on to continue the exam.';
      if (actionBtn) actionBtn.textContent = 'Turn On Webcam';
    }

    modal.classList.remove('hidden');
    lockBodyScroll();
  },

  acknowledgeCameraRequirementNotice() {
    const mode = this._pendingCameraRequirementNotice;
    const modal = document.getElementById('camera-requirement-modal');
    if (modal && !modal.classList.contains('hidden')) {
      unlockBodyScroll();
      modal.classList.add('hidden');
    }
    this._pendingCameraRequirementNotice = null;

    if (mode === 'enabled') {
      if (this._webcamConsentAccepted) {
        this._ensureCameraMonitoringActive();
      } else {
        this._requestWebcamConsent();
      }
    }
  },

  _getLiveSession() {
    if (!this.session) return null;
    return DB.getSession(this.session.id)
      || (this.exam ? DB.getStudentSession(this.exam.id, this.session.studentId) : null)
      || null;
  },

  _isForceSubmittedSession(session) {
    const activities = Array.isArray(session?.activities) ? session.activities : [];
    return activities.some(activity => activity?.type === 'force_submit');
  },

  _startSessionSyncPolling() {
    if (this._sessionSyncTimer || !this.session) return;
    this._sessionSyncTimer = setInterval(() => {
      if (!this.session) return;
      this._pollRemoteSessionState();
      if (!this.session.submitted) this._pollRemoteExamState();
    }, 1200);
  },

  _stopSessionSyncPolling() {
    if (this._sessionSyncTimer) {
      clearInterval(this._sessionSyncTimer);
      this._sessionSyncTimer = null;
    }
  },

  _applyLiveSessionLocally(liveSession) {
    if (!liveSession?.id || !DB?.KEYS?.sessions || typeof DB._read !== 'function' || typeof DB._write !== 'function') return;
    const sessions = [...DB._read(DB.KEYS.sessions, [])];
    const index = sessions.findIndex(session => session.id === liveSession.id);
    if (index >= 0) sessions[index] = { ...sessions[index], ...liveSession };
    else sessions.push(liveSession);
    DB._write(DB.KEYS.sessions, sessions);
  },

  _applyLiveExamLocally(liveExam) {
    if (!liveExam?.id || !DB?.KEYS?.exams || typeof DB._read !== 'function' || typeof DB._write !== 'function') return;
    const exams = [...DB._read(DB.KEYS.exams, [])];
    const index = exams.findIndex(exam => exam.id === liveExam.id);
    if (index >= 0) exams[index] = { ...exams[index], ...liveExam };
    else exams.push(liveExam);
    DB._write(DB.KEYS.exams, exams);
  },

  _pollRemoteSessionState() {
    const client = window.SupabaseSync?._client || window.supabase;
    if (!client || !this.session?.id) return;
    client.from('sessions').select('*').eq('id', this.session.id).maybeSingle()
      .then(({ data, error }) => {
        if (error || !data) return;
        const normalized = window.SupabaseSync?._dbToJsSession
          ? window.SupabaseSync._dbToJsSession(data)
          : {
              ...this.session,
              submitted: !!data.submitted,
              autoSubmitted: !!data.auto_submitted,
              submitReason: data.submit_reason || null,
              endTime: data.end_time || null,
              warnings: Number(data.warnings || 0),
              activities: Array.isArray(data.activities) ? data.activities : [],
              answers: data.answers && typeof data.answers === 'object' ? data.answers : {},
              score: data.score ?? null,
              maxScore: data.max_score ?? null,
              scoreReleased: !!data.score_released,
            };
        this._applyLiveSessionLocally(normalized);
        this._syncLiveSessionState();
      })
      .catch(() => {});
  },

  _pollRemoteExamState() {
    const client = window.SupabaseSync?._client || window.supabase;
    if (!client || !this.exam?.id) return;
    client.from('exams').select('*').eq('id', this.exam.id).maybeSingle()
      .then(({ data, error }) => {
        if (error || !data) return;
        const normalized = window.SupabaseSync?._dbToJsExam
          ? window.SupabaseSync._dbToJsExam(data)
          : {
              ...this.exam,
              cameraExemptStudentIds: Array.isArray(data.camera_exempt_student_ids) ? data.camera_exempt_student_ids : [],
              requireCamera: !!data.require_camera,
              objectMonitoring: data.object_monitoring && typeof data.object_monitoring === 'object'
                ? data.object_monitoring
                : {},
            };
        this._applyLiveExamLocally(normalized);
        this.exam = DB.getExam(this.exam.id) || normalized;
        this._syncLiveExamStatus();
        this._syncYoloMonitoringForExam();
        this._syncCameraExemptionState();
      })
      .catch(() => {});
  },

  _syncLiveSessionState() {
    if (!this.exam || !this.session) return;
    const previousSession = this.session;
    const previousWarnings = Number(previousSession?.warnings || 0);
    const liveSession = this._getLiveSession();
    if (!liveSession) return;

    this.session = liveSession;
    if (liveSession.answers && typeof liveSession.answers === 'object') {
      this.answers = liveSession.answers;
    }
    if (typeof liveSession.warnings === 'number') {
      this.warnings = liveSession.warnings;
      const warningNumEl = document.getElementById('warning-num');
      if (warningNumEl) warningNumEl.textContent = this.warnings;
    }

    if (previousSession?.submitted && !liveSession.submitted) {
      this._showReviewReopenedState(liveSession);
      return;
    }

    if (!previousSession?.submitted && liveSession.submitted) {
      if (this._isForceSubmittedSession(liveSession)) {
        this._showForceSubmitModal(liveSession);
      } else {
        this._teardownActiveExamForRemoteSubmission(liveSession);
        this._showSubmitted(true);
      }
      return;
    }

    if (
      !liveSession.submitted
      && previousWarnings < 3
      && Number(liveSession.warnings || 0) >= 3
    ) {
      this.submitExam('auto');
    }
  },

  _showReviewReopenedState(liveSession) {
    this._pendingReviewReopen = true;
    this._examRuntimeStarted = false;
    this.session = liveSession;
    this.answers = liveSession.answers || this.answers || {};
    this.warnings = Number(liveSession.warnings || 0);
    this.showState('submitted');
    this._startSessionSyncPolling();

    const titleEl = document.getElementById('submitted-title');
    const msgEl = document.getElementById('submitted-msg');
    const iconWrap = document.getElementById('submitted-icon-wrap');
    const autoNote = document.getElementById('submitted-auto-note');
    const resumeBtn = document.getElementById('btn-resume-reopened-exam');
    const reviewBtn = document.getElementById('btn-review-answers');
    if (titleEl) titleEl.textContent = 'Exam Reopened';
    if (msgEl) msgEl.textContent = 'Your professor dismissed a webcam violation. Your warning was deducted and you may continue this attempt.';
    if (iconWrap) {
      iconWrap.innerHTML = _submittedIcon('success');
      iconWrap.className = 'submitted-icon-wrap success';
    }
    if (autoNote) {
      autoNote.classList.remove('hidden');
      autoNote.innerHTML = `
        <span class="submitted-auto-badge">${this._portalIcon('checkCircle', { size: 13, stroke: 'currentColor' })}<span>Professor reviewed replay</span></span>
        <span class="submitted-auto-text">Select Resume Reopened Exam to continue with your saved answers.</span>
      `;
    }
    if (resumeBtn) resumeBtn.style.display = '';
    if (reviewBtn) reviewBtn.style.display = 'none';
  },

  resumeReopenedExam() {
    const liveSession = this.session?.id ? (DB.getSession(this.session.id) || this.session) : null;
    if (!liveSession || liveSession.submitted || !this._pendingReviewReopen) return;
    this._pendingReviewReopen = false;
    this.session = liveSession;
    this.answers = liveSession.answers || {};
    this.warnings = Number(liveSession.warnings || 0);
    const resumeBtn = document.getElementById('btn-resume-reopened-exam');
    if (resumeBtn) resumeBtn.style.display = 'none';
    this._prepareExamShell();
    this._continueExamLaunch();
    this._showToast('Your exam is active again. Your saved answers have been restored.', 'success');
  },

  _teardownActiveExamForRemoteSubmission(liveSession) {
    this._stopSessionSyncPolling();
    this._disableRefreshProtection();
    this.stopTimer();
    this.destroyAntiCheat();
    this.stopPoll();
    this._pendingManualSubmit = false;
    this._intentionalFullscreenExit = true;
    this.session = liveSession || this.session;
    this.answers = liveSession?.answers && typeof liveSession.answers === 'object'
      ? liveSession.answers
      : this.answers;
    this.warnings = typeof liveSession?.warnings === 'number' ? liveSession.warnings : this.warnings;

    const warningNumEl = document.getElementById('warning-num');
    if (warningNumEl) warningNumEl.textContent = this.warnings;

    [
      'confirm-submit-modal',
      'confirm-logout-modal',
      'confirm-unenroll-modal',
      'camera-requirement-modal',
      'exam-policies-modal',
      'webcam-consent-modal',
      'webcam-decline-reason-modal',
      'violations-info-modal',
    ].forEach((id) => {
      const modal = document.getElementById(id);
      if (modal && !modal.classList.contains('hidden')) {
        unlockBodyScroll();
        modal.classList.add('hidden');
      }
    });

    const warningOverlay = document.getElementById('warning-overlay');
    if (warningOverlay) warningOverlay.style.display = 'none';
    const offlineOverlay = document.getElementById('offline-overlay');
    if (offlineOverlay) offlineOverlay.style.display = 'none';
    this._hideFullscreenLock();

    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
    } else if (document.webkitFullscreenElement) {
      document.webkitExitFullscreen && document.webkitExitFullscreen();
    }
  },

  _ensureForceSubmitModal() {
    let modal = document.getElementById('force-submit-modal');
    if (modal) return modal;

    modal = document.createElement('div');
    modal.id = 'force-submit-modal';
    modal.className = 'modal-backdrop hidden';
    modal.innerHTML = `
      <div class="modal-dialog modal-sm">
        <div class="modal-body confirm-dialog">
          <div class="confirm-icon" style="background:#fdecea;">
            <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#b3261e" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M12 9v4"/>
              <path d="M12 17h.01"/>
              <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
            </svg>
          </div>
          <div class="confirm-title" id="force-submit-title">Exam Force-Submitted</div>
          <div class="confirm-message" id="force-submit-message">Your professor has submitted your current answers and ended this attempt.</div>
          <div class="confirm-actions">
            <button type="button" class="btn btn-primary examv2-interactive" id="force-submit-view-result-btn">View Result</button>
          </div>
        </div>
      </div>`;
    document.body.appendChild(modal);

    const viewResultBtn = modal.querySelector('#force-submit-view-result-btn');
    if (viewResultBtn) viewResultBtn.onclick = () => this.acknowledgeForceSubmit();

    return modal;
  },

  _showForceSubmitModal(liveSession) {
    if (!liveSession || this._remoteForceSubmitSessionId === liveSession.id) return;
    this._remoteForceSubmitSessionId = liveSession.id;
    this._teardownActiveExamForRemoteSubmission(liveSession);

    const modal = this._ensureForceSubmitModal();
    const title = document.getElementById('force-submit-title');
    const message = document.getElementById('force-submit-message');
    if (title) title.textContent = 'Exam Force-Submitted';
    if (message) {
      message.textContent = 'Your professor has force-submitted your exam. Leave the exam now and continue to your result page.';
    }
    modal.classList.remove('hidden');
    lockBodyScroll();
  },

  acknowledgeForceSubmit() {
    const modal = document.getElementById('force-submit-modal');
    if (modal && !modal.classList.contains('hidden')) {
      unlockBodyScroll();
      modal.classList.add('hidden');
    }
    this._showSubmitted(true);
  },

  // ============================================================
  // IN-EXAM CHAT (student -> professor)
  // ============================================================
  _CHAT_REPORTS: [
    { key: 'webcam',   label: 'Webcam issue',      body: "I'm having a problem with my webcam." },
    { key: 'loading',  label: "Page won't load",   body: "A question or part of the exam isn't loading properly." },
    { key: 'question', label: 'Question unclear',  body: "I need clarification on one of the questions." },
    { key: 'other',    label: 'Other issue',       body: "I'm having a technical problem during the exam." },
  ],

  _ensureChatUI() {
    if (document.getElementById('exam-chat-fab')) return;

    const fab = document.createElement('button');
    fab.id = 'exam-chat-fab';
    fab.type = 'button';
    fab.className = 'exam-chat-fab examv2-interactive';
    fab.setAttribute('data-exam-control', 'true');
    fab.title = 'Message your professor';
    fab.setAttribute('aria-label', 'Message your professor');
    // Single chat icon that springs with a bounce on every click (open + close).
    fab.innerHTML = `
      <span class="exam-chat-fab-inner"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg></span>
      <span class="exam-chat-fab-badge" id="exam-chat-fab-badge" style="display:none;">0</span>`;
    fab.onclick = () => this._toggleChat();
    document.body.appendChild(fab);

    const panel = document.createElement('div');
    panel.id = 'exam-chat-panel';
    panel.className = 'exam-chat-panel examv2-interactive';
    panel.setAttribute('data-exam-control', 'true');
    panel.style.display = 'none';
    panel.innerHTML = `
      <div class="exam-chat-header">
        <div class="exam-chat-header-title">
          <span class="exam-chat-header-dot"></span>
          <div>
            <div class="exam-chat-header-name">Your Professor</div>
            <div class="exam-chat-header-sub">Ask about tech issues or clarifications</div>
          </div>
        </div>
        <button type="button" class="exam-chat-close examv2-interactive" data-exam-control="true" aria-label="Close chat">&#10005;</button>
      </div>
      <div class="exam-chat-body" id="exam-chat-messages"></div>
      <div class="exam-chat-reports" id="exam-chat-reports"></div>
      <div class="exam-chat-composer">
        <textarea id="exam-chat-input" class="exam-chat-input examv2-interactive" data-exam-control="true" rows="1" placeholder="Type a message to your professor..." maxlength="1000"></textarea>
        <button type="button" id="exam-chat-send" class="exam-chat-send examv2-interactive" data-exam-control="true" aria-label="Send message">
          <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
        </button>
      </div>`;
    document.body.appendChild(panel);

    panel.querySelector('.exam-chat-close').onclick = () => this._toggleChat(false);
    panel.querySelector('#exam-chat-send').onclick = () => this._sendChatMessage();
    const input = panel.querySelector('#exam-chat-input');
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); this._sendChatMessage(); }
    });

    const reportsWrap = panel.querySelector('#exam-chat-reports');
    reportsWrap.innerHTML = `<div class="exam-chat-reports-label">Report a problem</div>`
      + this._CHAT_REPORTS.map(r =>
          `<button type="button" class="exam-chat-report-btn examv2-interactive" data-exam-control="true" data-report="${r.key}">${_esc(r.label)}</button>`
        ).join('');
    reportsWrap.querySelectorAll('.exam-chat-report-btn').forEach(btn => {
      btn.onclick = () => this._stageReport(btn.dataset.report);
    });
  },

  _toggleChat(force) {
    const panel = document.getElementById('exam-chat-panel');
    const fab = document.getElementById('exam-chat-fab');
    if (!panel || !fab) return;
    const open = typeof force === 'boolean' ? force : panel.style.display === 'none';
    panel.style.display = open ? 'flex' : 'none';
    fab.classList.toggle('active', open);
    // Replay the springy bounce on every click (opening AND closing) — restart
    // the CSS animation by removing the class, forcing reflow, then re-adding it.
    const inner = fab.querySelector('.exam-chat-fab-inner');
    if (inner) { fab.classList.remove('bounce'); void fab.offsetWidth; fab.classList.add('bounce'); }
    if (open) {
      this._rememberTrustedInteraction(1500);
      this._renderChatMessages();
      this._refreshChatMessagesFromSync();
      // Reading the thread clears the professor's unread messages for this student.
      if (this.exam && this.session) {
        DB.markMessagesRead(this.exam.id, this.session.studentId, 'professor');
      }
      this._updateChatBadge();
      const body = document.getElementById('exam-chat-messages');
      if (body) body.scrollTop = body.scrollHeight;
      setTimeout(() => document.getElementById('exam-chat-input')?.focus(), 50);
    }
  },

  _chatMessages() {
    if (!this.exam || !this.session) return [];
    return DB.getMessagesForExamStudent(this.exam.id, this.session.studentId);
  },

  _isWebcamDeclineRequestMessage(message) {
    const category = String(message?.reportCategory || '').trim().toLowerCase();
    return !!(
      message
      && message.senderRole === 'student'
      && message.type === 'report'
      && (category === 'webcam_consent_decline' || category === 'webcam')
    );
  },

  _isWebcamDecisionMessage(message) {
    return !!(
      message
      && message.senderRole === 'professor'
      && message.type === 'webcam_decision'
      && ['allow', 'deny'].includes(message.reportCategory)
    );
  },

  _getWebcamDecisionForRequest(requestMessage, messages = null) {
    if (!this._isWebcamDeclineRequestMessage(requestMessage)) return null;
    const thread = Array.isArray(messages) ? messages : this._chatMessages();
    const requestAt = new Date(requestMessage.createdAt || 0).getTime();
    const nextRequestAt = thread
      .filter(message => this._isWebcamDeclineRequestMessage(message) && message.id !== requestMessage.id)
      .map(message => new Date(message.createdAt || 0).getTime())
      .filter(timestamp => Number.isFinite(timestamp) && timestamp > requestAt)
      .sort((a, b) => a - b)[0];

    const decisions = thread
      .filter(message => this._isWebcamDecisionMessage(message))
      .filter(message => {
        const decisionAt = new Date(message.createdAt || 0).getTime();
        if (!Number.isFinite(decisionAt) || decisionAt < requestAt) return false;
        return !Number.isFinite(nextRequestAt) || decisionAt < nextRequestAt;
      })
      .sort((a, b) => new Date(a.createdAt || 0).getTime() - new Date(b.createdAt || 0).getTime());

    return decisions[decisions.length - 1] || null;
  },

  _handleIncomingWebcamDecision() {
    const messages = this._chatMessages();
    const latestRequest = [...messages].reverse().find(message => this._isWebcamDeclineRequestMessage(message));
    if (!latestRequest) return;
    const decision = this._getWebcamDecisionForRequest(latestRequest, messages);
    if (!decision || decision.id === this._lastHandledWebcamDecisionId) return;
    this._lastHandledWebcamDecisionId = decision.id;
    if (decision.reportCategory === 'deny') {
      this._hideWebcamWaitNoticeModal();
      this._hideWebcamWaitOverlay();
      this._showWebcamDeniedDecisionModal();
    }
  },

  _renderChatMessages() {
    const body = document.getElementById('exam-chat-messages');
    if (!body) return;
    const messages = this._chatMessages();
    if (!messages.length) {
      body.innerHTML = `<div class="exam-chat-empty">
        <svg xmlns="http://www.w3.org/2000/svg" width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
        <p>No messages yet. Send your professor a message if you run into a problem or need a clarification.</p>
      </div>`;
      return;
    }
    const wasAtBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 40;
    body.innerHTML = messages.map(m => {
      const mine = m.senderRole === 'student';
      const time = m.createdAt ? new Date(m.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
      if (this._isWebcamDecisionMessage(m)) {
        const allowed = m.reportCategory === 'allow';
        const icon = allowed
          ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>'
          : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M18.36 6.64a9 9 0 1 1-12.73 0"/><path d="M12 8v4"/><path d="M12 16h.01"/></svg>';
        return `<div class="exam-chat-msg report">
          <div class="exam-chat-report-bubble is-decision ${allowed ? 'is-allow' : 'is-deny'}">
            <span class="exam-chat-report-tag">${icon}${allowed ? 'Professor allowed webcam off' : 'Professor denied webcam off'}</span>
            <span class="exam-chat-report-copy">${_esc(m.body || '')}</span>
          </div>
          <div class="exam-chat-time">${_esc(time)}</div>
        </div>`;
      }
      if (m.type === 'report') {
        return `<div class="exam-chat-msg report">
          <div class="exam-chat-report-bubble">
            <span class="exam-chat-report-tag"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>Reported</span>
            <span class="exam-chat-report-copy">${_esc(m.body || 'Problem reported')}</span>
          </div>
          <div class="exam-chat-time">${_esc(time)}</div>
        </div>`;
      }
      return `<div class="exam-chat-msg ${mine ? 'mine' : 'theirs'}">
        <div class="exam-chat-bubble">${_esc(m.body || '')}</div>
        <div class="exam-chat-time">${mine ? 'You' : 'Professor'} &middot; ${_esc(time)}</div>
      </div>`;
    }).join('');
    if (wasAtBottom) body.scrollTop = body.scrollHeight;
  },

  _updateChatBadge() {
    const badge = document.getElementById('exam-chat-fab-badge');
    if (!badge) return;
    const panelOpen = document.getElementById('exam-chat-panel')?.style.display === 'flex';
    const unread = panelOpen ? 0 : this._chatMessages().filter(m => m.senderRole === 'professor' && !m.readAt).length;
    if (unread > 0) {
      badge.textContent = unread > 9 ? '9+' : String(unread);
      badge.style.display = '';
    } else {
      badge.style.display = 'none';
    }
  },

  _refreshChatMessagesFromSync() {
    if (!this.exam || !this.session || !window.SupabaseSync?._pullMessages) return Promise.resolve();
    return Promise.resolve(SupabaseSync._pullMessages({ studentId: this.session.studentId }))
      .then((changed) => {
        if (!changed) return;
        this._renderChatMessages();
        const panelOpen = document.getElementById('exam-chat-panel')?.style.display === 'flex';
        if (panelOpen) DB.markMessagesRead(this.exam.id, this.session.studentId, 'professor');
        this._updateChatBadge();
      })
      .catch(() => {});
  },

  _startChatSyncPolling() {
    if (this._chatPollTimer || !this.exam || !this.session) return;
    if (!window.SupabaseSync?._pullMessages) return;
    this._chatPollTimer = setInterval(() => {
      const chatAllowed = !document.getElementById('state-exam')?.classList.contains('hidden')
        || !document.getElementById('state-submitted')?.classList.contains('hidden');
      if (!chatAllowed || !this.exam || !this.session) return;
      this._refreshChatMessagesFromSync();
    }, 1200);
  },

  _stopChatSyncPolling() {
    if (this._chatPollTimer) {
      clearInterval(this._chatPollTimer);
      this._chatPollTimer = null;
    }
  },

  _sendChatMessage() {
    const input = document.getElementById('exam-chat-input');
    if (!input || !this.exam || !this.session) return;
    const text = (input.value || '').trim();
    if (!text) return;
    this._rememberTrustedInteraction(1500);
    // If the text was staged from a "Report a problem" chip (and left intact),
    // send it as a categorised report; otherwise it's a plain message.
    const pending = this._pendingReport;
    const asReport = pending && pending.body === text;
    DB.addMessage({
      ownerAdminId: this.exam.ownerAdminId || null,
      professorId: this.exam.ownerAdminId || null,
      studentId: this.session.studentId,
      studentName: this.session.studentName,
      examId: this.exam.id,
      sessionId: this.session.id,
      senderRole: 'student',
      type: asReport ? 'report' : 'message',
      reportCategory: asReport ? pending.key : undefined,
      body: text,
    });
    this._pendingReport = null;
    input.value = '';
    this._renderChatMessages();
    const body = document.getElementById('exam-chat-messages');
    if (body) body.scrollTop = body.scrollHeight;
  },

  // Clicking a "Report a problem" chip DOES NOT send — it drops the report text
  // into the composer so the student can review/edit, then send it themselves.
  _stageReport(key) {
    const report = this._CHAT_REPORTS.find(r => r.key === key);
    const input = document.getElementById('exam-chat-input');
    if (!report || !input) return;
    this._rememberTrustedInteraction(1500);
    this._pendingReport = { key, body: report.body };
    input.value = report.body;
    input.focus();
    try { input.setSelectionRange(input.value.length, input.value.length); } catch (_) {}
  },

  // Called from the global acsDataChanged listener while an exam is in progress.
  _handleExamDataChange(table) {
    if (table === 'sessions') {
      this._syncLiveSessionState();
      return;
    }
    // Exam closure is authoritative even while the student is still reading
    // rules or granting camera access, before the active exam screen appears.
    if (table === 'exams') this._syncLiveExamStatus();
    // Keep the chat live on both the active-exam and post-submit screens.
    const chatVisible = !document.getElementById('state-exam')?.classList.contains('hidden')
      || !document.getElementById('state-submitted')?.classList.contains('hidden');
    if (!chatVisible || !this.exam || !this.session) return;
    if (table === 'messages') {
      this._renderChatMessages();
      this._handleIncomingWebcamDecision();
      const panelOpen = document.getElementById('exam-chat-panel')?.style.display === 'flex';
      if (panelOpen) DB.markMessagesRead(this.exam.id, this.session.studentId, 'professor');
      this._updateChatBadge();
    } else if (table === 'exams') {
      this._syncCameraExemptionState();
    }
  },

  _syncLiveExamStatus() {
    if (!this.exam || !this.session) return;
    const liveExam = DB.getExam(this.exam.id);
    if (liveExam) this.exam = liveExam;
    const liveSession = this._getLiveSession();
    if (this.exam.status !== 'closed' || liveSession?.submitted) return;

    const startedAt = this.exam.startedAt ? new Date(this.exam.startedAt).getTime() : NaN;
    const durationMinutes = Number(this.exam.timeLimit);
    const deadline = Number.isFinite(startedAt) && Number.isFinite(durationMinutes)
      ? startedAt + durationMinutes * 60 * 1000
      : NaN;
    this._teardownActiveExamForRemoteSubmission(liveSession || this.session);
    this.submitExam(Number.isFinite(deadline) && Date.now() >= deadline ? 'timeout' : 'exam_closed');
  },

  // Keeps live camera enforcement in sync with the professor's exemption toggle
  // (set from the in-exam chat). Handles BOTH directions: granting an exemption
  // mid-exam tears down the live webcam, and revoking it later must bring the
  // camera requirement back — previously only the "grant" direction was handled,
  // so "Re-enable webcam" never actually resumed monitoring on the student's side.
  _syncCameraExemptionState() {
    if (!this.exam || !this.session || !this.exam.requireCamera) return;
    const examVisible = !document.getElementById('state-exam')?.classList.contains('hidden');
    if (!examVisible) return;
    const nowExempt = DB.isStudentCameraExempt(this.exam.id, this.session.studentId);
    if (nowExempt && this._cameraRequired) {
      this._cameraRequired = false;
      this.stopCamera();
      const camOff = document.getElementById('camera-off-overlay');
      if (camOff) camOff.style.display = 'none';
      const motion = document.getElementById('motion-warning-overlay');
      if (motion) motion.style.display = 'none';
      // The exemption answers any pending consent prompt — don't leave it hanging.
      const consentModal = document.getElementById('webcam-consent-modal');
      if (consentModal && !consentModal.classList.contains('hidden')) { unlockBodyScroll(); consentModal.classList.add('hidden'); }
      const reasonModal = document.getElementById('webcam-decline-reason-modal');
      if (reasonModal && !reasonModal.classList.contains('hidden')) { unlockBodyScroll(); reasonModal.classList.add('hidden'); }
      this._hideWebcamWaitNoticeModal();
      this._hideWebcamDeniedDecisionModal();
      this._hideWebcamWaitOverlay();
      this._showCameraRequirementNotice('disabled');
      if (!this._examRuntimeStarted) {
        this._beginExamRuntime();
      }
    } else if (!nowExempt && !this._cameraRequired) {
      // Professor turned the requirement back on — re-request consent before the
      // webcam is reactivated (a camera is never turned on without consent).
      this._cameraRequired = true;
      this._hideWebcamWaitOverlay();
      this._showCameraRequirementNotice('enabled');
    }
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
    const COUNTDOWN_SECS = 7;

    const doReturn = () => {
      this._stopFullscreenLockCountdown();
      this.requestFullscreen().then((ok) => {
        if (ok && this._isFullscreenActive()) {
          if (overlay) overlay.style.display = 'none';
        }
      });
    };

    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'fs-lock-overlay';
      overlay.innerHTML = `
        <div style="text-align:center;padding:40px 32px;max-width:420px;">
          <div style="width:64px;height:64px;border-radius:50%;background:rgba(255,255,255,0.1);display:flex;align-items:center;justify-content:center;margin:0 auto 20px;">
            <svg xmlns="http://www.w3.org/2000/svg" width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
          </div>
          <h2 style="font-size:22px;font-weight:800;color:#fff;margin-bottom:10px;">Fullscreen Required</h2>
          <p style="font-size:14px;color:rgba(255,255,255,0.7);margin-bottom:8px;line-height:1.6;">
            This exam must be taken in fullscreen mode.<br>
            Exiting fullscreen has been recorded as a violation.
          </p>
          <div id="fs-countdown-wrap" style="margin:18px auto 22px;width:90px;height:90px;position:relative;">
            <svg viewBox="0 0 90 90" style="width:90px;height:90px;transform:rotate(-90deg);">
              <circle cx="45" cy="45" r="38" fill="none" stroke="rgba(255,255,255,0.15)" stroke-width="6"/>
              <circle id="fs-cd-ring" cx="45" cy="45" r="38" fill="none" stroke="#ef4444" stroke-width="6"
                stroke-dasharray="238.76" stroke-dashoffset="0"
                style="transition:stroke-dashoffset 1s linear,stroke 0.3s;"/>
            </svg>
            <div style="position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;">
              <span id="fs-cd-num" style="font-size:28px;font-weight:900;color:#fff;line-height:1;">${COUNTDOWN_SECS}</span>
              <span style="font-size:10px;color:rgba(255,255,255,0.5);letter-spacing:1px;margin-top:2px;">SEC</span>
            </div>
          </div>
          <p style="font-size:12px;color:rgba(255,255,255,0.5);margin-bottom:20px;">
            Exam will be <strong style="color:#ef4444;">auto-submitted</strong> if you don't return to fullscreen
          </p>
          <button id="fs-return-btn" style="background:#fff;color:#0f2d1a;border:none;padding:12px 36px;border-radius:10px;font-size:15px;font-weight:800;cursor:pointer;font-family:inherit;box-shadow:0 4px 14px rgba(0,0,0,0.3);">
            Return to Fullscreen
          </button>
        </div>`;
      overlay.style.cssText = 'position:fixed;inset:0;background:#060e08;z-index:999999;display:flex;align-items:center;justify-content:center;';
      document.body.appendChild(overlay);
    } else {
      overlay.style.display = 'flex';
    }

    document.getElementById('fs-return-btn').onclick = doReturn;

    // Keep one deadline-based countdown alive even if the browser fires
    // repeated fullscreen/visibility events while already out of fullscreen.
    if (this.warnings < 3) {
      this._startDeadlineCountdown({
        timerKey: '_fullscreenLockTimer',
        tokenKey: '_fullscreenLockToken',
        deadlineKey: '_fullscreenLockDeadline',
        totalKey: '_fullscreenLockTotalSeconds',
        totalSeconds: COUNTDOWN_SECS,
        preserveExisting: true,
        onUpdate: (remaining, msRemaining, activeTotalSeconds, totalMs) => {
          const ring = document.getElementById('fs-cd-ring');
          const num = document.getElementById('fs-cd-num');
          if (num) num.textContent = remaining;
          if (ring) {
            const offset = 238.76 * ((totalMs - msRemaining) / totalMs);
            ring.style.strokeDashoffset = String(offset);
            ring.style.stroke = remaining <= 3 ? '#ef4444' : remaining <= 5 ? '#f59e0b' : '#22c55e';
          }
        },
        onExpire: () => {
          if (!this._isFullscreenActive()) this.submitExam('auto');
        },
      });
    }
  },

  _hideFullscreenLock() {
    const overlay = document.getElementById('fs-lock-overlay');
    if (!overlay) return;
    this._stopFullscreenLockCountdown();
    overlay.style.display = 'none';
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
        // Grace period: a brightness/display re-sync can fire a spurious
        // hidden→visible blip. Only act if the tab is STILL hidden shortly after.
        if (this._visTimer) clearTimeout(this._visTimer);
        this._visTimer = setTimeout(() => {
          this._visTimer = null;
          if (!document.hidden) return; // recovered on its own — ignore
          if (this._inReadCountdown) {
            this._cancelReadCountdown();
            this.startCountdown(10);
          } else {
            this.issueWarning('tab_switch', 'Tab or window switched');
          }
        }, 300);
      } else {
        if (this._visTimer) { clearTimeout(this._visTimer); this._visTimer = null; }
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
        // Grace period: changing screen brightness / HDR on some laptops makes
        // the display briefly drop and re-enter fullscreen, firing a spurious
        // exit→enter pair. Only treat it as a real exit if fullscreen is STILL
        // gone a moment later — otherwise it just flickers the warning overlay.
        if (this._fsLossTimer) clearTimeout(this._fsLossTimer);
        this._fsLossTimer = setTimeout(() => {
          this._fsLossTimer = null;
          if (this._isFullscreenActive()) return; // recovered on its own — ignore
          this.issueWarning('fullscreen_exit', 'Fullscreen mode exited');
          this._showFullscreenLock();
        }, 500);
      } else {
        if (this._fsLossTimer) { clearTimeout(this._fsLossTimer); this._fsLossTimer = null; }
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
      if (e.key === 'PrintScreen') {
        // The OS-level Win+PrintScreen capture (and PrintScreen alone) fires
        // outside the browser's control — preventDefault() can't stop the
        // capture itself, but the PrintScreen keydown still reaches us and
        // is a reliable signal that a screenshot was just taken.
        e.preventDefault();
        this.issueWarning('screenshot', 'PrintScreen key pressed — possible screenshot attempt');
      }
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
  // Privacy notice + consent gate — shown before the webcam is ever activated.
  // Explains why monitoring is required, what is collected, and how it is
  // used, and requires an explicit "Allow" before initCamera() runs.
  _requestWebcamConsent() {
    const modal = document.getElementById('webcam-consent-modal');
    if (!modal) {
      this._webcamConsentAccepted = true;
      if (this._examRuntimeStarted) this._ensureCameraMonitoringActive();
      else this._beginExamRuntime();
      return;
    } // fallback if markup is missing
    modal.classList.remove('hidden');
    lockBodyScroll();
  },

  acceptWebcamConsent() {
    const modal = document.getElementById('webcam-consent-modal');
    if (modal && !modal.classList.contains('hidden')) unlockBodyScroll();
    modal?.classList.add('hidden');
    this._webcamConsentAccepted = true;
    this._recordActivity('camera_consent_given', 'Student consented to webcam monitoring');
    if (this._examRuntimeStarted) this._ensureCameraMonitoringActive();
    else this._beginExamRuntime();
  },

  declineWebcamConsent() {
    const modal = document.getElementById('webcam-consent-modal');
    if (modal && !modal.classList.contains('hidden')) unlockBodyScroll();
    modal?.classList.add('hidden');
    this._recordActivity('camera_consent_declined', 'Student declined webcam monitoring consent');

    // Camera is required for this exam, but the student has explicitly declined
    // and is about to report it to their professor — show a quiet blocked
    // indicator only. Do NOT start the camera watchdog here: that would trigger
    // the full-screen "Camera Is Off" overlay and rack up camera_off violations
    // for something that isn't an accidental camera drop. The professor can
    // grant a camera exemption from the chat, which tears this state down via
    // _syncCameraExemptionState()/stopCamera().
    const container = document.getElementById('camera-container');
    const blockedMsg = document.getElementById('camera-blocked-msg');
    const statusText = document.getElementById('camera-status-text');
    if (container) container.style.display = '';
    if (blockedMsg) blockedMsg.style.display = 'flex';
    if (statusText) statusText.textContent = 'Camera denied';

    // Give the student a chance to tell their professor why, so the professor
    // can grant a camera exemption from the in-exam chat if warranted.
    const reasonModal = document.getElementById('webcam-decline-reason-modal');
    if (reasonModal) {
      const textarea = document.getElementById('webcam-decline-reason-input');
      if (textarea) textarea.value = '';
      reasonModal.classList.remove('hidden');
      lockBodyScroll();
      setTimeout(() => textarea?.focus(), 50);
    }
  },

  // The student has no professor permission to continue without a webcam, so
  // the only alternative to reporting a reason is leaving the exam entirely.
  exitWebcamDecline() {
    const reasonModal = document.getElementById('webcam-decline-reason-modal');
    if (reasonModal && !reasonModal.classList.contains('hidden')) unlockBodyScroll();
    reasonModal?.classList.add('hidden');
    this._hideWebcamWaitNoticeModal();
    this._hideWebcamDeniedDecisionModal();
    this._hideWebcamWaitOverlay();
    this.returnToLogin();
  },

  sendWebcamReport() {
    const textarea = document.getElementById('webcam-decline-reason-input');
    const text = (textarea?.value || '').trim();
    if (!text) {
      this._showToast('Please tell your professor why before sending.', 'error');
      textarea?.focus();
      return;
    }

    const modal = document.getElementById('webcam-decline-reason-modal');
    if (modal && !modal.classList.contains('hidden')) unlockBodyScroll();
    modal?.classList.add('hidden');
    if (!this.exam || !this.session) return;

    // Sent as a "report" (reusing the existing webcam report category) so it
    // surfaces in the professor's chat with a notification, same as any other
    // reported problem — the professor can then grant a camera exemption.
    DB.addMessage({
      ownerAdminId: this.exam.ownerAdminId || null,
      professorId: this.exam.ownerAdminId || null,
      studentId: this.session.studentId,
      studentName: this.session.studentName,
      examId: this.exam.id,
      sessionId: this.session.id,
      senderRole: 'student',
      type: 'report',
      reportCategory: 'webcam_consent_decline',
      body: text,
    });
    this._lastHandledWebcamDecisionId = null;
    this._renderChatMessages();
    this._updateChatBadge();
    this._showToast('Sent to your professor.', 'success');
    this._showWebcamWaitNoticeModal();
  },

  _showWebcamWaitOverlay() {
    const overlay = document.getElementById('webcam-wait-overlay');
    if (overlay) overlay.style.display = 'flex';
    this._startWebcamWaitPoll();
  },

  _hideWebcamWaitOverlay() {
    const overlay = document.getElementById('webcam-wait-overlay');
    if (overlay) overlay.style.display = 'none';
    this._stopWebcamWaitPoll();
  },

  _showWebcamWaitNoticeModal() {
    const modal = document.getElementById('webcam-wait-notice-modal');
    if (!modal) {
      this._showWebcamWaitOverlay();
      return;
    }
    modal.classList.remove('hidden');
    lockBodyScroll();
  },

  _hideWebcamWaitNoticeModal() {
    const modal = document.getElementById('webcam-wait-notice-modal');
    if (modal && !modal.classList.contains('hidden')) unlockBodyScroll();
    modal?.classList.add('hidden');
  },

  confirmWebcamWaitNotice() {
    this._hideWebcamWaitNoticeModal();
    this._showWebcamWaitOverlay();
  },

  _showWebcamDeniedDecisionModal() {
    const modal = document.getElementById('webcam-denied-modal');
    if (!modal) return;
    modal.classList.remove('hidden');
    lockBodyScroll();
  },

  _hideWebcamDeniedDecisionModal() {
    const modal = document.getElementById('webcam-denied-modal');
    if (modal && !modal.classList.contains('hidden')) unlockBodyScroll();
    modal?.classList.add('hidden');
  },

  turnOnCameraAfterWebcamDenied() {
    this._hideWebcamDeniedDecisionModal();
    this._webcamConsentAccepted = false;
    this._requestWebcamConsent();
  },

  // Realtime alone isn't trusted here: a professor's "Re-enable webcam" /
  // exemption toggle updates the exams row, but that postgres_changes event
  // can silently miss the student's socket (see refreshExams()'s own comment
  // about the realtime socket dropping) — leaving the student stuck on this
  // screen until they refresh. Poll a direct exam refetch instead, so the
  // professor's decision is picked up within a few seconds either way.
  _startWebcamWaitPoll() {
    if (this._webcamWaitPoll) return;
    this._webcamWaitPoll = setInterval(async () => {
      if (!this.exam || !this.session) return;
      try {
        if (window.SupabaseSync?.refreshExams) await window.SupabaseSync.refreshExams();
      } catch (_) { /* best-effort — next tick retries */ }
      this._syncCameraExemptionState();
    }, 3000);
  },

  _stopWebcamWaitPoll() {
    if (this._webcamWaitPoll) { clearInterval(this._webcamWaitPoll); this._webcamWaitPoll = null; }
  },

  async initCamera() {
    const container = document.getElementById('camera-container');
    const video = document.getElementById('camera-feed');
    const statusText = document.getElementById('camera-status-text');
    const blockedMsg = document.getElementById('camera-blocked-msg');
    if (!container || !video) return;

    container.style.display = '';
    this._cameraPrompting = true;

    // Model/session initialization is the slow part of object detection. Start
    // it while the browser is opening the webcam so the first frame can be
    // scanned as soon as the video becomes readable.
    this._startYoloObjectMonitoring(video);

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 960 }, height: { ideal: 720 }, facingMode: 'user' },
        audio: false,
      });
      this._cameraPrompting = false;
      this._cameraStream = stream;
      this._startViolationReplayBuffer();
      if (statusText) statusText.textContent = 'Monitoring';
      if (blockedMsg) blockedMsg.style.display = 'none';
      this._startCameraWatchdog();

      // Wait for video to be ready before starting presence checks. Object
      // detection has already been warming in parallel with camera startup.
      let cameraReadyHandled = false;
      const handleCameraReady = () => {
        if (cameraReadyHandled) return;
        cameraReadyHandled = true;
        if (!this._yoloMonitor) this._startYoloObjectMonitoring(video);
        if (statusText) statusText.textContent = 'Loading face detection...';
        // Basic motion monitoring starts immediately. Face detection upgrades
        // it in the background once TensorFlow and BlazeFace are available.
        setTimeout(() => this._checkInitialPresence(video), 500);
        this._loadFaceDetectionModel().then(() => {
          if (statusText) statusText.textContent = 'Face detection ready';
        }).catch(error => {
          this._faceModelReady = false;
          if (statusText) statusText.textContent = 'Monitoring';
          console.warn('[Camera] Face detection fallback active:', error?.message || error);
        });
      };
      video.onloadeddata = handleCameraReady;
      video.srcObject = stream;
      video.play().catch(() => {});
      if (video.readyState >= 2) handleCameraReady();
    } catch (err) {
      this._cameraPrompting = false;
      if (statusText) statusText.textContent = 'Camera denied';
      if (blockedMsg) blockedMsg.style.display = 'flex';
      this._recordActivity('camera_denied', 'Camera permission denied: ' + err.message);
      // Keep watching — the overlay blocks the exam and retries the camera
      // until the student re-enables it.
      this._startCameraWatchdog();
    }
  },

  _loadFaceDetectionModel() {
    if (this._faceModelReady && this._faceModel) return Promise.resolve(this._faceModel);
    if (this._faceModelPromise) return this._faceModelPromise;

    this._faceModelPromise = loadExamScript('https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.2.0/dist/tf.min.js')
      .then(() => loadExamScript('https://cdn.jsdelivr.net/npm/@tensorflow-models/blazeface@0.0.7/dist/blazeface.min.js'))
      .then(() => {
        if (!window.blazeface?.load) throw new Error('BlazeFace did not initialize.');
        return window.blazeface.load();
      })
      .then(model => {
        this._faceModel = model;
        this._faceModelReady = true;
        return model;
      })
      .catch(error => {
        this._faceModelPromise = null;
        throw error;
      });
    return this._faceModelPromise;
  },

  _getObjectMonitoringConfig() {
    const raw = this.exam?.objectMonitoring || {};
    if (window.YoloProctor?.normalizeConfig) {
      return {
        ...window.YoloProctor.normalizeConfig(raw),
        enabled: !!this.exam?.requireCamera,
        mode: 'enforce',
      };
    }
    return {
      enabled: !!this.exam?.requireCamera,
      mode: 'enforce',
    };
  },

  _preloadYoloObjectModel() {
    if (
      !this.exam?.requireCamera
      || !window.YoloProctor?.preloadModel
      || this._yoloPreloadPromise
    ) return;

    // Begin fetching as soon as the exam is known. Waiting for an idle callback
    // added up to four seconds before the model download even started.
    this._yoloPreloadPromise = window.YoloProctor.preloadModel('/models/yolo-proctor-v1.json')
      .then(details => (
        details?.modelProfile === 'coco'
          ? window.YoloProctor.preloadModel('/models/yolo-phone-specialist-v1.json')
          : details
      ))
      .catch(error => {
        this._yoloPreloadPromise = null;
        console.warn('[YOLO] Model preload failed; startup will retry:', error?.message || error);
      });
  },

  _setYoloStatus(state, detail = {}) {
    this._yoloStatus = state;
    this._yoloStatusDetail = detail;
    const container = document.getElementById('camera-container');
    if (!container) return;
    container.dataset.objectDetection = state;
    const indicator = document.getElementById('yolo-camera-status');
    const labels = {
      idle: 'Object scan off',
      loading: 'Object scan loading',
      ready: 'Object scan active',
      degraded: 'Object scan retrying',
      error: 'Object scan unavailable',
    };
    if (indicator) {
      indicator.dataset.state = state;
      indicator.textContent = labels[state] || 'Object scan unavailable';
      indicator.title = detail.message || indicator.textContent;
    }
    container.title = state === 'ready'
      ? 'Object detection active.'
      : state === 'error'
        ? 'Object detection unavailable; standard camera monitoring remains active.'
        : '';
  },

  async _startYoloObjectMonitoring(video) {
    if (this._yoloStarting) return;
    this._stopYoloObjectMonitoring();
    if (!this.exam?.requireCamera || !video) return;
    const generation = this._yoloStartGeneration;
    this._yoloStarting = true;
    this._setYoloStatus('loading');

    try {
      await window.YoloProctor?.load?.();
    } catch (error) {
      if (generation !== this._yoloStartGeneration) return;
      this._setYoloStatus('error');
      console.warn('[YOLO] Object monitoring runtime is unavailable:', error?.message || error);
      return;
    } finally {
      if (generation === this._yoloStartGeneration) this._yoloStarting = false;
    }
    if (generation !== this._yoloStartGeneration) return;

    const config = this._getObjectMonitoringConfig();
    if (!config.enabled) return;
    if (!window.YoloProctor?.createMonitor || !window.YoloProctor?.createPolicy) {
      this._setYoloStatus('error');
      console.warn('[YOLO] Object monitoring runtime is unavailable.');
      return;
    }

    this._yoloPolicy = window.YoloProctor.createPolicy(config);
    this._yoloConfigSignature = JSON.stringify(config);
    this._yoloMonitor = window.YoloProctor.createMonitor({
      video,
      manifestUrl: '/models/yolo-proctor-v1.json',
      onStatus: status => {
        this._setYoloStatus(status.state || 'unknown', status);
        if (
          status.state === 'ready'
          && status.modelProfile === 'coco'
          && generation === this._yoloStartGeneration
        ) {
          this._startYoloPhoneSpecialist(video, generation);
        }
        if (status.state === 'error') {
          console.warn('[YOLO] Object monitoring disabled:', status.message || 'Model unavailable');
        }
      },
      onResult: result => this._handleYoloResult(result),
    });

    try {
      await this._yoloMonitor.start();
    } catch (error) {
      this._setYoloStatus('error');
      this._yoloMonitor?.stop();
      this._yoloMonitor = null;
      console.warn('[YOLO] Unable to start object monitoring:', error?.message || error);
    }
  },

  async _startYoloPhoneSpecialist(video, generation) {
    if (
      this._yoloPhoneMonitor
      || generation !== this._yoloStartGeneration
      || !this.exam?.requireCamera
      || !video
    ) return;

    const monitor = window.YoloProctor.createMonitor({
      video,
      manifestUrl: '/models/yolo-phone-specialist-v1.json',
      onStatus: status => {
        if (generation !== this._yoloStartGeneration) return;
        this._yoloPhoneStatus = status;
        if (status.state === 'ready') {
          const indicator = document.getElementById('yolo-camera-status');
          if (indicator) indicator.title = 'Object detection and screen-away phone detection are active.';
        }
        if (status.state === 'error') {
          console.warn('[YOLO] Phone-back specialist unavailable:', status.message || 'Model unavailable');
        }
      },
      onResult: result => this._handleYoloResult(result),
    });
    this._yoloPhoneMonitor = monitor;
    try {
      await monitor.start();
    } catch (error) {
      if (this._yoloPhoneMonitor === monitor) this._yoloPhoneMonitor = null;
      monitor.stop();
      console.warn('[YOLO] Unable to start phone-back specialist:', error?.message || error);
    }
  },

  _stopYoloObjectMonitoring() {
    this._yoloStartGeneration += 1;
    this._yoloStarting = false;
    this._yoloMonitor?.stop();
    this._yoloPhoneMonitor?.stop();
    this._yoloMonitor = null;
    this._yoloPhoneMonitor = null;
    this._yoloPhoneStatus = null;
    this._yoloPolicy?.reset?.();
    this._yoloPolicy = null;
    this._lastYoloResult = null;
    this._yoloConfigSignature = '';
    this._setYoloStatus('idle');
  },

  _syncYoloMonitoringForExam() {
    const config = this._getObjectMonitoringConfig();
    const signature = JSON.stringify(config);
    const video = document.getElementById('camera-feed');
    if (!config.enabled || !this.exam?.requireCamera) {
      if (this._yoloMonitor) this._stopYoloObjectMonitoring();
      return;
    }
    if (!this._yoloMonitor && this._cameraStream && video?.readyState >= 2) {
      this._startYoloObjectMonitoring(video);
      return;
    }
    if (this._yoloPolicy && signature !== this._yoloConfigSignature) {
      this._yoloPolicy.updateConfig(config);
      this._yoloConfigSignature = signature;
    }
  },

  _handleYoloResult(result = {}) {
    if (!this._yoloPolicy || !this.session || !this.exam) return;
    this._lastYoloResult = result;
    const detections = (result.detections || []).map(detection => ({
      ...detection,
      detectorRole: result.detectorRole || 'primary',
    }));
    const events = this._yoloPolicy.evaluate(detections, {
      now: Date.now(),
      modelVersion: result.modelVersion || '',
      backend: result.backend || '',
      detectorRole: result.detectorRole || 'primary',
      inferenceMs: result.inferenceMs || 0,
      faceContext: this._latestFaceContext,
    });
    this._renderYoloDetectionProgress();
    events.forEach(event => this._handleYoloPolicyEvent(event));
  },

  _renderYoloDetectionProgress() {
    const indicator = document.getElementById('yolo-camera-status');
    if (!indicator || this._yoloStatus !== 'ready') return;
    const confirmed = this._yoloPolicy?.getConfirmedDetections?.()[0];
    if (confirmed) {
      indicator.dataset.state = 'detected';
      indicator.textContent = `${confirmed.objectLabel} detected`;
      indicator.title = `${confirmed.objectLabel} detected.`;
      return;
    }
    if (Date.now() < this._yoloDetectedUntil) return;
    const progress = this._yoloPolicy?.getDetectionProgress?.() || [];
    const best = progress.sort((a, b) => b.confidence - a.confidence)[0];
    if (!best) {
      indicator.dataset.state = 'ready';
      indicator.textContent = 'Object scan active';
      indicator.title = 'Object detection is active and scanning the webcam.';
      return;
    }
    const shortLabels = {
      mobile_phone: 'phone',
      laptop_monitor: 'computer',
      book_textbook: 'book',
    };
    const shortLabel = shortLabels[best.objectClass] || 'object';
    indicator.dataset.state = 'candidate';
    indicator.textContent = `Checking ${shortLabel}`;
    indicator.title = 'Keep the object visible for confirmation.';
  },

  getYoloDiagnostics() {
    const config = this._getObjectMonitoringConfig();
    const video = document.getElementById('camera-feed');
    return {
      enabledForExam: config.enabled,
      mode: config.mode,
      cameraRequired: !!this.exam?.requireCamera,
      cameraActive: !!this._cameraStream?.getVideoTracks?.().some(track => track.readyState === 'live'),
      videoReadyState: Number(video?.readyState || 0),
      status: this._yoloStatus,
      backend: this._yoloStatusDetail?.backend || this._lastYoloResult?.backend || '',
      modelVersion: this._yoloStatusDetail?.modelVersion || this._lastYoloResult?.modelVersion || '',
      modelProfile: this._yoloStatusDetail?.modelProfile || this._lastYoloResult?.modelProfile || '',
      phoneSpecialistStatus: this._yoloPhoneStatus?.state || 'off',
      phoneSpecialistVersion: this._yoloPhoneStatus?.modelVersion || '',
      inferenceMs: Number(this._lastYoloResult?.inferenceMs || 0),
      detections: Array.isArray(this._lastYoloResult?.detections)
        ? this._lastYoloResult.detections.map(detection => ({
            className: detection.rawClass,
            policyClass: detection.objectClass,
            confidence: Math.round(Number(detection.confidence || 0) * 1000) / 10,
          }))
        : [],
    };
  },

  _recordYoloDetectionSummary(event) {
    if (!this.session?.id) return;
    const session = DB.getSession(this.session.id);
    if (!session) return;
    const cache = { ...(session.aiDetections || {}) };
    const prior = cache.objectMonitoring && typeof cache.objectMonitoring === 'object'
      ? cache.objectMonitoring
      : { counts: {} };
    const counts = { ...(prior.counts || {}) };
    counts[event.objectClass] = Number(counts[event.objectClass] || 0) + 1;
    cache.objectMonitoring = {
      counts,
      latest: { ...event, detectedAt: new Date().toISOString() },
      modelVersion: event.modelVersion || prior.modelVersion || '',
      updatedAt: new Date().toISOString(),
    };
    DB.updateSession(this.session.id, { aiDetections: cache });
  },

  _handleYoloPolicyEvent(event) {
    const mode = event.policyMode || this._getObjectMonitoringConfig().mode;
    const detail = `A ${event.objectLabel.toLowerCase()} was detected in the student's camera.`;
    const metadata = {
      source: 'yolo',
      objectClass: event.objectClass,
      objectLabel: event.objectLabel,
      rawClass: event.rawClass || '',
      confidence: Number(event.confidence || 0),
      averageConfidence: Number(event.averageConfidence || 0),
      verificationConfidence: Number(event.verificationConfidence || 0),
      fullFrameConfidence: Number(event.fullFrameConfidence || 0),
      boundingBox: event.boundingBox || null,
      frameHits: Number(event.frameHits || 0),
      confirmationMs: Number(event.confirmationMs || 0),
      modelVersion: event.modelVersion || '',
      inferenceBackend: event.inferenceBackend || '',
      detectorRole: event.detectorRole || 'primary',
      inferenceMs: Number(event.inferenceMs || 0),
      policyMode: mode,
      policyDecision: event.policyDecision || mode,
    };

    this._yoloDetectedUntil = Date.now() + 2500;
    const indicator = document.getElementById('yolo-camera-status');
    if (indicator) {
      indicator.dataset.state = 'detected';
      indicator.textContent = `${event.objectLabel} detected`;
      indicator.title = `${event.objectLabel} detected.`;
    }

    this._recordYoloDetectionSummary({ ...event, policyMode: mode });
    if (mode === 'shadow') return;
    if (mode === 'enforce') {
      const issueWhenWarningSlotIsReady = () => {
        if (!this.session || !this.exam || !this._examRuntimeStarted || !this._cameraStream) return;
        if (this._getObjectMonitoringConfig().mode !== 'enforce' || this.warnings >= 3) return;
        const elapsed = this._lastWarningTime ? Date.now() - this._lastWarningTime : 1500;
        const waitMs = Math.max(0, 1500 - elapsed);
        if (waitMs > 0) {
          setTimeout(issueWhenWarningSlotIsReady, waitMs + 25);
          return;
        }
        this.issueWarning(event.violationType, detail, metadata);
      };
      issueWhenWarningSlotIsReady();
      return;
    }

    const replayClipPromise = this._capturePreViolationReplayClip(event.violationType).catch(() => null);
    const violationPromise = this._notifyProfessorViolation(event.violationType, detail, this.warnings, metadata);
    Promise.all([violationPromise, replayClipPromise]).then(([violation, replayClip]) => {
      if (!violation || !replayClip) return null;
      return this._uploadViolationReplayEvidence(violation, replayClip);
    }).catch(error => console.warn('[YOLO] Alert evidence failed:', error?.message || error));
    this._recordActivity(event.violationType, detail, metadata);
    this._captureCameraViolationSnapshot(event.violationType, detail, this.warnings, metadata);
  },

  // ── Camera-off detection ─────────────────────────────────────
  // Polls the camera stream every second. If the webcam is turned off,
  // unplugged, blocked at the OS level, or permission is revoked, a
  // blocking overlay tells the student to re-enable it, a strike is
  // issued if it stays off, and the camera is retried automatically.
  _startCameraWatchdog() {
    if (this._cameraWatchdog) clearInterval(this._cameraWatchdog);
    this._cameraOffSeconds = 0;
    this._cameraOffWarningIssued = false;
    this._cameraWatchdog = setInterval(() => this._checkCameraAlive(), 1000);
  },

  _isCameraRecoveryPending() {
    return this._cameraRecoveryGraceUntil > Date.now();
  },

  _isCameraLive() {
    const track = this._cameraStream && this._cameraStream.getVideoTracks()[0];
    return !!(
      track
      && track.readyState === 'live'
      && !track.muted
      && !this._cameraObstructed
      && !this._isCameraRecoveryPending()
    );
  },

  _checkCameraAlive() {
    if (!this.session) return;
    if (this._cameraPrompting || this._cameraReacquiring) return; // permission dialog open

    if (this._isCameraRecoveryPending()) {
      this._showCameraOffOverlay({ status: 'Checking camera...' });
      const statusText = document.getElementById('camera-status-text');
      if (statusText) statusText.textContent = 'Checking camera...';
      return;
    }

    if (this._isCameraLive()) {
      if (this._cameraOffSeconds > 0) {
        this._cameraOffSeconds = 0;
        this._cameraOffWarningIssued = false;
        this._hideCameraOffOverlay();
        const statusText = document.getElementById('camera-status-text');
        if (statusText) statusText.textContent = '● Monitoring';
        this._recordActivity('camera_restored', 'Webcam re-enabled — monitoring resumed');
      }
      return;
    }

    // Camera is off / blocked / unplugged
    this._showCameraOffOverlay();
    const statusText = document.getElementById('camera-status-text');
    if (statusText) statusText.textContent = 'Camera off';

    this._cameraOffSeconds += 1;
    if (this._cameraOffSeconds >= this._CAMERA_OFF_WARN_SEC && !this._cameraOffWarningIssued) {
      this._cameraOffWarningIssued = true;
      this.issueWarning('camera_off', 'Webcam turned off or blocked during the exam');
    }

    // Try to re-open the camera every ~5 seconds
    if (this._cameraOffSeconds % 5 === 1) this._reacquireCamera();
  },

  async _reacquireCamera() {
    if (this._cameraReacquiring) return;
    this._cameraReacquiring = true;
    this._cameraPrompting = true; // suppress focus-loss warnings if a permission dialog opens
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 960 }, height: { ideal: 720 }, facingMode: 'user' },
        audio: false,
      });
      if (this._cameraStream) this._cameraStream.getTracks().forEach(t => t.stop());
      this._cameraStream = stream;
      const video = document.getElementById('camera-feed');
      if (video) video.srcObject = stream;
      if (video && !this._yoloMonitor) this._startYoloObjectMonitoring(video);
      this._startViolationReplayBuffer();
      const blockedMsg = document.getElementById('camera-blocked-msg');
      if (blockedMsg) blockedMsg.style.display = 'none';
      const statusText = document.getElementById('camera-status-text');
      if (statusText) statusText.textContent = 'Checking camera...';
      this._cameraRecoveryGraceUntil = Date.now() + 2500;
      this._showCameraOffOverlay({ status: 'Checking camera...' });
      // If the camera was denied at exam start, detection never began — start it now
      if (video && !this._motionInterval) {
        setTimeout(() => this._checkInitialPresence(video), 800);
      }
    } catch (e) {
      // Still blocked — the watchdog keeps the overlay up and retries
    } finally {
      this._cameraReacquiring = false;
      this._cameraPrompting = false;
    }
  },

  _showCameraOffOverlay(options = {}) {
    const overlay = document.getElementById('camera-off-overlay');
    if (!overlay) return;
    const cd = document.getElementById('camera-off-countdown');
    const { status = '' } = options;
    if (cd) {
      if (status) {
        cd.textContent = status;
      } else {
        const remaining = Math.max(0, Math.ceil(this._CAMERA_OFF_WARN_SEC - this._cameraOffSeconds));
        cd.textContent = this._cameraOffWarningIssued
          ? 'A violation warning has been recorded. Re-enable your camera now.'
          : `A warning will be recorded in ${remaining}s if the camera stays off.`;
      }
    }
    if (overlay.style.display === 'none' || !overlay.style.display) {
      overlay.style.display = 'flex';
      this._recordActivity('camera_off', 'Webcam turned off or blocked during the exam');
    }
  },

  _hideCameraOffOverlay() {
    const overlay = document.getElementById('camera-off-overlay');
    if (overlay && overlay.style.display !== 'none') overlay.style.display = 'none';
    this._cameraRecoveryGraceUntil = 0;
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
    this._lastPresenceSeenAt = this._getDetectionNow();
    this._presenceConfirmSec = 0;
    this._startMotionDetection(video);
  },

  _startMotionDetection(video) {
    if (this._motionInterval) clearInterval(this._motionInterval);
    this._noMotionSec = 0;
    this._motionBlocked = false;
    this._multipleFaceSeconds = 0;
    this._multipleFaceWarningIssued = false;
    this._secondaryFaceTrack = null;
    this._lookDownSeconds = 0;
    this._lookDownConfirmSeconds = 0;
    this._lookDownWarningIssued = false;
    this._faceDetectInFlight = false;
    this._presenceConfirmSec = 0;
    this._lastPresenceSeenAt = this._getDetectionNow();
    this._facePoseBaseline = null;
    this._facePoseBaselineSamples = 0;
    this._latestFaceContext = null;
    this._lastCameraDetectAt = 0;
    this._brightnessBaseline = null; // reset baseline so first frames calibrate it
    this._darkSeconds = 0;
    this._brightnessWarningIssued = false;
    this._lowLightSeconds = 0;
    this._lowLightWarningIssued = false;
    this._cameraObstructed = false;
    this._cameraObstructedSeconds = 0;
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
      const presenceStable = this._confirmPresence(0.6);
      if (presenceStable) {
        this._noMotionSec = 0;
        this._motionBlocked = false;
      }
      if (statusText) statusText.textContent = presenceStable ? 'Person detected' : 'Confirming person...';
      if (presenceStable) this._clearMotionWarning();
    } else {
      const now = this._getDetectionNow();
      this._resetPresenceTracking();
      if (this._isPresenceGraceActive(now)) {
        if (statusText) statusText.textContent = 'Checking camera...';
        return;
      }

      // No significant motion
      this._noMotionSec += 0.5;
      const remaining = Math.max(0, this._NO_MOTION_WARN - this._noMotionSec);
      if (statusText) statusText.textContent = `No person (${Math.ceil(remaining)}s)`;

      if (this._noMotionSec >= this._NO_MOTION_WARN && !this._motionBlocked) {
        this._handleNoMotion();
      }
    }
  },

  _facePoint(point) {
    if (!point) return null;
    if (Array.isArray(point) && point.length >= 2) {
      const x = Number(point[0]);
      const y = Number(point[1]);
      return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
    }
    if (typeof point.x === 'number' && typeof point.y === 'number') {
      return { x: point.x, y: point.y };
    }
    return null;
  },

  _getFaceProbability(prediction) {
    const raw = Array.isArray(prediction?.probability) ? prediction.probability[0] : prediction?.probability;
    const probability = Number(raw);
    return Number.isFinite(probability) ? probability : 1;
  },

  _normalizeFacePrediction(prediction, frameWidth, frameHeight) {
    if (!prediction?.topLeft || !prediction?.bottomRight) return null;
    const [rawX1, rawY1] = prediction.topLeft;
    const [rawX2, rawY2] = prediction.bottomRight;
    const x1 = Math.max(0, Math.min(frameWidth, Number(rawX1)));
    const y1 = Math.max(0, Math.min(frameHeight, Number(rawY1)));
    const x2 = Math.max(0, Math.min(frameWidth, Number(rawX2)));
    const y2 = Math.max(0, Math.min(frameHeight, Number(rawY2)));
    const width = x2 - x1;
    const height = y2 - y1;
    if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) return null;

    const centerX = x1 + (width / 2);
    const centerY = y1 + (height / 2);
    const area = width * height;
    const areaRatio = area / Math.max(1, frameWidth * frameHeight);
    const centerXRatio = centerX / Math.max(1, frameWidth);
    const centerYRatio = centerY / Math.max(1, frameHeight);
    const edgeRatio = Math.min(centerXRatio, 1 - centerXRatio, centerYRatio, 1 - centerYRatio);
    const landmarks = Array.isArray(prediction.landmarks) ? prediction.landmarks : [];

    return {
      prediction,
      probability: this._getFaceProbability(prediction),
      x1,
      y1,
      x2,
      y2,
      width,
      height,
      area,
      areaRatio,
      centerX,
      centerY,
      centerXRatio,
      centerYRatio,
      edgeRatio,
      rightEye: this._facePoint(landmarks[0]),
      leftEye: this._facePoint(landmarks[1]),
      nose: this._facePoint(landmarks[2]),
      mouth: this._facePoint(landmarks[3]),
    };
  },

  _faceBoxOverlapRatio(a, b) {
    if (!a || !b) return 0;
    const left = Math.max(a.x1, b.x1);
    const top = Math.max(a.y1, b.y1);
    const right = Math.min(a.x2, b.x2);
    const bottom = Math.min(a.y2, b.y2);
    const width = Math.max(0, right - left);
    const height = Math.max(0, bottom - top);
    const overlapArea = width * height;
    if (!overlapArea) return 0;
    return overlapArea / Math.max(1, Math.min(a.area, b.area));
  },

  _classifyFacePredictions(predictions, frameWidth, frameHeight) {
    const faces = (Array.isArray(predictions) ? predictions : [])
      .map(prediction => this._normalizeFacePrediction(prediction, frameWidth, frameHeight))
      .filter(Boolean);

    const primaryCandidates = faces
      .filter(face => face.width >= 40 && face.height >= 40 && face.areaRatio >= 0.015 && face.edgeRatio >= 0.02)
      .map(face => ({
        ...face,
        primaryScore: (face.areaRatio * 5.2)
          + (face.probability * 1.25)
          - ((Math.abs(face.centerXRatio - 0.5) + Math.abs(face.centerYRatio - 0.5)) * 0.9)
          - (face.edgeRatio < 0.06 ? 0.18 : 0),
      }))
      .sort((a, b) => b.primaryScore - a.primaryScore);

    const primaryFace = primaryCandidates[0] || null;
    if (!primaryFace) {
      return { primaryFace: null, extraFaces: [], drawFaces: [] };
    }

    const extraFaces = faces
      .filter(face => face !== primaryFace)
      .filter(face => {
        const areaRelative = face.area / Math.max(1, primaryFace.area);
        const overlapRatio = this._faceBoxOverlapRatio(primaryFace, face);
        const centerDistance = Math.hypot(face.centerX - primaryFace.centerX, face.centerY - primaryFace.centerY);
        const minSeparation = Math.max(24, Math.min(primaryFace.width, primaryFace.height) * 0.28);
        const notEdgeGhost = face.edgeRatio >= 0.05 || face.areaRatio >= 0.04;

        return face.probability >= 0.86
          && face.width >= 48
          && face.height >= 48
          && face.areaRatio >= 0.018
          && areaRelative >= 0.18
          && overlapRatio <= 0.32
          && centerDistance >= minSeparation
          && notEdgeGhost;
      })
      .sort((a, b) => b.area - a.area);

    return {
      primaryFace,
      extraFaces,
      drawFaces: [primaryFace, ...extraFaces],
    };
  },

  _getFacePoseMetrics(face) {
    if (!face?.rightEye || !face?.leftEye || !face?.nose || !face?.mouth || !face.height || !face.width) return null;
    const eyeY = (face.rightEye.y + face.leftEye.y) / 2;
    return {
      eyeSpanRatio: Math.abs(face.leftEye.x - face.rightEye.x) / face.width,
      eyeSlopeRatio: Math.abs(face.leftEye.y - face.rightEye.y) / face.height,
      noseDropRatio: (face.nose.y - eyeY) / face.height,
      noseBoxRatio: (face.nose.y - face.y1) / face.height,
      mouthBoxRatio: (face.mouth.y - face.y1) / face.height,
      mouthGapRatio: (face.mouth.y - face.nose.y) / face.height,
      faceCenterYRatio: face.centerYRatio,
    };
  },

  _isNeutralFacePose(metrics) {
    if (!metrics) return false;
    return metrics.eyeSpanRatio >= 0.18
      && metrics.eyeSlopeRatio <= 0.14
      && metrics.noseBoxRatio >= 0.42
      && metrics.noseBoxRatio <= 0.6
      && metrics.mouthBoxRatio >= 0.62
      && metrics.mouthBoxRatio <= 0.82
      && metrics.mouthGapRatio >= 0.08
      && metrics.mouthGapRatio <= 0.22;
  },

  _updateFacePoseBaseline(metrics) {
    if (!this._isNeutralFacePose(metrics)) return;
    if (!this._facePoseBaseline) {
      this._facePoseBaseline = { ...metrics };
      this._facePoseBaselineSamples = 1;
      return;
    }

    const blend = this._facePoseBaselineSamples < 8 ? 0.22 : 0.08;
    Object.keys(metrics).forEach(key => {
      const value = Number(metrics[key]);
      if (!Number.isFinite(value)) return;
      const previous = Number(this._facePoseBaseline[key]);
      this._facePoseBaseline[key] = Number.isFinite(previous)
        ? (previous * (1 - blend)) + (value * blend)
        : value;
    });
    this._facePoseBaselineSamples += 1;
  },

  _evaluateLookingDown(face) {
    const metrics = this._getFacePoseMetrics(face);
    if (!metrics) return { isLookingDown: false, metrics: null };

    const baseline = this._facePoseBaseline;
    const baselineReady = !!baseline && this._facePoseBaselineSamples >= 5;

    let hardSignals = 0;
    if (metrics.noseDropRatio >= 0.235) hardSignals += 1;
    if (metrics.noseBoxRatio >= 0.58) hardSignals += 1;
    if (metrics.mouthBoxRatio >= 0.76) hardSignals += 1;
    if (metrics.mouthGapRatio >= 0.118) hardSignals += 1;
    if (metrics.faceCenterYRatio >= 0.56) hardSignals += 1;

    let adaptiveSignals = 0;
    if (baselineReady) {
      if (metrics.noseDropRatio >= baseline.noseDropRatio + 0.032) adaptiveSignals += 1;
      if (metrics.noseBoxRatio >= baseline.noseBoxRatio + 0.05) adaptiveSignals += 1;
      if (metrics.mouthBoxRatio >= baseline.mouthBoxRatio + 0.04) adaptiveSignals += 1;
      if (metrics.mouthGapRatio >= baseline.mouthGapRatio + 0.022) adaptiveSignals += 1;
      if (metrics.faceCenterYRatio >= baseline.faceCenterYRatio + 0.035) adaptiveSignals += 1;
    }

    const poseStable = metrics.eyeSpanRatio >= 0.17 && metrics.eyeSlopeRatio <= 0.14;
    const isLookingDown = poseStable && (
      adaptiveSignals >= 3
      || (hardSignals >= 3 && (!baselineReady || adaptiveSignals >= 2))
      || hardSignals >= 4
    );

    return { isLookingDown, metrics };
  },

  _trackSecondaryFace(face, deltaSec) {
    if (!face) {
      this._secondaryFaceTrack = null;
      return 0;
    }

    const previous = this._secondaryFaceTrack;
    const current = {
      centerX: face.centerX,
      centerY: face.centerY,
      area: face.area,
      width: face.width,
      height: face.height,
    };

    if (!previous) {
      this._secondaryFaceTrack = { ...current, seconds: deltaSec };
      return deltaSec;
    }

    const centerDistance = Math.hypot(current.centerX - previous.centerX, current.centerY - previous.centerY);
    const areaRatio = Math.min(current.area, previous.area) / Math.max(1, Math.max(current.area, previous.area));
    const isSameTrack = centerDistance <= Math.max(36, Math.min(face.width, face.height) * 0.6) && areaRatio >= 0.55;
    const seconds = isSameTrack ? ((previous.seconds || 0) + deltaSec) : deltaSec;

    this._secondaryFaceTrack = { ...current, seconds };
    return seconds;
  },

  _consumeCameraDetectDelta(fallbackMs = 600) {
    const now = (typeof performance !== 'undefined' && typeof performance.now === 'function')
      ? performance.now()
      : Date.now();
    const prev = this._lastCameraDetectAt || 0;
    this._lastCameraDetectAt = now;
    if (!prev) return fallbackMs / 1000;
    const deltaSec = Math.max(0, (now - prev) / 1000);
    return Math.min(deltaSec, Math.max(1.5, (fallbackMs / 1000) * 2));
  },

  _getDetectionNow() {
    return (typeof performance !== 'undefined' && typeof performance.now === 'function')
      ? performance.now()
      : Date.now();
  },

  _isPresenceGraceActive(now = this._getDetectionNow()) {
    return !!this._lastPresenceSeenAt && ((now - this._lastPresenceSeenAt) / 1000) < this._NO_PERSON_GRACE_SEC;
  },

  _confirmPresence(deltaSec) {
    this._presenceConfirmSec = Math.min(
      this._FACE_PRESENCE_CONFIRM_SEC,
      (this._presenceConfirmSec || 0) + Math.max(0, deltaSec || 0)
    );
    if (this._presenceConfirmSec < this._FACE_PRESENCE_CONFIRM_SEC) return false;
    this._lastPresenceSeenAt = this._getDetectionNow();
    return true;
  },

  _resetPresenceTracking() {
    this._presenceConfirmSec = 0;
  },

  async _detectFace(video) {
    if (!this._faceModel || !video || video.readyState < 2 || !this._cameraStream || this._faceDetectInFlight) return;
    const statusText = document.getElementById('camera-status-text');
    const canvas = document.getElementById('camera-canvas');
    this._faceDetectInFlight = true;
    try {
      const deltaSec = this._consumeCameraDetectDelta();
      const frameWidth = video.videoWidth || 320;
      const frameHeight = video.videoHeight || 240;
      const predictions = await this._faceModel.estimateFaces(video, false);
      const { primaryFace, extraFaces, drawFaces } = this._classifyFacePredictions(predictions, frameWidth, frameHeight);
      this._latestFaceContext = primaryFace ? {
        capturedAt: Date.now(),
        frameWidth,
        frameHeight,
        faces: [primaryFace, ...extraFaces].map(face => ({
          x: face.x1,
          y: face.y1,
          width: face.width,
          height: face.height,
          nose: face.nose,
          mouth: face.mouth,
        })),
      } : null;
      const secondaryFaceSeconds = extraFaces.length ? this._trackSecondaryFace(extraFaces[0], deltaSec) : 0;
      const multipleFacesConfirmed = secondaryFaceSeconds >= this._MULTIPLE_FACE_CONFIRM_SEC;
      const lookDownEvaluation = primaryFace && !extraFaces.length ? this._evaluateLookingDown(primaryFace) : { isLookingDown: false, metrics: null };
      const primaryLookingDown = !!primaryFace && !extraFaces.length && lookDownEvaluation.isLookingDown;
      const presenceStable = primaryFace ? this._confirmPresence(deltaSec) : false;
      if (primaryFace && !extraFaces.length && !primaryLookingDown) {
        this._updateFacePoseBaseline(lookDownEvaluation.metrics);
      }

      // Draw video + face boxes on canvas
      if (canvas) {
        canvas.width = frameWidth;
        canvas.height = frameHeight;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        try {
          const frame = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
          this._checkAmbientBrightness(frame, canvas.width * canvas.height);
        } catch (e) {}
        drawFaces.forEach(face => {
          const isExtraFace = extraFaces.includes(face) && multipleFacesConfirmed;
          const isLookingDownFace = face === primaryFace && primaryLookingDown;
          const color = isExtraFace ? '#ffb020' : (isLookingDownFace ? '#f97316' : '#00e676');
          ctx.strokeStyle = color;
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.roundRect ? ctx.roundRect(face.x1, face.y1, face.width, face.height, 4) : ctx.rect(face.x1, face.y1, face.width, face.height);
          ctx.stroke();
          // Label
          ctx.fillStyle = color;
          ctx.font = 'bold 11px sans-serif';
          const label = isExtraFace ? 'Extra person' : (isLookingDownFace ? 'Looking down' : 'Person');
          ctx.fillText(label, face.x1, face.y1 > 14 ? face.y1 - 4 : face.y1 + 14);
        });
      }

      if (extraFaces.length && multipleFacesConfirmed) {
        this._multipleFaceSeconds += deltaSec;
        this._lookDownSeconds = 0;
        this._lookDownConfirmSeconds = 0;
        this._lookDownWarningIssued = false;
        if (presenceStable) {
          this._noMotionSec = 0;
          this._motionBlocked = false;
        }
        const remaining = Math.max(0, this._MULTIPLE_FACE_WARN_SEC - this._multipleFaceSeconds);
        if (statusText) {
          statusText.textContent = this._multipleFaceWarningIssued
            ? 'Multiple faces detected'
            : `Multiple faces detected (${Math.ceil(remaining)}s)`;
        }
        if (presenceStable) this._clearMotionWarning();
        if (this._multipleFaceSeconds >= this._MULTIPLE_FACE_WARN_SEC && !this._multipleFaceWarningIssued) {
          this._multipleFaceWarningIssued = true;
          this.issueWarning(
            'multiple_people',
            'Another visible face/person was detected beside the student or facing the camera/screen'
          );
        }
      } else if (primaryFace && primaryLookingDown) {
        this._multipleFaceSeconds = 0;
        this._secondaryFaceTrack = null;
        this._multipleFaceWarningIssued = false;
        this._lookDownConfirmSeconds = Math.min(this._LOOK_DOWN_CONFIRM_SEC, this._lookDownConfirmSeconds + deltaSec);
        const lookDownConfirmed = this._lookDownConfirmSeconds >= this._LOOK_DOWN_CONFIRM_SEC;
        this._lookDownSeconds = lookDownConfirmed ? (this._lookDownSeconds + deltaSec) : 0;
        if (presenceStable) {
          this._noMotionSec = 0;
          this._motionBlocked = false;
        }
        const remaining = Math.max(0, this._LOOK_DOWN_WARN_SEC - this._lookDownSeconds);
        if (statusText) {
          statusText.textContent = this._lookDownWarningIssued
            ? 'Looking down detected'
            : lookDownConfirmed
              ? `Looking down (${Math.ceil(remaining)}s)`
              : (presenceStable ? 'Person detected' : 'Confirming person...');
        }
        if (presenceStable) this._clearMotionWarning();
        if (this._lookDownSeconds >= this._LOOK_DOWN_WARN_SEC && !this._lookDownWarningIssued) {
          this._lookDownWarningIssued = true;
          this.issueWarning(
            'look_down',
            'Student looked down away from the screen/camera for an extended period'
          );
        }
      } else if (primaryFace) {
        this._multipleFaceSeconds = 0;
        this._secondaryFaceTrack = null;
        this._multipleFaceWarningIssued = false;
        this._lookDownSeconds = 0;
        this._lookDownConfirmSeconds = 0;
        this._lookDownWarningIssued = false;
        if (presenceStable) {
          this._noMotionSec = 0;
          this._motionBlocked = false;
        }
        if (statusText) statusText.textContent = presenceStable ? 'Person detected' : 'Confirming person...';
        if (presenceStable) this._clearMotionWarning();
      } else {
        const now = this._getDetectionNow();
        this._multipleFaceSeconds = 0;
        this._secondaryFaceTrack = null;
        this._multipleFaceWarningIssued = false;
        this._lookDownSeconds = 0;
        this._lookDownConfirmSeconds = 0;
        this._lookDownWarningIssued = false;
        this._resetPresenceTracking();
        if (this._isPresenceGraceActive(now)) {
          if (statusText) statusText.textContent = 'Checking camera...';
          return;
        }
        this._noMotionSec += deltaSec;
        const remaining = Math.max(0, this._NO_MOTION_WARN - this._noMotionSec);
        if (statusText) statusText.textContent = `No person (${Math.ceil(remaining)}s)`;
        if (this._noMotionSec >= this._NO_MOTION_WARN && !this._motionBlocked) {
          this._handleNoMotion();
        }
      }
    } catch(e) {
      // Model error — fall back to motion detection silently
      this._lastCameraDetectAt = 0;
      this._latestFaceContext = null;
      this._detectMotion(video);
    } finally {
      this._faceDetectInFlight = false;
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

  // ── Brightness detection ─────────────────────────────────────
  // This measures luminance of the CAMERA feed (the student's face/room),
  // not the display's backlight — so it's really a "can the professor see
  // you" check, not a "is your screen bright enough" check (that's the
  // separate perceptual _startBrightnessCheck below). The live prompt asks
  // the student to improve room lighting; turning up display brightness
  // only helps because the prompt overlay itself is rendered near-white
  // while it's showing, turning the screen into an extra light source.
  // Two layers:
  //  1. Absolute level — camera luminance must stay above _MIN_LUMINANCE.
  //     Below it, a live prompt appears; ignoring it for _LOW_LIGHT_WARN_SEC
  //     becomes a strike.
  //  2. Relative drop — a luminance baseline is recorded at exam start and
  //     a drop below 75% of it flags a darkened room/camera view regardless
  //     of the absolute level.
  _checkAmbientBrightness(frameData, pixelCount) {
    let lum = 0;
    for (let i = 0; i < frameData.length; i += 4) {
      lum += 0.299 * frameData[i] + 0.587 * frameData[i + 1] + 0.114 * frameData[i + 2];
    }
    const avgLuminance = lum / pixelCount; // 0–255

    // ── Layer 1: absolute minimum brightness ──
    const tick = 0.6; // seconds per detection frame
    if (avgLuminance <= this._BLACK_FRAME_LUMINANCE) {
      this._cameraObstructedSeconds += tick;
      this._cameraObstructed = this._cameraObstructedSeconds >= 1.2;
      this._lowLightSeconds = 0;
      this._lowLightWarningIssued = false;
      this._darkSeconds = 0;
      this._brightnessWarningIssued = false;
      this._hideBrightnessPrompt();
      return;
    }

    this._cameraObstructed = false;
    this._cameraObstructedSeconds = 0;
    if (this._cameraRecoveryGraceUntil) {
      this._cameraRecoveryGraceUntil = 0;
    }
    if (avgLuminance < this._MIN_LUMINANCE) {
      this._lowLightSeconds += tick;
      if (this._lowLightSeconds >= this._LOW_LIGHT_PROMPT_SEC) {
        this._showBrightnessPrompt(avgLuminance);
      }
      if (this._lowLightSeconds >= this._LOW_LIGHT_WARN_SEC && !this._lowLightWarningIssued) {
        this._lowLightWarningIssued = true;
        this.issueWarning('low_brightness', 'Room too dark — professor cannot clearly see the student on camera');
      }
    } else if (this._lowLightSeconds > 0) {
      this._lowLightSeconds = 0;
      this._lowLightWarningIssued = false;
      this._hideBrightnessPrompt();
    }

    // ── Layer 2: relative drop vs baseline ──
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
        this.issueWarning('low_brightness', 'Camera view dimmed below 75% of its baseline — please restore your lighting');
      }
    } else {
      if (this._darkSeconds > 0) {
        this._darkSeconds = 0;
        this._brightnessWarningIssued = false;
        if (statusText) statusText.textContent = '● Monitoring';
      }
    }
  },

  // Live "turn up your brightness" prompt — appears while the camera
  // luminance is below the required minimum and updates a meter in real
  // time; disappears on its own once brightness is restored.
  _showBrightnessPrompt(avgLuminance) {
    const overlay = document.getElementById('brightness-warning-overlay');
    if (!overlay) return;
    const requiredPct = Math.round((this._MIN_LUMINANCE / 255) * 100);
    const currentPct = Math.min(100, Math.round((avgLuminance / 255) * 100));

    const fill = document.getElementById('brightness-meter-fill');
    if (fill) fill.style.width = currentPct + '%';
    const marker = document.getElementById('brightness-meter-marker');
    if (marker) marker.style.left = requiredPct + '%';
    const levelText = document.getElementById('brightness-level-text');
    if (levelText) levelText.textContent = `Current level: ${currentPct}% — required: at least ${requiredPct}%`;
    const cdText = document.getElementById('brightness-warn-countdown');
    if (cdText) {
      const remaining = Math.max(0, Math.ceil(this._LOW_LIGHT_WARN_SEC - this._lowLightSeconds));
      cdText.textContent = this._lowLightWarningIssued
        ? 'A violation warning has been recorded.'
        : `A warning will be recorded in ${remaining}s if brightness is not increased.`;
    }

    if (overlay.style.display === 'none' || !overlay.style.display) {
      overlay.style.display = 'flex';
      this._recordActivity('low_brightness_prompt', `Camera view too dark (${currentPct}% luminance) — student prompted to improve lighting`);
    }
  },

  _hideBrightnessPrompt() {
    const overlay = document.getElementById('brightness-warning-overlay');
    if (overlay && overlay.style.display !== 'none') overlay.style.display = 'none';
  },

  // ── Perceptual brightness check (runs at the start of every exam) ────
  // Browsers cannot read the OS screen-brightness setting, so we verify
  // brightness perceptually: one of four near-black tiles contains a
  // faint symbol that is only visible when the display is bright enough.
  // Two randomized correct picks prove the student's brightness is at an
  // acceptable level. Runs regardless of whether the camera is required,
  // since the camera's ambient-light monitor only reacts after the fact.
  _startBrightnessCheck() {
    if (!this.session) return;
    // Don't repeat the check on page refresh / exam resume
    const session = DB.getSession(this.session.id);
    const acts = (session && session.activities) || [];
    if (acts.some(a => a.type === 'brightness_check_passed' || a.type === 'brightness_check_skipped')) return;
    this._brightnessCheckRound = 0;
    this._brightnessCheckFails = 0;
    const skip = document.getElementById('brightness-check-skip');
    if (skip) skip.style.display = 'none';
    const msg = document.getElementById('brightness-check-msg');
    if (msg) { msg.textContent = ''; }
    this._renderBrightnessCheckRound();
    const overlay = document.getElementById('brightness-check-overlay');
    if (overlay) overlay.style.display = 'flex';
  },

  _renderBrightnessCheckRound() {
    const grid = document.getElementById('brightness-check-grid');
    if (!grid) return;
    const symbols = ['▲', '●', '■', '◆', '✚'];
    this._brightnessCheckAnswer = Math.floor(Math.random() * 4);
    const symbol = symbols[Math.floor(Math.random() * symbols.length)];
    grid.innerHTML = '';
    for (let i = 0; i < 4; i++) {
      const tile = document.createElement('button');
      tile.type = 'button';
      tile.setAttribute('data-exam-control', 'true');
      tile.style.cssText = 'width:104px;height:104px;border-radius:14px;border:1px solid #1f2937;background:#0a0a0a;color:#262626;font-size:42px;line-height:1;cursor:pointer;display:flex;align-items:center;justify-content:center;padding:0;';
      tile.textContent = i === this._brightnessCheckAnswer ? symbol : '';
      tile.onclick = () => this._answerBrightnessCheck(i);
      grid.appendChild(tile);
    }
    const progress = document.getElementById('brightness-check-progress');
    if (progress) progress.textContent = `Round ${this._brightnessCheckRound + 1} of 2`;
  },

  _answerBrightnessCheck(index) {
    const msg = document.getElementById('brightness-check-msg');
    if (index === this._brightnessCheckAnswer) {
      this._brightnessCheckRound++;
      if (this._brightnessCheckRound >= 2) {
        this._recordActivity('brightness_check_passed',
          'Display brightness check passed' + (this._brightnessCheckFails ? ` after ${this._brightnessCheckFails} failed attempt(s)` : ''));
        const overlay = document.getElementById('brightness-check-overlay');
        if (overlay) overlay.style.display = 'none';
        return;
      }
      if (msg) { msg.textContent = 'Correct — one more round to confirm.'; msg.style.color = '#4ade80'; }
      this._renderBrightnessCheckRound();
    } else {
      this._brightnessCheckFails++;
      this._brightnessCheckRound = 0;
      this._recordActivity('brightness_check_failed', 'Student could not identify the faint symbol — display likely too dark');
      if (msg) { msg.textContent = 'Wrong tile. Turn your screen brightness up (80–100%), then look again.'; msg.style.color = '#fbbf24'; }
      this._renderBrightnessCheckRound();
      // After several failures allow continuing so a faulty panel can't lock
      // the student out — the skip is recorded for the professor.
      const skip = document.getElementById('brightness-check-skip');
      if (skip && this._brightnessCheckFails >= 4) skip.style.display = '';
    }
  },

  _skipBrightnessCheck() {
    this._recordActivity('brightness_check_skipped', `Student skipped the brightness check after ${this._brightnessCheckFails} failed attempt(s)`);
    const overlay = document.getElementById('brightness-check-overlay');
    if (overlay) overlay.style.display = 'none';
  },

  // Keep captureSnapshot for admin monitoring thumbnails (less frequent)
  _captureLegacySnapshot() {
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

  captureSnapshot(options = {}) {
    if (!this.session) return null;
    const {
      kind = 'live',
      violationType = '',
      detail = '',
      warningCount = null,
      detectionMetadata = null,
      fallbackToLatest = false,
    } = options;

    try {
      const session = DB.getSession(this.session.id);
      if (!session) return null;

      let imageData = this._captureCameraFrameData(detectionMetadata);
      let usedFallback = false;

      if (!imageData && fallbackToLatest) {
        const existing = Array.isArray(session.cameraSnapshots) ? session.cameraSnapshots : [];
        const fallback = existing.find(s => s?.imageData);
        if (fallback?.imageData) {
          imageData = fallback.imageData;
          usedFallback = true;
        }
      }

      if (!imageData) return null;

      const snapshot = {
        timestamp: new Date().toISOString(),
        imageData,
        kind,
      };
      if (violationType) snapshot.violationType = violationType;
      if (detail) snapshot.detail = detail;
      if (Number.isFinite(warningCount)) snapshot.warningCount = warningCount;
      if (detectionMetadata && typeof detectionMetadata === 'object') snapshot.detectionMetadata = detectionMetadata;
      if (usedFallback) snapshot.usedFallback = true;

      DB.updateSession(this.session.id, {
        cameraSnapshots: this._buildCameraSnapshots(snapshot),
      });
      return snapshot;
    } catch (e) {
      return null;
    }
  },

  stopCamera() {
    this._stopYoloObjectMonitoring();
    this._cameraPrompting = false;
    this._cameraRecoveryGraceUntil = 0;
    if (this._cameraWatchdog)  { clearInterval(this._cameraWatchdog);  this._cameraWatchdog = null; }
    if (this._motionInterval) { clearInterval(this._motionInterval); this._motionInterval = null; }
    if (this._snapInterval)   { clearInterval(this._snapInterval);   this._snapInterval = null; }
    this._stopViolationReplayBuffer();
    this._faceDetectInFlight = false;
    this._prevFrameData = null;
    this._noMotionSec = 0;
    this._motionBlocked = false;
    this._presenceConfirmSec = 0;
    this._lastPresenceSeenAt = 0;
    this._multipleFaceSeconds = 0;
    this._multipleFaceWarningIssued = false;
    this._secondaryFaceTrack = null;
    this._lookDownSeconds = 0;
    this._lookDownConfirmSeconds = 0;
    this._lookDownWarningIssued = false;
    this._facePoseBaseline = null;
    this._facePoseBaselineSamples = 0;
    this._latestFaceContext = null;
    this._lowLightSeconds = 0;
    this._lowLightWarningIssued = false;
    this._hideBrightnessPrompt();
    this._cameraOffSeconds = 0;
    this._cameraOffWarningIssued = false;
    this._hideCameraOffOverlay();
    if (this._cameraStream) {
      this._cameraStream.getTracks().forEach(t => t.stop());
      this._cameraStream = null;
    }
    const container = document.getElementById('camera-container');
    if (container) container.style.display = 'none';
  },

  destroyAntiCheat() {
    if (this._blurTimer) { clearTimeout(this._blurTimer); this._blurTimer = null; }
    if (this._visTimer) { clearTimeout(this._visTimer); this._visTimer = null; }
    if (this._fsLossTimer) { clearTimeout(this._fsLossTimer); this._fsLossTimer = null; }
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
    this._stopConnectionMonitor();
    this._stopWebcamWaitPoll();
  },

  // ============================================================
  // COUNTDOWN (10-second auto-submit window)
  // ============================================================
  startCountdown(totalSeconds) {
    // If this 10-second return window is already running, keep its original
    // deadline instead of restarting it from scratch.
    const reusingExisting = this._warningCountdownMode === 'focus'
      && this._warningCountdownDeadline > Date.now() + 150;

    if (!reusingExisting) {
      this.cancelCountdown(false); // clear previous without hiding overlay
    }

    this._warningCountdownMode = 'focus';
    this._startDeadlineCountdown({
      timerKey: '_warningCountdownTimer',
      tokenKey: '_warningCountdownToken',
      deadlineKey: '_warningCountdownDeadline',
      totalKey: '_warningCountdownTotalSeconds',
      totalSeconds,
      preserveExisting: reusingExisting,
      onUpdate: (remaining, msRemaining, activeTotalSeconds, totalMs) => {
        const numEl = document.getElementById('cd-num');
        const circleEl = document.getElementById('cd-circle');
        const wrapEl = document.getElementById('warning-countdown-wrap');
        if (wrapEl) wrapEl.style.display = '';
        if (numEl) numEl.textContent = remaining;
        if (circleEl) {
          const offset = 163.36 * ((totalMs - msRemaining) / totalMs);
          circleEl.style.strokeDashoffset = String(offset);
        }
      },
      onExpire: () => {
        this._warningCountdownMode = null;
        const msgEl = document.getElementById('warning-overlay-msg');
        const subEl = document.getElementById('warning-overlay-sub');
        const wrapEl = document.getElementById('warning-countdown-wrap');
        if (msgEl) msgEl.textContent = 'Time expired. Submitting your exam now...';
        if (subEl) subEl.textContent = '';
        if (wrapEl) wrapEl.style.display = 'none';
        this._countdownInterval = null;
        setTimeout(() => this.submitExam('auto'), 1500);
      },
    });
    this._countdownInterval = this._warningCountdownTimer;
  },

  cancelCountdown(hideOverlay = true) {
    // If the 3-second read countdown is already running (started by an earlier
    // cancelCountdown call from the same return event pair), don't interrupt it —
    // just stop the 10s interval if it somehow still exists and bail out.
    if (this._inReadCountdown) {
      if (this._warningCountdownMode === 'focus') this._stopWarningCountdown();
      this._countdownInterval = null;
      return;
    }

    const hadCountdown = this._warningCountdownMode === 'focus'
      && this._warningCountdownDeadline > Date.now();
    this._stopWarningCountdown({ hideWrap: true });
    this._countdownInterval = null;

    if (hideOverlay && hadCountdown && this.warnings < 3) {
      // Student returned — keep overlay for 3s so they can read the warning
      this._startReadCountdown(3);
    }
  },

  _cancelReadCountdown() {
    if (this._warningCountdownMode === 'read') {
      this._stopWarningCountdown({ hideWrap: true, resetMessage: true });
    }
    if (this._warningReadTimer) {
      clearTimeout(this._warningReadTimer);
      this._warningReadTimer = null;
    }
    this._inReadCountdown = false;
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
    this._warningCountdownMode = 'read';
    this._startDeadlineCountdown({
      timerKey: '_warningCountdownTimer',
      tokenKey: '_warningCountdownToken',
      deadlineKey: '_warningCountdownDeadline',
      totalKey: '_warningCountdownTotalSeconds',
      totalSeconds,
      onUpdate: (remaining, msRemaining, activeTotalSeconds, totalMs) => {
        if (msgEl) msgEl.textContent = 'Read this warning. The exam will resume shortly.';
        wrapEl.style.display = '';
        if (cdNum) cdNum.textContent = remaining;
        if (cdCircle) {
          cdCircle.style.strokeDashoffset =
            String(circumference * ((totalMs - msRemaining) / totalMs));
        }
        this._warningReadTimer = this._warningCountdownTimer;
      },
      onExpire: () => {
        this._inReadCountdown = false;
        this._warningReadTimer = null;
        this._warningCountdownMode = null;
        wrapEl.style.display = 'none';
        overlay.style.display = 'none';
        if (msgEl) msgEl.textContent = 'Return to this window or your exam will be auto-submitted';
      },
    });
  },

  issueWarning(type, detail, detectionMetadata = null) {
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

    // Debounce: prevent double-firing within 1500ms (blur + visibilitychange fire together)
    const now = Date.now();
    if (this._lastWarningTime && (now - this._lastWarningTime) < 1500) return;
    this._lastWarningTime = now;

    this._stopWarningCountdown({ hideWrap: true });
    // Clear any in-progress read countdown so the new warning takes over cleanly
    this._cancelReadCountdown();

    this.warnings++;
    const replayClipPromise = this._capturePreViolationReplayClip(type).catch((error) => {
      console.warn('[Monitor] Unable to capture replay clip:', error?.message || error);
      return null;
    });
    const violationPromise = this._notifyProfessorViolation(type, detail, this.warnings, detectionMetadata);
    Promise.all([violationPromise, replayClipPromise]).then(([violation, replayClip]) => {
      if (!violation || !replayClip) return null;
      return this._uploadViolationReplayEvidence(violation, replayClip);
    }).catch((error) => {
      console.warn('[Monitor] Replay evidence pipeline failed:', error?.message || error);
    });

    this._recordActivity(type, detail, detectionMetadata);
    DB.updateSession(this.session.id, { warnings: this.warnings });
    this._captureCameraViolationSnapshot(type, detail, this.warnings, detectionMetadata);

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
      multiple_people: 'Another visible face/person was detected in the camera frame.',
      look_down:       'Looking down away from the screen/camera for too long was detected.',
      low_brightness:  'The camera view is too dark — improve your room lighting so your professor can see you clearly.',
      camera_off:      'Your webcam was turned off or blocked. Camera monitoring is required during the exam.',
      restricted_phone: 'A mobile phone was detected in the camera frame.',
      secondary_computer: 'A secondary computer or display was detected in the camera frame.',
      restricted_book: 'A book or textbook was detected during this closed-book exam.',
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

    // Always show countdown — duration depends on violation type
    const focusLoss = ['window_blur', 'tab_switch', 'fullscreen_exit'];
    const isFocusLoss = focusLoss.includes(type);

    if (this.warnings < 3) {
      const secs = isFocusLoss ? 10 : 5;
      const cdWrap = document.getElementById('warning-countdown-wrap');
      const cdNum  = document.getElementById('cd-num');
      const cdCircle = document.getElementById('cd-circle');
      const cdMsg  = cdWrap ? cdWrap.querySelector('.warning-countdown-msg') : null;
      const circumference = 163.36; // 2π × r(26)

      if (cdWrap) {
        if (cdMsg) cdMsg.textContent = isFocusLoss
          ? 'Return to this window or your exam will be auto-submitted'
          : 'This violation has been recorded. Returning to your exam…';
        cdWrap.style.display = '';
        if (cdNum) cdNum.textContent = secs;
        if (cdCircle) cdCircle.style.strokeDashoffset = '0';
      }

      // Focus-loss: issueWarning calls startCountdown() right after this — let it
      // own the interval so only ONE timer updates #cd-num and #cd-circle.
      // Non-focus: run a 5-second dismiss timer here (startCountdown is not called).
      if (!isFocusLoss) {
        this._warningCountdownMode = 'info';
        this._startDeadlineCountdown({
          timerKey: '_warningCountdownTimer',
          tokenKey: '_warningCountdownToken',
          deadlineKey: '_warningCountdownDeadline',
          totalKey: '_warningCountdownTotalSeconds',
          totalSeconds: secs,
          onUpdate: (remaining, msRemaining, activeTotalSeconds, totalMs) => {
            if (cdWrap) cdWrap.style.display = '';
            if (cdNum) cdNum.textContent = remaining;
            if (cdCircle) {
              cdCircle.style.strokeDashoffset = String(circumference * ((totalMs - msRemaining) / totalMs));
            }
          },
          onExpire: () => {
            this._warningCountdownMode = null;
            if (cdWrap) cdWrap.style.display = 'none';
            overlay.style.display = 'none';
          },
        });
      }
    }
  },

  // ============================================================
  // TIMER
  // ============================================================
  startTimer() {
    this.stopTimer();

    const session = DB.getSession(this.session.id);
    let sessionStartTime;
    if (session && session.startTime) {
      sessionStartTime = new Date(session.startTime).getTime();
    } else {
      // Fresh start (retake after reset) — record start time now
      sessionStartTime = Date.now();
      DB.updateSession(this.session.id, { startTime: new Date(sessionStartTime).toISOString() });
    }
    // Fall back to a sane default rather than letting a missing/invalid
    // timeLimit turn the whole countdown into NaN (which would silently
    // never reach the auto-submit check below, since NaN <= 0 is false).
    const timeLimitMinutes = Number(this.exam?.timeLimit) > 0 ? Number(this.exam.timeLimit) : 60;
    const examStartedAt = this.exam?.startedAt ? new Date(this.exam.startedAt).getTime() : NaN;
    const countdownStart = Number.isFinite(examStartedAt) ? examStartedAt : sessionStartTime;
    const deadline = countdownStart + timeLimitMinutes * 60 * 1000;
    this.timeRemaining = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));

    if (this.timeRemaining <= 0) {
      if (this.exam?.status === 'active') {
        const closedAt = new Date(deadline).toISOString();
        DB.updateExam(this.exam.id, { status: 'closed', closedAt });
        this.exam = { ...this.exam, status: 'closed', closedAt };
      }
      this.submitExam('timeout');
      return;
    }

    const timerEl = document.getElementById('exam-timer');
    const display = document.getElementById('timer-display');
    if (!timerEl || !display) return;

    const tick = () => {
      // An absolute deadline prevents background tabs and sleeping devices
      // from pausing or extending the exam countdown.
      this.timeRemaining = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
      if (this.timeRemaining <= 0) {
        display.textContent = '00:00';
        this.stopTimer();
        if (this.exam?.status === 'active') {
          const closedAt = new Date(deadline).toISOString();
          DB.updateExam(this.exam.id, { status: 'closed', closedAt });
          this.exam = { ...this.exam, status: 'closed', closedAt };
        }
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
    const questions = this.exam.shuffleQuestions
      ? this._shuffleWithinTypeGroups(this.exam.questions)
      : [...this.exam.questions];
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
    } else if (q.type === 'checkbox') {
      answerHtml = this._renderCheckbox(q, idx);
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

    const typeLabels = { mcq:'Multiple Choice', checkbox:'Checkboxes', tf:'True / False', identification:'Identification', essay:'Essay', enumeration:'Enumeration', matching:'Matching Type', coding:'Coding' };

    const imgHtml = q.imageUrl
      ? `<div class="question-img-wrap"><img src="${_escAttr(q.imageUrl)}" alt="Question image" class="question-img" onerror="this.parentElement.style.display='none'" /></div>`
      : '';

    const requiredBadge = q.required !== false
      ? `<span class="q-required-badge" title="Required" aria-label="Required question">*</span>`
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
        <div class="mcq-option" id="mcq-opt-${q.id}-${oi}" data-exam-control="true" data-qid="${q.id}" data-val="${_escAttr(opt)}" onclick="ExamApp.selectMCQ(this)">
          <div class="mcq-option-letter">${letters[oi] || (oi+1)}</div>
          <span class="mcq-option-text">${_escText(opt)}</span>
        </div>
      `).join('') +
      `</div>`;
  },

  _renderCheckbox(q, idx) {
    // Checkbox correctness is keyed by option INDEX (correctAnswerIndices), so we keep
    // each option's original index attached even when shuffled, instead of shuffling a
    // plain array (which would desync the picked indices from the correct-answer indices).
    const options = q.options.map((opt, oi) => ({ opt, oi }));
    if (this.exam.shuffleAnswers) this.shuffle(options);

    return `<div class="checkbox-options" id="checkbox-${q.id}">` +
      options.map(({ opt, oi }) => `
        <label class="checkbox-option" id="checkbox-opt-${q.id}-${oi}" data-exam-control="true" data-qid="${q.id}" data-idx="${oi}">
          <div class="checkbox-wrapper-30"><div class="checkbox" style="--size:0.9;--stroke:#1a6b35;">
            <input type="checkbox" onchange="ExamApp.toggleCheckboxOption(this)" />
            <svg viewBox="0 0 24 24"><rect x="1" y="1" width="22" height="22" rx="3" class="cb-border"/><polyline points="20,6 9,17 4,12" class="cb-check"/></svg>
          </div></div>
          <span class="mcq-option-text">${_escText(opt)}</span>
        </label>
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
        <span style="font-size:13px;color:var(--text-muted);font-weight:700;min-width:22px;">${i+1}.</span>
        <input type="text" class="form-control" id="enum-${q.id}-${i}" data-exam-control="true" placeholder="Item ${i+1}"
          autocomplete="off" spellcheck="true"
          oninput="ExamApp.handleEnumInput(event,'${q.id}',${count})" style="flex:1;" />
      </div>`).join('');
    return `<div style="display:flex;flex-direction:column;gap:8px;">${rows}</div>
      <div style="font-size:11px;color:var(--text-muted);margin-top:6px;">List all ${count} items. Each correct item earns partial points.</div>`;
  },

  _renderMatching(q, idx) {
    const pairs = q.pairs || [];
    // Show shuffled matches on the right
    const matches = [...pairs.map(p=>p.match)].sort(()=>Math.random()-0.5);
    return `<div style="display:flex;flex-direction:column;gap:8px;">
      ${pairs.map((p,pi)=>`
        <div style="display:grid;grid-template-columns:1fr auto 1fr;gap:10px;align-items:center;">
          <div style="background:var(--surface-2);color:var(--text);border-radius:8px;padding:8px 12px;font-size:13px;font-weight:600;">${_esc(p.term)}</div>
          <div style="color:var(--text-muted);font-size:16px;display:flex;align-items:center;justify-content:center;">${this._portalIcon('arrowRight', { size: 14, stroke: 'currentColor' })}</div>
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

  _getCodingEditorTheme(themeOverride) {
    const normalized = themeOverride === 'dark'
      ? 'dark'
      : themeOverride === 'light'
        ? 'light'
        : (document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light');
    return normalized === 'dark' ? 'dracula' : 'default';
  },

  _applyCodingFallbackTheme(textarea, themeOverride) {
    if (!textarea) return;
    const isDark = this._getCodingEditorTheme(themeOverride) === 'dracula';
    textarea.style.cssText = [
      'width:100%',
      'min-height:260px',
      "font-family:'Fira Code','Cascadia Code','Courier New',monospace",
      'font-size:13px',
      'line-height:1.6',
      'padding:14px 16px',
      'border-radius:0',
      'border:none',
      'outline:none',
      `background:${isDark ? '#1f2430' : '#f8fafc'}`,
      `color:${isDark ? '#e5e7eb' : '#111827'}`,
      'resize:vertical',
    ].join(';') + ';';
  },

  applyCodingEditorTheme(themeOverride) {
    const nextTheme = this._getCodingEditorTheme(themeOverride);
    document.querySelectorAll('.coding-cm-wrap').forEach(wrap => {
      if (wrap?._cm) {
        wrap._cm.setOption('theme', nextTheme);
        wrap._cm.refresh();
      }
    });
    document.querySelectorAll('.coding-cm-source').forEach(src => {
      if (src && src.style.display !== 'none') this._applyCodingFallbackTheme(src, themeOverride);
    });
  },

  _refreshVisibleCodeEditors() {
    this.questionOrder.forEach((q, idx) => {
      if (q.type !== 'coding' || idx !== this.currentQuestionIndex) return;
      const wrap = document.getElementById('coding-cm-' + q.id);
      if (wrap?._cm) wrap._cm.refresh();
    });
  },

  _loadCodeEditorRuntime() {
    if (window.CodeMirror) return Promise.resolve(window.CodeMirror);
    if (this._codeEditorRuntimePromise) return this._codeEditorRuntimePromise;

    const base = 'https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.16';
    this._codeEditorRuntimePromise = Promise.all([
      loadExamStylesheet(`${base}/codemirror.min.css`),
      loadExamStylesheet(`${base}/theme/dracula.min.css`),
    ])
      .then(() => loadExamScript(`${base}/codemirror.min.js`))
      .then(() => Promise.all([
        loadExamScript(`${base}/mode/python/python.min.js`),
        loadExamScript(`${base}/mode/javascript/javascript.min.js`),
        loadExamScript(`${base}/mode/clike/clike.min.js`),
      ]))
      .then(() => window.CodeMirror)
      .catch(error => {
        this._codeEditorRuntimePromise = null;
        throw error;
      });
    return this._codeEditorRuntimePromise;
  },

  _initCodeEditors() {
    const LANG_MODE = { python:'python', javascript:'javascript', java:'clike', cpp:'clike', c:'clike', php:'php' };
    this.questionOrder.forEach(q => {
      if (q.type !== 'coding') return;
      const wrap = document.getElementById('coding-cm-' + q.id);
      const src  = document.getElementById('coding-textarea-' + q.id);
      if (!wrap || !src || wrap.dataset.cmInit) return;

      if (!window.CodeMirror) {
        // Keep the editor usable while CodeMirror downloads or if its CDN is
        // unavailable. It is upgraded without losing the current answer.
        src.style.display = '';
        this._applyCodingFallbackTheme(src);
        src.oninput = () => ExamApp.selectAnswer(q.id, src.value);
        if (this.answers[q.id]) src.value = this.answers[q.id];
        return;
      }

      wrap.dataset.cmInit = '1';
      src.style.display = 'none';
      const cm = window.CodeMirror(wrap, {
        value: (this.answers[q.id] !== undefined ? this.answers[q.id] : src.value) || '',
        mode: LANG_MODE[q.language || 'python'] || 'python',
        theme: this._getCodingEditorTheme(),
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
      requestAnimationFrame(() => cm.refresh());
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
    } else if (q.type === 'checkbox') {
      let selectedIndices = [];
      try { selectedIndices = JSON.parse(value) || []; } catch (_) {}
      const opts = document.querySelectorAll(`[data-qid="${q.id}"].checkbox-option`);
      opts.forEach(opt => {
        if (!selectedIndices.includes(parseInt(opt.dataset.idx, 10))) return;
        opt.classList.add('selected');
        const input = opt.querySelector('input[type="checkbox"]');
        if (input) input.checked = true;
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
  selectMCQ(el) {
    const questionId = el.dataset.qid;
    const value = el.dataset.val;
    // Deselect all options for this question
    document.querySelectorAll(`[data-qid="${questionId}"].mcq-option`).forEach(opt => {
      opt.classList.remove('selected');
    });
    // Select clicked — read the value straight off the clicked element rather than
    // re-matching by value, so option text with quotes/special characters can never
    // break re-selection.
    el.classList.add('selected');
    this.selectAnswer(questionId, value);
  },

  toggleCheckboxOption(inputEl) {
    const optionEl = inputEl.closest('.checkbox-option');
    if (!optionEl) return;
    optionEl.classList.toggle('selected', inputEl.checked);
    const questionId = optionEl.dataset.qid;
    const selectedIndices = [...document.querySelectorAll(`[data-qid="${questionId}"].checkbox-option`)]
      .filter(opt => opt.querySelector('input[type="checkbox"]')?.checked)
      .map(opt => parseInt(opt.dataset.idx, 10))
      .sort((a, b) => a - b);
    // Store '' (not '[]') when nothing is checked, so this reads as unanswered like every
    // other question type instead of a truthy-but-empty string.
    this.selectAnswer(questionId, selectedIndices.length ? JSON.stringify(selectedIndices) : '');
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

  // ============================================================
  // CONNECTIVITY MONITOR
  // ============================================================
  // navigator.onLine / the browser's online-offline events only reflect the
  // network adapter's state — they miss "connected to Wi-Fi but no internet"
  // and can't tell strong from weak. So this combines both: the native events
  // give an instant signal the moment the adapter actually drops, and a
  // periodic same-origin fetch (timed) gives a real reachability + latency
  // reading in between. Two consecutive failed probes (or a native 'offline'
  // event) are required before the exam freezes, so a single dropped packet
  // doesn't slam the freeze overlay shut on a student for no reason.
  _initConnectionMonitor() {
    this._connFailStreak = 0;
    this._pendingManualSubmit = false;
    this._connOnlineHandler = () => this._probeConnection();
    this._connOfflineHandler = () => {
      this._connFailStreak = 2; // the OS itself says the adapter is down — trust it immediately
      this._setConnectionState('offline');
    };
    window.addEventListener('online', this._connOnlineHandler);
    window.addEventListener('offline', this._connOfflineHandler);
    if (this._connCheckInterval) clearInterval(this._connCheckInterval);
    this._connCheckInterval = setInterval(() => this._probeConnection(), this._CONN_PROBE_MS);
    this._probeConnection();
  },

  _stopConnectionMonitor() {
    if (this._connCheckInterval) { clearInterval(this._connCheckInterval); this._connCheckInterval = null; }
    if (this._connOnlineHandler) { window.removeEventListener('online', this._connOnlineHandler); this._connOnlineHandler = null; }
    if (this._connOfflineHandler) { window.removeEventListener('offline', this._connOfflineHandler); this._connOfflineHandler = null; }
  },

  _isOffline() { return this._connectionState === 'offline'; },

  // Same-origin requests (e.g. this app's own dev/hosting server) can succeed over the
  // OS loopback interface even with Wi-Fi fully off, which would make this probe lie.
  // Supabase is a genuinely remote dependency the exam actually needs (it's where
  // answers get saved), so pinging it is both a real network test AND the exact
  // signal that matters: if this fails, saving would fail too. `no-cors` is used
  // because we only need to know the request could complete, not read its response.
  _connProbeUrl() {
    const base = window.SupabaseBridge?.env?.url;
    return base ? `${base}/auth/v1/health?_cb=` : '/plp-logo.png?_cb=';
  },

  async _probeConnection() {
    if (!navigator.onLine) { this._connFailStreak = 2; this._setConnectionState('offline'); return; }
    const start = Date.now();
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this._CONN_TIMEOUT_MS);
      await fetch(this._connProbeUrl() + start, { method: 'GET', mode: 'no-cors', cache: 'no-store', signal: controller.signal });
      clearTimeout(timer);
      this._connFailStreak = 0;
      this._setConnectionState((Date.now() - start) > this._CONN_WEAK_MS ? 'weak' : 'online');
    } catch (e) {
      this._connFailStreak++;
      this._setConnectionState(this._connFailStreak >= 2 ? 'offline' : 'weak');
    }
  },

  _setConnectionState(state) {
    const prev = this._connectionState;
    this._connectionState = state;
    this._updateConnectionIndicator(state);
    if (state === 'offline' && prev !== 'offline') {
      this._showOfflineOverlay();
      this._recordActivity('connection_lost', 'Internet connection lost — exam frozen until reconnect');
    } else if (state !== 'offline' && prev === 'offline') {
      this._hideOfflineOverlay();
      this._recordActivity('connection_restored', 'Internet connection restored — resyncing answers');
      this._resyncSessionState();
    }
  },

  _updateConnectionIndicator(state) {
    const wrap = document.getElementById('connection-status');
    const icon = document.getElementById('connection-icon');
    const label = document.getElementById('connection-label');
    if (!wrap || !icon || !label) return;
    wrap.className = 'conn-status conn-' + state;
    const icons = {
      online:  '<path d="M5 12.55a11 11 0 0 1 14.08 0"/><path d="M1.42 9a16 16 0 0 1 21.16 0"/><path d="M8.53 16.11a6 6 0 0 1 6.95 0"/><line x1="12" y1="20" x2="12.01" y2="20"/>',
      weak:    '<path d="M8.53 16.11a6 6 0 0 1 6.95 0"/><line x1="12" y1="20" x2="12.01" y2="20"/><path d="M1.42 9a16 16 0 0 1 3.4-2.6" opacity="0.3"/><path d="M19.18 6.4A16 16 0 0 1 22.58 9" opacity="0.3"/>',
      offline: '<line x1="1" y1="1" x2="23" y2="23"/><path d="M16.72 11.06A10.94 10.94 0 0 1 19 12.55"/><path d="M5 12.55a10.94 10.94 0 0 1 5.17-2.39"/><path d="M10.71 5.05A16 16 0 0 1 22.58 9"/><path d="M1.42 9a15.91 15.91 0 0 1 4.7-2.88"/><path d="M8.53 16.11a6 6 0 0 1 6.95 0"/><line x1="12" y1="20" x2="12.01" y2="20"/>',
    };
    const labels = { online: 'Online', weak: 'Weak connection', offline: 'Offline' };
    icon.innerHTML = icons[state] || icons.online;
    label.textContent = labels[state] || 'Online';
  },

  _showOfflineOverlay() {
    const overlay = document.getElementById('offline-overlay');
    if (!overlay) return;
    const detail = document.getElementById('offline-overlay-detail');
    if (detail) {
      detail.textContent = this._pendingManualSubmit
        ? 'Your exam will submit automatically once you’re back online.'
        : 'Your answers are saved. The exam will resume automatically once you’re back online.';
    }
    overlay.style.display = 'flex';
  },

  _hideOfflineOverlay() {
    const overlay = document.getElementById('offline-overlay');
    if (overlay) overlay.style.display = 'none';
  },

  // Belt-and-suspenders for the moment right at the offline transition, before the
  // full-screen overlay has painted — makes the block visible immediately either way.
  _flashReconnectNotice(message) {
    this._showOfflineOverlay();
    const detail = document.getElementById('offline-overlay-detail');
    if (detail && message) detail.textContent = message;
    const content = document.getElementById('offline-overlay-content');
    if (content) {
      content.classList.remove('offline-shake');
      void content.offsetWidth;
      content.classList.add('offline-shake');
    }
  },

  // Push the latest local state back to the server once reconnected. `answers` is
  // always the full current map (not a delta), so resending it now supersedes every
  // write that silently failed while offline — no replay queue needed.
  _resyncSessionState() {
    if (this.session) {
      DB.updateSession(this.session.id, { answers: this.answers, warnings: this.warnings });
    }
    if (this._pendingManualSubmit) {
      this._pendingManualSubmit = false;
      this.submitExam('manual');
      return;
    }
    // Unfreeze: showQuestion() was refusing to run while offline, so re-run it now.
    this.showQuestion(this.currentQuestionIndex);
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
    if (this._isOffline()) { this._flashReconnectNotice(); return; }
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
    if (nextBtn) {
      const isLastQuestion = idx === questions.length - 1;
      nextBtn.disabled = isLastQuestion;
      nextBtn.style.display = isLastQuestion ? 'none' : '';
    }

    const cb = document.getElementById('mark-review-cb');
    if (cb) cb.checked = this.markedForReview.has(idx);

    const wrap = document.querySelector('.examv2-main');
    if (wrap) wrap.scrollTop = 0;

    // Show a plain editor immediately, then enhance it only when a coding
    // question actually needs CodeMirror.
    requestAnimationFrame(() => {
      this._initCodeEditors();
      const currentQuestion = questions[idx];
      if (currentQuestion?.type !== 'coding') return;
      this._loadCodeEditorRuntime()
        .then(() => {
          this._initCodeEditors();
          requestAnimationFrame(() => this._refreshVisibleCodeEditors());
        })
        .catch(error => console.warn('[Editor] CodeMirror fallback active:', error?.message || error));
    });

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

  // ── Question text zoom ─────────────────────────────────────
  _examFontScaleMin: 0.85,
  _examFontScaleMax: 1.4,
  _examFontScaleStep: 0.1,

  _applyFontScale(scale) {
    const wrap = document.getElementById('questions-container');
    if (wrap) wrap.style.setProperty('--exam-font-scale', scale);
    this._examFontScale = scale;
    try { localStorage.setItem('examFontScale', String(scale)); } catch (_) {}
  },

  _restoreFontScale() {
    let scale = 1;
    try {
      const saved = parseFloat(localStorage.getItem('examFontScale'));
      if (!isNaN(saved)) scale = Math.min(this._examFontScaleMax, Math.max(this._examFontScaleMin, saved));
    } catch (_) {}
    this._applyFontScale(scale);
  },

  adjustFontScale(direction) {
    const current = this._examFontScale || 1;
    const next = Math.round(Math.min(this._examFontScaleMax, Math.max(this._examFontScaleMin, current + direction * this._examFontScaleStep)) * 100) / 100;
    this._applyFontScale(next);
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
    lockBodyScroll();
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
    const modal = document.getElementById('confirm-submit-modal');
    if (modal && !modal.classList.contains('hidden')) unlockBodyScroll();
    modal.classList.add('hidden');
  },

  showReview() {
    const sess = this.session ? DB.getSession(this.session.id) : null;
    const exam = this.exam;
    if (!sess || !exam) return;
    const scoreReleased = !!sess.scoreReleased;

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
    if (scoreEl) {
      scoreEl.removeAttribute('style');
      if (scoreReleased && sess.score !== null && sess.maxScore !== null) {
        const totalScore = Number(sess.score || 0);
        const maxScore = Number(sess.maxScore || 0);
        const pct = maxScore ? Math.round(totalScore / maxScore * 100) : 0;
        scoreEl.className = `review-score-chip ${pct >= 75 ? 'score-high' : pct >= 60 ? 'score-mid' : 'score-low'}`;
        scoreEl.innerHTML = `
          <div class="review-score-chip-stats">
            <span id="review-score-value">${totalScore}/${maxScore}</span>
            <span class="review-score-chip-divider"></span>
            <span id="review-score-pct">${pct}%</span>
          </div>
          <div class="review-score-chip-label">Total Score</div>
        `;
      } else {
        scoreEl.className = 'review-score-chip review-score-chip-pending';
        scoreEl.innerHTML = `
          <div class="review-score-chip-stats">
            <span>Score Hidden</span>
          </div>
          <div class="review-score-chip-label">Your professor will release scores when ready</div>
        `;
      }
    }

    const typeLabel = { mcq: 'MCQ', checkbox: 'Checkbox', tf: 'T/F', identification: 'ID', enumeration: 'Enumeration', matching: 'Matching', essay: 'Essay' };

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
        if (scoreReleased) {
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
        } else {
          resultHtml = `
            <div class="review-answer-group">
              <div class="review-answer-row">
                <div class="review-answer-label">Your answer</div>
                <div class="review-answer-value ${studentItemsRaw.length ? 'is-neutral' : 'is-empty'}">${studentItemsRaw.length ? `${studentItemsRaw.length} item(s) submitted` : '(no answer)'}</div>
              </div>
              <div class="review-enum-list">
                ${studentItemsRaw.length ? studentItemsRaw.map((item) => {
                  const got = expected.some((e) => e.toUpperCase() === item.toUpperCase());
                  return `<div class="review-enum-item ${got ? 'is-correct' : 'is-wrong'}">
                    <span class="review-enum-icon">${this._portalIcon(got ? 'check' : 'x', { size: 14, stroke: got ? '#15803d' : '#dc2626' })}</span>
                    <div class="review-enum-copy">
                      <div class="review-enum-expected">${_esc(item)}</div>
                      <div class="review-enum-student">${got ? 'This submitted item is correct.' : 'This submitted item is incorrect.'}</div>
                    </div>
                  </div>`;
                }).join('') : `<div class="review-answer-note">(no answer)</div>`}
              </div>
              <div class="review-answer-note">${matched.length} correct submitted item(s). Remaining answers stay hidden until your professor releases scores.</div>
            </div>`;
        }
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
                    ${scoreReleased
                      ? (!correct ? `<div class="review-matching-correct">Correct: ${_esc(p.match)}</div>` : '')
                      : `<div class="review-matching-note">${correct ? 'Matched correctly.' : studentValue ? 'Correct match hidden until scores are released.' : 'No answer submitted.'}</div>`}
                  </div>
                </div>`;
              }).join('')}
            </div>
          </div>`;
      } else if (q.type === 'checkbox') {
        let given = [];
        try { given = JSON.parse(ans || '[]') || []; } catch (_) {}
        const correctIndices = q.correctAnswerIndices || [];
        if (scoreReleased) {
          resultHtml = `
            <div class="review-answer-group">
              <div class="review-enum-list">
                ${(q.options || []).map((opt, oi) => {
                  const wasGiven = given.includes(oi);
                  const shouldBeGiven = correctIndices.includes(oi);
                  const got = wasGiven === shouldBeGiven;
                  if (!wasGiven && !shouldBeGiven) return '';
                  return `<div class="review-enum-item ${got ? 'is-correct' : 'is-wrong'}">
                    <span class="review-enum-icon">${this._portalIcon(got ? 'check' : 'x', { size: 14, stroke: got ? '#15803d' : '#dc2626' })}</span>
                    <div class="review-enum-copy">
                      <div class="review-enum-expected">${_esc(opt)}</div>
                      ${!got ? `<div class="review-enum-student">${wasGiven ? 'You selected this, but it\'s not correct' : 'You missed this correct option'}</div>` : ''}
                    </div>
                  </div>`;
                }).join('') || `<div class="review-answer-note">(no answer)</div>`}
              </div>
            </div>`;
        } else {
          const missedCount = correctIndices.filter((oi) => !given.includes(oi)).length;
          resultHtml = `
            <div class="review-answer-group">
              <div class="review-enum-list">
                ${given.length ? given.map((oi) => {
                  const opt = (q.options || [])[oi];
                  const got = correctIndices.includes(oi);
                  return `<div class="review-enum-item ${got ? 'is-correct' : 'is-wrong'}">
                    <span class="review-enum-icon">${this._portalIcon(got ? 'check' : 'x', { size: 14, stroke: got ? '#15803d' : '#dc2626' })}</span>
                    <div class="review-enum-copy">
                      <div class="review-enum-expected">${_esc(opt || 'Selected option')}</div>
                      <div class="review-enum-student">${got ? 'This selected option is correct.' : 'This selected option is incorrect.'}</div>
                    </div>
                  </div>`;
                }).join('') : `<div class="review-answer-note">(no answer)</div>`}
              </div>
              <div class="review-answer-note">${missedCount > 0 ? `${missedCount} correct option(s) remain hidden until your professor releases scores.` : 'Full answer details will appear once scores are released.'}</div>
            </div>`;
        }
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
            ${scoreReleased
              ? `<div class="review-answer-row">
                  <div class="review-answer-label">Correct answer</div>
                  <div class="review-answer-value is-correct">${_esc(q.correctAnswer || '-')}</div>
                </div>`
              : ''}
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
    this._stopSessionSyncPolling();
    this._disableRefreshProtection();
    this._examRuntimeStarted = false;
    const cameraRequirementModal = document.getElementById('camera-requirement-modal');
    if (cameraRequirementModal && !cameraRequirementModal.classList.contains('hidden')) unlockBodyScroll();
    cameraRequirementModal?.classList.add('hidden');
    const policiesModal = document.getElementById('exam-policies-modal');
    if (policiesModal && !policiesModal.classList.contains('hidden')) unlockBodyScroll();
    policiesModal?.classList.add('hidden');
    this._hideWebcamWaitNoticeModal();
    this._hideWebcamDeniedDecisionModal();
    this._hideWebcamWaitOverlay();
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
    // Auto-submit (violations/timeout) still proceeds locally so it can't be dodged by
    // pulling the connection; the reconnect resync will push it once back online. A
    // manual submit, however, must wait — otherwise the student sees "Submitted!" while
    // the actual score silently never reaches the server.
    if (trigger === 'manual' && this._isOffline()) {
      this._pendingManualSubmit = true;
      this._flashReconnectNotice('Reconnect to submit your exam.');
      return;
    }
    const submitModal = document.getElementById('confirm-submit-modal');
    if (submitModal && !submitModal.classList.contains('hidden')) unlockBodyScroll();
    submitModal.classList.add('hidden');

    this._disableRefreshProtection();
    this._stopSessionSyncPolling();
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
      const autoSubmitted = trigger === 'auto' || trigger === 'timeout' || trigger === 'exam_closed';
      // Records WHY the session ended up auto-submitted (violations vs. time
      // running out) so the professor's Reports tab can show the real reason
      // instead of guessing from the warning count after the fact.
      const submitReason = trigger === 'timeout' ? 'timeout'
        : trigger === 'exam_closed' ? 'exam_closed'
        : trigger === 'auto' ? 'violations'
        : 'manual';
      DB.updateSession(this.session.id, {
        submitted: true,
        autoSubmitted,
        submitReason,
        endTime: new Date().toISOString(),
        answers: this.answers,
        score: score.earned,
        maxScore: score.max,
      });

      if (trigger === 'timeout') {
        DB.addLog({ sessionId: this.session.id, studentId: this.session.studentId, examId: this.exam.id, type: 'timeout', details: 'Auto-submitted: time expired' });
      } else if (trigger === 'exam_closed') {
        DB.addLog({ sessionId: this.session.id, studentId: this.session.studentId, examId: this.exam.id, type: 'exam_closed', details: 'Auto-submitted: exam was closed by professor' });
      } else if (trigger === 'auto') {
        DB.addLog({ sessionId: this.session.id, studentId: this.session.studentId, examId: this.exam.id, type: 'auto_submit', details: 'Auto-submitted: max warnings reached' });
      }
      this.session = this._getLiveSession() || { ...this.session, submitted: true, autoSubmitted, submitReason };
    }

    this._showSubmitted(true);
  },

  _showSubmitted(freshSubmit) {
    this.showState('submitted');
    this._pendingReviewReopen = false;
    const resumeBtn = document.getElementById('btn-resume-reopened-exam');
    if (resumeBtn) resumeBtn.style.display = 'none';

    // Keep the professor chat reachable after submission.
    if (this.exam && this.session) {
      this._ensureChatUI();
      this._renderChatMessages();
      this._updateChatBadge();
      const fab = document.getElementById('exam-chat-fab');
      if (fab) fab.style.display = '';
    }

    const session = this.session ? DB.getSession(this.session.id) : null;
    const warningAutoSubmit = session?.autoSubmitted
      && (session.submitReason === 'violations' || (!session.submitReason && Number(session.warnings || 0) >= 3));
    if (warningAutoSubmit) this._startSessionSyncPolling();
    const titleEl  = document.getElementById('submitted-title');
    const msgEl    = document.getElementById('submitted-msg');
    const iconWrap = document.getElementById('submitted-icon-wrap');
    const autoNote = document.getElementById('submitted-auto-note');

    if (freshSubmit) {
      // Immediately after submitting
      if (session && this._isForceSubmittedSession(session)) {
        iconWrap.innerHTML = _submittedIcon('auto');
        iconWrap.className = 'submitted-icon-wrap auto';
        titleEl.textContent = 'Exam Force-Submitted';
        msgEl.textContent = 'Your professor ended this attempt and submitted your current answers.';
      } else if (session && session.autoSubmitted) {
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
      if (session && this._isForceSubmittedSession(session)) {
        autoNote.classList.remove('hidden');
        autoNote.innerHTML = `
          <span class="submitted-auto-badge">${this._portalIcon('checkCircle', { size: 13, stroke: 'currentColor' })}<span>Force-Submitted</span></span>
          <span class="submitted-auto-text">Your professor submitted your exam for you.</span>
        `;
      } else if (session && session.autoSubmitted) {
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
    return this._calculateScoreFor(this.exam, this.answers);
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

  // Shuffles question order while keeping each question type contiguous (its own
  // "section") — e.g. all Multiple Choice questions stay together, all True/False
  // questions stay together, etc. Only the order WITHIN each type group is randomized;
  // the relative order of the type groups themselves matches their first occurrence
  // in the original exam (i.e. however the professor arranged the types).
  _shuffleWithinTypeGroups(questions) {
    const groupOrder = [];
    const groups = {};
    questions.forEach(q => {
      if (!groups[q.type]) { groups[q.type] = []; groupOrder.push(q.type); }
      groups[q.type].push(q);
    });
    groupOrder.forEach(type => this.shuffle(groups[type]));
    return groupOrder.flatMap(type => groups[type]);
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
document.addEventListener('supabaseSyncError', (e) => {
  const msg = e.detail?.message || 'Unable to sync with the server right now.';
  ExamApp._showToast(msg, 'error', { context: 'sync' });
});

document.addEventListener('acsDataChanged', (e) => {
  ExamApp._handlePortalDataChange(e.detail?.table);
  ExamApp._handleExamDataChange(e.detail?.table);
});

window.addEventListener('storage', (e) => {
  if (e.key && !e.key.startsWith('acs_')) return;
  const table = e.key === 'acs_messages' ? 'messages'
    : e.key === 'acs_sessions' ? 'sessions'
    : e.key === 'acs_exams' ? 'exams'
    : e.key === 'acs_students' ? 'students'
    : e.key === 'acs_subjects' ? 'subjects'
    : 'unknown';
  document.dispatchEvent(new CustomEvent('acsDataChanged', { detail: { table } }));
});

document.addEventListener('dbReady', () => ExamApp.init());


// Expose as global for ES-module consumers (React)
window.ExamApp = ExamApp;

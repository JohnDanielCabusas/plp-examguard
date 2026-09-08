import {
  FACE_EVENT_DESCRIPTIONS,
  FACE_EVENT_SEVERITY,
  createIncidentId,
} from './faceMonitoringTypes.js';

const CONDITION_RULES = Object.freeze([
  { eventType: 'FACE_ABSENT', flag: 'faceAbsent', thresholdKey: 'faceAbsentIncidentMs' },
  { eventType: 'FACE_PARTIALLY_VISIBLE', flag: 'partiallyVisible', thresholdKey: 'positioningIncidentMs' },
  { eventType: 'FACE_TOO_CLOSE', flag: 'tooClose', thresholdKey: 'positioningIncidentMs' },
  { eventType: 'FACE_TOO_FAR', flag: 'tooFar', thresholdKey: 'positioningIncidentMs' },
  { eventType: 'FACE_NEAR_FRAME_EDGE', flag: 'nearFrameEdge', thresholdKey: 'positioningIncidentMs' },
  { eventType: 'FACE_OCCLUDED', flag: 'occluded', thresholdKey: 'occlusionIncidentMs' },
  { eventType: 'FACE_TRACKING_UNSTABLE', flag: 'trackingUnstable', thresholdKey: 'unstableTrackingIncidentMs' },
  { eventType: 'SUSTAINED_LOOKING_DOWN', flag: 'lookingDown', thresholdKey: 'lookingDownIncidentMs' },
  { eventType: 'SUSTAINED_HEAD_TURN', flag: 'headTurned', thresholdKey: 'headTurnIncidentMs' },
]);

const POSITIONING_WARNINGS = Object.freeze({
  FACE_ABSENT: 'Please keep your face visible on camera.',
  FACE_PARTIALLY_VISIBLE: 'Your face is partially outside the camera frame.',
  FACE_TOO_CLOSE: 'Move slightly farther from the camera.',
  FACE_TOO_FAR: 'Move slightly closer to the camera.',
  FACE_NEAR_FRAME_EDGE: 'Please center your face in the camera frame.',
  FACE_OCCLUDED: 'Please keep your face unobstructed.',
  FACE_TRACKING_UNSTABLE: 'Improve the lighting so your face remains visible.',
});

const COUNTDOWN_EVENT_TYPES = new Set([
  'FACE_ABSENT',
  'SUSTAINED_HEAD_TURN',
  'SUSTAINED_LOOKING_DOWN',
]);

function iso(value) {
  return new Date(value).toISOString();
}

function incidentMetrics(track, observation) {
  const relative = observation?.relativePose || {};
  return {
    maxYaw: Math.max(Number(track.maxYaw || 0), Math.abs(Number(relative.yaw || 0))),
    maxPitch: Math.max(Number(track.maxPitch || 0), Math.abs(Number(relative.pitch || 0))),
    trackingConfidence: track.trackingSamples
      ? track.trackingTotal / track.trackingSamples
      : Number(observation?.trackingQuality || 0),
  };
}

export class FaceTemporalRuleEngine {
  constructor(config, onEvent = () => {}) {
    this.config = config;
    this.onEvent = onEvent;
    this.trackers = new Map();
    this.awayIncidentTimes = [];
    this.repeatedAwayCooldownUntil = 0;
  }

  _getTracker(eventType) {
    if (!this.trackers.has(eventType)) {
      this.trackers.set(eventType, {
        candidateSince: null,
        recoverySince: null,
        warningSent: false,
        active: null,
        cooldownUntil: 0,
        maxYaw: 0,
        maxPitch: 0,
        trackingTotal: 0,
        trackingSamples: 0,
        lastCountdownSecond: null,
      });
    }
    return this.trackers.get(eventType);
  }

  _emitIncident(phase, eventType, track, now, wallNow, observation) {
    const active = track.active;
    if (!active) return;
    const durationMs = Math.max(0, now - active.startedMonotonicAt);
    const metrics = incidentMetrics(track, observation);
    const payload = {
      kind: 'incident',
      phase,
      incidentId: active.incidentId,
      source: 'FACEMESH',
      eventType,
      severity: FACE_EVENT_SEVERITY[eventType] || 'INFO',
      description: FACE_EVENT_DESCRIPTIONS[eventType] || eventType,
      direction: active.direction || null,
      startedAt: active.startedAt,
      endedAt: phase === 'end' ? iso(wallNow) : null,
      durationMs,
      maxYaw: Math.round(metrics.maxYaw * 10) / 10,
      maxPitch: Math.round(metrics.maxPitch * 10) / 10,
      trackingConfidence: Math.round(metrics.trackingConfidence * 1000) / 1000,
      requiresProfessorReview: true,
    };
    active.lastEmittedAt = now;
    this.onEvent(payload);
  }

  _start(eventType, track, now, wallNow, observation) {
    const elapsedBeforeEmission = Math.max(0, now - track.candidateSince);
    const startedWall = wallNow - elapsedBeforeEmission;
    track.active = {
      incidentId: createIncidentId(),
      startedMonotonicAt: track.candidateSince,
      startedAt: iso(startedWall),
      direction: observation?.headDirection?.replace(/^HEAD_/, '') || null,
      lastEmittedAt: 0,
    };
    this._emitIncident('start', eventType, track, now, wallNow, observation);
  }

  _finish(eventType, track, now, wallNow, observation) {
    if (!track.active) return;
    const incidentId = track.active.incidentId;
    this._emitIncident('end', eventType, track, now, wallNow, observation);
    if (eventType === 'SUSTAINED_HEAD_TURN' || eventType === 'SUSTAINED_LOOKING_DOWN') {
      this._recordAwayIncident(wallNow, incidentId, observation);
    }
    track.active = null;
    track.candidateSince = null;
    track.recoverySince = null;
    track.warningSent = false;
    track.cooldownUntil = now + this.config.cooldownMs;
    track.maxYaw = 0;
    track.maxPitch = 0;
    track.trackingTotal = 0;
    track.trackingSamples = 0;
    track.lastCountdownSecond = null;
  }

  _recordAwayIncident(wallNow, relatedIncidentId, observation) {
    this.awayIncidentTimes = this.awayIncidentTimes
      .filter(entry => wallNow - entry.at <= this.config.repeatedAwayWindowMs);
    this.awayIncidentTimes.push({ at: wallNow, incidentId: relatedIncidentId });
    if (
      this.awayIncidentTimes.length < this.config.repeatedAwayCount
      || wallNow < this.repeatedAwayCooldownUntil
    ) return;

    const incidentId = createIncidentId('face-pattern');
    const common = {
      kind: 'incident',
      incidentId,
      source: 'FACEMESH',
      eventType: 'REPEATED_LOOKING_AWAY',
      severity: FACE_EVENT_SEVERITY.REPEATED_LOOKING_AWAY,
      description: FACE_EVENT_DESCRIPTIONS.REPEATED_LOOKING_AWAY,
      direction: null,
      startedAt: iso(this.awayIncidentTimes[0].at),
      durationMs: Math.max(0, wallNow - this.awayIncidentTimes[0].at),
      maxYaw: Math.abs(Number(observation?.relativePose?.yaw || 0)),
      maxPitch: Math.abs(Number(observation?.relativePose?.pitch || 0)),
      trackingConfidence: Number(observation?.trackingQuality || 0),
      requiresProfessorReview: true,
      relatedIncidentIds: this.awayIncidentTimes.map(entry => entry.incidentId),
    };
    this.onEvent({ ...common, phase: 'start', endedAt: null });
    this.onEvent({ ...common, phase: 'end', endedAt: iso(wallNow) });
    this.repeatedAwayCooldownUntil = wallNow + this.config.repeatedAwayCooldownMs;
  }

  _updateRule(rule, condition, observation, now, wallNow) {
    const track = this._getTracker(rule.eventType);
    if (condition) {
      track.recoverySince = null;
      if (track.candidateSince === null && now >= track.cooldownUntil) track.candidateSince = now;
      if (track.candidateSince === null) return;

      const relative = observation?.relativePose || {};
      track.maxYaw = Math.max(track.maxYaw, Math.abs(Number(relative.yaw || 0)));
      track.maxPitch = Math.max(track.maxPitch, Math.abs(Number(relative.pitch || 0)));
      const quality = Number(observation?.trackingQuality);
      if (Number.isFinite(quality)) {
        track.trackingTotal += quality;
        track.trackingSamples += 1;
      }

      const elapsed = now - track.candidateSince;
      const incidentThresholdMs = Number(this.config[rule.thresholdKey] || 0);
      if (COUNTDOWN_EVENT_TYPES.has(rule.eventType) && !track.active) {
        const remainingSeconds = Math.max(0, Math.ceil((incidentThresholdMs - elapsed) / 1000));
        if (remainingSeconds !== track.lastCountdownSecond) {
          track.lastCountdownSecond = remainingSeconds;
          this.onEvent({
            kind: 'condition-progress',
            eventType: rule.eventType,
            direction: observation?.headDirection?.replace(/^HEAD_/, '') || null,
            elapsedMs: Math.max(0, elapsed),
            thresholdMs: incidentThresholdMs,
            remainingSeconds,
          });
        }
      }
      if (!track.warningSent && POSITIONING_WARNINGS[rule.eventType] && elapsed >= this.config.positioningWarningMs) {
        track.warningSent = true;
        this.onEvent({
          kind: 'positioning-warning',
          eventType: rule.eventType,
          description: POSITIONING_WARNINGS[rule.eventType],
        });
      }

      if (!track.active && elapsed >= incidentThresholdMs) {
        this._start(rule.eventType, track, now, wallNow, observation);
      } else if (
        track.active
        && now - track.active.lastEmittedAt >= this.config.incidentUpdateMs
      ) {
        this._emitIncident('update', rule.eventType, track, now, wallNow, observation);
      }
      return;
    }

    track.candidateSince = null;
    if (track.lastCountdownSecond !== null) {
      this.onEvent({ kind: 'condition-progress-clear', eventType: rule.eventType });
      track.lastCountdownSecond = null;
    }
    if (track.warningSent) {
      this.onEvent({ kind: 'positioning-warning-clear', eventType: rule.eventType });
    }
    track.warningSent = false;
    if (!track.active) {
      track.maxYaw = 0;
      track.maxPitch = 0;
      track.trackingTotal = 0;
      track.trackingSamples = 0;
      return;
    }
    if (track.recoverySince === null) track.recoverySince = now;
    if (now - track.recoverySince >= this.config.recoveryMs) {
      this._finish(rule.eventType, track, now, wallNow, observation);
    }
  }

  update(observation) {
    const now = Number(observation?.timestampMs ?? performance.now());
    const wallNow = Number(observation?.wallClockMs ?? Date.now());
    const faceAbsent = observation?.facePresent !== true
      && observation?.personPresent !== true
      && observation?.occluded !== true;
    const conditions = {
      faceAbsent,
      partiallyVisible: observation?.facePresent === true && observation?.partiallyVisible === true,
      tooClose: observation?.facePresent === true && observation?.tooClose === true,
      tooFar: observation?.facePresent === true && observation?.tooFar === true,
      nearFrameEdge: observation?.facePresent === true && observation?.nearFrameEdge === true,
      occluded: observation?.occluded === true,
      trackingUnstable: observation?.facePresent === true && observation?.trackingUnstable === true,
      lookingDown: observation?.facePresent === true && observation?.headDirection === 'HEAD_DOWN',
      headTurned: observation?.facePresent === true
        && ['HEAD_LEFT', 'HEAD_RIGHT', 'HEAD_UP'].includes(observation?.headDirection),
    };

    CONDITION_RULES.forEach(rule => {
      this._updateRule(rule, conditions[rule.flag], observation, now, wallNow);
    });
  }

  stop(observation = {}) {
    const now = Number(observation.timestampMs ?? performance.now());
    const wallNow = Number(observation.wallClockMs ?? Date.now());
    this.trackers.forEach((track, eventType) => {
      if (track.active) this._finish(eventType, track, now, wallNow, observation);
    });
  }
}

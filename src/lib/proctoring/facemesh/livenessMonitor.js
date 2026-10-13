import {
  FACE_EVENT_DESCRIPTIONS,
  FACE_EVENT_SEVERITY,
  createIncidentId,
} from './faceMonitoringTypes.js';

// Decides whether the face on camera is alive, from the cues the worker ships
// with every frame (see livenessCues.js).
//
// It is built to be wrong in only one direction. A living face is credited for
// any sign of life — a blink, a change of expression, the face changing shape
// — and the clock only runs while the face is cleanly in view. Only when a
// whole window of clean viewing passes with no sign at all is the student
// asked, on screen with a countdown, to blink or open their mouth. A picture
// cannot answer; a student can, in a second, and nothing is recorded. Only a
// prompt that goes unanswered while the face stays in view becomes an incident:
// it goes to the professor for review, and costs a strike when the config's
// failureCountsAsWarning says so.
//
// Every cue that fails to work on a given camera fails safe: blink scores that
// never settle to an open-eye level stop counting, unavailable scores switch the
// monitor off, and a student who passes a check earns a longer quiet window.

export const LIVENESS_CHALLENGES = Object.freeze({
  blink: Object.freeze({ kind: 'blink', instruction: 'Please blink twice.' }),
  mouth: Object.freeze({ kind: 'mouth', instruction: 'Please open your mouth briefly, then close it.' }),
});

// Expression scores watched for change over the quiet window. Each is
// averaged over its left/right pair where the model reports one.
const EXPRESSION_LEVELS = Object.freeze({
  jawOpen: ['jawOpen'],
  mouthSmile: ['mouthSmileLeft', 'mouthSmileRight'],
  mouthPucker: ['mouthPucker'],
  mouthFunnel: ['mouthFunnel'],
  browInnerUp: ['browInnerUp'],
});

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function iso(value) {
  return new Date(value).toISOString();
}

export function eyeBlinkLevel(blendshapes) {
  const left = finite(blendshapes?.eyeBlinkLeft);
  const right = finite(blendshapes?.eyeBlinkRight);
  if (left === null || right === null) return null;
  return (left + right) / 2;
}

function expressionLevel(blendshapes, keys) {
  const values = keys.map(key => finite(blendshapes?.[key])).filter(value => value !== null);
  if (values.length !== keys.length) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export class FaceLivenessMonitor {
  constructor(config, baseline = null, onEvent = () => {}, options = {}) {
    this.config = config;
    this.onEvent = onEvent;
    this.random = typeof options.random === 'function' ? options.random : Math.random;
    this.restEyeBlink = finite(baseline?.baselineEyeBlink);
    this.restJawOpen = finite(baseline?.baselineJawOpen);
    this.restSamples = this.restEyeBlink === null ? 0 : Infinity;
    this.blinkReliable = null;
    this.state = config.enabled === false ? 'disabled' : 'passive';
    this.unavailableReason = config.enabled === false ? 'disabled-by-config' : '';
    this.windowMs = Number(config.passiveWindowMs);
    this.consecutivePasses = 0;
    this.cleanSinceLifeMs = 0;
    this.lastCleanAt = null;
    this.cooldownUntil = 0;
    this.eyesClosed = false;
    this.eyesClosedAt = null;
    this.expressionRanges = new Map();
    this.expressionSmoothed = new Map();
    this.motionFrames = 0;
    this.challenge = null;
    this.lastLifeSign = null;
    this.blinkCount = 0;
    this.outcomes = { passed: 0, failed: 0, cancelled: 0 };
  }

  // Frames worth judging. Expression scores are only trustworthy when the model
  // has a steady, frontal, single face; everything else is simply not counted,
  // so time spent turned away or badly lit never adds up to a prompt.
  _isClean(observation) {
    if (observation?.facePresent !== true) return false;
    if (observation.partiallyVisible === true || observation.trackingUnstable === true) return false;
    const faceCount = finite(observation.faceCount);
    if (faceCount !== null && faceCount > 1) return false;
    const quality = finite(observation.trackingQuality);
    if (quality === null || quality < Number(this.config.minimumTrackingQuality)) return false;
    const yaw = finite(observation.relativePose?.yaw);
    if (yaw !== null && Math.abs(yaw) > Number(this.config.maximumYawDegrees)) return false;
    return !!observation.blendshapes;
  }

  _disable(reason) {
    if (this.state === 'disabled') return;
    this.state = 'disabled';
    this.unavailableReason = reason;
    this.challenge = null;
    this.onEvent({ kind: 'liveness-unavailable', reason });
  }

  // The open-eye level this camera reports for this student. Calibration
  // supplies it; without that it is learned from the first clean frames. A level
  // that never settles near "open" (narrow eyes, glare on glasses, or a picture
  // with the eyes shut) makes blinks unreadable, so they stop counting and the
  // check leans on the mouth instead, over a longer window.
  _settleRestLevels(blendshapes) {
    if (this.blinkReliable !== null) return;
    const eye = eyeBlinkLevel(blendshapes);
    if (eye === null) {
      this._disable('blendshapes-unavailable');
      return;
    }
    if (this.restEyeBlink === null || this.restSamples < this.config.restSampleCount) {
      this.restEyeBlink = this.restEyeBlink === null
        ? eye
        : this.restEyeBlink + ((eye - this.restEyeBlink) * 0.15);
      this.restSamples += 1;
      if (this.restSamples < this.config.restSampleCount) return;
    }
    if (this.restJawOpen === null) this.restJawOpen = finite(blendshapes.jawOpen) ?? 0;
    this.blinkReliable = this.restEyeBlink < Number(this.config.maximumRestingEyeBlink);
    if (!this.blinkReliable) {
      this.windowMs = Number(this.config.passiveWindowMs) * Number(this.config.unreliableBlinkWindowScale);
      this.onEvent({ kind: 'liveness-blink-unreliable', restEyeBlink: this.restEyeBlink });
    }
  }

  _detectBlink(blendshapes, now) {
    if (!this.blinkReliable) return false;
    const eye = eyeBlinkLevel(blendshapes);
    if (eye === null) return false;
    const closeAt = Math.max(Number(this.config.blinkThreshold), this.restEyeBlink + Number(this.config.blinkRiseAboveRest));
    const openAt = Math.min(closeAt - 0.1, this.restEyeBlink + Number(this.config.blinkRecoveryAboveRest));
    if (!this.eyesClosed) {
      if (eye >= closeAt) {
        this.eyesClosed = true;
        this.eyesClosedAt = now;
      }
      return false;
    }
    if (eye > openAt) return false;
    this.eyesClosed = false;
    // Eyes that stayed shut for a long time and then opened are not a blink; a
    // picture swapped for a face would read as one otherwise.
    const closedMs = now - Number(this.eyesClosedAt ?? now);
    this.eyesClosedAt = null;
    if (closedMs > Number(this.config.maximumBlinkMs)) return false;
    this.blinkCount += 1;
    return true;
  }

  // The mouth answer is a movement, not a position: the jaw has to be seen shut
  // and then open (or open and then shut) during the prompt. A picture of an
  // open mouth holds one position and never makes the transition.
  _trackMouth(blendshapes, challenge) {
    const jaw = finite(blendshapes?.jawOpen);
    if (jaw === null) return false;
    const rest = this.restJawOpen ?? 0;
    const openAt = Math.max(Number(this.config.mouthOpenThreshold), rest + Number(this.config.mouthOpenRiseAboveRest));
    const closedAt = Math.min(openAt - 0.1, rest + Number(this.config.mouthClosedAboveRest));
    const position = jaw >= openAt ? 'open' : jaw <= closedAt ? 'closed' : null;
    if (!position) return false;
    if (challenge.mouthPosition && challenge.mouthPosition !== position) return true;
    challenge.mouthPosition = position;
    return false;
  }

  // Scores are smoothed before their range is taken. The model's frame-to-frame
  // jitter on a still picture is a spike here and a spike there, and over a
  // whole window those spikes added up to a "change of expression"; a real
  // smile or raised brow is held for many frames and survives the smoothing.
  _detectExpressionChange(blendshapes) {
    let changed = false;
    const smoothing = Number(this.config.expressionSmoothing ?? 1);
    for (const [name, keys] of Object.entries(EXPRESSION_LEVELS)) {
      const raw = expressionLevel(blendshapes, keys);
      if (raw === null) continue;
      const previous = this.expressionSmoothed.get(name);
      const level = previous === undefined ? raw : previous + ((raw - previous) * smoothing);
      this.expressionSmoothed.set(name, level);
      const range = this.expressionRanges.get(name) || { min: level, max: level };
      range.min = Math.min(range.min, level);
      range.max = Math.max(range.max, level);
      this.expressionRanges.set(name, range);
      if (range.max - range.min >= Number(this.config.expressionRangeThreshold)) changed = true;
    }
    return changed;
  }

  // The first sign found, in order of how specific it is. Every one of them is
  // a change over time; a held position, however lifelike, never counts.
  _detectLifeSign(observation, now) {
    const blendshapes = observation.blendshapes;
    const blink = this._detectBlink(blendshapes, now);
    const expression = this._detectExpressionChange(blendshapes);
    const motion = finite(observation.nonRigidMotion);
    // One noisy frame is not a change of shape; a blink or a word keeps the
    // landmarks off the picture fit for several frames running.
    this.motionFrames = motion !== null && motion >= Number(this.config.nonRigidMotionThreshold)
      ? this.motionFrames + 1
      : 0;
    const moved = this.motionFrames >= Number(this.config.nonRigidMotionFrames ?? 1);
    if (blink) return 'blink';
    if (expression) return 'expression';
    if (moved) return 'motion';
    return null;
  }

  _creditLife(kind, now) {
    this.cleanSinceLifeMs = 0;
    this.expressionRanges.clear();
    this.lastLifeSign = { kind, at: now };
  }

  _startChallenge(observation, now, wallNow) {
    const kind = this.blinkReliable && this.random() < Number(this.config.blinkChallengeProbability)
      ? 'blink'
      : 'mouth';
    const thresholdMs = Number(this.config.challengeDurationMs);
    const challenge = {
      kind,
      startedAt: now,
      startedWall: wallNow,
      blinks: 0,
      mouthOpened: false,
      mouthPosition: null,
      cleanMs: 0,
      lastCleanAt: now,
      trackingTotal: 0,
      trackingSamples: 0,
      lastCountdownSecond: null,
    };
    // Where the mouth is as the prompt goes up, so that the first movement
    // after it counts as the transition it is.
    this._trackMouth(observation?.blendshapes, challenge);
    this.challenge = challenge;
    this.state = 'challenge';
    this.onEvent({
      kind: 'liveness-challenge',
      challenge: kind,
      instruction: LIVENESS_CHALLENGES[kind].instruction,
      thresholdMs,
      remainingSeconds: Math.ceil(thresholdMs / 1000),
      quietMs: Math.round(this.windowMs),
    });
  }

  _endChallenge(outcome, now, extra = {}) {
    const challenge = this.challenge;
    this.challenge = null;
    this.state = 'cooldown';
    this.cleanSinceLifeMs = 0;
    this.expressionRanges.clear();
    this.outcomes[outcome] += 1;
    const base = Number(this.config.passiveWindowMs)
      * (this.blinkReliable ? 1 : Number(this.config.unreliableBlinkWindowScale));
    if (outcome === 'passed') {
      // A student who answers has shown the cues simply miss their quiet
      // reading face; each pass buys a longer window before the next ask.
      this.consecutivePasses += 1;
      this.windowMs = Math.min(
        Number(this.config.maximumPassiveWindowMs),
        base + (Number(this.config.passiveWindowGrowthMs) * this.consecutivePasses),
      );
      this.cooldownUntil = now + Number(this.config.challengeCooldownMs);
      this._creditLife(challenge.kind, now);
    } else if (outcome === 'failed') {
      this.consecutivePasses = 0;
      this.windowMs = base;
      this.cooldownUntil = now + Number(this.config.challengeCooldownMs);
    } else {
      this.cooldownUntil = now + Number(this.config.cancelledCooldownMs);
    }
    this.onEvent({
      kind: `liveness-challenge-${outcome}`,
      challenge: challenge.kind,
      responseMs: Math.max(0, now - challenge.startedAt),
      ...extra,
    });
  }

  _emitFailure(challenge, now, wallNow) {
    const incidentId = createIncidentId('face-liveness');
    const common = {
      kind: 'incident',
      incidentId,
      source: 'FACEMESH',
      eventType: 'FACE_LIVENESS_UNCONFIRMED',
      severity: FACE_EVENT_SEVERITY.FACE_LIVENESS_UNCONFIRMED,
      description: FACE_EVENT_DESCRIPTIONS.FACE_LIVENESS_UNCONFIRMED,
      direction: null,
      startedAt: iso(challenge.startedWall),
      durationMs: Math.max(0, now - challenge.startedAt),
      maxYaw: 0,
      maxPitch: 0,
      trackingConfidence: challenge.trackingSamples
        ? Math.round((challenge.trackingTotal / challenge.trackingSamples) * 1000) / 1000
        : 0,
      requiresProfessorReview: true,
      challenge: challenge.kind,
      quietMs: Math.round(this.windowMs),
    };
    this.onEvent({ ...common, phase: 'start', endedAt: null });
    this.onEvent({ ...common, phase: 'end', endedAt: iso(wallNow) });
  }

  _updateChallenge(observation, clean, life, now, wallNow) {
    const challenge = this.challenge;
    if (clean) {
      if (challenge.lastCleanAt !== null) {
        challenge.cleanMs += Math.min(Math.max(0, now - challenge.lastCleanAt), Number(this.config.maximumFrameGapMs));
      }
      challenge.lastCleanAt = now;
      const quality = finite(observation.trackingQuality);
      if (quality !== null) {
        challenge.trackingTotal += quality;
        challenge.trackingSamples += 1;
      }
      if (life === 'blink') challenge.blinks += 1;
      if (this._trackMouth(observation.blendshapes, challenge)) challenge.mouthOpened = true;
    } else {
      // The face left in the middle of the check. That is the absence rule's
      // business, not evidence either way here.
      const sinceClean = now - Number(challenge.lastCleanAt ?? challenge.startedAt);
      if (observation?.facePresent !== true && sinceClean >= Number(this.config.challengeAbsenceCancelMs)) {
        this._endChallenge('cancelled', now, { reason: 'face-not-visible' });
        return;
      }
    }

    // Either answer is accepted whichever one was asked for; the ask only has
    // to be something a picture cannot do.
    const passed = challenge.blinks >= Number(this.config.challengeBlinkCount) || challenge.mouthOpened;
    if (passed) {
      this._endChallenge('passed', now);
      return;
    }

    const thresholdMs = Number(this.config.challengeDurationMs);
    const elapsed = now - challenge.startedAt;
    if (elapsed < thresholdMs) {
      const remainingSeconds = Math.max(0, Math.ceil((thresholdMs - elapsed) / 1000));
      if (remainingSeconds !== challenge.lastCountdownSecond) {
        challenge.lastCountdownSecond = remainingSeconds;
        this.onEvent({
          kind: 'liveness-challenge-progress',
          challenge: challenge.kind,
          instruction: LIVENESS_CHALLENGES[challenge.kind].instruction,
          remainingSeconds,
          thresholdMs,
        });
      }
      return;
    }

    // The face has to have been cleanly in view for most of the prompt before
    // silence counts against it.
    if (challenge.cleanMs < thresholdMs * Number(this.config.challengeMinimumCleanRatio)) {
      this._endChallenge('cancelled', now, { reason: 'face-not-steady' });
      return;
    }
    this._emitFailure(challenge, now, wallNow);
    this._endChallenge('failed', now);
  }

  observe(observation) {
    if (this.state === 'disabled') return;
    const now = Number(observation?.timestampMs ?? performance.now());
    const wallNow = Number(observation?.wallClockMs ?? Date.now());
    const clean = this._isClean(observation);
    let life = null;
    if (clean) {
      this._settleRestLevels(observation.blendshapes);
      if (this.state === 'disabled') return;
      if (this.blinkReliable === null) return;
      life = this._detectLifeSign(observation, now);
    } else {
      this.eyesClosed = false;
      this.eyesClosedAt = null;
      this.motionFrames = 0;
    }

    if (this.state === 'challenge') {
      this._updateChallenge(observation, clean, life, now, wallNow);
      return;
    }

    if (clean) {
      if (this.lastCleanAt !== null) {
        const gap = now - this.lastCleanAt;
        // A gap longer than a few frames means the pipeline stalled or the face
        // was lost; that time is not counted as quiet viewing.
        if (gap > 0 && gap <= Number(this.config.maximumFrameGapMs)) this.cleanSinceLifeMs += gap;
      }
      this.lastCleanAt = now;
    } else {
      this.lastCleanAt = null;
    }
    if (life) this._creditLife(life, now);

    if (this.state === 'cooldown') {
      if (now < this.cooldownUntil) return;
      this.state = 'passive';
      this.cleanSinceLifeMs = 0;
      this.expressionRanges.clear();
      return;
    }
    if (this.cleanSinceLifeMs >= this.windowMs) this._startChallenge(observation, now, wallNow);
  }

  stop() {
    if (this.state === 'challenge') {
      const now = Number(this.challenge?.lastCleanAt ?? this.challenge?.startedAt ?? 0);
      this._endChallenge('cancelled', now, { reason: 'monitoring-stopped' });
    }
    this.state = 'disabled';
    this.unavailableReason = this.unavailableReason || 'stopped';
  }

  snapshot() {
    return {
      state: this.state,
      unavailableReason: this.unavailableReason,
      blinkReliable: this.blinkReliable,
      restEyeBlink: this.restEyeBlink,
      restJawOpen: this.restJawOpen,
      windowMs: Math.round(this.windowMs),
      quietMs: Math.round(this.cleanSinceLifeMs),
      lastLifeSign: this.lastLifeSign,
      blinkCount: this.blinkCount,
      challenge: this.challenge ? { kind: this.challenge.kind, blinks: this.challenge.blinks } : null,
      outcomes: { ...this.outcomes },
    };
  }
}

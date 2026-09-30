function average(values) {
  return values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
}

function range(values) {
  return values.length ? Math.max(...values) - Math.min(...values) : Infinity;
}

function robustRange(values) {
  if (values.length < 5) return range(values);
  const sorted = [...values].sort((left, right) => left - right);
  const trimCount = Math.max(1, Math.floor(sorted.length * 0.1));
  return range(sorted.slice(trimCount, sorted.length - trimCount));
}

// Gaps longer than this say the pipeline stalled, not how fast frames normally
// come, so they are left out of the cadence estimate.
const CADENCE_STALL_MS = 10000;

export class FaceCalibrationSession {
  constructor(config) {
    this.config = {
      transientInvalidToleranceMs: 900,
      cadenceToleranceMultiplier: 2.5,
      maximumTransientInvalidToleranceMs: 4000,
      minimumSamples: 15,
      ...config,
    };
    this.assisted = false;
    this.reset();
  }

  // Lower the bar without discarding what the student has already held steady:
  // the samples and stable time they earned still count, they just now clear a
  // shorter, more forgiving target.
  relax(overrides = {}) {
    this.config = { ...this.config, ...overrides };
    this.assisted = true;
    this.invalidSince = null;
    return this.config;
  }

  _centerOffsetLimits() {
    const fallback = Number(this.config.maximumCenterOffset);
    const x = Number(this.config.maximumCenterOffsetX);
    const y = Number(this.config.maximumCenterOffsetY);
    return {
      x: Number.isFinite(x) ? x : fallback,
      y: Number.isFinite(y) ? y : fallback,
    };
  }

  reset() {
    this.samples = [];
    this.startedAt = null;
    this.lastSampleAt = null;
    this.lastObservationAt = null;
    this.lastObservationWasValid = false;
    this.stableDurationMs = 0;
    this.invalidSince = null;
    this.failureReason = '';
    this.complete = false;
    this.baseline = null;
    // How far apart frames actually arrive on this device, valid or not.
    this.typicalGapMs = null;
  }

  // The bar has to reflect whichever requirement is still holding the scan
  // back. Progress used to be time alone, so on a slow device it reached the
  // end and then sat at full while the sample count quietly caught up.
  _progress() {
    const timeProgress = this.stableDurationMs / Math.max(1, Number(this.config.durationMs) || 1);
    const sampleProgress = this.samples.length / Math.max(1, Number(this.config.minimumSamples) || 1);
    return Math.max(0, Math.min(1, timeProgress, sampleProgress));
  }

  _observeCadence(now) {
    const previous = this.lastObservationAt;
    if (previous === null || !Number.isFinite(previous)) return;
    const gap = now - previous;
    if (!(gap > 0) || gap >= CADENCE_STALL_MS) return;
    this.typicalGapMs = this.typicalGapMs === null
      ? gap
      : (this.typicalGapMs * 0.7) + (gap * 0.3);
  }

  // A dropped frame is only "transient" relative to how often frames come. At
  // ten frames a second, 900 ms is nine missed frames; at two frames a second it
  // is less than two, and one skipped frame was enough to start the scan over.
  _transientToleranceMs() {
    const floor = Number(this.config.transientInvalidToleranceMs) || 0;
    const multiplier = Number(this.config.cadenceToleranceMultiplier) || 0;
    const cap = Number(this.config.maximumTransientInvalidToleranceMs);
    const cadence = this.typicalGapMs === null ? 0 : this.typicalGapMs * multiplier;
    const tolerance = Math.max(floor, cadence);
    return Number.isFinite(cap) && cap > 0 ? Math.min(cap, tolerance) : tolerance;
  }

  _restart(reason) {
    this.samples = [];
    this.startedAt = null;
    this.lastSampleAt = null;
    this.lastObservationWasValid = false;
    this.stableDurationMs = 0;
    this.failureReason = reason;
    return { complete: false, progress: 0, reason };
  }

  _pause(reason, now) {
    if (this.invalidSince === null) this.invalidSince = now;
    const invalidForMs = Math.max(0, now - this.invalidSince);
    if (invalidForMs >= this._transientToleranceMs()) {
      this._restart(reason);
    }
    this.lastObservationAt = now;
    this.lastObservationWasValid = false;
    this.failureReason = reason;
    return {
      complete: false,
      progress: this._progress(),
      reason,
    };
  }

  addObservation(observation) {
    if (this.complete) return { complete: true, progress: 1, baseline: this.baseline };
    const rawTimestamp = observation?.timestampMs;
    const suppliedTimestamp = rawTimestamp === null || rawTimestamp === undefined
      ? NaN
      : Number(rawTimestamp);
    const now = Number.isFinite(suppliedTimestamp) ? suppliedTimestamp : performance.now();
    this._observeCadence(now);
    const geometry = observation?.geometry;
    const pose = observation?.pose;
    const geometryIsValid = geometry && [
      geometry.width,
      geometry.height,
      geometry.centerX,
      geometry.centerY,
    ].every(value => Number.isFinite(Number(value)));
    const poseIsValid = pose && [pose.yaw, pose.pitch, pose.roll]
      .every(value => Number.isFinite(Number(value)));
    // "Fully visible" told a student whose face the model had not found at all
    // to adjust something that was already right. Say what actually happened.
    if (!observation?.facePresent) {
      return this._pause('No face detected yet. Face the camera directly and make sure your face is well lit.', now);
    }
    if (!geometryIsValid || !poseIsValid) {
      return this._pause('Keep your face fully visible inside the guide.', now);
    }
    if (observation.partiallyVisible || observation.nearFrameEdge) {
      return this._pause('Move your face away from the edge of the camera frame.', now);
    }
    const trackingQuality = Number(observation.trackingQuality);
    if (!Number.isFinite(trackingQuality) || trackingQuality < this.config.minimumTrackingQuality) {
      return this._pause('Hold still for a moment. If this keeps showing, improve the lighting on your face.', now);
    }
    if (geometry.width < this.config.minimumFaceWidthRatio) {
      return this._pause('Move slightly closer to the camera.', now);
    }
    if (geometry.width > this.config.maximumFaceWidthRatio) {
      return this._pause('Move slightly farther from the camera.', now);
    }
    // "Center your face" on its own left students who believed they were centered
    // with nothing to act on. Name the direction instead.
    const centerLimits = this._centerOffsetLimits();
    const offsetX = Number(geometry.centerX) - 0.5;
    const offsetY = Number(geometry.centerY) - 0.5;
    if (Math.abs(offsetX) > centerLimits.x || Math.abs(offsetY) > centerLimits.y) {
      const horizontal = Math.abs(offsetX) > centerLimits.x;
      const vertical = Math.abs(offsetY) > centerLimits.y;
      let hint = 'Center your face inside the guide.';
      if (vertical && !horizontal) {
        hint = offsetY < 0
          ? 'Your face is high in the frame — lower your screen or sit back a little.'
          : 'Your face is low in the frame — raise your screen or sit up a little.';
      } else if (horizontal && !vertical) {
        // The preview is mirrored, so the direction the student sees is flipped.
        hint = offsetX < 0
          ? 'Move a little to your right, into the middle of the guide.'
          : 'Move a little to your left, into the middle of the guide.';
      }
      return this._pause(hint, now);
    }

    if (this.lastObservationWasValid && this.lastObservationAt !== null) {
      const sampleGapMs = now - this.lastObservationAt;
      // A late frame still shows the student held steady for at least the cap.
      // Skipping it outright meant a slow device could never accumulate time.
      if (sampleGapMs >= 0) {
        this.stableDurationMs += Math.min(sampleGapMs, Number(this.config.maximumSampleGapMs) || sampleGapMs);
      }
    }

    if (this.startedAt === null) this.startedAt = now;
    this.invalidSince = null;
    this.lastObservationAt = now;
    this.lastObservationWasValid = true;
    this.lastSampleAt = now;
    this.failureReason = '';
    const cues = observation?.poseCues;
    this.samples.push({
      timestampMs: now,
      yaw: Number(pose.yaw),
      pitch: Number(pose.pitch),
      roll: Number(pose.roll),
      width: Number(geometry.width),
      height: Number(geometry.height),
      centerX: Number(geometry.centerX),
      centerY: Number(geometry.centerY),
      trackingQuality,
      // The neutral face proportions this camera sees for this student. Head
      // pitch is later judged against these, not against a fixed figure.
      noseFraction: Number.isFinite(Number(cues?.noseFraction)) ? Number(cues.noseFraction) : null,
      faceSpanRatio: Number.isFinite(Number(cues?.faceSpanRatio)) ? Number(cues.faceSpanRatio) : null,
    });

    const progress = this._progress();
    if (
      this.stableDurationMs < this.config.durationMs
      || this.samples.length < this.config.minimumSamples
    ) {
      return { complete: false, progress, reason: 'Keep looking normally at the screen.' };
    }

    const yawValues = this.samples.map(sample => sample.yaw);
    const pitchValues = this.samples.map(sample => sample.pitch);
    if (robustRange(yawValues) > this.config.maximumYawRange || robustRange(pitchValues) > this.config.maximumPitchRange) {
      return this._restart('Keep your head centered and steady for five seconds.');
    }

    const noseFractions = this.samples
      .map(sample => sample.noseFraction)
      .filter(value => Number.isFinite(value));
    const faceSpanRatios = this.samples
      .map(sample => sample.faceSpanRatio)
      .filter(value => Number.isFinite(value));

    this.complete = true;
    this.baseline = Object.freeze({
      assisted: this.assisted === true,
      // Null when the camera never gave usable landmarks: pitch then falls back to
      // the euler-only rule rather than comparing against a figure we never saw.
      baselineNoseFraction: noseFractions.length >= 5 ? average(noseFractions) : null,
      baselineFaceSpanRatio: faceSpanRatios.length >= 5 ? average(faceSpanRatios) : null,
      baselineYaw: average(yawValues),
      baselinePitch: average(pitchValues),
      baselineRoll: average(this.samples.map(sample => sample.roll)),
      normalFaceWidth: average(this.samples.map(sample => sample.width)),
      normalFaceHeight: average(this.samples.map(sample => sample.height)),
      normalFaceCenterX: average(this.samples.map(sample => sample.centerX)),
      normalFaceCenterY: average(this.samples.map(sample => sample.centerY)),
      landmarkTrackingStability: average(this.samples.map(sample => sample.trackingQuality)),
      sampleCount: this.samples.length,
    });
    return { complete: true, progress: 1, baseline: this.baseline };
  }
}

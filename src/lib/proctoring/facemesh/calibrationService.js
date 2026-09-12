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

export class FaceCalibrationSession {
  constructor(config) {
    this.config = {
      transientInvalidToleranceMs: 900,
      minimumSamples: 15,
      ...config,
    };
    this.reset();
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
    if (invalidForMs >= this.config.transientInvalidToleranceMs) {
      this._restart(reason);
    }
    this.lastObservationAt = now;
    this.lastObservationWasValid = false;
    this.failureReason = reason;
    return {
      complete: false,
      progress: Math.min(1, this.stableDurationMs / this.config.durationMs),
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
    if (!observation?.facePresent || !geometryIsValid || !poseIsValid) {
      return this._pause('Keep your face fully visible inside the guide.', now);
    }
    if (observation.partiallyVisible || observation.nearFrameEdge) {
      return this._pause('Move your face away from the edge of the camera frame.', now);
    }
    const trackingQuality = Number(observation.trackingQuality);
    if (!Number.isFinite(trackingQuality) || trackingQuality < this.config.minimumTrackingQuality) {
      return this._pause('Improve the lighting and keep your face unobstructed.', now);
    }
    if (geometry.width < this.config.minimumFaceWidthRatio) {
      return this._pause('Move slightly closer to the camera.', now);
    }
    if (geometry.width > this.config.maximumFaceWidthRatio) {
      return this._pause('Move slightly farther from the camera.', now);
    }
    if (
      Math.abs(geometry.centerX - 0.5) > this.config.maximumCenterOffset
      || Math.abs(geometry.centerY - 0.5) > this.config.maximumCenterOffset
    ) {
      return this._pause('Center your face inside the guide.', now);
    }

    if (this.lastObservationWasValid && this.lastObservationAt !== null) {
      const sampleGapMs = now - this.lastObservationAt;
      if (sampleGapMs >= 0 && sampleGapMs <= this.config.maximumSampleGapMs) {
        this.stableDurationMs += sampleGapMs;
      }
    }

    if (this.startedAt === null) this.startedAt = now;
    this.invalidSince = null;
    this.lastObservationAt = now;
    this.lastObservationWasValid = true;
    this.lastSampleAt = now;
    this.failureReason = '';
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
    });

    const progress = Math.min(1, this.stableDurationMs / this.config.durationMs);
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

    this.complete = true;
    this.baseline = Object.freeze({
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

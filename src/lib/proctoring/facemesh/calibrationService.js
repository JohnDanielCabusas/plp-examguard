function average(values) {
  return values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
}

function range(values) {
  return values.length ? Math.max(...values) - Math.min(...values) : Infinity;
}

export class FaceCalibrationSession {
  constructor(config) {
    this.config = config;
    this.reset();
  }

  reset() {
    this.samples = [];
    this.startedAt = null;
    this.lastSampleAt = null;
    this.failureReason = '';
    this.complete = false;
    this.baseline = null;
  }

  _reject(reason) {
    this.samples = [];
    this.startedAt = null;
    this.lastSampleAt = null;
    this.failureReason = reason;
    return { complete: false, progress: 0, reason };
  }

  addObservation(observation) {
    if (this.complete) return { complete: true, progress: 1, baseline: this.baseline };
    const now = Number(observation?.timestampMs || performance.now());
    const geometry = observation?.geometry;
    const pose = observation?.pose;
    if (!observation?.facePresent || !geometry || !pose) {
      return this._reject('Keep your face fully visible inside the guide.');
    }
    if (observation.partiallyVisible || observation.nearFrameEdge) {
      return this._reject('Move your face away from the edge of the camera frame.');
    }
    if (observation.trackingQuality < this.config.minimumTrackingQuality) {
      return this._reject('Improve the lighting and keep your face unobstructed.');
    }
    if (geometry.width < this.config.minimumFaceWidthRatio) {
      return this._reject('Move slightly closer to the camera.');
    }
    if (geometry.width > this.config.maximumFaceWidthRatio) {
      return this._reject('Move slightly farther from the camera.');
    }
    if (
      Math.abs(geometry.centerX - 0.5) > this.config.maximumCenterOffset
      || Math.abs(geometry.centerY - 0.5) > this.config.maximumCenterOffset
    ) {
      return this._reject('Center your face inside the guide.');
    }
    if (this.lastSampleAt !== null && now - this.lastSampleAt > this.config.maximumSampleGapMs) {
      return this._reject('Keep your head steady while calibration restarts.');
    }

    if (this.startedAt === null) this.startedAt = now;
    this.lastSampleAt = now;
    this.failureReason = '';
    this.samples.push({
      timestampMs: now,
      yaw: pose.yaw,
      pitch: pose.pitch,
      roll: pose.roll,
      width: geometry.width,
      height: geometry.height,
      centerX: geometry.centerX,
      centerY: geometry.centerY,
      trackingQuality: observation.trackingQuality,
    });

    const elapsed = now - this.startedAt;
    const progress = Math.min(1, elapsed / this.config.durationMs);
    if (elapsed < this.config.durationMs) return { complete: false, progress, reason: 'Keep looking normally at the screen.' };

    const yawValues = this.samples.map(sample => sample.yaw);
    const pitchValues = this.samples.map(sample => sample.pitch);
    if (range(yawValues) > this.config.maximumYawRange || range(pitchValues) > this.config.maximumPitchRange) {
      return this._reject('Keep your head centered and steady for five seconds.');
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

const DEFAULT_OBJECT_MONITORING = Object.freeze({
  enabled: false,
  mode: 'alert',
  allowSecondaryComputer: false,
  allowBooks: false,
});

const POLICY_RULES = Object.freeze({
  mobile_phone: {
    violationType: 'restricted_phone',
    label: 'Mobile phone',
    hitCount: 2,
    fastHitCount: 1,
    fastConfidence: 0.78,
    fastExcludedRawClasses: ['remote'],
    fallbackMovementRawClasses: ['remote'],
    windowMs: 3000,
    absenceResetMs: 6000,
    minimumPeakConfidence: 0.3,
    minimumAverageConfidence: 0.26,
    calibrationBypassConfidence: 0.7,
    strongConfidence: 0.7,
    minimumMovementForWeakConfidence: 0.03,
    specialistMinimumMovement: 0.05,
    requiresVerification: true,
  },
  laptop_monitor: {
    violationType: 'secondary_computer',
    label: 'Secondary computer or display',
    allowKey: 'allowSecondaryComputer',
    hitCount: 5,
    windowMs: 5500,
    absenceResetMs: 10000,
  },
  book_textbook: {
    violationType: 'restricted_book',
    label: 'Book or textbook',
    allowKey: 'allowBooks',
    hitCount: 2,
    fastHitCount: 1,
    fastConfidence: 0.82,
    windowMs: 3000,
    absenceResetMs: 7000,
    minimumPeakConfidence: 0.3,
    minimumAverageConfidence: 0.25,
    calibrationBypassConfidence: 0.82,
    requiresVerification: true,
  },
});

export function normalizeObjectMonitoring(value = {}) {
  const mode = ['shadow', 'alert', 'enforce'].includes(value?.mode) ? value.mode : 'alert';
  return {
    ...DEFAULT_OBJECT_MONITORING,
    enabled: !!value?.enabled,
    mode,
    allowSecondaryComputer: !!value?.allowSecondaryComputer,
    allowBooks: !!value?.allowBooks,
  };
}

function bestDetectionForClass(detections, objectClass) {
  return detections
    .filter(detection => detection?.objectClass === objectClass)
    .sort((a, b) => Number(b.confidence || 0) - Number(a.confidence || 0))[0] || null;
}

function requiredHitsForTrack(rule, track) {
  const peakConfidence = Number(track.bestDetection?.confidence || 0);
  const rawClass = String(track.bestDetection?.rawClass || '');
  const fastExcluded = rule.fastExcludedRawClasses?.includes(rawClass);
  if (!fastExcluded && peakConfidence >= Number(rule.fastConfidence || Infinity)) {
    return Number(rule.fastHitCount || rule.hitCount || 1);
  }
  return Number(rule.hitCount || 1);
}

function intersectionOverUnion(a, b) {
  if (!a || !b) return 0;
  const left = Math.max(a.x, b.x);
  const top = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  const intersection = Math.max(0, right - left) * Math.max(0, bottom - top);
  const union = (a.width * a.height) + (b.width * b.height) - intersection;
  return union > 0 ? intersection / union : 0;
}

function mergeRegion(region, boundingBox) {
  const nextCount = region.count + 1;
  const weight = 1 / nextCount;
  ['x', 'y', 'width', 'height'].forEach(key => {
    region.boundingBox[key] += (boundingBox[key] - region.boundingBox[key]) * weight;
  });
  region.count = nextCount;
}

export class YoloObjectPolicy {
  constructor(config = {}) {
    this.config = normalizeObjectMonitoring(config);
    this.calibrationMs = Number.isFinite(config.calibrationMs)
      ? Math.max(0, Number(config.calibrationMs))
      : 3000;
    this.specialistCalibrationMs = Number.isFinite(config.specialistCalibrationMs)
      ? Math.max(0, Number(config.specialistCalibrationMs))
      : (this.calibrationMs === 0 ? 0 : 5000);
    this.tracks = new Map();
    this.reset();
  }

  updateConfig(config = {}) {
    this.config = normalizeObjectMonitoring(config);
    this.reset();
  }

  reset() {
    this.tracks.clear();
    this.firstEvaluationAt = 0;
    this.calibrationComplete = false;
    this.calibrationRegions = new Map();
    this.baselineObjectRegions = new Map();
    this.specialistCalibrationStartedAt = 0;
    this.specialistCalibrationComplete = false;
    this.specialistCalibrationRegions = new Map();
  }

  _collectCalibrationDetections(detections) {
    detections
      .filter(detection => (
        detection?.boundingBox
        && detection?.detectorRole !== 'phone-specialist'
        && Number.isFinite(POLICY_RULES[detection?.objectClass]?.calibrationBypassConfidence)
        && Number(detection.confidence || 0)
          < POLICY_RULES[detection.objectClass].calibrationBypassConfidence
      ))
      .forEach(detection => {
        const regions = this.calibrationRegions.get(detection.objectClass) || [];
        const matchingRegion = regions.find(region => (
          intersectionOverUnion(region.boundingBox, detection.boundingBox) >= 0.55
        ));
        if (matchingRegion) {
          mergeRegion(matchingRegion, detection.boundingBox);
        } else {
          regions.push({
            boundingBox: { ...detection.boundingBox },
            count: 1,
          });
        }
        this.calibrationRegions.set(detection.objectClass, regions);
      });
  }

  _finishCalibration() {
    this.baselineObjectRegions = new Map(
      [...this.calibrationRegions.entries()].map(([objectClass, regions]) => [
        objectClass,
        regions
          .filter(region => region.count >= 3)
          .map(region => ({ ...region.boundingBox })),
      ]),
    );
    this.calibrationRegions = new Map();
    this.calibrationComplete = true;
  }

  _collectSpecialistCalibrationDetections(detections) {
    detections
      .filter(detection => detection?.detectorRole === 'phone-specialist' && detection?.boundingBox)
      .forEach(detection => {
        const regions = this.specialistCalibrationRegions.get(detection.objectClass) || [];
        const matchingRegion = regions.find(region => (
          intersectionOverUnion(region.boundingBox, detection.boundingBox) >= 0.55
        ));
        if (matchingRegion) {
          mergeRegion(matchingRegion, detection.boundingBox);
        } else {
          regions.push({ boundingBox: { ...detection.boundingBox }, count: 1 });
        }
        this.specialistCalibrationRegions.set(detection.objectClass, regions);
      });
  }

  _finishSpecialistCalibration() {
    this.specialistCalibrationRegions.forEach((regions, objectClass) => {
      const existing = this.baselineObjectRegions.get(objectClass) || [];
      const stableFurnitureRegions = regions
        .filter(region => region.count >= 3)
        .map(region => ({ ...region.boundingBox }));
      this.baselineObjectRegions.set(objectClass, [...existing, ...stableFurnitureRegions]);
    });
    this.specialistCalibrationRegions = new Map();
    this.specialistCalibrationComplete = true;
  }

  _isCalibratedBackground(detection) {
    if (!detection?.boundingBox) return false;
    const regions = this.baselineObjectRegions.get(detection.objectClass) || [];
    return regions.some(region => (
      intersectionOverUnion(region, detection.boundingBox) >= 0.6
    ));
  }

  getDetectionProgress() {
    return [...this.tracks.entries()]
      .filter(([, track]) => !track.emitted)
      .map(([objectClass, track]) => {
        const rule = POLICY_RULES[objectClass];
        return {
          objectClass,
          objectLabel: rule?.label || objectClass,
          hits: track.hits.length,
          requiredHits: requiredHitsForTrack(rule || {}, track),
          confidence: Number(track.bestDetection?.confidence || 0),
        };
      });
  }

  getConfirmedDetections(now = Date.now()) {
    return [...this.tracks.entries()]
      .filter(([, track]) => track.emitted && now - track.lastSeenAt <= 1500)
      .map(([objectClass, track]) => ({
        objectClass,
        objectLabel: POLICY_RULES[objectClass]?.label || objectClass,
      }));
  }

  evaluate(detections = [], context = {}) {
    if (!this.config.enabled) return [];
    const now = Number(context.now || Date.now());
    if (!this.firstEvaluationAt) this.firstEvaluationAt = now;
    const calibrating = !this.calibrationComplete && now - this.firstEvaluationAt < this.calibrationMs;
    if (calibrating) {
      this._collectCalibrationDetections(detections);
    }
    if (!calibrating && !this.calibrationComplete) this._finishCalibration();

    const isSpecialistResult = context.detectorRole === 'phone-specialist';
    if (isSpecialistResult && !this.specialistCalibrationStartedAt) {
      this.specialistCalibrationStartedAt = now;
    }
    const specialistCalibrating = (
      isSpecialistResult
      && !this.specialistCalibrationComplete
      && now - this.specialistCalibrationStartedAt < this.specialistCalibrationMs
    );
    if (specialistCalibrating) this._collectSpecialistCalibrationDetections(detections);
    if (
      isSpecialistResult
      && !specialistCalibrating
      && !this.specialistCalibrationComplete
    ) this._finishSpecialistCalibration();

    const policyDetections = detections.filter(detection => {
      if (this._isCalibratedBackground(detection)) return false;
      const rule = POLICY_RULES[detection?.objectClass];
      if (rule?.requiresVerification && detection?.verified !== true) return false;
      if (specialistCalibrating && detection?.detectorRole === 'phone-specialist') return false;
      if (!calibrating || !Number.isFinite(rule?.calibrationBypassConfidence)) return true;
      return Number(detection.confidence || 0) >= rule.calibrationBypassConfidence;
    });
    const confirmed = [];

    Object.entries(POLICY_RULES).forEach(([objectClass, rule]) => {
      const detection = bestDetectionForClass(policyDetections, objectClass);
      const prior = this.tracks.get(objectClass) || {
        hits: [],
        confidences: [],
        firstSeenAt: 0,
        lastSeenAt: 0,
        emitted: false,
        bestDetection: null,
        bestDetectionAt: 0,
        lastBoundingBox: null,
        originBoundingBox: null,
        maxMovement: 0,
      };

      if (!detection) {
        if (prior.lastSeenAt && now - prior.lastSeenAt >= rule.absenceResetMs) {
          this.tracks.delete(objectClass);
        } else if (prior.lastSeenAt) {
          prior.hits = prior.hits.filter(timestamp => now - timestamp <= rule.windowMs);
          prior.confidences = prior.confidences.filter(item => now - item.timestamp <= rule.windowMs);
          this.tracks.set(objectClass, prior);
        }
        return;
      }

      if (rule.allowKey && this.config[rule.allowKey]) {
        this.tracks.delete(objectClass);
        return;
      }

      const gapMs = prior.lastSeenAt ? now - prior.lastSeenAt : 0;
      const changedRegion = prior.lastBoundingBox
        && detection.boundingBox
        && intersectionOverUnion(prior.lastBoundingBox, detection.boundingBox) < 0.15;
      const maximumTrackingGap = detection.detectorRole === 'phone-specialist'
        ? rule.windowMs
        : Math.min(2500, rule.windowMs / 2);
      if (!prior.lastSeenAt || gapMs > maximumTrackingGap || changedRegion) {
        prior.hits = [];
        prior.confidences = [];
        prior.firstSeenAt = now;
        prior.emitted = false;
        prior.bestDetection = null;
        prior.bestDetectionAt = 0;
        prior.originBoundingBox = detection.boundingBox || null;
        prior.maxMovement = 0;
      }

      prior.lastSeenAt = now;
      if (prior.originBoundingBox && detection.boundingBox) {
        const originCenterX = prior.originBoundingBox.x + (prior.originBoundingBox.width / 2);
        const originCenterY = prior.originBoundingBox.y + (prior.originBoundingBox.height / 2);
        const currentCenterX = detection.boundingBox.x + (detection.boundingBox.width / 2);
        const currentCenterY = detection.boundingBox.y + (detection.boundingBox.height / 2);
        const distance = Math.hypot(currentCenterX - originCenterX, currentCenterY - originCenterY);
        const objectScale = Math.max(prior.originBoundingBox.width, prior.originBoundingBox.height, 1);
        prior.maxMovement = Math.max(prior.maxMovement, distance / objectScale);
      }
      prior.lastBoundingBox = detection.boundingBox || null;
      prior.hits = [...prior.hits.filter(timestamp => now - timestamp <= rule.windowMs), now];
      prior.confidences = [
        ...prior.confidences.filter(item => now - item.timestamp <= rule.windowMs),
        { timestamp: now, value: Number(detection.confidence || 0) },
      ];
      if (prior.bestDetectionAt && now - prior.bestDetectionAt > rule.windowMs) {
        prior.bestDetection = null;
        prior.bestDetectionAt = 0;
      }
      if (!prior.bestDetection || detection.confidence > prior.bestDetection.confidence) {
        prior.bestDetection = detection;
        prior.bestDetectionAt = now;
      }
      this.tracks.set(objectClass, prior);

      const averageConfidence = prior.confidences.reduce((sum, item) => sum + item.value, 0) / prior.confidences.length;
      const peakConfidence = Number(prior.bestDetection?.confidence || 0);
      if (prior.emitted || prior.hits.length < requiredHitsForTrack(rule, prior)) return;
      if (peakConfidence < Number(rule.minimumPeakConfidence || 0)) return;
      if (averageConfidence < Number(rule.minimumAverageConfidence || 0)) return;
      const specialistDetection = prior.bestDetection?.detectorRole === 'phone-specialist';
      const fallbackMovementDetection = rule.fallbackMovementRawClasses?.includes(
        String(prior.bestDetection?.rawClass || ''),
      );
      const movementRequiredDetection = specialistDetection || fallbackMovementDetection;
      const minimumMovement = movementRequiredDetection
        ? Number(rule.specialistMinimumMovement || Infinity)
        : Number(rule.minimumMovementForWeakConfidence || 0);
      if (
        prior.maxMovement < minimumMovement
        && (movementRequiredDetection || peakConfidence < Number(rule.strongConfidence || 0))
      ) return;
      prior.emitted = true;
      const confirmationMs = Math.max(0, now - prior.firstSeenAt);
      confirmed.push({
        violationType: rule.violationType,
        objectClass,
        objectLabel: rule.label,
        confidence: Number(prior.bestDetection?.confidence || detection.confidence || 0),
        averageConfidence,
        verificationConfidence: Number(prior.bestDetection?.verificationConfidence || detection.verificationConfidence || 0),
        fullFrameConfidence: Number(prior.bestDetection?.fullFrameConfidence || detection.fullFrameConfidence || 0),
        boundingBox: prior.bestDetection?.boundingBox || detection.boundingBox || null,
        frameHits: prior.hits.length,
        confirmationMs,
        policyMode: this.config.mode,
        policyDecision: this.config.mode === 'enforce' ? 'warning' : this.config.mode,
        rawClass: prior.bestDetection?.rawClass || detection.rawClass || '',
        detectorRole: prior.bestDetection?.detectorRole || detection.detectorRole || 'primary',
        modelVersion: context.modelVersion || '',
        inferenceBackend: context.backend || '',
        inferenceMs: Number(context.inferenceMs || 0),
      });
    });

    return confirmed;
  }
}

export { DEFAULT_OBJECT_MONITORING, POLICY_RULES };

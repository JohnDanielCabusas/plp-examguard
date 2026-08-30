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
    fastHitCount: 2,
    fastConfidence: 0.78,
    fastExcludedRawClasses: ['remote'],
    fallbackMovementRawClasses: ['remote'],
    windowMs: 5500,
    absenceResetMs: 6000,
    minimumPeakConfidence: 0.3,
    minimumAverageConfidence: 0.26,
    calibrationBypassConfidence: 0.7,
    strongConfidence: 0.7,
    minimumMovementForWeakConfidence: 0.05,
    specialistMinimumMovement: 0.05,
    specialistStationaryHitCount: 3,
    minimumStationaryAreaRatio: 0.025,
    frameEdgeMarginRatio: 0.025,
    frameEdgeHitCount: 3,
    frameEdgeMinimumMovement: 0.15,
    minimumAspectRatio: 1.35,
    maximumAspectRatio: 4.2,
    backgroundHitCount: 4,
    backgroundMinimumMovement: 0.18,
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

function normalizedBoundingBoxArea(boundingBox) {
  const frameArea = Number(boundingBox?.frameWidth || 0) * Number(boundingBox?.frameHeight || 0);
  if (!boundingBox || frameArea <= 0) return 0;
  return (Number(boundingBox.width || 0) * Number(boundingBox.height || 0)) / frameArea;
}

function isFrameEdgeBound(boundingBox, marginRatio = POLICY_RULES.mobile_phone.frameEdgeMarginRatio) {
  const frameWidth = Number(boundingBox?.frameWidth || 0);
  const frameHeight = Number(boundingBox?.frameHeight || 0);
  if (!boundingBox || frameWidth <= 0 || frameHeight <= 0) return true;
  const left = Number(boundingBox.x || 0) / frameWidth;
  const top = Number(boundingBox.y || 0) / frameHeight;
  const right = (frameWidth - Number(boundingBox.x || 0) - Number(boundingBox.width || 0)) / frameWidth;
  const bottom = (frameHeight - Number(boundingBox.y || 0) - Number(boundingBox.height || 0)) / frameHeight;
  return Math.min(left, top, right, bottom) < Number(marginRatio || 0);
}

function phoneAspectRatio(boundingBox) {
  const width = Number(boundingBox?.width || 0);
  const height = Number(boundingBox?.height || 0);
  if (width <= 0 || height <= 0) return 0;
  return Math.max(width, height) / Math.min(width, height);
}

function hasPlausiblePhoneShape(detection, rule = POLICY_RULES.mobile_phone) {
  if (detection?.objectClass !== 'mobile_phone' || !detection?.boundingBox) return false;
  const aspectRatio = phoneAspectRatio(detection.boundingBox);
  return aspectRatio >= Number(rule.minimumAspectRatio || 0)
    && aspectRatio <= Number(rule.maximumAspectRatio || Infinity);
}

function isClearlySizedPhone(detection, rule = POLICY_RULES.mobile_phone, context = {}) {
  if (detection?.objectClass !== 'mobile_phone' || !detection?.boundingBox) return false;
  const areaRatio = normalizedBoundingBoxArea(detection.boundingBox);
  return areaRatio >= Number(rule.minimumStationaryAreaRatio || Infinity)
    && !isFrameEdgeBound(detection.boundingBox, rule.frameEdgeMarginRatio)
    && hasPlausiblePhoneShape(detection, rule)
    && handheldAssociation(detection, context) === true;
}

function scaledFaceForDetection(face, faceContext, boundingBox) {
  const sourceWidth = Number(faceContext?.frameWidth || boundingBox?.frameWidth || 0);
  const sourceHeight = Number(faceContext?.frameHeight || boundingBox?.frameHeight || 0);
  const targetWidth = Number(boundingBox?.frameWidth || sourceWidth);
  const targetHeight = Number(boundingBox?.frameHeight || sourceHeight);
  if (!face || sourceWidth <= 0 || sourceHeight <= 0 || targetWidth <= 0 || targetHeight <= 0) return null;
  const scaleX = targetWidth / sourceWidth;
  const scaleY = targetHeight / sourceHeight;
  const scalePoint = point => (
    point && Number.isFinite(Number(point.x)) && Number.isFinite(Number(point.y))
      ? { x: Number(point.x) * scaleX, y: Number(point.y) * scaleY }
      : null
  );
  return {
    x: Number(face.x || 0) * scaleX,
    y: Number(face.y || 0) * scaleY,
    width: Number(face.width || 0) * scaleX,
    height: Number(face.height || 0) * scaleY,
    nose: scalePoint(face.nose),
    mouth: scalePoint(face.mouth),
  };
}

function pointDistanceFromBoxCenter(point, boundingBox) {
  if (!point || !boundingBox) return Infinity;
  const centerX = Number(boundingBox.x || 0) + (Number(boundingBox.width || 0) / 2);
  const centerY = Number(boundingBox.y || 0) + (Number(boundingBox.height || 0) / 2);
  return Math.hypot(point.x - centerX, point.y - centerY);
}

function isDetectionNearFreshFace(detection, context = {}) {
  const faceContext = context.faceContext;
  const faces = Array.isArray(faceContext?.faces) ? faceContext.faces : [];
  if (!detection?.boundingBox || !faces.length) return false;
  const capturedAt = Number(faceContext.capturedAt || 0);
  const now = Number(context.now || Date.now());
  if (capturedAt && Math.abs(now - capturedAt) > 1800) return false;

  const box = detection.boundingBox;
  const centerX = Number(box.x || 0) + (Number(box.width || 0) / 2);
  const centerY = Number(box.y || 0) + (Number(box.height || 0) / 2);
  const boxBottom = Number(box.y || 0) + Number(box.height || 0);
  return faces.some(rawFace => {
    const face = scaledFaceForDetection(rawFace, faceContext, box);
    if (!face || face.width <= 0 || face.height <= 0) return false;
    const insideInteractionZone = centerX >= face.x - (face.width * 0.9)
      && centerX <= face.x + (face.width * 1.9)
      && centerY <= face.y + (face.height * 2.5)
      && boxBottom >= face.y + (face.height * 0.1);
    if (!insideInteractionZone) return false;
    const faceCenterX = face.x + (face.width / 2);
    const faceCenterY = face.y + (face.height / 2);
    return Math.hypot(centerX - faceCenterX, centerY - faceCenterY)
      <= Math.max(face.width, face.height) * 1.8;
  });
}

function handheldAssociation(detection, context = {}) {
  const humanContext = detection?.humanContext;
  if (humanContext?.available && humanContext?.personDetected) {
    return humanContext.nearPerson === true;
  }
  if (isDetectionNearFreshFace(detection, context)) return true;
  if (humanContext?.available) return false;
  return null;
}

function isLikelyFacialFeatureFalsePositive(detection, context = {}) {
  if (detection?.objectClass !== 'mobile_phone' || !detection?.boundingBox) return false;
  const faceContext = context.faceContext;
  const faces = Array.isArray(faceContext?.faces) ? faceContext.faces : [];
  if (!faces.length) return false;
  const capturedAt = Number(faceContext.capturedAt || 0);
  const now = Number(context.now || Date.now());
  if (capturedAt && Math.abs(now - capturedAt) > 1800) return false;

  const box = detection.boundingBox;
  // A clearly held phone occupies much more of a webcam frame. This check is
  // deliberately limited to small candidates located on a fresh face landmark,
  // which prevents a nose or mouth from being enlarged and reclassified as a phone.
  if (normalizedBoundingBoxArea(box) > 0.03) return false;

  return faces.some(rawFace => {
    const face = scaledFaceForDetection(rawFace, faceContext, box);
    if (!face || face.width <= 0 || face.height <= 0) return false;
    const boxArea = Number(box.width || 0) * Number(box.height || 0);
    const faceArea = face.width * face.height;
    const smallRelativeToFace = box.width <= face.width * 0.45
      && box.height <= face.height * 0.65
      && boxArea <= faceArea * 0.22;
    if (!smallRelativeToFace) return false;

    const landmarkDistance = Math.min(
      pointDistanceFromBoxCenter(face.nose, box),
      pointDistanceFromBoxCenter(face.mouth, box),
    );
    return landmarkDistance <= Math.min(face.width, face.height) * 0.3;
  });
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

  _collectCalibrationDetections(detections, context = {}) {
    detections
      .filter(detection => (
        detection?.boundingBox
        && detection?.detectorRole !== 'phone-specialist'
        && !isClearlySizedPhone(detection, POLICY_RULES[detection?.objectClass], context)
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

  _collectSpecialistCalibrationDetections(detections, context = {}) {
    detections
      .filter(detection => (
        detection?.detectorRole === 'phone-specialist'
        && detection?.boundingBox
        && !isClearlySizedPhone(detection, POLICY_RULES[detection?.objectClass], context)
      ))
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
      this._collectCalibrationDetections(detections, { ...context, now });
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
    if (specialistCalibrating) {
      this._collectSpecialistCalibrationDetections(detections, { ...context, now });
    }
    if (
      isSpecialistResult
      && !specialistCalibrating
      && !this.specialistCalibrationComplete
    ) this._finishSpecialistCalibration();

    const policyDetections = detections.filter(detection => {
      if (this._isCalibratedBackground(detection)) return false;
      const rule = POLICY_RULES[detection?.objectClass];
      if (rule?.requiresVerification && detection?.verified !== true) return false;
      if (detection?.objectClass === 'mobile_phone' && !hasPlausiblePhoneShape(detection, rule)) return false;
      if (isLikelyFacialFeatureFalsePositive(detection, { ...context, now })) return false;
      if (specialistCalibrating && detection?.detectorRole === 'phone-specialist') {
        return isClearlySizedPhone(detection, rule, { ...context, now });
      }
      if (!calibrating || !Number.isFinite(rule?.calibrationBypassConfidence)) return true;
      if (isClearlySizedPhone(detection, rule, { ...context, now })) return true;
      return Number(detection.confidence || 0) >= rule.calibrationBypassConfidence;
    });
    const confirmed = [];

    Object.entries(POLICY_RULES).forEach(([objectClass, rule]) => {
      const detection = bestDetectionForClass(policyDetections, objectClass);
      const prior = this.tracks.get(objectClass) || {
        hits: [],
        specialistHits: [],
        confidences: [],
        firstSeenAt: 0,
        lastSeenAt: 0,
        emitted: false,
        bestDetection: null,
        bestDetectionAt: 0,
        bestSpecialistDetection: null,
        bestSpecialistDetectionAt: 0,
        lastBoundingBox: null,
        originBoundingBox: null,
        maxMovement: 0,
      };

      if (!detection) {
        if (prior.lastSeenAt && now - prior.lastSeenAt >= rule.absenceResetMs) {
          this.tracks.delete(objectClass);
        } else if (prior.lastSeenAt) {
          prior.hits = prior.hits.filter(timestamp => now - timestamp <= rule.windowMs);
          prior.specialistHits = (prior.specialistHits || [])
            .filter(timestamp => now - timestamp <= rule.windowMs);
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
        prior.specialistHits = [];
        prior.confidences = [];
        prior.firstSeenAt = now;
        prior.emitted = false;
        prior.bestDetection = null;
        prior.bestDetectionAt = 0;
        prior.bestSpecialistDetection = null;
        prior.bestSpecialistDetectionAt = 0;
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
      prior.specialistHits = (prior.specialistHits || [])
        .filter(timestamp => now - timestamp <= rule.windowMs);
      if (detection.detectorRole === 'phone-specialist') prior.specialistHits.push(now);
      prior.confidences = [
        ...prior.confidences.filter(item => now - item.timestamp <= rule.windowMs),
        { timestamp: now, value: Number(detection.confidence || 0) },
      ];
      if (prior.bestDetectionAt && now - prior.bestDetectionAt > rule.windowMs) {
        prior.bestDetection = null;
        prior.bestDetectionAt = 0;
      }
      if (prior.bestSpecialistDetectionAt && now - prior.bestSpecialistDetectionAt > rule.windowMs) {
        prior.bestSpecialistDetection = null;
        prior.bestSpecialistDetectionAt = 0;
      }
      if (!prior.bestDetection || detection.confidence > prior.bestDetection.confidence) {
        prior.bestDetection = detection;
        prior.bestDetectionAt = now;
      }
      if (
        detection.detectorRole === 'phone-specialist'
        && (
          !prior.bestSpecialistDetection
          || detection.confidence > prior.bestSpecialistDetection.confidence
        )
      ) {
        prior.bestSpecialistDetection = detection;
        prior.bestSpecialistDetectionAt = now;
      }
      this.tracks.set(objectClass, prior);

      const averageConfidence = prior.confidences.reduce((sum, item) => sum + item.value, 0) / prior.confidences.length;
      const peakConfidence = Number(prior.bestDetection?.confidence || 0);
      if (prior.emitted || prior.hits.length < requiredHitsForTrack(rule, prior)) return;
      if (peakConfidence < Number(rule.minimumPeakConfidence || 0)) return;
      if (averageConfidence < Number(rule.minimumAverageConfidence || 0)) return;
      const edgeBoundPhone = objectClass === 'mobile_phone'
        && isFrameEdgeBound(prior.bestDetection?.boundingBox, rule.frameEdgeMarginRatio);
      if (edgeBoundPhone && prior.hits.length < Number(rule.frameEdgeHitCount || Infinity)) return;
      const specialistDetection = prior.bestDetection?.detectorRole === 'phone-specialist';
      const fallbackMovementDetection = rule.fallbackMovementRawClasses?.includes(
        String(prior.bestDetection?.rawClass || ''),
      );
      const phoneEvidenceDetection = prior.bestSpecialistDetection || prior.bestDetection;
      const stationaryPhoneEvidenceIsClear = isClearlySizedPhone(
        phoneEvidenceDetection,
        rule,
        { ...context, now },
      );
      const separatedFromStudent = objectClass === 'mobile_phone'
        && handheldAssociation(phoneEvidenceDetection, { ...context, now }) === false;
      if (separatedFromStudent && prior.hits.length < Number(rule.backgroundHitCount || Infinity)) return;
      const specialistStationaryEvidence = (prior.specialistHits || []).length > 0
        && stationaryPhoneEvidenceIsClear
        && prior.specialistHits.length >= Number(rule.specialistStationaryHitCount || Infinity);
      const smallPhoneNeedsMovement = objectClass === 'mobile_phone' && !stationaryPhoneEvidenceIsClear;
      const movementRequiredDetection = fallbackMovementDetection
        || smallPhoneNeedsMovement
        || edgeBoundPhone
        || separatedFromStudent
        || (specialistDetection && !specialistStationaryEvidence);
      const minimumMovement = separatedFromStudent
        ? Number(rule.backgroundMinimumMovement || Infinity)
        : edgeBoundPhone
        ? Number(rule.frameEdgeMinimumMovement || Infinity)
        : movementRequiredDetection
          ? Number(rule.specialistMinimumMovement || Infinity)
          : Number(rule.minimumMovementForWeakConfidence || 0);
      const weakConfidenceNeedsMovement = peakConfidence < Number(rule.strongConfidence || 0)
        && !specialistStationaryEvidence;
      if (
        prior.maxMovement < minimumMovement
        && (movementRequiredDetection || weakConfidenceNeedsMovement)
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

const DEFAULT_OBJECT_MONITORING = Object.freeze({
  enabled: false,
  mode: 'alert',
});

// Mobile phones are the only restricted object. Mouse is learned solely as a
// negative class so a phone-shaped desk mouse is not reported as a phone.
const POLICY_RULES = Object.freeze({
  mobile_phone: {
    violationType: 'restricted_phone',
    label: 'Mobile phone',
    allowedRawClasses: ['cell phone', 'mobile_phone'],
    // One scan to know where the object was and two more to see that it left.
    hitCount: 3,
    windowMs: 5500,
    absenceResetMs: 6000,
    minimumPeakConfidence: 0.3,
    minimumAverageConfidence: 0.26,
    calibrationBypassConfidence: 0.7,
    minimumStationaryAreaRatio: 0.025,
    frameEdgeMarginRatio: 0.025,
    frameEdgeHitCount: 3,
    frameEdgeMinimumMovement: 0.15,
    // A phone in use travels; a fixture's box only wobbles. Both used to be
    // measured the same way - the furthest the box centre had ever strayed from
    // where it was first seen - and a few pixels of wobble on an air conditioner
    // or a switch plate cleared a 4% bar within seconds. Travel is now judged on
    // the two newest scans against where the object had been sitting, and has to
    // be this share of the frame's longer side as well as of the object itself.
    movementWindowMs: 12000,
    movementHistoryLimit: 48,
    minimumMovementFrameRatio: 0.03,
    // Scans older than this no longer say who is in the picture.
    peopleContextMs: 2500,
    // A candidate that has sat still for this many scans is no longer shown to
    // the student as something being checked.
    settledHitCount: 6,
    // Phones are held upright far more often than not, and a portrait box is the
    // one shape a room's fixtures rarely produce. Landscape candidates are kept
    // to the proportions a real handset actually has, because most wide
    // rectangles in a room are an air conditioner, a vent, a frame or a shelf.
    minimumAspectRatio: 1.45,
    // A phone seen edge-on or cropped by a close-up scan is a narrow sliver, so
    // the portrait band stays wide. The restriction that matters is below.
    maximumAspectRatio: 4.2,
    maximumLandscapeAspectRatio: 2.6,
    // A phone cannot occupy this much of a webcam frame without being pressed
    // against the lens, which the camera-obstruction rules already cover.
    maximumAreaRatio: 0.28,
    // Nothing sitting in the top band of the frame, away from the student's face,
    // is a phone in use — that is where wall fixtures live.
    upperFrameBandRatio: 0.35,
    backgroundHitCount: 4,
    backgroundMinimumMovement: 0.18,
    minimumPhoneMovement: 0.12,
    requiresVerification: true,
  },
});

export function normalizeObjectMonitoring(value = {}) {
  const mode = ['shadow', 'alert', 'enforce'].includes(value?.mode) ? value.mode : 'alert';
  return {
    ...DEFAULT_OBJECT_MONITORING,
    enabled: !!value?.enabled,
    mode,
  };
}

function bestDetectionForClass(detections, objectClass) {
  return detections
    .filter(detection => detection?.objectClass === objectClass)
    .sort((a, b) => Number(b.confidence || 0) - Number(a.confidence || 0))[0] || null;
}

function requiredHitsForTrack(rule) {
  return Number(rule.hitCount || 1);
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function boxEdges(boundingBox) {
  const left = Number(boundingBox?.x || 0);
  const top = Number(boundingBox?.y || 0);
  return {
    left,
    top,
    right: left + Number(boundingBox?.width || 0),
    bottom: top + Number(boundingBox?.height || 0),
  };
}

// Where the object had been sitting: the middle of its earlier boxes, edge by
// edge, so one odd reading among them does not move the reference.
function anchorEdges(boundingBoxes) {
  const edges = boundingBoxes.map(boxEdges);
  return {
    left: median(edges.map(edge => edge.left)),
    top: median(edges.map(edge => edge.top)),
    right: median(edges.map(edge => edge.right)),
    bottom: median(edges.map(edge => edge.bottom)),
  };
}

// How far the object itself travelled along one axis. When a box grows, shrinks
// or is read first as the whole unit and then as part of it, one edge moves and
// the other stays put, or they move apart. Only the distance both edges cover in
// the same direction is the object going somewhere.
function sharedShift(startDelta, endDelta) {
  if (!startDelta || !endDelta || Math.sign(startDelta) !== Math.sign(endDelta)) return 0;
  return Math.sign(startDelta) * Math.min(Math.abs(startDelta), Math.abs(endDelta));
}

function rigidShift(anchor, boundingBox) {
  const edges = boxEdges(boundingBox);
  return {
    x: sharedShift(edges.left - anchor.left, edges.right - anchor.right),
    y: sharedShift(edges.top - anchor.top, edges.bottom - anchor.bottom),
  };
}

// Travel the track has actually shown, in lengths of the object itself; zero
// when there is none worth the name.
//
// The two newest scans are compared with where the object had been before them.
// Both have to be clear of that spot, in the same direction, by more than the
// frame-size floor. A still object never does that: its box wobbles back and
// forth around one place, so consecutive readings disagree about the direction
// or stay inside the floor. Each detector is judged on its own readings, because
// the two models draw slightly different boxes around the same object and
// alternating between them would otherwise look like motion.
function trackMovement(positions, detectorRole, rule) {
  const own = positions.filter(position => position.role === detectorRole && position.boundingBox);
  if (own.length < 3) return 0;
  const recent = own.slice(-2);
  const anchor = anchorEdges(own.slice(0, -2).map(position => position.boundingBox));
  const newest = recent[1].boundingBox;
  const frameSide = Math.max(Number(newest.frameWidth || 0), Number(newest.frameHeight || 0));
  const floor = frameSide * Number(rule.minimumMovementFrameRatio || 0);
  const shifts = recent.map(position => rigidShift(anchor, position.boundingBox));
  const distances = shifts.map(shift => Math.hypot(shift.x, shift.y));
  const shortest = Math.min(...distances);
  if (!(shortest > 0) || shortest < floor) return 0;
  if ((shifts[0].x * shifts[1].x) + (shifts[0].y * shifts[1].y) <= 0) return 0;
  const objectScale = Math.max(anchor.right - anchor.left, anchor.bottom - anchor.top, 1);
  return shortest / objectScale;
}

// The same test the detector applies when it can see people itself: the object
// overlaps a person, or sits right beside one.
function isNearAnyPerson(boundingBox, people = []) {
  if (!boundingBox || !people.length) return false;
  const boxArea = Math.max(1, Number(boundingBox.width || 0) * Number(boundingBox.height || 0));
  const box = boxEdges(boundingBox);
  const centerX = (box.left + box.right) / 2;
  const centerY = (box.top + box.bottom) / 2;
  return people.some(rawPerson => {
    const scaleX = Number(boundingBox.frameWidth || 0) / Number(rawPerson.frameWidth || boundingBox.frameWidth || 1) || 1;
    const scaleY = Number(boundingBox.frameHeight || 0) / Number(rawPerson.frameHeight || boundingBox.frameHeight || 1) || 1;
    const person = {
      left: Number(rawPerson.x || 0) * scaleX,
      top: Number(rawPerson.y || 0) * scaleY,
      right: (Number(rawPerson.x || 0) + Number(rawPerson.width || 0)) * scaleX,
      bottom: (Number(rawPerson.y || 0) + Number(rawPerson.height || 0)) * scaleY,
    };
    const overlap = Math.max(0, Math.min(box.right, person.right) - Math.max(box.left, person.left))
      * Math.max(0, Math.min(box.bottom, person.bottom) - Math.max(box.top, person.top));
    if (overlap / boxArea >= 0.15) return true;
    const gapX = Math.max(person.left - centerX, 0, centerX - person.right);
    const gapY = Math.max(person.top - centerY, 0, centerY - person.bottom);
    const personScale = Math.max(1, person.right - person.left, person.bottom - person.top);
    return Math.hypot(gapX, gapY) / personScale <= 0.08;
  });
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

function isPortraitBox(boundingBox) {
  return Number(boundingBox?.height || 0) >= Number(boundingBox?.width || 0);
}

// A box sitting entirely in the top band of the frame, with the student's face
// nowhere near it, is a wall fixture rather than a phone in anyone's hand. The
// face exemption keeps a phone raised to the ear or held up to the screen.
function isUpperFrameFixture(detection, rule, context = {}) {
  const box = detection?.boundingBox;
  const frameHeight = Number(box?.frameHeight || 0);
  const band = Number(rule?.upperFrameBandRatio || 0);
  if (!box || frameHeight <= 0 || band <= 0) return false;
  const bottom = (Number(box.y || 0) + Number(box.height || 0)) / frameHeight;
  if (bottom > band) return false;
  return !isDetectionNearFreshFace(detection, context);
}

function hasPlausiblePhoneShape(detection, rule = POLICY_RULES.mobile_phone, context = {}) {
  if (detection?.objectClass !== 'mobile_phone' || !detection?.boundingBox) return false;
  const aspectRatio = phoneAspectRatio(detection.boundingBox);
  if (aspectRatio < Number(rule.minimumAspectRatio || 0)) return false;
  if (aspectRatio > Number(rule.maximumAspectRatio || Infinity)) return false;

  if (normalizedBoundingBoxArea(detection.boundingBox) > Number(rule.maximumAreaRatio ?? Infinity)) {
    return false;
  }

  if (!isPortraitBox(detection.boundingBox)) {
    // Wide candidates get the narrower band a real handset has, and are only
    // believed when the student's own face places them in their hands: a person
    // bounding box overlapping a fixture on the wall behind them does not.
    if (aspectRatio > Number(rule.maximumLandscapeAspectRatio ?? Infinity)) return false;
    if (!isDetectionNearFreshFace(detection, context)) return false;
  }

  if (isUpperFrameFixture(detection, rule, context)) return false;

  return true;
}

function isClearlySizedPhone(detection, rule = POLICY_RULES.mobile_phone, context = {}) {
  if (detection?.objectClass !== 'mobile_phone' || !detection?.boundingBox) return false;
  const areaRatio = normalizedBoundingBoxArea(detection.boundingBox);
  return areaRatio >= Number(rule.minimumStationaryAreaRatio || Infinity)
    && !isFrameEdgeBound(detection.boundingBox, rule.frameEdgeMarginRatio)
    && hasPlausiblePhoneShape(detection, rule, context)
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
  // The phone-back model knows only phones and mice, so it cannot say whether
  // anyone is near what it found and every object it reported was treated as
  // possibly in someone's hand. The general model scans the same picture a
  // moment earlier and does see people; its answer is used here.
  const people = context.peopleContext;
  if (people?.available) return isNearAnyPerson(detection?.boundingBox, people.boxes);
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
    this.peopleBoxes = [];
    this.peopleScannedAt = 0;
    this.peopleContextKnown = false;
  }

  // People arrive only in the general model's results. They are kept for a
  // moment so the phone-back model's findings can be placed against them.
  _rememberPeople(detections, context, now) {
    if (context.detectorRole === 'phone-specialist') return;
    const people = detections.filter(detection => detection?.contextClass === 'person' && detection?.boundingBox);
    // A model without a person class returns none either, which must not be
    // read as an empty room. It is known to see people once it has reported one,
    // or once it has said so on a phone candidate.
    if (people.length || detections.some(detection => detection?.humanContext?.available === true)) {
      this.peopleContextKnown = true;
    }
    if (!this.peopleContextKnown) return;
    this.peopleBoxes = people.map(person => ({ ...person.boundingBox }));
    this.peopleScannedAt = now;
  }

  _peopleContext(now) {
    const maximumAge = Number(POLICY_RULES.mobile_phone.peopleContextMs || 0);
    const fresh = this.peopleContextKnown
      && this.peopleScannedAt > 0
      && Math.abs(now - this.peopleScannedAt) <= maximumAge;
    return { available: fresh, boxes: fresh ? this.peopleBoxes : [] };
  }

  _collectCalibrationDetections(detections, context = {}) {
    detections
      .filter(detection => (
        detection?.boundingBox
        && detection?.detectorRole !== 'phone-specialist'
        // A confident score is not evidence that something is not furniture: a
        // wall unit can read as a phone at 0.8 all day. Only a detection that
        // genuinely looks like a held phone is kept out of the background map,
        // so a fixture in view at startup is learned and then ignored for the
        // rest of the attempt however strongly it scores.
        && !isClearlySizedPhone(detection, POLICY_RULES[detection?.objectClass], context)
        && !!POLICY_RULES[detection?.objectClass]
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
      .filter(([objectClass, track]) => {
        if (track.emitted) return false;
        // Something that has been scanned this many times without going anywhere
        // is part of the room. Showing "checking phone" over it for the whole
        // exam told the student they were suspected of something.
        const settledAfter = Number(POLICY_RULES[objectClass]?.settledHitCount || Infinity);
        return !((track.positions || []).length >= settledAfter && !(track.movement > 0));
      })
      .map(([objectClass, track]) => {
        const rule = POLICY_RULES[objectClass];
        return {
          objectClass,
          objectLabel: rule?.label || objectClass,
          hits: track.hits.length,
          requiredHits: requiredHitsForTrack(rule || {}),
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
    this._rememberPeople(detections, context, now);
    const policyContext = { ...context, now, peopleContext: this._peopleContext(now) };
    const calibrating = !this.calibrationComplete && now - this.firstEvaluationAt < this.calibrationMs;
    if (calibrating) {
      this._collectCalibrationDetections(detections, policyContext);
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
      this._collectSpecialistCalibrationDetections(detections, policyContext);
    }
    if (
      isSpecialistResult
      && !specialistCalibrating
      && !this.specialistCalibrationComplete
    ) this._finishSpecialistCalibration();

    const policyDetections = detections.filter(detection => {
      if (this._isCalibratedBackground(detection)) return false;
      const rule = POLICY_RULES[detection?.objectClass];
      if (
        Array.isArray(rule?.allowedRawClasses)
        && !rule.allowedRawClasses.includes(String(detection?.rawClass || ''))
      ) return false;
      if (rule?.requiresVerification && detection?.verified !== true) return false;
      if (
        detection?.objectClass === 'mobile_phone'
        && !hasPlausiblePhoneShape(detection, rule, policyContext)
      ) return false;
      if (isLikelyFacialFeatureFalsePositive(detection, policyContext)) return false;
      if (specialistCalibrating && detection?.detectorRole === 'phone-specialist') {
        return isClearlySizedPhone(detection, rule, policyContext);
      }
      if (!calibrating || !Number.isFinite(rule?.calibrationBypassConfidence)) return true;
      if (isClearlySizedPhone(detection, rule, policyContext)) return true;
      return Number(detection.confidence || 0) >= rule.calibrationBypassConfidence;
    });
    const confirmed = [];

    Object.entries(POLICY_RULES).forEach(([objectClass, rule]) => {
      const detection = bestDetectionForClass(policyDetections, objectClass);
      const prior = this.tracks.get(objectClass) || {
        hits: [],
        confidences: [],
        positions: [],
        movement: 0,
        firstSeenAt: 0,
        lastSeenAt: 0,
        emitted: false,
        bestDetection: null,
        bestDetectionAt: 0,
        lastBoundingBox: null,
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
        prior.positions = [];
        prior.movement = 0;
        prior.firstSeenAt = now;
        prior.emitted = false;
        prior.bestDetection = null;
        prior.bestDetectionAt = 0;
      }

      prior.lastSeenAt = now;
      const detectorRole = detection.detectorRole || 'primary';
      if (detection.boundingBox) {
        const movementWindowMs = Number(rule.movementWindowMs || rule.windowMs);
        prior.positions = [
          ...(prior.positions || []).filter(position => now - position.timestamp <= movementWindowMs),
          { timestamp: now, role: detectorRole, boundingBox: detection.boundingBox },
        ].slice(-Number(rule.movementHistoryLimit || 48));
      }
      prior.movement = trackMovement(prior.positions || [], detectorRole, rule);
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
      if (prior.emitted || prior.hits.length < requiredHitsForTrack(rule)) return;
      if (peakConfidence < Number(rule.minimumPeakConfidence || 0)) return;
      if (averageConfidence < Number(rule.minimumAverageConfidence || 0)) return;
      const edgeBoundPhone = objectClass === 'mobile_phone'
        && isFrameEdgeBound(prior.bestDetection?.boundingBox, rule.frameEdgeMarginRatio);
      if (edgeBoundPhone && prior.hits.length < Number(rule.frameEdgeHitCount || Infinity)) return;
      // Judged where the object is now, not where it scored highest: a phone
      // lifted from the desk into the student's hand has joined them.
      const separatedFromStudent = objectClass === 'mobile_phone'
        && handheldAssociation(detection, policyContext) === false;
      if (separatedFromStudent && prior.hits.length < Number(rule.backgroundHitCount || Infinity)) return;
      // Static wall and desk items repeatedly resemble a phone to both models,
      // often with high confidence. A prohibited phone in use moves with a hand,
      // so every report needs the object to have clearly travelled, however sure
      // the model is and however many scans agree. Objects at the frame edge or
      // away from the student have to travel further still.
      const requiredMovement = separatedFromStudent
        ? Number(rule.backgroundMinimumMovement || Infinity)
        : edgeBoundPhone
          ? Number(rule.frameEdgeMinimumMovement || Infinity)
          : Number(rule.minimumPhoneMovement || Infinity);
      if (objectClass === 'mobile_phone' && !(prior.movement >= requiredMovement)) return;
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

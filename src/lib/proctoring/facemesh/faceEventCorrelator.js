import {
  FACE_EVENT_DESCRIPTIONS,
  FACE_EVENT_SEVERITY,
  createIncidentId,
} from './faceMonitoringTypes.js';

function boxesNear(face, object, expansionRatio) {
  if (!face || !object) return true;
  const expandX = face.width * expansionRatio;
  const expandY = face.height * expansionRatio;
  const faceLeft = face.x - expandX;
  const faceTop = face.y - expandY;
  const faceRight = face.x + face.width + expandX;
  const faceBottom = face.y + face.height + expandY;
  const objectRight = object.x + object.width;
  const objectBottom = object.y + object.height;
  return object.x <= faceRight
    && objectRight >= faceLeft
    && object.y <= faceBottom
    && objectBottom >= faceTop;
}

export class FaceEventCorrelator {
  constructor(config) {
    this.config = config;
    this.activeOcclusion = null;
    this.recentPhone = null;
    this.emittedKeys = new Set();
  }

  handleFaceEvent(event, faceBox = null, now = Date.now()) {
    if (event?.eventType !== 'FACE_OCCLUDED') return null;
    if (event.phase === 'end') {
      this.activeOcclusion = null;
      return null;
    }
    this.activeOcclusion = { event, faceBox, at: now };
    return this._correlate(now);
  }

  handleYoloEvent(event, now = Date.now()) {
    if (event?.objectClass !== 'mobile_phone' && event?.violationType !== 'restricted_phone') return null;
    this.recentPhone = { event, at: now };
    return this._correlate(now);
  }

  _correlate(now) {
    if (!this.activeOcclusion || !this.recentPhone) return null;
    if (Math.abs(this.activeOcclusion.at - this.recentPhone.at) > this.config.overlapWindowMs) return null;
    if (!boxesNear(
      this.activeOcclusion.faceBox,
      this.recentPhone.event.boundingBox,
      this.config.faceBoxExpansionRatio,
    )) return null;

    const key = `${this.activeOcclusion.event.incidentId}|${this.recentPhone.event.objectClass || 'phone'}`;
    if (this.emittedKeys.has(key)) return null;
    this.emittedKeys.add(key);
    const timestamp = new Date(now).toISOString();
    return {
      kind: 'incident',
      phase: 'end',
      incidentId: createIncidentId('face-yolo'),
      source: 'FACEMESH_YOLO',
      eventType: 'PHONE_NEAR_OR_COVERING_FACE',
      severity: FACE_EVENT_SEVERITY.PHONE_NEAR_OR_COVERING_FACE,
      description: FACE_EVENT_DESCRIPTIONS.PHONE_NEAR_OR_COVERING_FACE,
      direction: null,
      startedAt: this.activeOcclusion.event.startedAt || timestamp,
      endedAt: timestamp,
      durationMs: Number(this.activeOcclusion.event.durationMs || 0),
      maxYaw: Number(this.activeOcclusion.event.maxYaw || 0),
      maxPitch: Number(this.activeOcclusion.event.maxPitch || 0),
      trackingConfidence: Number(this.activeOcclusion.event.trackingConfidence || 0),
      phoneConfidence: Number(this.recentPhone.event.confidence || 0),
      relatedIncidentIds: [this.activeOcclusion.event.incidentId],
      requiresProfessorReview: true,
    };
  }

  reset() {
    this.activeOcclusion = null;
    this.recentPhone = null;
    this.emittedKeys.clear();
  }
}

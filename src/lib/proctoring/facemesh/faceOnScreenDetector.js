import {
  FACE_EVENT_DESCRIPTIONS,
  FACE_EVENT_SEVERITY,
  createIncidentId,
} from './faceMonitoringTypes.js';

// A face that sits inside a phone the object detector can see is a face shown
// on a screen. The existing phone rule only correlates a phone with a *covered*
// face; a face displayed on the phone passes as ordinary presence.
//
// Face boxes come from the face scan and phone boxes from YOLO, each in its
// own frame's pixels, so both are normalised to 0..1 before they are compared.
// Each YOLO scan is one vote; the incident needs a run of them over several
// seconds, so a single mislabelled frame never reaches the professor.

function iso(value) {
  return new Date(value).toISOString();
}

function normalizeBox(box, fallbackFrame = null) {
  const frameWidth = Number(box?.frameWidth || fallbackFrame?.frameWidth || 0);
  const frameHeight = Number(box?.frameHeight || fallbackFrame?.frameHeight || 0);
  if (!box || !(frameWidth > 0) || !(frameHeight > 0)) return null;
  const left = Number(box.x || 0) / frameWidth;
  const top = Number(box.y || 0) / frameHeight;
  const width = Number(box.width || 0) / frameWidth;
  const height = Number(box.height || 0) / frameHeight;
  if (!(width > 0) || !(height > 0)) return null;
  return { left, top, right: left + width, bottom: top + height, area: width * height };
}

function containment(inner, outer) {
  const width = Math.min(inner.right, outer.right) - Math.max(inner.left, outer.left);
  const height = Math.min(inner.bottom, outer.bottom) - Math.max(inner.top, outer.top);
  if (width <= 0 || height <= 0) return 0;
  return (width * height) / inner.area;
}

export function findContainingPhone(face, phones, config) {
  const faceBox = normalizeBox(face);
  if (!faceBox || !Array.isArray(phones)) return null;
  let best = null;
  for (const phone of phones) {
    const confidence = Number(phone?.confidence || 0);
    if (confidence < Number(config.minimumPhoneConfidence)) continue;
    const phoneBox = normalizeBox(phone.boundingBox, face);
    if (!phoneBox) continue;
    // A screen the face can be shown on is bigger than the face, and a phone is
    // never most of the frame — that is a monitor behind the student, or a
    // phone pressed against the lens, which the obstruction rules cover.
    if (phoneBox.area > Number(config.maximumPhoneFrameAreaRatio)) continue;
    if (phoneBox.area < faceBox.area * Number(config.minimumPhoneToFaceAreaRatio)) continue;
    const covered = containment(faceBox, phoneBox);
    if (covered < Number(config.minimumContainment)) continue;
    if (!best || confidence > best.confidence) best = { confidence, containment: covered, boundingBox: phone.boundingBox };
  }
  return best;
}

export class FaceOnScreenDetector {
  constructor(config, onEvent = () => {}) {
    this.config = config;
    this.onEvent = onEvent;
    this.face = null;
    this.reset();
  }

  reset() {
    this.hits = [];
    this.firstHitAt = null;
    this.lastHitAt = null;
    this.peakConfidence = 0;
    this.lastMatch = null;
    this.active = null;
    this.cooldownUntil = 0;
  }

  // The latest face box in frame pixels, with its frameWidth/frameHeight.
  observeFace(face, now = Date.now()) {
    this.face = face ? { ...face, at: now } : null;
  }

  _emit(phase, now, wallNow) {
    const active = this.active;
    if (!active) return;
    active.lastEmittedAt = now;
    this.onEvent({
      kind: 'incident',
      phase,
      incidentId: active.incidentId,
      source: 'FACEMESH_YOLO',
      eventType: 'FACE_ON_PHONE_SCREEN',
      severity: FACE_EVENT_SEVERITY.FACE_ON_PHONE_SCREEN,
      description: FACE_EVENT_DESCRIPTIONS.FACE_ON_PHONE_SCREEN,
      direction: null,
      startedAt: active.startedAt,
      endedAt: phase === 'end' ? iso(wallNow) : null,
      durationMs: Math.max(0, now - active.startedMonotonicAt),
      maxYaw: 0,
      maxPitch: 0,
      trackingConfidence: 0,
      phoneConfidence: Math.round(this.peakConfidence * 1000) / 1000,
      boundingBox: this.lastMatch?.boundingBox || null,
      frameHits: this.hits.length,
      requiresProfessorReview: true,
    });
  }

  observePhones(phones, now = Date.now(), wallNow = Date.now()) {
    const face = this.face && now - this.face.at <= Number(this.config.faceContextMs) ? this.face : null;
    const match = face ? findContainingPhone(face, phones, this.config) : null;

    if (match) {
      if (this.lastHitAt === null || now - this.lastHitAt > Number(this.config.gapToleranceMs)) {
        if (!this.active) {
          this.hits = [];
          this.firstHitAt = now;
          this.peakConfidence = 0;
        }
      }
      if (this.firstHitAt === null) this.firstHitAt = now;
      this.hits.push(now);
      this.lastHitAt = now;
      this.lastMatch = match;
      this.peakConfidence = Math.max(this.peakConfidence, match.confidence);
      if (this.active) {
        if (now - this.active.lastEmittedAt >= Number(this.config.incidentUpdateMs)) this._emit('update', now, wallNow);
        return;
      }
      const sustained = now - this.firstHitAt >= Number(this.config.incidentMs);
      if (sustained && this.hits.length >= Number(this.config.minimumHits) && now >= this.cooldownUntil) {
        this.active = {
          incidentId: createIncidentId('face-screen'),
          startedMonotonicAt: this.firstHitAt,
          startedAt: iso(wallNow - (now - this.firstHitAt)),
          lastEmittedAt: 0,
        };
        this._emit('start', now, wallNow);
      }
      return;
    }

    if (this.lastHitAt === null) return;
    const sinceHit = now - this.lastHitAt;
    if (this.active) {
      if (sinceHit >= Number(this.config.recoveryMs)) {
        this._emit('end', now, wallNow);
        this.reset();
        this.cooldownUntil = now + Number(this.config.cooldownMs);
      }
      return;
    }
    if (sinceHit > Number(this.config.gapToleranceMs)) {
      const cooldownUntil = this.cooldownUntil;
      this.reset();
      this.cooldownUntil = cooldownUntil;
    }
  }

  stop(now = Date.now(), wallNow = Date.now()) {
    if (this.active) this._emit('end', now, wallNow);
    this.reset();
  }
}

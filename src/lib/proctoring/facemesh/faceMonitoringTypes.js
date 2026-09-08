export const FACE_STATES = Object.freeze({
  FACE_PRESENT: 'FACE_PRESENT',
  FACE_ABSENT: 'FACE_ABSENT',
  FACE_PARTIALLY_VISIBLE: 'FACE_PARTIALLY_VISIBLE',
  FACE_TOO_CLOSE: 'FACE_TOO_CLOSE',
  FACE_TOO_FAR: 'FACE_TOO_FAR',
  FACE_NEAR_FRAME_EDGE: 'FACE_NEAR_FRAME_EDGE',
  HEAD_CENTER: 'HEAD_CENTER',
  HEAD_LEFT: 'HEAD_LEFT',
  HEAD_RIGHT: 'HEAD_RIGHT',
  HEAD_UP: 'HEAD_UP',
  HEAD_DOWN: 'HEAD_DOWN',
  FACE_OCCLUDED: 'FACE_OCCLUDED',
  FACE_TRACKING_UNSTABLE: 'FACE_TRACKING_UNSTABLE',
});

export const FACE_INCIDENT_TYPES = Object.freeze({
  FACE_ABSENT: 'FACE_ABSENT',
  FACE_PARTIALLY_VISIBLE: 'FACE_PARTIALLY_VISIBLE',
  FACE_TOO_CLOSE: 'FACE_TOO_CLOSE',
  FACE_TOO_FAR: 'FACE_TOO_FAR',
  FACE_NEAR_FRAME_EDGE: 'FACE_NEAR_FRAME_EDGE',
  SUSTAINED_HEAD_TURN: 'SUSTAINED_HEAD_TURN',
  SUSTAINED_LOOKING_DOWN: 'SUSTAINED_LOOKING_DOWN',
  REPEATED_LOOKING_AWAY: 'REPEATED_LOOKING_AWAY',
  FACE_OCCLUDED: 'FACE_OCCLUDED',
  FACE_TRACKING_UNSTABLE: 'FACE_TRACKING_UNSTABLE',
  PHONE_NEAR_OR_COVERING_FACE: 'PHONE_NEAR_OR_COVERING_FACE',
});

export const FACE_EVENT_DESCRIPTIONS = Object.freeze({
  FACE_ABSENT: 'No person detected in the camera frame',
  FACE_PARTIALLY_VISIBLE: 'Face partially outside camera',
  FACE_TOO_CLOSE: 'Face is too close to the camera',
  FACE_TOO_FAR: 'Face is too far from the camera',
  FACE_NEAR_FRAME_EDGE: 'Face is near the camera frame edge',
  SUSTAINED_HEAD_TURN: 'Sustained head turn detected',
  SUSTAINED_LOOKING_DOWN: 'Sustained downward head direction detected',
  REPEATED_LOOKING_AWAY: 'Repeated looking-away pattern detected',
  FACE_OCCLUDED: 'Face appears obstructed',
  FACE_TRACKING_UNSTABLE: 'Face tracking is unstable',
  PHONE_NEAR_OR_COVERING_FACE: 'Phone detected near or covering the face',
});

export const FACE_EVENT_SEVERITY = Object.freeze({
  FACE_ABSENT: 'MODERATE',
  FACE_PARTIALLY_VISIBLE: 'INFO',
  FACE_TOO_CLOSE: 'INFO',
  FACE_TOO_FAR: 'INFO',
  FACE_NEAR_FRAME_EDGE: 'INFO',
  SUSTAINED_HEAD_TURN: 'LOW',
  SUSTAINED_LOOKING_DOWN: 'LOW',
  REPEATED_LOOKING_AWAY: 'MODERATE',
  FACE_OCCLUDED: 'LOW',
  FACE_TRACKING_UNSTABLE: 'INFO',
  PHONE_NEAR_OR_COVERING_FACE: 'HIGH',
});

export function createIncidentId(prefix = 'face') {
  if (globalThis.crypto?.randomUUID) return `${prefix}-${globalThis.crypto.randomUUID()}`;
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

const ALLOWED_LABELS = new Set([
  'CENTER',
  'HEAD_LEFT',
  'HEAD_RIGHT',
  'HEAD_UP',
  'HEAD_DOWN',
  'BRIEF_LOOK_AWAY',
  'SUSTAINED_LOOK_AWAY',
  'FACE_ABSENT',
  'PARTIAL_FACE',
  'FACE_OCCLUDED',
  'LOW_LIGHT',
  'GLASSES',
  'NORMAL_MOVEMENT',
]);

const COLUMNS = [
  'participant_id', 'session_id', 'timestamp_ms', 'yaw', 'pitch', 'roll',
  'relative_yaw', 'relative_pitch', 'relative_roll', 'face_present',
  'face_center_x', 'face_center_y', 'face_width', 'face_height',
  'tracking_confidence', 'expected_label',
];

function csvValue(value) {
  const text = String(value ?? '');
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export class FaceEvaluationExporter {
  constructor({ participantId, sessionId, consented = false, developmentMode = false } = {}) {
    if (!developmentMode) throw new Error('Face evaluation export is available only in development mode.');
    if (!consented) throw new Error('Explicit participant consent is required.');
    if (!/^[a-zA-Z0-9_-]{3,64}$/.test(String(participantId || ''))) {
      throw new Error('Use an anonymous participant ID.');
    }
    this.participantId = participantId;
    this.sessionId = String(sessionId || '');
    this.rows = [];
  }

  add(observation, expectedLabel) {
    const label = String(expectedLabel || '').toUpperCase();
    if (!ALLOWED_LABELS.has(label)) throw new Error('Unsupported evaluation label.');
    const pose = observation?.pose || {};
    const relative = observation?.relativePose || {};
    const geometry = observation?.geometry || {};
    this.rows.push({
      participant_id: this.participantId,
      session_id: this.sessionId,
      timestamp_ms: Number(observation?.timestampMs || 0),
      yaw: Number(pose.yaw || 0),
      pitch: Number(pose.pitch || 0),
      roll: Number(pose.roll || 0),
      relative_yaw: Number(relative.yaw || 0),
      relative_pitch: Number(relative.pitch || 0),
      relative_roll: Number(relative.roll || 0),
      face_present: observation?.facePresent === true ? 1 : 0,
      face_center_x: Number(geometry.centerX || 0),
      face_center_y: Number(geometry.centerY || 0),
      face_width: Number(geometry.width || 0),
      face_height: Number(geometry.height || 0),
      tracking_confidence: Number(observation?.trackingQuality || 0),
      expected_label: label,
    });
  }

  toCsv() {
    return [
      COLUMNS.join(','),
      ...this.rows.map(row => COLUMNS.map(column => csvValue(row[column])).join(',')),
    ].join('\n');
  }
}

export { ALLOWED_LABELS as FACE_EVALUATION_LABELS };

const FEATURE_COLUMNS = Object.freeze([
  'browser_start_count',
  'browser_end_count',
  'browser_tab_switched_count',
  'browser_screenshot_count',
  'browser_exam_duration_minutes',
  'webcam_face_present',
  'webcam_no_of_face',
  'webcam_face_conf',
  'webcam_hand_count',
  'webcam_head_pitch',
  'webcam_head_yaw',
  'webcam_head_roll',
]);

const FEATURE_CONTRACT_VERSION = 'rf-session-summary-v1';
const DEG_TO_RAD = Math.PI / 180;

class PredictionUnavailableError extends Error {
  constructor(message, code = 'FEATURES_UNAVAILABLE') {
    super(message);
    this.name = 'PredictionUnavailableError';
    this.code = code;
  }
}

function finiteNumber(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    throw new PredictionUnavailableError(`${label} is missing or invalid.`);
  }
  return number;
}

function countActivities(activities, type) {
  return activities.filter((activity) => String(activity?.type || '') === type).length;
}

function roundFeature(value) {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function aggregateSessionFeatures(session) {
  if (!session || session.submitted !== true) {
    throw new PredictionUnavailableError('The examination session is not completed.', 'SESSION_NOT_COMPLETED');
  }
  const start = new Date(session.start_time || session.startTime || '');
  const end = new Date(session.end_time || session.endTime || '');
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end < start) {
    throw new PredictionUnavailableError('The completed session has invalid start or end timestamps.');
  }

  const activities = Array.isArray(session.activities) ? session.activities : [];
  const startCount = countActivities(activities, 'browser_exam_start');
  const endCount = countActivities(activities, 'browser_exam_end');
  if (startCount < 1 || endCount < 1) {
    throw new PredictionUnavailableError(
      'This session predates the Random Forest browser summary and cannot be analyzed safely.',
      'BROWSER_SUMMARY_UNAVAILABLE',
    );
  }

  const detections = session.ai_detections || session.aiDetections || {};
  const face = detections.faceMonitoring;
  if (!face || face.feature_contract_version !== FEATURE_CONTRACT_VERSION) {
    throw new PredictionUnavailableError(
      'This session does not contain the required FaceMesh summary version.',
      'WEBCAM_SUMMARY_UNAVAILABLE',
    );
  }
  if (face.randomForestCompatible !== true && face.random_forest_compatible !== true) {
    throw new PredictionUnavailableError(
      'Face, pose, or hand monitoring was incomplete for this session.',
      'WEBCAM_SUMMARY_INCOMPLETE',
    );
  }

  const durationMinutes = (end.getTime() - start.getTime()) / 60_000;
  const featureValues = {
    browser_start_count: startCount,
    browser_end_count: endCount,
    browser_tab_switched_count: countActivities(activities, 'tab_switch'),
    browser_screenshot_count: countActivities(activities, 'screenshot'),
    browser_exam_duration_minutes: durationMinutes,
    webcam_face_present: finiteNumber(face.final_face_present, 'Final face-presence value'),
    webcam_no_of_face: finiteNumber(face.maximum_face_count, 'Face count'),
    webcam_face_conf: finiteNumber(face.average_tracking_confidence, 'Face confidence') * 100,
    webcam_hand_count: finiteNumber(face.maximum_hand_count, 'Hand count'),
    webcam_head_pitch: finiteNumber(face.average_head_pitch_degrees, 'Head pitch') * DEG_TO_RAD,
    webcam_head_yaw: finiteNumber(face.average_head_yaw_degrees, 'Head yaw') * DEG_TO_RAD,
    webcam_head_roll: finiteNumber(face.average_head_roll_degrees, 'Head roll') * DEG_TO_RAD,
  };

  const ordered = {};
  for (const column of FEATURE_COLUMNS) {
    const value = featureValues[column];
    if (!Number.isFinite(value)) {
      throw new PredictionUnavailableError(`${column} is missing or invalid.`);
    }
    ordered[column] = roundFeature(value);
  }
  return ordered;
}

module.exports = {
  FEATURE_COLUMNS,
  FEATURE_CONTRACT_VERSION,
  PredictionUnavailableError,
  aggregateSessionFeatures,
};


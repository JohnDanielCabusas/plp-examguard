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

// Missing sensors must not make an otherwise completed examination impossible to
// classify. These are medians from the non-suspicious class in the version 1.0.0
// training set. They represent an ordinary observation, while every feature that
// was actually recorded continues to take precedence. Keeping the policy explicit
// also prevents an absent webcam summary from being interpreted as "no face".
const NEUTRAL_FEATURE_DEFAULTS = Object.freeze({
  browser_start_count: 1,
  browser_end_count: 1,
  browser_tab_switched_count: 0,
  browser_screenshot_count: 0,
  browser_exam_duration_minutes: 18.48,
  webcam_face_present: 1,
  webcam_no_of_face: 1,
  webcam_face_conf: 91.5844,
  webcam_hand_count: 0,
  webcam_head_pitch: 0.005361,
  webcam_head_yaw: 0.002756,
  webcam_head_roll: 0.000073,
});

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

function optionalFiniteNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function countActivities(activities, type) {
  return activities.filter((activity) => String(activity?.type || '') === type).length;
}

function roundFeature(value) {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function aggregateSessionFeatureSnapshot(session, configuredDefaults = NEUTRAL_FEATURE_DEFAULTS) {
  if (!session || session.submitted !== true) {
    throw new PredictionUnavailableError('The examination session is not completed.', 'SESSION_NOT_COMPLETED');
  }

  const defaults = { ...NEUTRAL_FEATURE_DEFAULTS, ...(configuredDefaults || {}) };
  FEATURE_COLUMNS.forEach((column) => finiteNumber(defaults[column], `Neutral default for ${column}`));

  const start = new Date(session.start_time || session.startTime || '');
  const end = new Date(session.end_time || session.endTime || '');
  const activities = Array.isArray(session.activities) ? session.activities : [];
  const startCount = countActivities(activities, 'browser_exam_start');
  const endCount = countActivities(activities, 'browser_exam_end');
  const detections = session.ai_detections || session.aiDetections || {};
  const face = detections.faceMonitoring && typeof detections.faceMonitoring === 'object'
    ? detections.faceMonitoring
    : null;
  const imputedFeatures = [];
  const useRecordedOrDefault = (column, rawValue, recorded = true, transform = value => value) => {
    const numeric = recorded ? optionalFiniteNumber(rawValue) : null;
    if (numeric !== null) return transform(numeric);
    imputedFeatures.push(column);
    return defaults[column];
  };
  const hasSamples = (field) => {
    if (!face) return false;
    if (!Object.prototype.hasOwnProperty.call(face, field)) return true;
    return Number(face[field]) > 0;
  };
  const hasValidDuration = Number.isFinite(start.getTime())
    && Number.isFinite(end.getTime())
    && end >= start;

  const featureValues = {
    browser_start_count: useRecordedOrDefault('browser_start_count', startCount, startCount > 0),
    browser_end_count: useRecordedOrDefault('browser_end_count', endCount, endCount > 0),
    browser_tab_switched_count: useRecordedOrDefault(
      'browser_tab_switched_count',
      countActivities(activities, 'tab_switch'),
      Array.isArray(session.activities),
    ),
    browser_screenshot_count: useRecordedOrDefault(
      'browser_screenshot_count',
      countActivities(activities, 'screenshot'),
      Array.isArray(session.activities),
    ),
    browser_exam_duration_minutes: useRecordedOrDefault(
      'browser_exam_duration_minutes',
      hasValidDuration ? (end.getTime() - start.getTime()) / 60_000 : null,
      hasValidDuration,
    ),
    webcam_face_present: useRecordedOrDefault(
      'webcam_face_present', face?.final_face_present, hasSamples('observation_count'),
    ),
    webcam_no_of_face: useRecordedOrDefault(
      'webcam_no_of_face', face?.maximum_face_count, hasSamples('observation_count'),
    ),
    webcam_face_conf: useRecordedOrDefault(
      'webcam_face_conf', face?.average_tracking_confidence, hasSamples('tracking_sample_count'), value => value * 100,
    ),
    webcam_hand_count: useRecordedOrDefault(
      'webcam_hand_count', face?.maximum_hand_count, hasSamples('hand_sample_count'),
    ),
    webcam_head_pitch: useRecordedOrDefault(
      'webcam_head_pitch', face?.average_head_pitch_degrees, hasSamples('pose_sample_count'), value => value * DEG_TO_RAD,
    ),
    webcam_head_yaw: useRecordedOrDefault(
      'webcam_head_yaw', face?.average_head_yaw_degrees, hasSamples('pose_sample_count'), value => value * DEG_TO_RAD,
    ),
    webcam_head_roll: useRecordedOrDefault(
      'webcam_head_roll', face?.average_head_roll_degrees, hasSamples('pose_sample_count'), value => value * DEG_TO_RAD,
    ),
  };

  const ordered = {};
  for (const column of FEATURE_COLUMNS) {
    const value = featureValues[column];
    if (!Number.isFinite(value)) {
      throw new PredictionUnavailableError(`${column} is missing or invalid.`);
    }
    ordered[column] = roundFeature(value);
  }
  return { features: ordered, imputedFeatures };
}

function aggregateSessionFeatures(session, configuredDefaults) {
  return aggregateSessionFeatureSnapshot(session, configuredDefaults).features;
}

module.exports = {
  FEATURE_COLUMNS,
  FEATURE_CONTRACT_VERSION,
  NEUTRAL_FEATURE_DEFAULTS,
  PredictionUnavailableError,
  aggregateSessionFeatureSnapshot,
  aggregateSessionFeatures,
};

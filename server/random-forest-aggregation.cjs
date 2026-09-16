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

// Only events that are raised by the in-exam rule engine belong in a
// suspicion calculation. Session lifecycle records (start/end, timeout,
// pre-exam calibration, consent, connectivity, etc.) are deliberately absent.
const RULE_VIOLATION_TYPES = Object.freeze(new Set([
  'window_blur',
  'tab_switch',
  'fullscreen_exit',
  'screenshot',
  'no_person',
  'multiple_people',
  'look_down',
  'low_brightness',
  'camera_off',
  'restricted_phone',
  'secondary_computer',
  'restricted_book',
  'FACE_ABSENT',
  'FACE_PARTIALLY_VISIBLE',
  'FACE_TOO_CLOSE',
  'FACE_TOO_FAR',
  'FACE_NEAR_FRAME_EDGE',
  'SUSTAINED_HEAD_TURN',
  'SUSTAINED_LOOKING_DOWN',
  'REPEATED_LOOKING_AWAY',
  'FACE_OCCLUDED',
  'FACE_TRACKING_UNSTABLE',
  'PHONE_NEAR_OR_COVERING_FACE',
]));

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

function isRuleViolationEvent(event) {
  if (!event || event.dismissed === true || event.reviewStatus === 'dismissed') return false;
  const type = String(event.violation_type || event.violationType || event.type || '').trim();
  const metadata = event.detection_metadata || event.detectionMetadata || event.metadata || {};
  return RULE_VIOLATION_TYPES.has(type) || metadata.countsAsWarning === true;
}

function collectRuleViolationEvents(session, recordedEvents = []) {
  const databaseEvents = Array.isArray(recordedEvents) ? recordedEvents : [];
  // Once the append-only violation feed contains rows for the session it is
  // authoritative, including professor dismissals. Activities are retained as
  // a fallback for older/offline attempts whose live event could not sync.
  const source = databaseEvents.length
    ? databaseEvents
    : (Array.isArray(session?.activities) ? session.activities : []);
  return source.filter(isRuleViolationEvent);
}

// Build the legacy model's fixed feature shape from confirmed rule records.
// Neutral training medians fill every non-violation field, meaning elapsed
// time, normal start/end checks, and raw pre-exam sensor checks cannot move the
// probability. Only a persisted, non-dismissed rule event changes a feature.
function aggregateViolationFeatureSnapshot(session, recordedEvents = [], configuredDefaults = NEUTRAL_FEATURE_DEFAULTS) {
  if (!session || session.submitted !== true) {
    throw new PredictionUnavailableError('The examination session is not completed.', 'SESSION_NOT_COMPLETED');
  }
  const defaults = { ...NEUTRAL_FEATURE_DEFAULTS, ...(configuredDefaults || {}) };
  FEATURE_COLUMNS.forEach((column) => finiteNumber(defaults[column], `Neutral default for ${column}`));

  const violations = collectRuleViolationEvents(session, recordedEvents);
  const types = violations.map(event => String(event.violation_type || event.violationType || event.type || '').trim());
  const typeCount = type => types.filter(value => value === type).length;
  const countAny = candidates => types.filter(value => candidates.has(value)).length;
  const focusTypes = new Set(['window_blur', 'tab_switch', 'fullscreen_exit']);
  const noFaceTypes = new Set(['no_person', 'camera_off', 'FACE_ABSENT', 'FACE_OCCLUDED']);
  const multiFaceTypes = new Set(['multiple_people']);
  const pitchTypes = new Set(['look_down', 'SUSTAINED_LOOKING_DOWN']);
  const yawTypes = new Set(['SUSTAINED_HEAD_TURN', 'REPEATED_LOOKING_AWAY']);
  const handOrObjectTypes = new Set(['restricted_phone', 'secondary_computer', 'restricted_book', 'PHONE_NEAR_OR_COVERING_FACE']);

  const features = { ...defaults };
  features.browser_tab_switched_count = Math.min(5, countAny(focusTypes));
  features.browser_screenshot_count = Math.min(1, typeCount('screenshot'));
  if (countAny(noFaceTypes) > 0) {
    features.webcam_face_present = 0;
    features.webcam_no_of_face = 0;
    features.webcam_face_conf = 0;
  }
  if (countAny(multiFaceTypes) > 0) features.webcam_no_of_face = 2;
  if (countAny(pitchTypes) > 0) features.webcam_head_pitch = 0.30996;
  if (countAny(yawTypes) > 0) features.webcam_head_yaw = 0.74048;
  if (countAny(handOrObjectTypes) > 0) features.webcam_hand_count = 3;

  const ordered = {};
  FEATURE_COLUMNS.forEach(column => { ordered[column] = roundFeature(Number(features[column])); });
  return { features: ordered, violations, violationCount: violations.length };
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
  RULE_VIOLATION_TYPES,
  PredictionUnavailableError,
  aggregateSessionFeatureSnapshot,
  aggregateSessionFeatures,
  aggregateViolationFeatureSnapshot,
  collectRuleViolationEvents,
  isRuleViolationEvent,
};

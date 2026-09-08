const RAD_TO_DEG = 180 / Math.PI;

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function point(landmarks, index) {
  const value = landmarks?.[index];
  if (!value || !Number.isFinite(value.x) || !Number.isFinite(value.y)) return null;
  return value;
}

export function eulerFromTransformationMatrix(matrix) {
  const data = matrix?.data;
  const columns = Number(matrix?.columns || 4);
  if (!data || data.length < 11 || columns < 3) return null;

  const r00 = Number(data[0]);
  const r10 = Number(data[columns]);
  const r20 = Number(data[columns * 2]);
  const r21 = Number(data[(columns * 2) + 1]);
  const r22 = Number(data[(columns * 2) + 2]);
  if (![r00, r10, r20, r21, r22].every(Number.isFinite)) return null;

  const yaw = Math.asin(clamp(-r20, -1, 1));
  const cosYaw = Math.cos(yaw);
  const pitch = Math.abs(cosYaw) > 1e-6
    ? Math.atan2(r21, r22)
    : 0;
  const roll = Math.abs(cosYaw) > 1e-6
    ? Math.atan2(r10, r00)
    : 0;

  return {
    yaw: yaw * RAD_TO_DEG,
    pitch: pitch * RAD_TO_DEG,
    roll: roll * RAD_TO_DEG,
    method: 'transformation-matrix',
  };
}

export function estimateEulerFromLandmarks(landmarks) {
  const leftEye = point(landmarks, 33);
  const rightEye = point(landmarks, 263);
  const nose = point(landmarks, 1);
  const forehead = point(landmarks, 10);
  const chin = point(landmarks, 152);
  if (!leftEye || !rightEye || !nose || !forehead || !chin) return null;

  const eyeMidX = (leftEye.x + rightEye.x) / 2;
  const eyeMidY = (leftEye.y + rightEye.y) / 2;
  const eyeSpan = Math.max(0.001, Math.hypot(rightEye.x - leftEye.x, rightEye.y - leftEye.y));
  const faceHeight = Math.max(0.001, Math.hypot(chin.x - forehead.x, chin.y - forehead.y));
  const yaw = clamp(((nose.x - eyeMidX) / eyeSpan) * 75, -60, 60);
  const normalizedNoseDrop = (nose.y - eyeMidY) / faceHeight;
  // Match the transformation-matrix camera convention used above: upward
  // movement is positive before relativePose applies the UI direction sign.
  const pitch = clamp((0.19 - normalizedNoseDrop) * 115, -50, 50);
  const roll = Math.atan2(rightEye.y - leftEye.y, rightEye.x - leftEye.x) * RAD_TO_DEG;

  return { yaw, pitch, roll, method: 'landmark-fallback' };
}

export function estimateHeadPose(result) {
  return eulerFromTransformationMatrix(result?.facialTransformationMatrixes?.[0])
    || estimateEulerFromLandmarks(result?.faceLandmarks?.[0]);
}

export function smoothHeadPose(previous, current, baseAlpha = 0.5) {
  if (!current) return null;
  if (!previous) return { ...current };

  const minimumAlpha = clamp(Number(baseAlpha) || 0.5, 0.2, 1);
  const largestChange = Math.max(
    Math.abs(Number(current.yaw || 0) - Number(previous.yaw || 0)),
    Math.abs(Number(current.pitch || 0) - Number(previous.pitch || 0)),
    Math.abs(Number(current.roll || 0) - Number(previous.roll || 0)),
  );
  // Small landmark jitter is smoothed, while an intentional turn gets close
  // to the current sample immediately so the countdown does not feel delayed.
  const alpha = clamp(minimumAlpha + (largestChange / 90), minimumAlpha, 0.9);
  const blend = key => Number(previous[key] || 0)
    + ((Number(current[key] || 0) - Number(previous[key] || 0)) * alpha);
  return {
    yaw: blend('yaw'),
    pitch: blend('pitch'),
    roll: blend('roll'),
    method: current.method || previous.method || 'unknown',
  };
}

export function relativePose(pose, baseline, poseConfig = {}) {
  if (!pose || !baseline) return null;
  const yawMultiplier = Number(poseConfig.yawDirectionMultiplier || 1);
  const pitchMultiplier = Number(poseConfig.pitchDirectionMultiplier || 1);
  return {
    yaw: (Number(pose.yaw) - Number(baseline.baselineYaw)) * yawMultiplier,
    pitch: (Number(pose.pitch) - Number(baseline.baselinePitch)) * pitchMultiplier,
    roll: Number(pose.roll) - Number(baseline.baselineRoll),
    method: pose.method || 'unknown',
  };
}

export function classifyHeadDirection(relative, poseConfig) {
  if (!relative) return 'HEAD_CENTER';
  const candidates = [];
  const addCandidate = (direction, value, threshold) => {
    const magnitude = Math.max(1, Math.abs(Number(threshold)));
    candidates.push({ direction, score: Math.abs(Number(value)) / magnitude });
  };
  if (relative.yaw <= poseConfig.leftYawDegrees) {
    addCandidate('HEAD_LEFT', relative.yaw, poseConfig.leftYawDegrees);
  }
  if (relative.yaw >= poseConfig.rightYawDegrees) {
    addCandidate('HEAD_RIGHT', relative.yaw, poseConfig.rightYawDegrees);
  }
  if (relative.pitch <= poseConfig.upPitchDegrees) {
    addCandidate('HEAD_UP', relative.pitch, poseConfig.upPitchDegrees);
  }
  if (relative.pitch >= poseConfig.downPitchDegrees) {
    addCandidate('HEAD_DOWN', relative.pitch, poseConfig.downPitchDegrees);
  }
  return candidates.reduce(
    (strongest, candidate) => candidate.score > strongest.score ? candidate : strongest,
    { direction: 'HEAD_CENTER', score: 0 },
  ).direction;
}

export function classifyFaceObservation(observation, baseline, config) {
  const relative = relativePose(observation?.pose, baseline, config.pose);
  const facePresent = observation?.facePresent === true;
  return {
    ...observation,
    facePresent,
    relativePose: relative,
    headDirection: facePresent ? classifyHeadDirection(relative, config.pose) : null,
  };
}

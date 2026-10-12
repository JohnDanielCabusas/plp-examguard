// Per-frame signals that tell a living face from a picture of one.
//
// Face Landmarker happily finds a face in a printed photo or on a phone screen
// held up to the webcam, and the head-pose rules then see a perfectly attentive
// student. Two cues are measured here and shipped with every observation:
//
// 1. Expression scores (blink, jaw, brows, mouth) from the model's blendshape
//    head. A picture holds every one of them constant.
// 2. Non-rigid motion: how much the landmarks changed shape since a frame about
//    a second earlier, after the motion a flat picture can produce (shifting,
//    turning, tilting, moving closer) has been fitted out. What is left over is
//    the face changing shape — a blink, the mouth, an eyebrow, the nose moving
//    against the cheeks as the head turns — which a picture cannot do.
//
// Neither cue is judged here. The liveness monitor decides over a long window.

// The blendshape categories worth keeping. The full set is 52 values; shipping
// all of them per frame is pointless for a policy that reads these few.
const BLENDSHAPE_KEYS = Object.freeze([
  'eyeBlinkLeft',
  'eyeBlinkRight',
  'jawOpen',
  'mouthSmileLeft',
  'mouthSmileRight',
  'mouthPucker',
  'mouthFunnel',
  'browInnerUp',
]);

const LEFT_EYE_OUTER = 33;
const RIGHT_EYE_OUTER = 263;

export function extractBlendshapes(classifications) {
  const categories = classifications?.categories;
  if (!Array.isArray(categories) || !categories.length) return null;
  const result = {};
  let found = 0;
  for (const category of categories) {
    const name = category?.categoryName;
    if (!BLENDSHAPE_KEYS.includes(name)) continue;
    const score = Number(category.score);
    if (!Number.isFinite(score)) continue;
    result[name] = Math.round(score * 1000) / 1000;
    found += 1;
  }
  return found ? result : null;
}

// Least-squares affine fit from `reference` onto `current`: x' = a·x + b·y + c
// and y' = d·x + e·y + f. Points are centred first so the normal equations stay
// well conditioned for coordinates that live in 0..1.
function fitAffine(reference, current) {
  const count = reference.length;
  if (count < 6) return null;
  let meanU = 0; let meanV = 0; let meanX = 0; let meanY = 0;
  for (let index = 0; index < count; index += 1) {
    meanU += reference[index].x; meanV += reference[index].y;
    meanX += current[index].x; meanY += current[index].y;
  }
  meanU /= count; meanV /= count; meanX /= count; meanY /= count;

  let suu = 0; let suv = 0; let svv = 0;
  let sux = 0; let svx = 0; let suy = 0; let svy = 0;
  for (let index = 0; index < count; index += 1) {
    const u = reference[index].x - meanU;
    const v = reference[index].y - meanV;
    const x = current[index].x - meanX;
    const y = current[index].y - meanY;
    suu += u * u; suv += u * v; svv += v * v;
    sux += u * x; svx += v * x; suy += u * y; svy += v * y;
  }
  const determinant = (suu * svv) - (suv * suv);
  if (!(Math.abs(determinant) > 1e-12)) return null;
  const a = ((sux * svv) - (svx * suv)) / determinant;
  const b = ((svx * suu) - (sux * suv)) / determinant;
  const d = ((suy * svv) - (svy * suv)) / determinant;
  const e = ((svy * suu) - (suy * suv)) / determinant;
  return {
    a, b, d, e,
    c: meanX - (a * meanU) - (b * meanV),
    f: meanY - (d * meanU) - (e * meanV),
  };
}

export function nonRigidResidual(reference, current, options = {}) {
  if (!Array.isArray(reference) || !Array.isArray(current)) return null;
  const count = Math.min(reference.length, current.length);
  if (count < 6) return null;
  const transform = fitAffine(reference.slice(0, count), current.slice(0, count));
  if (!transform) return null;

  const leftEye = current[LEFT_EYE_OUTER];
  const rightEye = current[RIGHT_EYE_OUTER];
  const scale = leftEye && rightEye
    ? Math.hypot(rightEye.x - leftEye.x, rightEye.y - leftEye.y)
    : Number(options.scale);
  if (!(scale > 1e-4)) return null;

  const residuals = new Array(count);
  for (let index = 0; index < count; index += 1) {
    const source = reference[index];
    const target = current[index];
    const predictedX = (transform.a * source.x) + (transform.b * source.y) + transform.c;
    const predictedY = (transform.d * source.x) + (transform.e * source.y) + transform.f;
    residuals[index] = Math.hypot(target.x - predictedX, target.y - predictedY) / scale;
  }
  // The mean over every point would dilute a blink (thirty-odd eyelid points out
  // of nearly five hundred) into the noise floor, so the score is the mean of the
  // most-moved tenth: large enough to ignore a single jittery point, small
  // enough to register a localised change of shape.
  residuals.sort((left, right) => right - left);
  const topCount = Math.max(1, Math.ceil(count * Number(options.topFraction || 0.1)));
  let total = 0;
  for (let index = 0; index < topCount; index += 1) total += residuals[index];
  return total / topCount;
}

function snapshotPoints(landmarks) {
  const points = new Array(landmarks.length);
  for (let index = 0; index < landmarks.length; index += 1) {
    const value = landmarks[index];
    points[index] = { x: Number(value?.x), y: Number(value?.y) };
    if (!Number.isFinite(points[index].x) || !Number.isFinite(points[index].y)) return null;
  }
  return points;
}

// Compares each frame with one roughly `referenceAgeMs` earlier. A single
// frame-to-frame step is too small to separate a blink from landmark jitter.
export function createNonRigidMotionMeter(options = {}) {
  const referenceAgeMs = Number(options.referenceAgeMs) > 0 ? Number(options.referenceAgeMs) : 700;
  const maximumAgeMs = Math.max(referenceAgeMs * 3, Number(options.maximumAgeMs) || 0);
  let history = [];

  return {
    reset() {
      history = [];
    },
    measure(landmarks, timestampMs) {
      const now = Number(timestampMs);
      if (!Number.isFinite(now) || !Array.isArray(landmarks) || !landmarks.length) {
        history = [];
        return null;
      }
      const points = snapshotPoints(landmarks);
      if (!points) {
        history = [];
        return null;
      }
      history = history.filter(entry => now - entry.at <= maximumAgeMs && entry.at < now);
      // The oldest frame that is at least the reference age away — the one whose
      // comparison says the most about what changed.
      const reference = history.find(entry => now - entry.at >= referenceAgeMs) || null;
      history.push({ at: now, points });
      if (!reference) return null;
      const residual = nonRigidResidual(reference.points, points);
      return residual === null ? null : Math.round(residual * 10000) / 10000;
    },
  };
}

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

// Centre a point set and scale it to an average distance of √2 from the
// origin, so the projective fit below stays well conditioned.
function normalizer(points) {
  let meanX = 0; let meanY = 0;
  for (const point of points) { meanX += point.x; meanY += point.y; }
  meanX /= points.length; meanY /= points.length;
  let spread = 0;
  for (const point of points) spread += Math.hypot(point.x - meanX, point.y - meanY);
  spread /= points.length;
  if (!(spread > 1e-9)) return null;
  return { meanX, meanY, scale: Math.SQRT2 / spread };
}

// Solves the n×n system in place by Gaussian elimination with partial pivoting.
function solveLinear(matrix, vector) {
  const size = vector.length;
  for (let column = 0; column < size; column += 1) {
    let pivot = column;
    for (let row = column + 1; row < size; row += 1) {
      if (Math.abs(matrix[row][column]) > Math.abs(matrix[pivot][column])) pivot = row;
    }
    if (!(Math.abs(matrix[pivot][column]) > 1e-12)) return null;
    [matrix[column], matrix[pivot]] = [matrix[pivot], matrix[column]];
    [vector[column], vector[pivot]] = [vector[pivot], vector[column]];
    for (let row = column + 1; row < size; row += 1) {
      const factor = matrix[row][column] / matrix[column][column];
      if (!factor) continue;
      for (let k = column; k < size; k += 1) matrix[row][k] -= factor * matrix[column][k];
      vector[row] -= factor * vector[column];
    }
  }
  const solution = new Array(size);
  for (let row = size - 1; row >= 0; row -= 1) {
    let total = vector[row];
    for (let k = row + 1; k < size; k += 1) total -= matrix[row][k] * solution[k];
    solution[row] = total / matrix[row][row];
  }
  return solution.every(Number.isFinite) ? solution : null;
}

// Least-squares homography from `reference` onto `current`. A flat picture
// tilted towards or away from the camera is foreshortened in perspective,
// which an affine map cannot express: the leftover read as the face changing
// shape, so a hand-held photo earned "signs of life". A homography is exactly
// the set of images a flat picture can make, so it fits every one of them out.
function fitHomography(reference, current) {
  const count = reference.length;
  if (count < 6) return null;
  const from = normalizer(reference);
  const to = normalizer(current);
  if (!from || !to) return null;
  const normal = Array.from({ length: 8 }, () => new Array(8).fill(0));
  const rhs = new Array(8).fill(0);
  const accumulate = (row, target) => {
    for (let i = 0; i < 8; i += 1) {
      if (!row[i]) continue;
      rhs[i] += row[i] * target;
      for (let j = 0; j < 8; j += 1) normal[i][j] += row[i] * row[j];
    }
  };
  for (let index = 0; index < count; index += 1) {
    const u = (reference[index].x - from.meanX) * from.scale;
    const v = (reference[index].y - from.meanY) * from.scale;
    const x = (current[index].x - to.meanX) * to.scale;
    const y = (current[index].y - to.meanY) * to.scale;
    accumulate([u, v, 1, 0, 0, 0, -u * x, -v * x], x);
    accumulate([0, 0, 0, u, v, 1, -u * y, -v * y], y);
  }
  const h = solveLinear(normal, rhs);
  if (!h) return null;
  return {
    apply(point) {
      const u = (point.x - from.meanX) * from.scale;
      const v = (point.y - from.meanY) * from.scale;
      const w = (h[6] * u) + (h[7] * v) + 1;
      if (!(Math.abs(w) > 1e-9)) return null;
      return {
        x: ((((h[0] * u) + (h[1] * v) + h[2]) / w) / to.scale) + to.meanX,
        y: ((((h[3] * u) + (h[4] * v) + h[5]) / w) / to.scale) + to.meanY,
      };
    },
  };
}

function affineMapper(transform) {
  return {
    apply: point => ({
      x: (transform.a * point.x) + (transform.b * point.y) + transform.c,
      y: (transform.d * point.x) + (transform.e * point.y) + transform.f,
    }),
  };
}

export function nonRigidResidual(reference, current, options = {}) {
  if (!Array.isArray(reference) || !Array.isArray(current)) return null;
  const count = Math.min(reference.length, current.length);
  if (count < 6) return null;
  const source = reference.slice(0, count);
  const target = current.slice(0, count);
  let transform = fitHomography(source, target);
  if (!transform) {
    const affine = fitAffine(source, target);
    transform = affine ? affineMapper(affine) : null;
  }
  if (!transform) return null;

  const leftEye = current[LEFT_EYE_OUTER];
  const rightEye = current[RIGHT_EYE_OUTER];
  const scale = leftEye && rightEye
    ? Math.hypot(rightEye.x - leftEye.x, rightEye.y - leftEye.y)
    : Number(options.scale);
  if (!(scale > 1e-4)) return null;

  const residuals = new Array(count);
  for (let index = 0; index < count; index += 1) {
    const predicted = transform.apply(source[index]);
    if (!predicted) return null;
    residuals[index] = Math.hypot(target[index].x - predicted.x, target[index].y - predicted.y) / scale;
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

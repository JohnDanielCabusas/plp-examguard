// How steady the landmarks are from one frame to the next, as a 0..1 score.
//
// The score is the frame-to-frame movement of a few anchor landmarks, measured
// in face widths so that it does not change with distance from the camera. It
// was written for a 10 fps scan. On a laptop that falls back to the CPU model,
// frames can be half a second or more apart, and in that time a perfectly still
// student's landmarks drift further than they do in a tenth of a second — so the
// same steady face scored as "unstable", the scan paused on it, and the bar sat
// still. The movement is therefore scaled to the cadence the thresholds were
// tuned for before it is scored.
const TRACKED_LANDMARKS = [1, 10, 33, 61, 152, 263, 291];

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function createTrackingQualityMeter(options = {}) {
  const decay = Number(options.decay) > 0 ? Number(options.decay) : 18;
  // Frames further apart than four times the expected interval are not given
  // any more credit: past that the gap says the pipeline stalled, not that the
  // student moved.
  const minimumScale = Number(options.minimumScale) > 0 ? Number(options.minimumScale) : 0.25;
  let lastPoints = null;
  let lastTimestampMs = null;

  return {
    reset() {
      lastPoints = null;
      lastTimestampMs = null;
    },
    measure(landmarks, geometry, timestampMs = null, expectedIntervalMs = null) {
      const points = TRACKED_LANDMARKS.map(index => landmarks?.[index]).filter(Boolean);
      if (points.length !== TRACKED_LANDMARKS.length || !geometry?.width || !geometry?.height) {
        lastPoints = null;
        lastTimestampMs = null;
        return 0;
      }
      const normalized = points.map(value => ({
        x: (value.x - geometry.centerX) / geometry.width,
        y: (value.y - geometry.centerY) / geometry.height,
      }));
      const now = Number(timestampMs);
      const previousAt = lastTimestampMs;
      lastTimestampMs = Number.isFinite(now) ? now : null;
      if (!lastPoints) {
        lastPoints = normalized;
        return 1;
      }
      const meanSquared = normalized.reduce((sum, value, index) => {
        const previous = lastPoints[index];
        return sum + ((value.x - previous.x) ** 2) + ((value.y - previous.y) ** 2);
      }, 0) / normalized.length;
      lastPoints = normalized;

      let movement = Math.sqrt(meanSquared);
      const elapsedMs = Number.isFinite(now) && Number.isFinite(previousAt) ? now - previousAt : NaN;
      const interval = Number(expectedIntervalMs);
      if (elapsedMs > 0 && interval > 0 && elapsedMs > interval) {
        movement *= clamp(interval / elapsedMs, minimumScale, 1);
      }
      return clamp(Math.exp(-movement * decay), 0, 1);
    },
  };
}

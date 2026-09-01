// Regression test for the YOLO worker's raw-output parsing, specifically the
// negative-class suppression that keeps desk objects (e.g. a mouse) from
// being reported as a mobile phone. Runs in Node against the real manifest,
// bypassing the browser-only bits (OffscreenCanvas, onnxruntime-web) by
// feeding a synthetic model output tensor straight into parseOutput().
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

// The worker script executes `self.addEventListener(...)` at module load
// time, so a minimal stand-in for the Worker global scope must exist before
// it is imported in Node.
globalThis.self ??= { addEventListener: () => {}, postMessage: () => {}, navigator: {} };

const { parseOutput, __setManifestForTesting } = await import(
  '../src/lib/proctoring/yolo/yoloWorker.js'
);

const manifest = JSON.parse(
  await readFile(resolve('public/models/yolo-proctor-v1.json'), 'utf8'),
);
__setManifestForTesting(manifest);

const classNames = manifest.classNames;
const mouseIndex = classNames.indexOf('mouse');
const cellPhoneIndex = classNames.indexOf('cell phone');
assert.ok(mouseIndex >= 0 && cellPhoneIndex >= 0, 'Fixture manifest must include mouse and cell phone.');

const anchors = 4;
const channels = classNames.length + 4;
const data = new Float32Array(channels * anchors);

function setBox(anchor, { centerX, centerY, width, height }) {
  data[(0 * anchors) + anchor] = centerX;
  data[(1 * anchors) + anchor] = centerY;
  data[(2 * anchors) + anchor] = width;
  data[(3 * anchors) + anchor] = height;
}

function setClassScore(anchor, classIndex, score) {
  data[((classIndex + 4) * anchors) + anchor] = score;
}

// Anchor 0: a mouse that the raw detector confidently mis-scores as a phone
// at its own box. This is the exact bug report — must resolve to "mouse".
setBox(0, { centerX: 100, centerY: 100, width: 40, height: 60 });
setClassScore(0, cellPhoneIndex, 0.55);
setClassScore(0, mouseIndex, 0.20);

// Anchor 1: a genuine phone, far from anything else, negligible mouse
// signal. Must still confirm as a phone — the fix must not blanket-suppress.
setBox(1, { centerX: 300, centerY: 300, width: 50, height: 90 });
setClassScore(1, cellPhoneIndex, 0.5);
setClassScore(1, mouseIndex, 0.05);

// Anchors 2 and 3: two different anchors landing on the *same* physical box
// — one calls it a phone without enough same-anchor mouse signal to trip the
// primary check, the other independently and confidently calls it a mouse.
// This exercises the cross-box IoU suppression (suppressNegativeMatches) as
// the second line of defense.
const sharedBox = { centerX: 500, centerY: 500, width: 60, height: 100 };
setBox(2, sharedBox);
setClassScore(2, cellPhoneIndex, 0.45);
setClassScore(2, mouseIndex, 0.05);
setBox(3, sharedBox);
setClassScore(3, mouseIndex, 0.6);

const output = { dims: [1, channels, anchors], data };
const transform = {
  regionX: 0,
  regionY: 0,
  regionWidth: 640,
  regionHeight: 640,
  padX: 0,
  padY: 0,
  scale: 1,
  sourceWidth: 640,
  sourceHeight: 640,
};

const detections = parseOutput(output, transform);

const phoneDetections = detections.filter(detection => detection.objectClass === 'mobile_phone');
assert.equal(
  phoneDetections.length,
  1,
  `Expected exactly one surviving phone detection (the genuine one), got ${phoneDetections.length}.`,
);
assert.ok(
  Math.abs(phoneDetections[0].boundingBox.x + (phoneDetections[0].boundingBox.width / 2) - 300) < 5,
  'The surviving phone detection must be the genuine anchor-1 phone, not a mouse false positive.',
);

const mouseDetections = detections.filter(detection => detection.negativeClass === 'mouse');
assert.equal(
  mouseDetections.length,
  2,
  'Expected the same-anchor override (anchor 0) and the native mouse call (anchor 3) to both survive as negatives.',
);
assert.ok(
  detections.every(detection => !(detection.rawClass === 'cell phone' && detection.boundingBox.x > 450)),
  'A phone call sharing a box with a confident mouse call must be suppressed, not just deduplicated by NMS.',
);

console.log('YOLO worker parsing tests passed.');

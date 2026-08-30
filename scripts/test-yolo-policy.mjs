import assert from 'node:assert/strict';
import {
  YoloObjectPolicy,
  normalizeObjectMonitoring,
} from '../src/lib/proctoring/yolo/objectPolicy.js';

function detection(objectClass, confidence = 0.9, boundingBox = null) {
  return {
    objectClass,
    rawClass: objectClass,
    confidence,
    fullFrameConfidence: confidence,
    verificationConfidence: confidence,
    verified: true,
    boundingBox: boundingBox || { x: 10, y: 12, width: 40, height: 60, frameWidth: 640, frameHeight: 480 },
  };
}

const normalized = normalizeObjectMonitoring({
  enabled: true,
  mode: 'enforce',
  allowBooks: true,
  legacySetting: true,
});
assert.deepEqual(normalized, {
  enabled: true,
  mode: 'enforce',
  allowSecondaryComputer: false,
  allowBooks: true,
});

const policy = new YoloObjectPolicy({ enabled: true, mode: 'enforce', calibrationMs: 0 });
let events = [];
events.push(...policy.evaluate(
  [detection('mobile_phone')],
  { now: 1000, modelVersion: 'test-v1', backend: 'wasm' },
));
assert.equal(events.length, 1, 'A very clear verified phone may use one-frame confirmation.');
events.push(...policy.evaluate([detection('mobile_phone')], { now: 2000, modelVersion: 'test-v1', backend: 'wasm' }));
assert.equal(events.length, 1);
assert.equal(events[0].violationType, 'restricted_phone');
assert.equal(events[0].policyDecision, 'warning');
assert.equal(events[0].modelVersion, 'test-v1');

events.push(...policy.evaluate([detection('mobile_phone')], { now: 3500 }));
assert.equal(events.length, 1, 'A continuously visible object must not emit duplicate events.');

policy.evaluate([], { now: 12000 });
const resetEvents = [];
resetEvents.push(...policy.evaluate([detection('mobile_phone')], { now: 13000 }));
assert.equal(resetEvents.length, 1, 'An object may emit again only after a confirmed absence.');

const authorizedPolicy = new YoloObjectPolicy({ enabled: true, mode: 'enforce', allowBooks: true, calibrationMs: 0 });
for (let index = 0; index < 6; index += 1) {
  assert.equal(
    authorizedPolicy.evaluate([detection('book_textbook')], { now: 1000 + (index * 1000) }).length,
    0,
    'Authorized books must not emit restricted-object events.',
  );
}

const shadowPolicy = new YoloObjectPolicy({ enabled: true, mode: 'shadow', calibrationMs: 0 });
let shadowEvents = [];
for (let index = 0; index < 2; index += 1) {
  shadowEvents = shadowEvents.concat(
    shadowPolicy.evaluate([detection('mobile_phone')], { now: 1000 + (index * 1000) }),
  );
}
assert.equal(shadowEvents[0].policyDecision, 'shadow');

const lowConfidencePolicy = new YoloObjectPolicy({ enabled: true, mode: 'alert', calibrationMs: 0 });
let lowConfidenceEvents = [];
for (let index = 0; index < 6; index += 1) {
  lowConfidenceEvents = lowConfidenceEvents.concat(
    lowConfidencePolicy.evaluate([detection('mobile_phone', 0.45)], { now: 1000 + (index * 700) }),
  );
}
assert.equal(lowConfidenceEvents.length, 0, 'Low-confidence phone candidates must not emit alerts.');

const movingPhonePolicy = new YoloObjectPolicy({ enabled: true, mode: 'enforce', calibrationMs: 0 });
let movingPhoneEvents = [];
for (let index = 0; index < 2; index += 1) {
  movingPhoneEvents = movingPhoneEvents.concat(
    movingPhonePolicy.evaluate([
      detection('mobile_phone', 0.35, {
        x: 210 + (index * 8),
        y: 170 + (index * 4),
        width: 82,
        height: 145,
        frameWidth: 640,
        frameHeight: 480,
      }),
    ], { now: 1000 + (index * 500) }),
  );
}
assert.equal(
  movingPhoneEvents.length,
  1,
  'A verified lower-confidence handheld phone must confirm after two moving scans.',
);

const unverifiedPolicy = new YoloObjectPolicy({ enabled: true, mode: 'enforce', calibrationMs: 0 });
const unverifiedDetection = { ...detection('mobile_phone', 0.9), verified: false };
let unverifiedEvents = [];
for (let index = 0; index < 5; index += 1) {
  unverifiedEvents = unverifiedEvents.concat(
    unverifiedPolicy.evaluate([unverifiedDetection], { now: 1000 + (index * 500) }),
  );
}
assert.equal(unverifiedEvents.length, 0, 'Unverified full-frame candidates must never emit warnings.');

const bookPolicy = new YoloObjectPolicy({ enabled: true, mode: 'enforce', calibrationMs: 0 });
let bookEvents = [];
for (let index = 0; index < 2; index += 1) {
  bookEvents = bookEvents.concat(
    bookPolicy.evaluate([detection('book_textbook', 0.55)], { now: 1000 + (index * 500) }),
  );
}
assert.equal(bookEvents.length, 1, 'A verified book must confirm after two scans.');
assert.equal(bookEvents[0].violationType, 'restricted_book');

const calibratedBookPolicy = new YoloObjectPolicy({ enabled: true, mode: 'enforce' });
const shelfBookBox = { x: 500, y: 80, width: 90, height: 160, frameWidth: 640, frameHeight: 480 };
for (let index = 0; index < 6; index += 1) {
  assert.equal(
    calibratedBookPolicy.evaluate(
      [detection('book_textbook', 0.7, shelfBookBox)],
      { now: 1000 + (index * 700) },
    ).length,
    0,
    'A stationary background book must not alert during calibration.',
  );
}
assert.equal(
  calibratedBookPolicy.evaluate([detection('book_textbook', 0.7, shelfBookBox)], { now: 6000 }).length,
  0,
  'A calibrated bookshelf region must remain non-violating.',
);
const heldBookBox = { x: 210, y: 180, width: 180, height: 220, frameWidth: 640, frameHeight: 480 };
calibratedBookPolicy.evaluate([detection('book_textbook', 0.7, heldBookBox)], { now: 6500 });
assert.equal(
  calibratedBookPolicy.evaluate([detection('book_textbook', 0.7, heldBookBox)], { now: 6900 }).length,
  1,
  'A book introduced outside the calibrated shelf region must still alert.',
);

const calibratedPolicy = new YoloObjectPolicy({ enabled: true, mode: 'alert' });
const staticFalsePositiveBox = { x: 467, y: 100, width: 156, height: 108, frameWidth: 640, frameHeight: 480 };
for (let index = 0; index < 6; index += 1) {
  assert.equal(
    calibratedPolicy.evaluate(
      [detection('mobile_phone', 0.65, staticFalsePositiveBox)],
      { now: 1000 + (index * 1000) },
    ).length,
    0,
    'Calibration must not emit alerts.',
  );
}
assert.equal(
  calibratedPolicy.evaluate([detection('mobile_phone', 0.65, staticFalsePositiveBox)], { now: 7000 }).length,
  0,
  'A persistent calibrated background region must be ignored.',
);

const stationaryShelfPolicy = new YoloObjectPolicy({ enabled: true, mode: 'alert', calibrationMs: 0 });
let stationaryShelfEvents = [];
for (let index = 0; index < 6; index += 1) {
  stationaryShelfEvents = stationaryShelfEvents.concat(
    stationaryShelfPolicy.evaluate(
      [detection('mobile_phone', 0.65, staticFalsePositiveBox)],
      { now: 1000 + (index * 500) },
    ),
  );
}
assert.equal(
  stationaryShelfEvents.length,
  0,
  'A stationary shelf-like candidate below the strong threshold must not emit an alert.',
);

const realPhoneBox = { x: 220, y: 180, width: 90, height: 150, frameWidth: 640, frameHeight: 480 };
let calibratedEvents = [];
for (let index = 0; index < 2; index += 1) {
  calibratedEvents = calibratedEvents.concat(
    calibratedPolicy.evaluate([detection('mobile_phone', 0.75, realPhoneBox)], { now: 8000 + (index * 1000) }),
  );
}
assert.equal(calibratedEvents.length, 1, 'A phone entering after calibration must still emit an alert.');

const fastPathPolicy = new YoloObjectPolicy({ enabled: true, mode: 'enforce' });
let fastPathEvents = [];
for (let index = 0; index < 1; index += 1) {
  fastPathEvents = fastPathEvents.concat(
    fastPathPolicy.evaluate([detection('mobile_phone', 0.8, realPhoneBox)], { now: 1000 + (index * 500) }),
  );
}
assert.equal(fastPathEvents.length, 1, 'A clear phone must confirm quickly during startup calibration.');
assert.equal(fastPathEvents[0].policyDecision, 'warning');

const phoneBackSpecialistPolicy = new YoloObjectPolicy({ enabled: true, mode: 'enforce', calibrationMs: 0 });
let phoneBackEvents = [];
for (let index = 0; index < 2; index += 1) {
  phoneBackEvents = phoneBackEvents.concat(
    phoneBackSpecialistPolicy.evaluate([
      {
        ...detection('mobile_phone', 0.35, {
          ...realPhoneBox,
          x: realPhoneBox.x + (index * 9),
        }),
        rawClass: 'mobile_phone',
        detectorRole: 'phone-specialist',
      },
    ], { now: 5000 + (index * 650), detectorRole: 'phone-specialist' }),
  );
}
assert.equal(
  phoneBackEvents.length,
  1,
  'A verified moving screen-away phone from the specialist must confirm after calibration.',
);
assert.equal(phoneBackEvents[0].detectorRole, 'phone-specialist');

const tiledPartialPhonePolicy = new YoloObjectPolicy({
  enabled: true,
  mode: 'enforce',
  calibrationMs: 0,
});
let tiledPartialPhoneEvents = [];
for (let index = 0; index < 2; index += 1) {
  tiledPartialPhoneEvents = tiledPartialPhoneEvents.concat(
    tiledPartialPhonePolicy.evaluate([
      {
        ...detection('mobile_phone', 0.36, {
          ...realPhoneBox,
          x: realPhoneBox.x + (index * 9),
          width: 42,
        }),
        rawClass: 'mobile_phone',
        detectorRole: 'phone-specialist',
      },
    ], { now: 5000 + (index * 1800), detectorRole: 'phone-specialist' }),
  );
}
assert.equal(
  tiledPartialPhoneEvents.length,
  1,
  'A partial phone revisited by rotating close-up scans must remain trackable.',
);

const stationaryPhoneBackPolicy = new YoloObjectPolicy({ enabled: true, mode: 'enforce', calibrationMs: 0 });
let stationaryPhoneBackEvents = [];
for (let index = 0; index < 6; index += 1) {
  stationaryPhoneBackEvents = stationaryPhoneBackEvents.concat(
    stationaryPhoneBackPolicy.evaluate([
      {
        ...detection('mobile_phone', 0.35, realPhoneBox),
        rawClass: 'mobile_phone',
        detectorRole: 'phone-specialist',
      },
    ], { now: 5000 + (index * 650), detectorRole: 'phone-specialist' }),
  );
}
assert.equal(
  stationaryPhoneBackEvents.length,
  0,
  'A stationary specialist candidate must not turn furniture into a phone warning.',
);

const furnitureCalibrationPolicy = new YoloObjectPolicy({ enabled: true, mode: 'enforce' });
const shelfBox = { x: 30, y: 30, width: 110, height: 80, frameWidth: 960, frameHeight: 720 };
for (let index = 0; index < 6; index += 1) {
  furnitureCalibrationPolicy.evaluate([
    {
      ...detection('mobile_phone', 0.82, shelfBox),
      rawClass: 'mobile_phone',
      detectorRole: 'phone-specialist',
    },
  ], { now: 1000 + (index * 650), detectorRole: 'phone-specialist' });
}
assert.equal(
  furnitureCalibrationPolicy.evaluate([
    {
      ...detection('mobile_phone', 0.82, shelfBox),
      rawClass: 'mobile_phone',
      detectorRole: 'phone-specialist',
    },
  ], { now: 6000, detectorRole: 'phone-specialist' }).length,
  0,
  'A stable shelf region learned by the specialist must remain non-violating.',
);

const remoteFallbackPolicy = new YoloObjectPolicy({ enabled: true, mode: 'enforce', calibrationMs: 0 });
const remotePhone = { ...detection('mobile_phone', 0.85, realPhoneBox), rawClass: 'remote' };
assert.equal(
  remoteFallbackPolicy.evaluate([remotePhone], { now: 1000 }).length,
  0,
  'The COCO remote fallback must never warn from a single frame.',
);
assert.equal(
  remoteFallbackPolicy.evaluate([
    { ...remotePhone, boundingBox: { ...realPhoneBox, x: realPhoneBox.x + 8 } },
  ], { now: 1300 }).length,
  1,
  'A verified moving remote-shaped phone must confirm after two frames.',
);

const remoteShelfPolicy = new YoloObjectPolicy({ enabled: true, mode: 'alert', calibrationMs: 0 });
let remoteShelfEvents = [];
for (let index = 0; index < 6; index += 1) {
  remoteShelfEvents = remoteShelfEvents.concat(
    remoteShelfPolicy.evaluate(
      [{ ...detection('mobile_phone', 0.65, staticFalsePositiveBox), rawClass: 'remote' }],
      { now: 1000 + (index * 500) },
    ),
  );
}
assert.equal(
  remoteShelfEvents.length,
  0,
  'A stationary remote-shaped shelf candidate must remain non-violating.',
);

const highConfidenceRemoteShelfPolicy = new YoloObjectPolicy({ enabled: true, mode: 'alert', calibrationMs: 0 });
let highConfidenceRemoteShelfEvents = [];
for (let index = 0; index < 4; index += 1) {
  highConfidenceRemoteShelfEvents = highConfidenceRemoteShelfEvents.concat(
    highConfidenceRemoteShelfPolicy.evaluate(
      [{ ...detection('mobile_phone', 0.9, staticFalsePositiveBox), rawClass: 'remote' }],
      { now: 1000 + (index * 500) },
    ),
  );
}
assert.equal(
  highConfidenceRemoteShelfEvents.length,
  0,
  'Even a high-confidence stationary remote-shaped shelf must not alert.',
);

console.log('YOLO object policy tests passed.');

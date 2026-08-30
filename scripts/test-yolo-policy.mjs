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
    boundingBox: boundingBox || { x: 210, y: 150, width: 90, height: 150, frameWidth: 640, frameHeight: 480 },
    ...(objectClass === 'mobile_phone' ? {
      humanContext: {
        available: true,
        personDetected: true,
        nearPerson: true,
        overlapRatio: 0.65,
        proximityRatio: 0,
      },
    } : {}),
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
assert.equal(events.length, 0, 'A single phone-shaped frame must not issue a violation.');
events.push(...policy.evaluate([detection('mobile_phone')], { now: 2000, modelVersion: 'test-v1', backend: 'wasm' }));
assert.equal(events.length, 1, 'A clear phone must confirm on a repeated frame.');
assert.equal(events[0].violationType, 'restricted_phone');
assert.equal(events[0].policyDecision, 'warning');
assert.equal(events[0].modelVersion, 'test-v1');

events.push(...policy.evaluate([detection('mobile_phone')], { now: 3500 }));
assert.equal(events.length, 1, 'A continuously visible object must not emit duplicate events.');

policy.evaluate([], { now: 12000 });
const resetEvents = [];
resetEvents.push(...policy.evaluate([detection('mobile_phone')], { now: 13000 }));
resetEvents.push(...policy.evaluate([detection('mobile_phone')], { now: 13500 }));
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

const facialFeaturePolicy = new YoloObjectPolicy({ enabled: true, mode: 'enforce', calibrationMs: 0 });
const faceContext = {
  frameWidth: 640,
  frameHeight: 480,
  faces: [{
    x: 220,
    y: 100,
    width: 180,
    height: 180,
    nose: { x: 308, y: 205 },
    mouth: { x: 308, y: 242 },
  }],
};
let facialFeatureEvents = [];
for (let index = 0; index < 6; index += 1) {
  const now = 1000 + (index * 500);
  facialFeatureEvents = facialFeatureEvents.concat(facialFeaturePolicy.evaluate([
    detection('mobile_phone', 0.92, {
      x: 292 + index,
      y: 184,
      width: 32,
      height: 52,
      frameWidth: 640,
      frameHeight: 480,
    }),
  ], { now, faceContext: { ...faceContext, capturedAt: now } }));
}
assert.equal(
  facialFeatureEvents.length,
  0,
  'A small high-confidence box on the face nose/mouth landmarks must not be treated as a phone.',
);

const faceOverlapPhonePolicy = new YoloObjectPolicy({ enabled: true, mode: 'enforce', calibrationMs: 0 });
let faceOverlapPhoneEvents = [];
for (let index = 0; index < 2; index += 1) {
  const now = 5000 + (index * 500);
  faceOverlapPhoneEvents = faceOverlapPhoneEvents.concat(faceOverlapPhonePolicy.evaluate([
    detection('mobile_phone', 0.82, {
      x: 315,
      y: 155,
      width: 130,
      height: 205,
      frameWidth: 640,
      frameHeight: 480,
    }),
  ], { now, faceContext: { ...faceContext, capturedAt: now } }));
}
assert.equal(
  faceOverlapPhoneEvents.length,
  1,
  'A clearly sized phone held in front of the student must not be suppressed by face filtering.',
);

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
for (let index = 0; index < 2; index += 1) {
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

const startupPhoneSpecialistPolicy = new YoloObjectPolicy({ enabled: true, mode: 'enforce' });
let startupPhoneEvents = [];
for (let index = 0; index < 3; index += 1) {
  startupPhoneEvents = startupPhoneEvents.concat(
    startupPhoneSpecialistPolicy.evaluate([{
      ...detection('mobile_phone', 0.35, realPhoneBox),
      rawClass: 'mobile_phone',
      detectorRole: 'phone-specialist',
    }], {
      now: 1000 + (index * 650),
      detectorRole: 'phone-specialist',
    }),
  );
}
assert.equal(
  startupPhoneEvents.length,
  1,
  'A clearly sized phone shown during startup must not be learned as background furniture.',
);

const mixedDetectorPhonePolicy = new YoloObjectPolicy({ enabled: true, mode: 'enforce', calibrationMs: 0 });
let mixedDetectorPhoneEvents = [];
for (let index = 0; index < 2; index += 1) {
  mixedDetectorPhoneEvents = mixedDetectorPhoneEvents.concat(
    mixedDetectorPhonePolicy.evaluate([
      detection('mobile_phone', 0.6, realPhoneBox),
    ], { now: 1000 + (index * 500), detectorRole: 'primary' }),
  );
}
for (let index = 0; index < 3; index += 1) {
  mixedDetectorPhoneEvents = mixedDetectorPhoneEvents.concat(
    mixedDetectorPhonePolicy.evaluate([{
      ...detection('mobile_phone', 0.35, realPhoneBox),
      rawClass: 'mobile_phone',
      detectorRole: 'phone-specialist',
    }], {
      now: 2000 + (index * 650),
      detectorRole: 'phone-specialist',
    }),
  );
}
assert.equal(
  mixedDetectorPhoneEvents.length,
  1,
  'Repeated specialist evidence must confirm a steady phone even when a stronger primary candidate owns the track.',
);

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
  1,
  'A clearly sized stationary phone from the specialist must confirm after an extra frame.',
);

const angledShelfPolicy = new YoloObjectPolicy({ enabled: true, mode: 'enforce', calibrationMs: 0 });
const angledShelfBox = {
  x: 1,
  y: 0,
  width: 190,
  height: 90,
  frameWidth: 640,
  frameHeight: 480,
};
let angledShelfEvents = [];
for (let index = 0; index < 8; index += 1) {
  angledShelfEvents = angledShelfEvents.concat(angledShelfPolicy.evaluate([{
    ...detection('mobile_phone', 0.9, {
      ...angledShelfBox,
      x: angledShelfBox.x + (index % 2),
      width: angledShelfBox.width + (index % 3),
    }),
    rawClass: 'mobile_phone',
    detectorRole: 'phone-specialist',
    humanContext: {
      available: true,
      personDetected: true,
      nearPerson: false,
      overlapRatio: 0,
      proximityRatio: 0.8,
    },
  }], {
    now: 5000 + (index * 650),
    detectorRole: 'phone-specialist',
  }));
}
assert.equal(
  angledShelfEvents.length,
  0,
  'A large static shelf candidate pinned to a frame edge must not be treated as a phone.',
);

const movingEdgePhonePolicy = new YoloObjectPolicy({ enabled: true, mode: 'enforce', calibrationMs: 0 });
let movingEdgePhoneEvents = [];
for (let index = 0; index < 3; index += 1) {
  movingEdgePhoneEvents = movingEdgePhoneEvents.concat(movingEdgePhonePolicy.evaluate([
    detection('mobile_phone', 0.82, {
      x: index * 25,
      y: 150,
      width: 90,
      height: 150,
      frameWidth: 640,
      frameHeight: 480,
    }),
  ], { now: 1000 + (index * 500), detectorRole: 'primary' }));
}
assert.equal(
  movingEdgePhoneEvents.length,
  1,
  'A real phone entering from the frame edge must still confirm after clear movement.',
);

const squareFurniturePolicy = new YoloObjectPolicy({ enabled: true, mode: 'enforce', calibrationMs: 0 });
let squareFurnitureEvents = [];
for (let index = 0; index < 8; index += 1) {
  squareFurnitureEvents = squareFurnitureEvents.concat(squareFurniturePolicy.evaluate([
    detection('mobile_phone', 0.98, {
      x: 240 + (index % 2),
      y: 150,
      width: 112,
      height: 105,
      frameWidth: 640,
      frameHeight: 480,
    }),
  ], { now: 1000 + (index * 500), detectorRole: 'primary' }));
}
assert.equal(
  squareFurnitureEvents.length,
  0,
  'A verified square object must be rejected even when the detector reports very high phone confidence.',
);

const interiorFurniturePolicy = new YoloObjectPolicy({ enabled: true, mode: 'enforce', calibrationMs: 0 });
let interiorFurnitureEvents = [];
for (let index = 0; index < 8; index += 1) {
  interiorFurnitureEvents = interiorFurnitureEvents.concat(interiorFurniturePolicy.evaluate([{
    ...detection('mobile_phone', 0.92, {
      x: 70 + (index % 3),
      y: 80 + (index % 2),
      width: 165,
      height: 90,
      frameWidth: 640,
      frameHeight: 480,
    }),
    humanContext: {
      available: true,
      personDetected: true,
      nearPerson: false,
      overlapRatio: 0,
      proximityRatio: 0.55,
    },
  }], { now: 1000 + (index * 500), detectorRole: 'primary' }));
}
assert.equal(
  interiorFurnitureEvents.length,
  0,
  'Phone-shaped furniture away from the student must not confirm from static detector jitter.',
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

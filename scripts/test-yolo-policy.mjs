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
  legacySetting: true,
});
assert.deepEqual(normalized, {
  enabled: true,
  mode: 'enforce',
});

const policy = new YoloObjectPolicy({ enabled: true, mode: 'enforce', calibrationMs: 0 });
let events = [];
events.push(...policy.evaluate(
  [detection('mobile_phone')],
  { now: 1000, modelVersion: 'test-v1', backend: 'wasm' },
));
assert.equal(events.length, 0, 'A single phone-shaped frame must not issue a violation.');
// A phone in a hand travels. One scan fixes where it was, and the next two have
// to find it clear of that spot - here 26 px further each time, a phone being
// lifted or turned. A few pixels of drift is what a wall fixture's box does.
events.push(...policy.evaluate([detection('mobile_phone', 0.9, {
  x: 236, y: 150, width: 90, height: 150, frameWidth: 640, frameHeight: 480,
})], { now: 2000, modelVersion: 'test-v1', backend: 'wasm' }));
assert.equal(events.length, 0, 'One displaced frame is not yet proof that the object moved.');
events.push(...policy.evaluate([detection('mobile_phone', 0.9, {
  x: 262, y: 150, width: 90, height: 150, frameWidth: 640, frameHeight: 480,
})], { now: 3000, modelVersion: 'test-v1', backend: 'wasm' }));
assert.equal(events.length, 1, 'A clear phone must confirm once it has visibly moved.');
assert.equal(events[0].violationType, 'restricted_phone');
assert.equal(events[0].policyDecision, 'warning');
assert.equal(events[0].modelVersion, 'test-v1');

events.push(...policy.evaluate([detection('mobile_phone')], { now: 3500 }));
assert.equal(events.length, 1, 'A continuously visible object must not emit duplicate events.');

policy.evaluate([], { now: 12000 });
const resetEvents = [];
for (let index = 0; index < 3; index += 1) {
  resetEvents.push(...policy.evaluate([detection('mobile_phone', 0.9, {
    x: 210 + (index * 26), y: 150, width: 90, height: 150, frameWidth: 640, frameHeight: 480,
  })], { now: 13000 + (index * 500) }));
}
assert.equal(resetEvents.length, 1, 'An object may emit again only after a confirmed absence.');

const shadowPolicy = new YoloObjectPolicy({ enabled: true, mode: 'shadow', calibrationMs: 0 });
let shadowEvents = [];
for (let index = 0; index < 3; index += 1) {
  shadowEvents = shadowEvents.concat(
    shadowPolicy.evaluate([detection('mobile_phone', 0.9, {
      x: 210 + (index * 26), y: 150, width: 90, height: 150, frameWidth: 640, frameHeight: 480,
    })], { now: 1000 + (index * 1000) }),
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
for (let index = 0; index < 3; index += 1) {
  movingPhoneEvents = movingPhoneEvents.concat(
    movingPhonePolicy.evaluate([
      detection('mobile_phone', 0.35, {
        x: 210 + (index * 24),
        y: 170 + (index * 12),
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
  'A verified lower-confidence handheld phone must confirm once it has clearly moved.',
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
for (let index = 0; index < 3; index += 1) {
  const now = 5000 + (index * 500);
  faceOverlapPhoneEvents = faceOverlapPhoneEvents.concat(faceOverlapPhonePolicy.evaluate([
    detection('mobile_phone', 0.82, {
      x: 300 + (index * 30),
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

const calendarPolicy = new YoloObjectPolicy({ enabled: true, mode: 'enforce', calibrationMs: 0 });
const calendarBox = { x: 35, y: 25, width: 135, height: 80, frameWidth: 640, frameHeight: 480 };
let calendarEvents = [];
for (let index = 0; index < 8; index += 1) {
  const detectorRole = index % 2 ? 'phone-specialist' : 'primary';
  calendarEvents = calendarEvents.concat(calendarPolicy.evaluate([{
    ...detection('mobile_phone', 0.96, calendarBox),
    rawClass: detectorRole === 'phone-specialist' ? 'mobile_phone' : 'cell phone',
    detectorRole,
  }], { now: 1000 + (index * 500), detectorRole }));
}
assert.equal(
  calendarEvents.length,
  0,
  'A static wall calendar must remain non-violating even when both phone detectors misclassify it.',
);

const realPhoneBox = { x: 220, y: 180, width: 90, height: 150, frameWidth: 640, frameHeight: 480 };
let calibratedEvents = [];
for (let index = 0; index < 3; index += 1) {
  calibratedEvents = calibratedEvents.concat(
    calibratedPolicy.evaluate([detection('mobile_phone', 0.75, {
      ...realPhoneBox,
      x: realPhoneBox.x + (index * 26),
    })], { now: 8000 + (index * 1000) }),
  );
}
assert.equal(calibratedEvents.length, 1, 'A phone entering after calibration must still emit an alert.');

const fastPathPolicy = new YoloObjectPolicy({ enabled: true, mode: 'enforce' });
let fastPathEvents = [];
for (let index = 0; index < 3; index += 1) {
  fastPathEvents = fastPathEvents.concat(
    fastPathPolicy.evaluate([detection('mobile_phone', 0.8, {
      ...realPhoneBox,
      x: realPhoneBox.x + (index * 26),
    })], { now: 1000 + (index * 500) }),
  );
}
assert.equal(fastPathEvents.length, 1, 'A clear phone must confirm quickly during startup calibration.');
assert.equal(fastPathEvents[0].policyDecision, 'warning');

const phoneBackSpecialistPolicy = new YoloObjectPolicy({ enabled: true, mode: 'enforce', calibrationMs: 0 });
let phoneBackEvents = [];
for (let index = 0; index < 3; index += 1) {
  phoneBackEvents = phoneBackEvents.concat(
    phoneBackSpecialistPolicy.evaluate([
      {
        ...detection('mobile_phone', 0.35, {
          ...realPhoneBox,
          x: realPhoneBox.x + (index * 26),
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
      ...detection('mobile_phone', 0.35, {
        ...realPhoneBox,
        x: realPhoneBox.x + (index * 26),
      }),
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
      ...detection('mobile_phone', 0.35, {
        ...realPhoneBox,
        x: realPhoneBox.x + (index * 26),
      }),
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
  'Repeated specialist evidence must confirm a moving phone even when a stronger primary candidate owns the track.',
);

const tiledPartialPhonePolicy = new YoloObjectPolicy({
  enabled: true,
  mode: 'enforce',
  calibrationMs: 0,
});
let tiledPartialPhoneEvents = [];
for (let index = 0; index < 3; index += 1) {
  tiledPartialPhoneEvents = tiledPartialPhoneEvents.concat(
    tiledPartialPhonePolicy.evaluate([
      {
        ...detection('mobile_phone', 0.36, {
          ...realPhoneBox,
          x: realPhoneBox.x + (index * 26),
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
  'A stationary candidate seen by only one detector must not be treated as a phone.',
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
  0,
  'A generic remote must never be promoted into a mobile-phone violation.',
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


// ── Room fixtures must never be reported as a phone ─────────────────────────
// Each of these was reported as a mobile phone in use. They are all defeated by
// what a phone in someone's hand looks like and where it is, rather than by
// asking the model for more confidence — which it was happy to give.

// A wall-mounted air conditioner: wide, and nowhere near the student's face. The
// person's bounding box covers most of the frame, so 2D overlap with the person
// says "near person" and cannot be the deciding signal.
function fixtureDetection(boundingBox, confidence = 0.82) {
  return {
    objectClass: 'mobile_phone',
    rawClass: 'cell phone',
    confidence,
    fullFrameConfidence: confidence,
    verificationConfidence: confidence,
    verified: true,
    detectorRole: 'primary',
    boundingBox,
    humanContext: {
      available: true,
      personDetected: true,
      nearPerson: true,
      overlapRatio: 0.4,
      proximityRatio: 0,
    },
  };
}

function runFixture(boundingBox, { confidence = 0.82, scans = 6, faceContext = null } = {}) {
  const policy = new YoloObjectPolicy({ enabled: true, mode: 'enforce', calibrationMs: 0 });
  let events = [];
  for (let index = 0; index < scans; index += 1) {
    events = events.concat(policy.evaluate(
      [fixtureDetection({
        ...boundingBox,
        // A fixed object's box is not fixed: on a large item the model shifts it
        // by tens of pixels between frames as the student moves in front of it or
        // it reads first the whole unit and then part of it. That instability is
        // what used to clear the "a phone in use moves" gate.
        x: boundingBox.x + (index % 2 === 0 ? 0 : 18),
        y: boundingBox.y + (index % 2 === 0 ? 14 : 0),
      }, confidence)],
      { now: 10000 + (index * 700), faceContext, modelVersion: 'test-v1' },
    ));
  }
  return events;
}

const airconBox = { x: 380, y: 18, width: 210, height: 78, frameWidth: 640, frameHeight: 480 };
assert.equal(
  runFixture(airconBox).length,
  0,
  'A wall air conditioner must never be reported as a mobile phone.',
);

// A wide fixture at desk height, away from the face: still not a handset shape.
const wideShelfBox = { x: 300, y: 250, width: 240, height: 84, frameWidth: 640, frameHeight: 480 };
assert.equal(
  runFixture(wideShelfBox).length,
  0,
  'A wide object beside the student must not be reported as a mobile phone.',
);

// A square patch on the wall - a vent, a switch plate, a shadow.
const squarePatchBox = { x: 120, y: 200, width: 96, height: 92, frameWidth: 640, frameHeight: 480 };
assert.equal(
  runFixture(squarePatchBox).length,
  0,
  'A square spot must not be reported as a mobile phone.',
);

// A large appliance close to the camera cannot be a phone in use.
const largeApplianceBox = { x: 60, y: 90, width: 300, height: 330, frameWidth: 640, frameHeight: 480 };
assert.equal(
  runFixture(largeApplianceBox).length,
  0,
  'An object filling much of the frame must not be reported as a mobile phone.',
);

// A tall object taking up a third of the frame - a door frame, a monitor, a
// cabinet - has phone-like proportions but cannot be a phone in anyone's hand.
const largePortraitBox = { x: 120, y: 40, width: 260, height: 400, frameWidth: 640, frameHeight: 480 };
assert.equal(
  runFixture(largePortraitBox).length,
  0,
  'A tall object filling much of the frame must not be reported as a mobile phone.',
);

// A tall fixture high on the wall - a speaker, a switch box - even at the shape
// and size of a phone, is not where a phone in use can be.
const highFixtureBox = { x: 470, y: 8, width: 60, height: 104, frameWidth: 640, frameHeight: 480 };
assert.equal(
  runFixture(highFixtureBox).length,
  0,
  'A phone-shaped fixture in the top band of the frame must not be reported.',
);

// The face is what settles it: the same wide box, held where the student's face
// is, is a phone being watched or filmed and must still be caught.
const faceBesideLandscapePhone = {
  capturedAt: 10000,
  frameWidth: 640,
  frameHeight: 480,
  faces: [{ x: 250, y: 120, width: 150, height: 190, nose: { x: 325, y: 215 }, mouth: { x: 325, y: 250 } }],
};
const landscapeInHandBox = { x: 300, y: 200, width: 160, height: 80, frameWidth: 640, frameHeight: 480 };
const landscapeInHandEvents = (() => {
  const policy = new YoloObjectPolicy({ enabled: true, mode: 'enforce', calibrationMs: 0 });
  let events = [];
  for (let index = 0; index < 3; index += 1) {
    events = events.concat(policy.evaluate(
      [fixtureDetection({
        ...landscapeInHandBox,
        x: landscapeInHandBox.x + (index * 22),
        y: landscapeInHandBox.y + (index * 9),
      }, 0.74)],
      {
        now: 20000 + (index * 700),
        faceContext: { ...faceBesideLandscapePhone, capturedAt: 20000 + (index * 700) },
        modelVersion: 'test-v1',
      },
    ));
  }
  return events;
})();
assert.equal(
  landscapeInHandEvents.length,
  1,
  'A landscape phone held at the student\'s face must still be reported.',
);

// Whatever is in view while the exam starts up is mapped as furniture and then
// filtered out for the rest of the attempt. A confident score used to skip that
// mapping entirely - and a wall unit can read as a phone at 0.88 all day - so the
// one object the model was surest about was the one never learned.
//
// This object is phone-shaped and phone-sized but has no person beside it, which
// is what separates a fixture from a phone actually in use.
function detachedFixture(boundingBox, confidence = 0.88) {
  return {
    ...fixtureDetection(boundingBox, confidence),
    humanContext: {
      available: true,
      personDetected: true,
      nearPerson: false,
      overlapRatio: 0,
      proximityRatio: 0.6,
    },
  };
}

const confidentFixturePolicy = new YoloObjectPolicy({ enabled: true, mode: 'enforce' });
const confidentFixtureBox = { x: 40, y: 190, width: 92, height: 152, frameWidth: 640, frameHeight: 480 };
let confidentFixtureEvents = [];
// In view through startup, jittering the way a fixed object's box does.
for (let index = 0; index < 6; index += 1) {
  confidentFixtureEvents = confidentFixtureEvents.concat(confidentFixturePolicy.evaluate(
    [detachedFixture({ ...confidentFixtureBox, x: confidentFixtureBox.x + (index % 2 === 0 ? 0 : 3) })],
    { now: 30000 + (index * 700), modelVersion: 'test-v1' },
  ));
}
assert.ok(
  confidentFixturePolicy.calibrationComplete,
  'startup calibration should have finished by now',
);
assert.equal(
  confidentFixturePolicy._isCalibratedBackground(detachedFixture({ ...confidentFixtureBox })),
  true,
  'A confidently scored fixture present at startup must be mapped as background.',
);
assert.equal(
  confidentFixtureEvents.length,
  0,
  'A fixture in view at startup must never be reported as a phone.',
);

// The mapping is not a blanket amnesty for that corner of the frame: a phone the
// student actually holds up is still reported, because a held phone is kept out
// of the furniture map in the first place.
const phoneOverFixturePolicy = new YoloObjectPolicy({ enabled: true, mode: 'enforce' });
let phoneOverFixtureEvents = [];
for (let index = 0; index < 6; index += 1) {
  phoneOverFixtureEvents = phoneOverFixtureEvents.concat(phoneOverFixturePolicy.evaluate(
    [detachedFixture({ ...confidentFixtureBox })],
    { now: 50000 + (index * 700), modelVersion: 'test-v1' },
  ));
}
for (let index = 0; index < 3; index += 1) {
  phoneOverFixtureEvents = phoneOverFixtureEvents.concat(phoneOverFixturePolicy.evaluate(
    [detection('mobile_phone', 0.82, {
      x: 250 + (index * 26),
      y: 210 + (index * 12),
      width: 90,
      height: 150,
      frameWidth: 640,
      frameHeight: 480,
    })],
    { now: 60000 + (index * 700), modelVersion: 'test-v1' },
  ));
}
assert.equal(
  phoneOverFixtureEvents.length,
  1,
  'A real phone must still be reported on a camera that also shows furniture.',
);

// ── A box that wobbles is not an object that moved ──────────────────────────
// Every fixture below sits where a phone could be: phone-shaped, phone-sized,
// at desk height, overlapping the student. None of the shape or position rules
// can reject it, and each one used to be reported within a few scans because
// its box shifted by a handful of pixels from one scan to the next.
function wobbleSource(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return (state / 4294967296) - 0.5;
  };
}

function runScans(scans, makeDetection, { stepMs = 600, startAt = 100000, role = 'primary', policy = null } = {}) {
  const activePolicy = policy || new YoloObjectPolicy({ enabled: true, mode: 'enforce', calibrationMs: 0 });
  let events = [];
  for (let index = 0; index < scans; index += 1) {
    const found = makeDetection(index);
    events = events.concat(activePolicy.evaluate(
      found ? [].concat(found) : [],
      { now: startAt + (index * stepMs), detectorRole: role, modelVersion: 'test-v1' },
    ));
  }
  return { events, policy: activePolicy };
}

const deskFixtureBox = { x: 470, y: 200, width: 70, height: 120, frameWidth: 640, frameHeight: 480 };
function wobblingBox(base, random, position = 8, size = 6) {
  return {
    ...base,
    x: base.x + (random() * 2 * position),
    y: base.y + (random() * 2 * position),
    width: base.width + (random() * 2 * size),
    height: base.height + (random() * 2 * size),
  };
}

// Ten minutes of scans, several different wobble sequences.
for (const seed of [1, 2, 3, 4, 5]) {
  const random = wobbleSource(seed);
  assert.equal(
    runScans(1000, () => fixtureDetection(wobblingBox(deskFixtureBox, random), 0.82)).events.length,
    0,
    'A phone-sized fixture beside the student must not be reported because its box wobbles.',
  );
}

// The same fixture through the phone-back model, which cannot see people and
// so used to treat everything it found as possibly held.
for (const seed of [6, 7, 8]) {
  const random = wobbleSource(seed);
  assert.equal(
    runScans(1000, () => ({
      ...fixtureDetection(wobblingBox(deskFixtureBox, random), 0.82),
      rawClass: 'mobile_phone',
      detectorRole: 'phone-specialist',
      humanContext: { available: false, personDetected: false, nearPerson: false, overlapRatio: 0, proximityRatio: null },
    }), { role: 'phone-specialist' }).events.length,
    0,
    'A wobbling fixture must not be reported by the phone-back model either.',
  );
}

// Read first as the whole unit and then as part of it: the top edge jumps by
// forty pixels while the bottom edge stays where it is. The centre of the box
// moves a long way; the object has not moved at all.
assert.equal(
  runScans(60, index => fixtureDetection({
    ...deskFixtureBox,
    y: Math.floor(index / 4) % 2 ? 240 : 200,
    height: Math.floor(index / 4) % 2 ? 122 : 162,
  }, 0.82)).events.length,
  0,
  'A box that grows and shrinks around a fixed object must not count as movement.',
);

// One wild reading among steady ones.
assert.equal(
  runScans(40, index => fixtureDetection({
    ...deskFixtureBox,
    x: deskFixtureBox.x + (index % 9 === 8 ? 34 : 0),
  }, 0.82)).events.length,
  0,
  'A single stray box must not be taken for the object moving.',
);

// Both models looking at one fixture, each drawing its own slightly different
// box. Alternating between the two is not the object travelling.
assert.equal(
  runScans(80, index => {
    const specialist = index % 3 !== 0;
    return {
      ...fixtureDetection(specialist
        ? { ...deskFixtureBox, x: deskFixtureBox.x + 26, y: deskFixtureBox.y + 14, width: 66, height: 116 }
        : deskFixtureBox, 0.82),
      rawClass: specialist ? 'mobile_phone' : 'cell phone',
      detectorRole: specialist ? 'phone-specialist' : 'primary',
    };
  }).events.length,
  0,
  'Two detectors disagreeing about a fixture\'s box must not read as movement.',
);

// What has to keep working: a phone that sat still and is then picked up.
const heldThenMoved = runScans(12, index => detection('mobile_phone', 0.74, {
  x: 300 + (index >= 6 ? 40 : 0),
  y: 250 + (index % 2),
  width: 78,
  height: 132,
  frameWidth: 640,
  frameHeight: 480,
}));
assert.equal(heldThenMoved.events.length, 1, 'A phone that rests and is then moved must be reported.');
assert.ok(heldThenMoved.events[0].frameHits >= 3);

// And one that creeps: no single step is large, but it ends up somewhere else.
assert.equal(
  runScans(14, index => detection('mobile_phone', 0.74, {
    x: 300 + (index * 6), y: 250, width: 78, height: 132, frameWidth: 640, frameHeight: 480,
  })).events.length,
  1,
  'A phone drifting slowly across the frame must be reported once it has clearly travelled.',
);

// ── The phone-back model borrows the general model's view of who is there ────
// It has no person class, so on its own it cannot tell a phone in a hand from a
// fixture across the room. The general model scans the same picture moments
// earlier and its people are used to place what the phone-back model finds.
const studentBox = { x: 200, y: 120, width: 240, height: 360, frameWidth: 640, frameHeight: 480 };
const personDetection = { rawClass: 'person', contextClass: 'person', confidence: 0.9, boundingBox: studentBox };
function specialistPhone(box, confidence = 0.6) {
  return {
    objectClass: 'mobile_phone',
    rawClass: 'mobile_phone',
    confidence,
    fullFrameConfidence: confidence,
    verificationConfidence: confidence,
    verified: true,
    detectorRole: 'phone-specialist',
    boundingBox: { ...box, frameWidth: 640, frameHeight: 480 },
    humanContext: { available: false, personDetected: false, nearPerson: false, overlapRatio: 0, proximityRatio: null },
  };
}

function runWithPeople(phoneBoxAt, scans) {
  const policy = new YoloObjectPolicy({ enabled: true, mode: 'enforce', calibrationMs: 0 });
  const reportedAt = [];
  for (let index = 0; index < scans; index += 1) {
    const now = 200000 + (index * 600);
    policy.evaluate([personDetection], { now: now - 200, detectorRole: 'primary' });
    const events = policy.evaluate([specialistPhone(phoneBoxAt(index))], { now, detectorRole: 'phone-specialist' });
    if (events.length) reportedAt.push(index);
  }
  return reportedAt;
}

// In the student's hands: reported as soon as it has moved on two scans.
assert.deepEqual(
  runWithPeople(index => ({ x: 280 + (index * 26), y: 300, width: 78, height: 132 }), 6),
  [2],
  'A phone the specialist finds inside the student\'s outline is treated as held.',
);

// The same motion across the room from the student: held to the stricter
// standard for objects nobody is near, so it takes longer to be believed.
assert.deepEqual(
  runWithPeople(index => ({ x: 20 + (index * 26), y: 300, width: 60, height: 104 }), 6),
  [3],
  'A phone-shaped object away from the student needs more evidence, even from the specialist.',
);

// A general model with no person class must not be read as "nobody is here".
const noPersonClassPolicy = new YoloObjectPolicy({ enabled: true, mode: 'enforce', calibrationMs: 0 });
noPersonClassPolicy.evaluate([], { now: 300000, detectorRole: 'primary' });
assert.equal(
  noPersonClassPolicy._peopleContext(300100).available,
  false,
  'An empty result from a model that may not detect people says nothing about who is present.',
);
noPersonClassPolicy.evaluate([personDetection], { now: 300400, detectorRole: 'primary' });
assert.equal(noPersonClassPolicy._peopleContext(300500).available, true);
assert.equal(
  noPersonClassPolicy._peopleContext(310000).available,
  false,
  'A person seen long ago no longer places anything.',
);

// ── What the student is shown ───────────────────────────────────────────────
// The camera chip reads "Checking phone" while a candidate is being weighed.
// Over a fixture that never moves it stayed that way for the whole exam.
const chipPolicy = new YoloObjectPolicy({ enabled: true, mode: 'enforce', calibrationMs: 0 });
runScans(3, () => fixtureDetection(deskFixtureBox, 0.82), { policy: chipPolicy });
assert.equal(chipPolicy.getDetectionProgress().length, 1, 'A new candidate is shown as being checked.');
runScans(6, () => fixtureDetection(deskFixtureBox, 0.82), { policy: chipPolicy, startAt: 100000 + (3 * 600) });
assert.equal(
  chipPolicy.getDetectionProgress().length,
  0,
  'A candidate that has stayed put is no longer shown as being checked.',
);

console.log('YOLO object policy tests passed.');

# FaceMesh implementation and validation guide

## What is implemented

TUKLAS now runs the official MediaPipe Face Landmarker locally in a module Web
Worker. The main page captures at most one new source-video frame per inference
interval and transfers an `ImageBitmap` to the worker. The worker returns only
derived pose, face geometry, tracking quality, timing, and classification input;
it never returns or uploads the landmark array.

Before a camera-required exam starts, the student completes a five-second,
session-only calibration inside a visible face guide. The resulting baseline is
kept in memory. Monitoring then classifies relative head pose and face geometry,
and a temporal state machine emits one start/update/end lifecycle per sustained
incident. FaceMesh incidents are professor-review indicators and never call the
existing three-warning or automatic-submission path.

BlazeFace remains responsible for multiple-face detection. When the existing
YOLO monitor is enabled, its non-violation `person` context reinforces both
multiple-person and presence tracking, including bodies with turned or obscured
faces. A sustained FaceMesh occlusion overlapping a YOLO mobile-phone detection
creates one `PHONE_NEAR_OR_COVERING_FACE` review event; standalone occlusion and
camera-positioning states remain local prompts and are not separate professor
incidents.

The professor-facing camera behavior categories are deliberately limited to:

- no person detected (`FACE_ABSENT`),
- multiple faces or people (`multiple_people`),
- looking down (`SUSTAINED_LOOKING_DOWN`), and
- looking away left, right, or up (`SUSTAINED_HEAD_TURN` with direction).

## Main files

- `src/lib/proctoring/facemesh/faceLandmarker.worker.js`: MediaPipe inference,
  GPU-first initialization, CPU fallback, and derived observations.
- `src/lib/proctoring/facemesh/faceLandmarkerRuntime.js`: frame scheduling,
  duplicate-timestamp protection, worker lifecycle, and cleanup.
- `src/lib/proctoring/facemesh/calibrationService.js`: session baseline.
- `src/lib/proctoring/facemesh/headPoseEstimator.js`: transformation-matrix
  Euler angles, landmark fallback, relative angles, and classifications.
- `src/lib/proctoring/facemesh/temporalRuleEngine.js`: duration, recovery,
  update, repetition, and cooldown rules.
- `src/lib/proctoring/facemesh/faceEventCorrelator.js`: FaceMesh/YOLO phone
  correlation.
- `src/lib/proctoring/facemesh/faceSessionAggregator.js`: monitoring-report
  aggregates that are deliberately not sent to the current Random Forest.
- `src/lib/proctoring/facemesh/evaluationExporter.js`: consent-gated,
  development-only derived CSV exporter.
- `public/js/exam.js`: exam lifecycle, calibration, warnings, activity logging,
  backend synchronization, and cleanup.
- `public/js/admin.js`: neutral professor live alerts, activity details, and
  confirm/dismiss review actions.
- `server/monitor-route.cjs`: authenticated, allowlisted incident lifecycle
  upserts using the existing `violation_events` table.

## Install and model setup

Run:

```powershell
npm install
npm run prepare:mediapipe
```

The checked-in model is `public/models/face_landmarker.task`. To restore it from
the official source if needed:

```powershell
Invoke-WebRequest `
  -Uri "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/latest/face_landmarker.task" `
  -OutFile "public/models/face_landmarker.task"
Get-FileHash "public/models/face_landmarker.task" -Algorithm SHA256
```

Expected SHA-256:
`64184E229B263107BC2B804C6625DB1341FF2BB731874B0BCC2FE6544E0BC9FF`.
The build script automatically refreshes the matching local MediaPipe WASM
assets from the installed npm package.

## Initial thresholds

All tunable values are centralized in
`src/lib/proctoring/facemesh/faceMonitoringConfig.js`:

| Rule | Initial value |
| --- | ---: |
| Inference rate | Up to 15 FPS (one in-flight frame at a time, 640 px maximum input side) |
| Calibration | 5 seconds |
| Left/right yaw | below -25 degrees / above +25 degrees |
| Up/down pitch | below -18 degrees / above +18 degrees |
| Positioning warning | 3 seconds |
| Face-absence incident | 10 seconds |
| Sustained head turn (left/right/up) | 10 seconds |
| Sustained downward direction | 10 seconds |
| Recovery before incident end | 1 second |
| Same-rule cooldown | 5 seconds |

Pitch is normalized to the student-facing convention: negative is up and
positive is down. These are starting values, not validated production policy;
pilot measurements must tune thresholds before operational use.

## Manual calibration and behavior checks

Use a non-production test exam with camera monitoring enabled:

1. Grant camera access. Confirm that the calibration modal appears before the
   timer starts and that an off-center, too-close, too-far, obstructed, or
   unstable face resets progress with a neutral instruction.
2. Hold a centered position for five seconds, select **Continue to Exam**, and
   confirm the timer and ordinary monitoring start only then.
3. Stay centered for several minutes and confirm no FaceMesh incidents appear.
4. Turn briefly for less than two seconds; confirm no incident. Hold left,
   right, and upward turns through the ten-second countdown; each continuous turn should create one
   lifecycle event, ending after one centered second.
5. Look downward through the ten-second countdown and return to center. Verify one
   neutral downward-direction event.
6. Leave the frame. Verify a positioning message after three seconds, one
   `FACE_ABSENT` event after the ten-second countdown, and an end after returning.
7. Move partly outside the frame and test near/far positioning. Verify neutral
   messages and one sustained event per continuous condition.
8. Reduce lighting enough to make tracking unstable. Verify the lighting prompt
   and `FACE_TRACKING_UNSTABLE` behavior without accusatory wording.
9. In a controlled test, obscure the face while presenting a phone. Verify the
   correlated professor review event and that the occlusion is not counted a
   second time in the behavior summary.
10. Submit while monitoring is active, navigate away during calibration, and
    reload/remount the page. In browser developer tools, verify the worker,
    timers, and camera track stop and do not duplicate.
11. Deny camera permission. Confirm the retry and exit controls remain usable.

The student camera panel deliberately does not display pose coordinates,
tracking percentages, backend details, or inference timing. Confirm left/right
and up/down behavior through the concise camera countdown labels on each
supported browser/device combination.

## Automated verification

```powershell
npm run test:facemesh
npm run test:facemesh:browser
npm run test:yolo
npm run test:replay
npm run build
```

The logic suite covers pose conversion and classification, calibration rejection
and completion, video time zero, brief-versus-sustained movement, start/end and
recovery behavior, repeated-event counting, incident deduplication, aggregation,
YOLO correlation, and camera permission errors. The Edge/Chromium smoke test
loads the actual local task model and WASM, initializes the real worker, runs an
inference, verifies model-load failure cleanup, cancels initialization, and
checks duplicate starts share one worker initialization.

These automated tests do not constitute accuracy validation. The manual
camera-behavior matrix above and a consented participant evaluation remain
required.

## Evaluation and privacy

See `docs/facemesh-evaluation.md`. Evaluation export is disabled outside Vite
development mode and requires an explicit consent flag plus an anonymous
participant ID. Split CSV data by participant with:

```powershell
npm run split:facemesh-evaluation -- input.csv output-directory
```

Production does not export landmarks, collect a FaceMesh dataset, or record a
complete exam video. FaceMesh evidence capture is disabled. Existing evidence
features remain governed by the application's current policy. Professors can
mark each FaceMesh indicator confirmed-for-review or dismissed; confirmation is
not a finding of cheating.

## Random Forest boundary and limitations

No deployed Random Forest artifact or exact trained input-column contract was
found in this repository. FaceMesh aggregates are saved under
`session.aiDetections.faceMonitoring` with `randomForestCompatible: false`.
Retraining, or proof of an equivalent feature contract and preprocessing order,
is required before any aggregate can be supplied to a Random Forest.

Current technical limitations:

- Head pose is an estimate, affected by camera placement, face geometry,
  eyeglasses, lighting, and landmark quality.
- The tracking-quality value is a landmark-stability proxy because the browser
  Face Landmarker result does not expose a per-frame tracking-confidence score.
- Occlusion is inferred by disagreement between MediaPipe landmark availability
  and the existing face detector; it is not an identity or intent classifier.
- Iris/gaze classification is disabled. The system does not infer an exact
  on-screen gaze target.
- Face Landmarker tracks one primary face; BlazeFace continues to handle
  multiple faces.
- Browser/device behavioral accuracy, fairness slices, false warnings per exam
  hour, precision, recall, F1, detection delay, and tracking-failure rate remain
  unmeasured until a consented pilot dataset is collected.

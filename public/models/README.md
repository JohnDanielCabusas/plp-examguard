# YOLO proctoring models

`yolo-proctor-v1.json` is the active browser manifest. It currently points to
the checked-in official YOLO11n COCO baseline, `yolo11n.onnx`.

`yolo-proctor-coco-v1.json` is the immutable rollback manifest for that model.
Custom Open Images models are exported with versioned filenames and remain
staged until `ml/yolo/promote_model.py` validates and activates them.

Model URLs must include a versioned filename or query string. The production
server caches ONNX files as immutable assets, while the active manifest is
always revalidated so a promoted model can select a new cached URL safely.

The active model must map this policy class:

- `mobile_phone`

`mobile_phone` is the only restricted object. `person` may be present in model
classes for context, but it must never appear in `policyMappings`. A person
detection alone is not a cheating violation.

A model may also declare `negativeMappings` (e.g. `{"mouse": "mouse"}`) for
raw classes that must never be treated as a violation but exist to suppress a
restricted class's false positives at the same detector box -- for example, a
computer mouse's shape being confused for a mobile phone. `negativeMappings`
must never overlap with `policyMappings`, and `person` must never appear
there either. See `ml/yolo/dataset_config.py` and
`src/lib/proctoring/yolo/yoloWorker.js` for how negative classes are used.

The browser verifies the model SHA-256 before inference. Every restricted
candidate must also pass isolated-crop and temporal policy checks before it can
issue a warning or notify the professor.

Ultralytics models are AGPL-3.0 by default. Confirm that deployment complies
with those terms or uses an appropriate Ultralytics commercial license.

## MediaPipe Face Landmarker

`face_landmarker.task` is the official MediaPipe Face Landmarker float16 task
bundle downloaded from Google's MediaPipe model storage. It runs locally in
the browser and is not a model trained by TUKLAS.

- Source: `https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/latest/face_landmarker.task`
- SHA-256: `64184E229B263107BC2B804C6625DB1341FF2BB731874B0BCC2FE6544E0BC9FF`
- Runtime: `@mediapipe/tasks-vision`

The matching runtime WASM files are copied from the installed npm package to
`public/vendor/mediapipe/wasm` by `npm run prepare:mediapipe`. Keep the model
and runtime files local so an exam does not depend on a CDN.

## MediaPipe Hand Landmarker

`hand_landmarker.task` is the official MediaPipe Hand Landmarker float16 task
bundle. A dedicated browser worker runs it locally at a lower sampling rate and
merges only the latest count into the FaceMesh observation stream. Keeping the
task in its own worker isolates the MediaPipe runtime used by Face Landmarker.
Only the maximum summarized hand count reaches Random Forest; webcam frames and
hand landmarks are not sent to the prediction service. The worker verifies the
configured SHA-256 before initializing the task.

- Source: `https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task`
- SHA-256: `FBC2A30080C3C557093B5DDFC334698132EB341044CCEE322CCF8BCF3607CDE1`
- Runtime: `@mediapipe/tasks-vision`

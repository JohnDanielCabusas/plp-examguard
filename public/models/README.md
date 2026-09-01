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

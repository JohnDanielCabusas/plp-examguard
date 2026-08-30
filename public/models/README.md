# YOLO proctoring models

`yolo-proctor-v1.json` is the active browser manifest. It currently points to
the checked-in official YOLO11n COCO baseline, `yolo11n.onnx`.

`yolo-proctor-coco-v1.json` is the immutable rollback manifest for that model.
Custom Open Images models are exported with versioned filenames and remain
staged until `ml/yolo/promote_model.py` validates and activates them.

Model URLs must include a versioned filename or query string. The production
server caches ONNX files as immutable assets, while the active manifest is
always revalidated so a promoted model can select a new cached URL safely.

The active model must map all of these policy classes:

- `mobile_phone`
- `laptop_monitor`
- `book_textbook`

`person` may be present in model classes for context, but it must never appear
in `policyMappings`. A person detection alone is not a cheating violation.

The browser verifies the model SHA-256 before inference. Every restricted
candidate must also pass isolated-crop and temporal policy checks before it can
issue a warning or notify the professor.

Ultralytics models are AGPL-3.0 by default. Confirm that deployment complies
with those terms or uses an appropriate Ultralytics commercial license.

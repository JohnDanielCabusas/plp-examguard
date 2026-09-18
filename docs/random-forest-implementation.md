# Random Forest implementation

TUKLAS version `1.0.0` combines twelve summarized browser and webcam signals
for completed sessions. The exact order, units, and sources are defined in
`ml/random_forest/feature_contract.json` and repeated in the signed model
metadata.

The Statistics integration applies the `rule-logs-v3` policy before inference.
Only persisted in-exam rule violations can change the model input. Tab/window/
fullscreen violations, screenshot warnings, and recorded webcam/object rule
violations are mapped into the existing twelve-feature contract. Normal browser
start/end records, elapsed minutes, timeout submission, consent, calibration,
connectivity, and passed pre-exam checks stay at the non-suspicious training
baseline and cannot raise the displayed probability.

For exams with Motion Detection off (`require_camera = false`), the server
discards camera rule events and sends only focus-switch and screenshot counts
to a separate browser-only Random Forest artifact. Its input and metadata
contain no webcam fields. Camera-enabled exams retain the twelve-feature
model. The profile is part of the stored prediction version, so older results
are refreshed under the appropriate policy. The student table displays only
completed, positive-probability results with a flagged risk level; coverage
and Normal counts still reflect every analyzed session.

The browser performs FaceMesh and hand landmark inference locally. Random
Forest receives only numeric summary values derived from qualifying
rule records—never images, video, landmarks, names, student numbers, email
addresses, course information, scores, or grades.

Every completed session receives a result. A session with no qualifying rule
violations is deterministically `0%` and `normal` without invoking the model.
Dismissed violation evidence is excluded. For legacy/offline attempts with no
append-only violation feed, the same strict allowlist is applied to recorded
session activities. The professor sees how many rule records supported each
result.

## API

- `POST /api/exam-sessions/:sessionId/random-forest-prediction`
- `GET /api/statistics/random-forest?examId=...`
- `POST /api/statistics/random-forest/refresh?examId=...`

All routes require the existing signed professor cookie and scope database
queries through `owner_admin_id`. Refresh is bounded and idempotent; the unique
key is `(exam_session_id, model_version)`.

## Interpretation

- `normal`: probability below 0.50
- `needs_monitoring`: probability from 0.50 through 0.79
- `suspicious`: probability from 0.80 through 1.00

No result changes a score, warning count, submission state, or academic record.
Professors must inspect the supporting monitoring incidents before taking any
action.

The browser-only artifact is a limited prototype: the source labels include
camera-based suspicious cases, so its held-out recall against those mixed
labels is low. Its percentages are not calibrated for camera-off exams and
need validation on real camera-off sessions before consequential use.

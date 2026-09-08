# Random Forest implementation

TUKLAS version `1.0.0` combines twelve summarized browser and webcam signals
for completed sessions. The exact order, units, and sources are defined in
`ml/random_forest/feature_contract.json` and repeated in the signed model
metadata.

Browser starts, browser endings, tab switches, screenshot attempts, and elapsed
minutes come from the session record. The current FaceMesh branch contributes
final face presence, maximum face count, mean tracking confidence, maximum hand
count, and mean calibrated head pose. Confidence is converted from 0–1 to
0–100 and pose is converted from degrees to radians only in the centralized
server aggregator.

The browser performs FaceMesh and hand landmark inference locally. Random
Forest receives only the twelve numeric summary values—never images, video,
landmarks, names, student numbers, email addresses, course information, scores,
or grades. YOLO detections, fullscreen exits, and clipboard events remain
separate professor-review evidence.

Historical or degraded sessions are marked unavailable when a required summary
is absent. Missing measurements are never replaced with zeros.

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


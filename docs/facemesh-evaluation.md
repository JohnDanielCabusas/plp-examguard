# FaceMesh calibration and evaluation

FaceMesh is a behavioral indicator for professor review. It does not determine
whether academic dishonesty occurred and must not be evaluated as a cheating
classifier.

## Consent and data handling

- Obtain written informed consent before collecting an evaluation session.
- Use an anonymous participant ID, never a student name or school ID.
- Do not collect evaluation data during a real examination.
- Prefer derived metrics. Raw landmarks are not exported by the production
  worker and raw video is not required.
- If research approval permits temporary video, restrict access, document the
  retention deadline, and delete it after feature verification.

The development-only `FaceEvaluationExporter` requires both an explicit
`consented` flag and Vite development mode. Supported labels are `CENTER`,
`HEAD_LEFT`, `HEAD_RIGHT`, `HEAD_UP`, `HEAD_DOWN`, `BRIEF_LOOK_AWAY`,
`SUSTAINED_LOOK_AWAY`, `FACE_ABSENT`, `PARTIAL_FACE`, `FACE_OCCLUDED`,
`LOW_LIGHT`, `GLASSES`, and `NORMAL_MOVEMENT`.

## Evaluation procedure

1. Record varied consented sessions across lighting, skin tones, eyeglasses,
   camera placement, webcam quality, face distance, and natural movement.
2. Include substantial centered, normal behavior to measure false warnings.
3. Export only the derived CSV fields defined in `evaluationExporter.js`.
4. Split data by participant with:

   `node scripts/split-facemesh-evaluation.mjs input.csv output-directory`

5. Report event-level precision, recall, F1, false warnings per exam hour,
   detection delay, tracking failure rate, inference time, and results by
   lighting, eyeglasses, and webcam group.
6. Inspect complete incidents rather than scoring individual frames.

The split script assigns approximately 70% of anonymous participants to
development, 15% to validation, and 15% to final testing using a stable hash.
No participant can appear in more than one output split.

## Initial thresholds

All thresholds are in `faceMonitoringConfig.js`. Initial values are ±25° yaw,
−20° upward pitch, +25° downward pitch, 10 seconds for sustained head turns,
downward direction, or face absence, and four qualified
looking-away incidents within 60 seconds. These values require pilot
calibration before production use.

## Random Forest boundary

The repository currently contains no Random Forest artifact or trained feature
column contract. FaceMesh session aggregates are stored only as monitoring
report data. A Random Forest must be retrained or proven to contain equivalent
features, in the same order and with the same preprocessing, before these
aggregates can be supplied to it.

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

All thresholds are in `faceMonitoringConfig.js`. The shipped gates are ±25° yaw
and ±18° pitch (the pitch gates are tighter than this document's original ±20°/
+25° proposal), 10 seconds for sustained head turns, downward direction, or face
absence, and four qualified looking-away incidents within 60 seconds. These
values still require pilot calibration before production use.

## Head direction: two signals must agree

Euler pitch from the face transformation matrix is not sufficient on its own to
call a downward look. It shifts with camera placement, mixes with roll, mixes
with yaw once the head turns away, and jitters frame to frame — so a student who
never pitched their head could cross an 18° gate and be reported as looking down.

A second signal is therefore measured from the landmarks in
`faceLandmarker.worker.js` and carried on each observation as `poseCues`:

- `noseFraction` — where the nose sits along the face's own eye-to-chin axis,
  divided by that axis's length. Tucking the chin foreshortens the lower face
  faster than the upper face, so the nose slides measurably further down the
  axis. Projecting onto the face's own axis makes the figure independent of head
  roll, of distance from the camera, and of where the face sits in the frame.
- `faceSpanRatio` — eye-to-chin length against eye span, which shrinks as the
  face foreshortens in either pitch direction.

Calibration averages both into the baseline (`baselineNoseFraction`,
`baselineFaceSpanRatio`), so every later comparison is against this student on
this camera at this angle. `classifyHeadDirection` then decides as follows:

| Situation | Outcome |
| --- | --- |
| Pitch past the confirmed gate (13°) and the cue agrees | direction reported |
| Cue shift alone past the decisive delta (0.085) | direction reported |
| Pitch alone past 1.8× the gate | direction reported |
| Pitch past the gate but the cue contradicts it | no direction, treated as noise |
| Head turned past 20° of yaw | pitch gate ×1.4, cue not trusted |
| No cue on the frame or in the baseline | original euler-only gate |

The last row keeps baselines recorded before this change, and cameras that never
yield usable landmarks, working exactly as before.

This is a geometric and logical improvement covered by unit tests in
`scripts/test-facemesh.mjs`; it is **not** a measured accuracy gain. The
repository still contains no labelled evaluation data, so the precision, recall
and false-warnings-per-hour figures described above remain to be collected with
the procedure in this document.

## Random Forest boundary

The repository currently contains no Random Forest artifact or trained feature
column contract. FaceMesh session aggregates are stored only as monitoring
report data. A Random Forest must be retrained or proven to contain equivalent
features, in the same order and with the same preprocessing, before these
aggregates can be supplied to it.

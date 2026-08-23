# Webcam Violation Replay Task List

Scope: replay only applies to webcam-detected violations and must show only the last 10 seconds before the violation trigger. No post-trigger footage is stored or replayed.

Replayable violation types:
- `no_person`
- `multiple_people`
- `look_down`
- `low_brightness`
- `camera_off`

Non-replayable violation types remain unchanged:
- `tab_switch`
- `window_blur`
- `fullscreen_exit`
- `copy_attempt`
- `paste_attempt`
- `ctrl_c_attempt`
- `ctrl_v_attempt`
- `screenshot`

## Delivery Order

1. Apply the new Supabase SQL in [supabase/add-violation-evidence.sql](/C:/Users/Jenny/Desktop/Capstone/plp-examguard/supabase/add-violation-evidence.sql:1).
2. Add server endpoints and validation in `server/monitor-route.cjs`.
3. Add student-side rolling webcam buffer and upload flow in `public/js/exam.js`.
4. Add professor review UI and warning-adjustment handling in `public/js/admin.js`.
5. Test webcam replayable violations end-to-end before expanding UI polish.

## Database Changes

### [supabase/add-violation-evidence.sql](/C:/Users/Jenny/Desktop/Capstone/plp-examguard/supabase/add-violation-evidence.sql:1)

Build tasks:
- Create `public.violation_evidence` for replay metadata and professor review state.
- Keep evidence linked to `public.violation_events` through `violation_event_id`.
- Store only metadata in Postgres. The clip binary should live in Supabase Storage.
- Add indexes for professor review and per-session lookup.
- Add a `review_status` check constraint with `pending`, `confirmed`, `dismissed`.
- Add `warning_adjustment` with a default of `0`.
- Create a dedicated Storage bucket `violation-evidence`.

Columns expected by app code:
- `id`
- `violation_event_id`
- `owner_admin_id`
- `exam_id`
- `session_id`
- `student_id`
- `violation_type`
- `evidence_type`
- `storage_bucket`
- `storage_path`
- `mime_type`
- `clip_started_at`
- `clip_ended_at`
- `triggered_at`
- `duration_ms`
- `file_size_bytes`
- `review_status`
- `review_notes`
- `warning_adjustment`
- `reviewed_by`
- `reviewed_at`
- `created_at`
- `updated_at`

Follow-up decision:
- If you want strict bucket access rules later, add a separate SQL file for Storage policies once the upload strategy is finalized.

### [supabase/schema-bootstrap.sql](/C:/Users/Jenny/Desktop/Capstone/plp-examguard/supabase/schema-bootstrap.sql:129)

Build tasks:
- Do not move the new schema into this file yet unless you want all fresh installs to get it automatically.
- After the feature is stable, optionally fold the new table definition into bootstrap for new environments.
- Keep `sessions.camera_snapshots` unchanged for still images only.

## API Changes

### [server/monitor-route.cjs](/C:/Users/Jenny/Desktop/Capstone/plp-examguard/server/monitor-route.cjs:103)

Build tasks:
- Add a helper that returns `true` only for replayable webcam violation types.
- Extend violation insert flow so the client can optionally send pre-violation clip metadata.
- Add `POST /api/monitor/violation-evidence` for evidence registration after upload succeeds.
- Validate that:
- `sessionId`, `examId`, and `studentId` belong to the logged-in student.
- `violationEventId` belongs to the same session and professor scope.
- `violationType` is replayable before evidence is accepted.
- Add `GET /api/monitor/violation-evidence?examId=...&sessionId=...` for professor review.
- Add `PATCH /api/monitor/violation-evidence/:id/review` for professor decisions.
- On review patch, allow only:
- `confirmed`
- `dismissed`
- `reviewNotes`
- `warningAdjustment`
- Enforce `warningAdjustment` to be `0` or negative, with the first implementation limited to `0` and `-1`.
- Return both raw warning count and adjusted warning count in the response so the UI does not have to infer it.

Implementation notes:
- Keep `handleViolationInsert()` as the real-time event path.
- Do not block the professor alert on clip upload completion.
- The violation should exist even if clip upload fails.

### [server/db.cjs](/C:/Users/Jenny/Desktop/Capstone/plp-examguard/server/db.cjs:1)

Build tasks:
- No structural change required unless you decide to add a small transaction helper.
- Optional cleanup: add a lightweight helper for `queryOne()` if the new endpoints become repetitive.

### [server.js](/C:/Users/Jenny/Desktop/Capstone/plp-examguard/server.js:1)

Build tasks:
- Wire the new `POST` and `PATCH` monitor routes if `server/monitor-route.cjs` dispatch is path-based here.
- If direct multipart upload is chosen instead of signed URLs, increase request-size handling carefully.

Open decision:
- Prefer metadata registration plus signed upload over sending large video blobs through the existing JSON violation endpoint.

## Frontend Tasks

### [public/js/exam.js](/C:/Users/Jenny/Desktop/Capstone/plp-examguard/public/js/exam.js:3859)

Build tasks:
- Add a replayable-webcam-violation helper that matches the backend scope exactly.
- When camera monitoring starts, initialize a rolling `MediaRecorder` buffer from the existing webcam stream.
- Record fixed-size chunks, ideally 1000 ms each.
- Keep only the most recent 10 chunks in memory.
- Store enough metadata to reconstruct:
- clip start time
- clip end time
- trigger time
- estimated duration
- In `issueWarning()`:
- when the type is replayable, freeze the current 10-second buffer immediately
- do not record the next 10 seconds
- do not generate clips for non-webcam violations
- Keep the current still-image fallback in `_captureCameraViolationSnapshot()`.
- After `_notifyProfessorViolation()` succeeds, upload or register the clip against the created violation event.
- If upload fails:
- keep the violation event
- keep the still snapshot
- log a warning
- show no extra student-facing interruption
- Clean up recorder state when:
- exam ends
- camera is turned off
- session exits
- page unloads

Suggested sub-tasks by code area:
- Near `_startMotionDetection()`: start and stop the rolling buffer with camera lifecycle.
- Near `_isCameraViolationType()`: add a stricter replayable subset helper.
- Near `_notifyProfessorViolation()`: capture the returned `violation.id` so evidence can link to it.
- Near `issueWarning()`: freeze buffer and kick off upload without delaying warning UI.

### [public/js/admin.js](/C:/Users/Jenny/Desktop/Capstone/plp-examguard/public/js/admin.js:6711)

Build tasks:
- Add professor-side fetch helpers for evidence records.
- Extend the monitoring view so webcam violations can open a review modal or drawer.
- In the review UI, show:
- student name
- student ID
- exam title
- violation type
- trigger timestamp
- warning count at trigger time
- still snapshot if present
- embedded replay player for `Last 10 seconds before detection`
- Add professor actions:
- `Confirm violation`
- `Dismiss as false positive`
- optional review notes
- If dismissed, send `warningAdjustment = -1`.
- Update visible counts in monitoring and reports to show:
- raw warnings
- adjusted warnings
- review status badge
- Add empty states:
- replay unavailable
- upload still processing
- evidence missing

Suggested sub-tasks by code area:
- Near monitoring data fetches: pull evidence alongside session and violation data.
- Near violation alert rendering: add a review action only for replayable webcam events.
- Near session summary widgets: compute effective warnings as `rawWarnings + summedAdjustments`, floored at `0`.
- Near history/report views: surface `Pending review`, `Confirmed`, and `Dismissed`.

### [public/js/supabase-sync.js](/C:/Users/Jenny/Desktop/Capstone/plp-examguard/public/js/supabase-sync.js:1219)

Build tasks:
- No video data should be added to `sessions.camera_snapshots`.
- If you later cache evidence metadata client-side, add a new mapping for `violation_evidence` instead of extending sessions.
- For the first implementation, server-fetching evidence on demand is simpler and safer than syncing clips through local storage.

### [src/pages/AdminPage.jsx](/C:/Users/Jenny/Desktop/Capstone/plp-examguard/src/pages/AdminPage.jsx:785)

Build tasks:
- Add modal or drawer markup for replay review if you want it declarative in React markup instead of injected HTML.
- Add placeholders for:
- video player container
- review status badge
- notes textarea
- confirm and dismiss buttons
- Keep the label explicit: `Last 10 seconds before detection`.

### [src/pages/ExamPage.jsx](/C:/Users/Jenny/Desktop/Capstone/plp-examguard/src/pages/ExamPage.jsx:1)

Build tasks:
- No required UI change for students beyond the existing webcam monitoring flow.
- Optional: add a privacy note that webcam violations may retain the last 10 seconds before detection for professor review.

## Data And Warning Rules

### Warning calculation rule

Use:
- `rawWarnings = session.warnings`
- `adjustmentTotal = sum(violation_evidence.warning_adjustment for reviewed evidence)`
- `effectiveWarnings = max(0, rawWarnings + adjustmentTotal)`

Do not:
- delete rows from `violation_events`
- rewrite historical session activity logs
- overwrite the original warning count at trigger time inside the evidence record

### Review decision rules

Professor can:
- confirm a webcam violation with `warningAdjustment = 0`
- dismiss a false positive with `warningAdjustment = -1`

System should:
- preserve the original event
- preserve the original trigger-time warning count
- mark the review state for auditability

## Testing Checklist

### Database
- Apply [supabase/add-violation-evidence.sql](/C:/Users/Jenny/Desktop/Capstone/plp-examguard/supabase/add-violation-evidence.sql:1) successfully.
- Verify `violation_evidence` exists with indexes.
- Verify the `violation-evidence` bucket exists.

### API
- Create a replayable violation and confirm evidence registration succeeds.
- Create a non-replayable violation and confirm evidence is rejected.
- Dismiss a webcam false positive and verify adjusted warning counts update.
- Confirm professor review cannot cross session or owner boundaries.

### Frontend
- Trigger `look_down` and verify the replay shows only the 10 seconds before detection.
- Trigger `no_person`, `multiple_people`, `low_brightness`, and `camera_off`.
- Confirm `tab_switch` and `fullscreen_exit` do not show replay controls.
- Confirm still snapshots continue working even when clip upload fails.
- Confirm the professor can dismiss a false positive and see the effective warning count decrease.

## Suggested Commit Sequence

1. `db: add violation evidence schema`
2. `server: add violation evidence endpoints and review logic`
3. `exam: capture pre-violation webcam replay buffer`
4. `admin: add professor replay review workflow`
5. `reports: surface adjusted warning counts and review state`

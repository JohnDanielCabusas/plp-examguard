# Supabase bandwidth optimization

The pilot's 14.53 GB figure was outgoing traffic (egress), rather than stored
database size. The October 2 dashboard attributed 99.5% of that day's egress
to PostgREST. Frequent full-session reads included embedded camera images.

Student initial loads and portal refreshes now request session and exam
metadata. They exclude answers, activity logs, detection results, camera images,
archived attempts, question bodies, exam sections, and policy details. Portal
fallback polling runs every 30 seconds instead of 10 seconds; realtime updates
and the active exam's existing small status checks remain enabled.

Opening an exam or result loads that selected exam and the student's saved
attempts for it. Detailed-read failures stop the entry flow so missing answers
cannot be mistaken for an empty attempt. The waiting room uses metadata reads
and enters the same hydration flow when the exam starts.

Partial responses preserve previously loaded details. Explicit empty values
from a full response still reset a retake. Saving an unloaded summary omits
large fields so it cannot erase details it never downloaded. Overlapping session
and exam refreshes share a network request; completed or failed reads are not
cached.

Professor monitoring fallback reads cover only the selected exam and use session
summaries. Report refreshes cover only the selected exam and exclude current
camera snapshots while retaining answers, grades, and archived attempts for
grading and auditing. These fallback refreshes skip hidden tabs. Professor
initial loads still include details needed by existing editors, exports, and
evidence tools. Realtime messages and actual evidence viewing can still transfer
images; this change does not eliminate all bandwidth usage.

A read-only measurement of the old project's 273 sessions found 3,083,968 bytes
of full JSON versus 143,698 bytes of summary JSON, a 95.3% reduction for that
dataset. This is a payload comparison, not a guarantee of the same reduction in
total billed egress (which also includes other queries and services).

Validation: `npm run test:sync-payloads` exercises filtering, request sharing,
payload reduction, detail hydration, saved-answer preservation, retake resets,
report reads, and failed-read recovery. The summary columns were checked against
both configured Supabase projects using read-only transactions.

Deploy the updated application to apply these changes to hosted users; no schema
migration is required. Compare daily PostgREST egress during the next pilot.
Bandwidth already used remains in the billing cycle's usage total.

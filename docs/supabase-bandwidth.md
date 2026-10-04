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
and exam refreshes share a network request. Failed reads are never cached.

Professor monitoring fallback reads cover only the selected exam and use session
summaries. Report refreshes read summaries for the selected exam, then load full
details for the visible page. These fallback refreshes skip hidden tabs. Professor
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

## Steps 1–5 applied on October 4, 2026

1. **Private snapshot storage.** New embedded camera images are uploaded to the
   private `camera-snapshots` bucket. Session JSON stores an authenticated image
   route and object metadata. Content hashes make retries reuse the same image.
   Current and archived snapshots use the same mechanism. Students can read only
   their own evidence; owning professors and the system administrator can review
   it. The publishable key alone cannot read the bucket. Image responses support
   private browser caching and conditional requests. Upload failures or timeouts
   retain the original embedded image in the session instead of saving a broken
   reference. Local image originals remain available while writes run.

2. **Changed-field writes.** `DB.updateSession` supplies the changed field names.
   Existing rows receive a PATCH containing just those fields; answer saves do
   not resend camera images or archived history. New rows still receive complete
   inserts. A missing-row recovery requires a fully loaded attempt. Queued writes
   remain ordered, and pending new rows survive a refresh that arrives before
   their insert finishes.

3. **Short caches for stable data.** Profiles, course lists, and professor lists
   have a 60-second cache scoped to the current user. Realtime changes and local
   writes invalidate it; forced refresh bypasses it. Exam entry forces current
   enrollment/profile reads. Errors leave previous data available and permit a
   fresh retry. Exam status, answers, and warnings are not cached this way.

4. **Pagination and SQL totals.** Reports show 25 submissions per page; student
   history shows 10 entries per page. The selected page loads its own details.
   Filters reset pagination, and exports/selection continue to cover the whole
   filtered dataset rather than only one page. Required session/exam lists are
   collected in bounded requests, so the API's row cap does not silently omit
   records. Failed later pages do not publish an incomplete cache. Dashboard
   counts use an authenticated SQL aggregate endpoint with a 30-second cache and
   a complete local fallback. Existing detailed professor caches remain for
   editing, analytics, and export compatibility.

5. **Targeted indexes.** Installed indexes cover student/exam session lookups,
   owner/exam session lookups, exam session ordering, subject and owner exam lists,
   and JSONB course enrollment checks. Existing violation/evidence indexes remain.
   All six new query indexes were verified valid. The new database is currently
   too small to establish a realistic CPU improvement; review query plans again
   after a pilot instead of promising a fixed performance gain.

The additive migration was applied directly to project `vehjkwwamdjvhbduacod`.
It had no exam/session rows before verification, so there were no existing image
rows to migrate. The old project was left unchanged. Local `.env.local` now uses
the new project; its prior configuration is retained in an ignored backup.

`npm run supabase:optimize` applies the migration idempotently and migrates legacy
embedded snapshots on the new project. It refuses another project, saves original
JSON under ignored `.data/snapshot-migration`, checks downloaded image bytes, and
uses compare-and-swap updates so concurrent session edits are not overwritten.
It never deletes legacy evidence. If the database password changes, rerun this
command to refresh the private storage gateway credential hash.

Validation commands:

- `npm run test:bandwidth`: field patches, image failure fallback, retry safety,
  per-user cache behavior, retakes, lazy hydration, and complete paginated reads.
- `npm run test:bandwidth:browser`: 55 reachable report records, page detail loads,
  complete export scope, and filter resets in a real browser.
- `npm run test:bandwidth:database`: new-project integration with disposable
  fixtures, private image access, identical stored bytes, conditional caching,
  preserved archives, SQL counts, and index validity. Fixtures are cleaned up.

The production build and existing exam, retake, filter/export, monitoring,
violation review, and replay browser checks also passed. Deploy the updated app
with the new project's environment variables to apply the code to hosted users.
Restart an already-running local server to reload its database configuration.
Compare daily PostgREST egress during the next pilot. Already consumed bandwidth
remains in the billing cycle's total.

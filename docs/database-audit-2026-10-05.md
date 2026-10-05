# Database audit — October 5, 2026

Audited project `vehjkwwamdjvhbduacod` directly using PostgreSQL table sizes, index definitions and cumulative query statistics. Database size was approximately 13 MB, with no exam or session rows at the time of the audit. Student and professor records remained present. There was no evidence of gigabytes of table bloat. The earlier 14.53 GB alert concerned outgoing bandwidth, not stored database size.

Most observed query time came from Supabase infrastructure queries, including Realtime polling and catalog inspection. Cumulative statistics also contained earlier full session inserts; they are not a measurement of the updated application's pilot performance. Real pilot traffic is needed to establish bandwidth savings and capacity.

## Improvements applied

1. Replaced the evidence list's per-evidence self join with one warning-adjustment aggregate per selected session. Owner and session filters remain unchanged, and adjustment totals still include all peer evidence belonging to each selected session.
2. Added server-maintained `messages.updated_at` and owner/student timestamp indexes. Message polling now merges changes after its latest timestamp rather than repeatedly downloading all message bodies. Inclusive timestamp boundaries retain simultaneous updates. A complete reconciliation every 60 seconds also catches deletions if Realtime delivery fails.
3. Message history uses complete, scoped pagination. Changing users starts a fresh scoped read. Pending local inserts survive reconciliation, and failed pages preserve the previous complete cache and cursor.
4. Deferred activity-log loading now reads every scoped page and retains cached records if any page fails. Professor activity reads also check database errors before replacing their existing recent-history cache.
5. Added indexes for owner/student log reads and recent professor activity. Existing indexes and application records were retained.

The SQL changes in `supabase/query-audit-optimizations.sql` were applied directly to the new project. The optimization installer also applies this file on future runs. The application code must be deployed, and existing local application servers restarted, before those processes use the revised reads and evidence query.

## Verification

`npm run test:message-sync` covers a 1,237-message history, old-message edits/read receipts, incremental transfer, equal timestamp inserts, deletion reconciliation, failed-page recovery and user scope changes.

`npm run test:evidence-query:database` compares original and revised warning results against 1,500 temporary evidence records with mixed owners, adjustments and session filters. It also checks all five new indexes are valid. Temporary fixtures are rolled back; no application records are changed.

Existing bandwidth database tests verify private image access, exact image bytes, archived evidence preservation, answer-only updates and RLS. Pilot monitoring should compare daily PostgREST egress and request counts after deploying the updated application; this audit cannot guarantee a particular maximum number of students before a representative load test.

Supabase defines egress as data transmitted to clients and recommends smaller responses and fewer repeated calls: https://supabase.com/docs/guides/platform/manage-your-usage/egress

-- Additive and idempotent. No evidence, session or violation rows are changed.

-- The evidence table only accepted the original eight webcam types, so every
-- FaceMesh replay (no person, head turn, looking down, ...) was refused after
-- its video had already been uploaded. The server's REPLAYABLE_VIOLATION_TYPES
-- is the one list of replayable types; the database no longer keeps a copy.
alter table if exists public.violation_evidence
  drop constraint if exists violation_evidence_replayable_type_check;

-- Replays now hold at least the ten seconds before detection, plus up to five
-- seconds more from the recorder that was cut.
alter table if exists public.violation_evidence
  drop constraint if exists violation_evidence_duration_check;
alter table if exists public.violation_evidence
  add constraint violation_evidence_duration_check check (duration_ms >= 0 and duration_ms <= 20000);

-- The server removes a replay video whose evidence row was refused. Only the
-- server holds the gateway key, so clients still cannot delete evidence.
drop policy if exists violation_evidence_gateway_delete on storage.objects;
create policy violation_evidence_gateway_delete on storage.objects for delete to anon, authenticated
using (bucket_id = 'violation-evidence' and examguard_private.snapshot_gateway_allowed());

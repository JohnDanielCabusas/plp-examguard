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

-- Replay videos are webcam footage of students. The bucket used to be open to
-- the public key, which ships in every browser, so anyone could list and
-- download every replay. Now only the server, which holds the storage gateway
-- key, can read, write or remove them; professors watch replays through the
-- authenticated /api/monitor/violation-evidence/:id/file route.
drop policy if exists violation_evidence_anon_insert on storage.objects;
drop policy if exists violation_evidence_anon_select on storage.objects;
drop policy if exists violation_evidence_anon_update on storage.objects;
-- A storage smoke test used to add this temporary open delete policy.
drop policy if exists violation_evidence_smoke_test_delete on storage.objects;

drop policy if exists violation_evidence_gateway_select on storage.objects;
create policy violation_evidence_gateway_select on storage.objects for select to anon, authenticated
using (bucket_id = 'violation-evidence' and examguard_private.snapshot_gateway_allowed());
drop policy if exists violation_evidence_gateway_insert on storage.objects;
create policy violation_evidence_gateway_insert on storage.objects for insert to anon, authenticated
with check (bucket_id = 'violation-evidence' and examguard_private.snapshot_gateway_allowed());
drop policy if exists violation_evidence_gateway_update on storage.objects;
create policy violation_evidence_gateway_update on storage.objects for update to anon, authenticated
using (bucket_id = 'violation-evidence' and examguard_private.snapshot_gateway_allowed())
with check (bucket_id = 'violation-evidence' and examguard_private.snapshot_gateway_allowed());
-- The server removes a replay video whose evidence row was refused.
drop policy if exists violation_evidence_gateway_delete on storage.objects;
create policy violation_evidence_gateway_delete on storage.objects for delete to anon, authenticated
using (bucket_id = 'violation-evidence' and examguard_private.snapshot_gateway_allowed());

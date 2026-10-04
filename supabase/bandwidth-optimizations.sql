-- Additive migration: no exam, answer, history, or evidence rows are removed.
create schema if not exists examguard_private;
revoke all on schema examguard_private from public;
create table if not exists examguard_private.storage_gateway (
  id boolean primary key default true check (id), key_hash text not null
);
alter table examguard_private.storage_gateway enable row level security;
revoke all on examguard_private.storage_gateway from public, anon, authenticated;
-- Server-only table: explicitly deny client roles, including if another policy
-- or grant is added later. The owner-backed SECURITY DEFINER gateway still works.
drop policy if exists storage_gateway_deny_clients on examguard_private.storage_gateway;
create policy storage_gateway_deny_clients on examguard_private.storage_gateway
as restrictive for all to anon, authenticated using (false) with check (false);

create or replace function examguard_private.snapshot_gateway_allowed()
returns boolean language sql stable security definer
set search_path = pg_catalog, examguard_private, extensions
as $$
  select exists (
    select 1 from examguard_private.storage_gateway
    where key_hash = encode(extensions.digest(
      coalesce(nullif(current_setting('request.headers', true), '')::jsonb ->> 'x-examguard-storage-key', ''), 'sha256'), 'hex')
  );
$$;
grant usage on schema examguard_private to anon, authenticated;
revoke all on function examguard_private.snapshot_gateway_allowed() from public;
grant execute on function examguard_private.snapshot_gateway_allowed() to anon, authenticated;

create table if not exists public.camera_snapshot_assets (
  id text primary key,
  session_id text not null references public.sessions(id) on delete cascade,
  storage_path text not null unique,
  mime_type text not null,
  byte_size integer not null check (byte_size > 0 and byte_size <= 2097152),
  created_at timestamptz not null default now()
);
alter table public.camera_snapshot_assets enable row level security;
revoke all on public.camera_snapshot_assets from anon, authenticated;
-- Asset metadata is accessed through authenticated server routes, not directly
-- by browser database clients. The server's database owner bypasses RLS.
drop policy if exists camera_snapshot_assets_deny_clients on public.camera_snapshot_assets;
create policy camera_snapshot_assets_deny_clients on public.camera_snapshot_assets
as restrictive for all to anon, authenticated using (false) with check (false);
create index if not exists camera_snapshot_assets_session_idx on public.camera_snapshot_assets(session_id);

insert into storage.buckets(id, name, public, file_size_limit, allowed_mime_types)
values ('camera-snapshots', 'camera-snapshots', false, 2097152, array['image/jpeg','image/png','image/webp','image/gif'])
on conflict(id) do update set public=false, file_size_limit=excluded.file_size_limit, allowed_mime_types=excluded.allowed_mime_types;
drop policy if exists camera_snapshots_gateway_select on storage.objects;
create policy camera_snapshots_gateway_select on storage.objects for select to anon, authenticated
using (bucket_id='camera-snapshots' and examguard_private.snapshot_gateway_allowed());
drop policy if exists camera_snapshots_gateway_insert on storage.objects;
create policy camera_snapshots_gateway_insert on storage.objects for insert to anon, authenticated
with check (bucket_id='camera-snapshots' and examguard_private.snapshot_gateway_allowed());
drop policy if exists camera_snapshots_gateway_update on storage.objects;
create policy camera_snapshots_gateway_update on storage.objects for update to anon, authenticated
using (bucket_id='camera-snapshots' and examguard_private.snapshot_gateway_allowed())
with check (bucket_id='camera-snapshots' and examguard_private.snapshot_gateway_allowed());

drop policy if exists camera_snapshots_gateway_delete on storage.objects;
create policy camera_snapshots_gateway_delete on storage.objects for delete to anon, authenticated
using (bucket_id='camera-snapshots' and examguard_private.snapshot_gateway_allowed());

-- These support the exact predicates used by student portals, professor lists,
-- selected-exam monitoring, and course exam lists. Existing evidence indexes stay.
create index if not exists sessions_student_exam_idx on public.sessions(student_id, exam_id, id);
create index if not exists sessions_owner_exam_idx on public.sessions(owner_admin_id, exam_id, id);
create index if not exists sessions_exam_created_idx on public.sessions(exam_id, created_at, id);
create index if not exists exams_subject_created_idx on public.exams(subject_id, created_at, id);
create index if not exists exams_owner_created_idx on public.exams(owner_admin_id, created_at, id);
create index if not exists students_enrolled_subjects_gin_idx on public.students using gin(enrolled_subjects jsonb_path_ops);

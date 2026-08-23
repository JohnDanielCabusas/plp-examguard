begin;

-- Idempotent corrective migration for webcam violation replay.
-- Clips are kept in private Supabase Storage; Postgres stores metadata only.

create table if not exists public.violation_evidence (
  id text primary key,
  violation_event_id text not null references public.violation_events(id) on delete cascade,
  owner_admin_id text,
  exam_id text not null,
  session_id text not null,
  student_id text not null,
  violation_type text not null,
  evidence_type text not null default 'pre_violation_webcam_clip',
  storage_bucket text not null default 'violation-evidence',
  storage_path text not null,
  mime_type text not null default 'video/webm',
  clip_started_at timestamptz not null,
  clip_ended_at timestamptz not null,
  triggered_at timestamptz not null,
  duration_ms integer not null default 0,
  file_size_bytes bigint,
  review_status text not null default 'pending',
  review_notes text,
  warning_adjustment integer not null default 0,
  reviewed_by text,
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint violation_evidence_review_status_check
    check (review_status in ('pending', 'confirmed', 'dismissed')),
  constraint violation_evidence_warning_adjustment_check
    check (warning_adjustment <= 0),
  constraint violation_evidence_time_window_check
    check (clip_started_at <= clip_ended_at and clip_ended_at <= triggered_at),
  constraint violation_evidence_duration_check
    check (duration_ms >= 0 and duration_ms <= 10000),
  constraint violation_evidence_replayable_type_check
    check (violation_type in ('no_person', 'multiple_people', 'look_down', 'low_brightness', 'camera_off'))
);

create unique index if not exists violation_evidence_violation_event_unique_idx
  on public.violation_evidence (violation_event_id);
create index if not exists violation_evidence_owner_exam_created_idx
  on public.violation_evidence (owner_admin_id, exam_id, created_at desc);
create index if not exists violation_evidence_session_created_idx
  on public.violation_evidence (session_id, created_at desc);
create index if not exists violation_evidence_review_status_idx
  on public.violation_evidence (review_status, created_at desc);

alter table public.violation_events enable row level security;
alter table public.violation_evidence enable row level security;

drop policy if exists violation_events_no_direct_client_access on public.violation_events;
create policy violation_events_no_direct_client_access
  on public.violation_events
  for all
  to anon, authenticated
  using (false)
  with check (false);

drop policy if exists violation_evidence_no_direct_client_access on public.violation_evidence;
create policy violation_evidence_no_direct_client_access
  on public.violation_evidence
  for all
  to anon, authenticated
  using (false)
  with check (false);

create or replace function public.set_violation_evidence_updated_at()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists violation_evidence_set_updated_at on public.violation_evidence;
create trigger violation_evidence_set_updated_at
before update on public.violation_evidence
for each row
execute function public.set_violation_evidence_updated_at();

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'violation-evidence',
  'violation-evidence',
  false,
  10485760,
  array['video/webm', 'video/mp4']
)
on conflict (id) do update
set public = excluded.public,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

-- The app server uses the configured publishable key when a service-role key
-- is unavailable. Professor playback still passes through the app's own
-- authenticated endpoint; these policies only authorize that Storage request.
drop policy if exists violation_evidence_anon_insert on storage.objects;
create policy violation_evidence_anon_insert
on storage.objects
for insert
to anon
with check (bucket_id = 'violation-evidence');

drop policy if exists violation_evidence_anon_select on storage.objects;
create policy violation_evidence_anon_select
on storage.objects
for select
to anon
using (bucket_id = 'violation-evidence');

drop policy if exists violation_evidence_anon_update on storage.objects;
create policy violation_evidence_anon_update
on storage.objects
for update
to anon
using (bucket_id = 'violation-evidence')
with check (bucket_id = 'violation-evidence');

commit;

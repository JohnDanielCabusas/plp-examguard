begin;

-- ============================================================
-- ExamGuard — consolidated incremental schema.
-- Assumes the original base tables (professors, superadmin, students,
-- subjects, exams, sessions, logs, settings) already exist. Every
-- statement here is idempotent, so this file is safe to re-run in full
-- against a database that already has some/all of these changes applied.
-- ============================================================

-- ── Multi-tenant scoping: each professor's data is isolated ──
alter table if exists public.students add column if not exists owner_admin_id text;
alter table if exists public.subjects add column if not exists owner_admin_id text;
alter table if exists public.exams    add column if not exists owner_admin_id text;
alter table if exists public.sessions add column if not exists owner_admin_id text;
alter table if exists public.logs     add column if not exists owner_admin_id text;

-- Backfill owner_admin_id for rows created before multi-tenancy existed
with first_professor as (
  select id from public.professors order by created_at nulls first, id limit 1
)
update public.subjects set owner_admin_id = (select id from first_professor) where owner_admin_id is null;

with first_professor as (
  select id from public.professors order by created_at nulls first, id limit 1
)
update public.students set owner_admin_id = (select id from first_professor) where owner_admin_id is null;

update public.exams e
set owner_admin_id = s.owner_admin_id
from public.subjects s
where e.subject_id = s.id and e.owner_admin_id is null;

with first_professor as (
  select id from public.professors order by created_at nulls first, id limit 1
)
update public.exams set owner_admin_id = (select id from first_professor) where owner_admin_id is null;

update public.sessions sess
set owner_admin_id = e.owner_admin_id
from public.exams e
where sess.exam_id = e.id and sess.owner_admin_id is null;

with first_professor as (
  select id from public.professors order by created_at nulls first, id limit 1
)
update public.sessions set owner_admin_id = (select id from first_professor) where owner_admin_id is null;

update public.logs l
set owner_admin_id = sess.owner_admin_id
from public.sessions sess
where l.session_id = sess.id and l.owner_admin_id is null;

update public.logs l
set owner_admin_id = e.owner_admin_id
from public.exams e
where l.exam_id = e.id and l.owner_admin_id is null;

with first_professor as (
  select id from public.professors order by created_at nulls first, id limit 1
)
update public.logs set owner_admin_id = (select id from first_professor) where owner_admin_id is null;

-- ── Profile fields ──
alter table if exists public.professors add column if not exists department text;
alter table if exists public.professors alter column username drop not null;
alter table if exists public.professors alter column password drop not null;
alter table if exists public.superadmin
  add column if not exists email text,
  add column if not exists department text;
alter table if exists public.superadmin alter column email drop not null;

-- ── Feature columns ──
alter table if exists public.sessions add column if not exists essay_grades jsonb not null default '{}'::jsonb;
alter table if exists public.sessions add column if not exists ai_detections jsonb not null default '{}'::jsonb;
alter table if exists public.sessions add column if not exists camera_snapshots jsonb not null default '[]'::jsonb;
alter table if exists public.settings add column if not exists claude_api_key text;
alter table if exists public.exams add column if not exists excluded_student_ids jsonb not null default '[]'::jsonb;
alter table if exists public.exams add column if not exists exam_policies jsonb not null default '[]'::jsonb;
alter table if exists public.subjects add column if not exists school_year text;
alter table if exists public.subjects add column if not exists manage_access text;
update public.subjects set manage_access = 'restrict' where manage_access is null or btrim(coalesce(manage_access, '')) = '';
alter table if exists public.subjects alter column manage_access set default 'restrict';

-- Exams may optionally require an access code. When blank, students can open
-- the exam directly from their course page; when present, the code remains
-- globally unique and acts as a lock.
alter table if exists public.exams alter column code drop not null;
update public.exams set code = null where btrim(coalesce(code, '')) = '';
alter table if exists public.exams drop constraint if exists exams_code_key;
drop index if exists public.exams_code_key;
create unique index if not exists exams_code_key
on public.exams using btree (code)
where code is not null;

-- Course code uniqueness: a professor may reuse the same course code across
-- different year-level/section offerings — enforced at the app layer
-- (saveSubject() in admin.js), not in the database.
alter table if exists public.subjects drop constraint if exists subjects_code_key;
drop index if exists public.subjects_owner_admin_id_code_key;

-- ── In-exam chat / help messages ──
-- A lightweight 1:1 message thread between a student and their professor,
-- used during an exam for tech issues, clarifications, and the professor's
-- replies. owner_admin_id scopes each row to a professor so realtime routing
-- and the multi-tenant pull filters work the same way they do for every other
-- table here.
create table if not exists public.messages (
  id text primary key,
  owner_admin_id text,
  professor_id text,
  student_id text,
  exam_id text,
  session_id text,
  sender_role text not null default 'student',
  type text not null default 'message',           -- 'message' | 'report'
  report_category text,                            -- webcam | loading | question | other (reports only)
  body text,
  created_at timestamptz not null default now(),
  read_at timestamptz
);
create index if not exists messages_owner_admin_id_idx on public.messages (owner_admin_id);
create index if not exists messages_student_id_idx on public.messages (student_id);
create index if not exists messages_exam_id_idx on public.messages (exam_id);

-- Append-only professor alert feed for suspicious exam behavior. This is used
-- by the app server polling endpoint so the professor UI can update instantly
-- without depending on Supabase Realtime websocket delivery.
create table if not exists public.violation_events (
  id text primary key,
  owner_admin_id text,
  exam_id text not null,
  session_id text not null,
  student_id text not null,
  student_name text,
  violation_type text not null,
  detail text,
  warning_count integer not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists violation_events_owner_admin_exam_created_idx
  on public.violation_events (owner_admin_id, exam_id, created_at desc);
create index if not exists violation_events_session_created_idx
  on public.violation_events (session_id, created_at desc);
alter table if exists public.violation_events enable row level security;

-- Publish core live-monitoring tables to Supabase Realtime so professor and
-- student clients receive pushes without requiring a browser refresh.
-- Guarded so re-running this file doesn't error with "relation is already member".
do $$
declare
  realtime_table text;
begin
  foreach realtime_table in array array['messages', 'sessions', 'logs']
  loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = realtime_table
    ) then
      execute format('alter publication supabase_realtime add table public.%I', realtime_table);
    end if;
  end loop;
exception
  when undefined_object then
    -- supabase_realtime publication doesn't exist on this deployment; skip.
    null;
end $$;

-- ── Per-student camera exemption ──
-- Lets a professor waive the webcam requirement for a single student on a
-- single exam (e.g. their webcam is broken), without turning it off for the
-- whole class. Mirrors exams.excluded_student_ids in shape.
alter table if exists public.exams add column if not exists camera_exempt_student_ids jsonb not null default '[]'::jsonb;

-- ── Default accounts ──
insert into public.superadmin (id, username, password, name, email, department)
values (
  'main',
  'sysadmin',
  'pbkdf2_sha256$210000$RJXkCxVfJy2ylVAlFoVO5g==$UmOBzFrUOtuBsNnoOFBXaG9EIoRtoEZ0CiYodPNjYx0=',
  'System Administrator',
  'sysadmin@school.edu',
  null
)
on conflict (id) do update
set
  email = coalesce(public.superadmin.email, excluded.email),
  department = coalesce(public.superadmin.department, excluded.department);

insert into public.professors (id, username, password, name, email, department)
select
  'admin1',
  'admin',
  'pbkdf2_sha256$210000$RJXkCxVfJy2ylVAlFoVO5g==$UmOBzFrUOtuBsNnoOFBXaG9EIoRtoEZ0CiYodPNjYx0=',
  'Administrator',
  'admin@school.edu',
  null
where not exists (
  select 1
  from public.professors
  where id = 'admin1'
     or lower(username) = lower('admin')
     or lower(email) = lower('admin@school.edu')
);

commit;

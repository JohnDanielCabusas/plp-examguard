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
alter table if exists public.superadmin
  add column if not exists email text,
  add column if not exists department text;
alter table if exists public.superadmin alter column email drop not null;

-- ── Feature columns ──
alter table if exists public.sessions add column if not exists ai_detections jsonb not null default '{}'::jsonb;
alter table if exists public.sessions add column if not exists camera_snapshots jsonb not null default '[]'::jsonb;
alter table if exists public.settings add column if not exists claude_api_key text;
alter table if exists public.exams add column if not exists excluded_student_ids jsonb not null default '[]'::jsonb;
alter table if exists public.subjects add column if not exists school_year text;

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

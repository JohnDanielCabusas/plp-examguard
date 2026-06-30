begin;

-- Incremental migration for latest admin/system-admin persistence changes.
-- Assumes the original base schema has already been applied.

alter table if exists public.professors
  add column if not exists department text;

alter table if exists public.superadmin
  add column if not exists email text,
  add column if not exists department text;

alter table if exists public.superadmin
  alter column email drop not null;

alter table if exists public.sessions
  add column if not exists ai_detections jsonb not null default '{}'::jsonb;

alter table if exists public.subjects
  drop constraint if exists subjects_code_key;

create unique index if not exists subjects_owner_admin_id_code_key
  on public.subjects (owner_admin_id, code);

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

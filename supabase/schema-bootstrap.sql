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

insert into public.superadmin (id, username, password, name, email, department)
values (
  'main',
  'sysadmin',
  'admin123',
  'System Administrator',
  'sysadmin@school.edu',
  null
)
on conflict (id) do update
set
  email = coalesce(public.superadmin.email, excluded.email),
  department = coalesce(public.superadmin.department, excluded.department);

commit;

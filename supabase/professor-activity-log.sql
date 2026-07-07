begin;

-- Professor activity log: recent professor activity (logins, course/exam/
-- student changes) plus system-admin actions on professor accounts, shown
-- on the system admin dashboard. Logins and account changes are written
-- server-side (auth-service.cjs); course/exam/student activity is written
-- client-side by the professor's own admin panel (data.js).
create table if not exists public.professor_activity_log (
  id text primary key,
  professor_id text,
  professor_name text not null,
  action text not null,
  entity_type text,
  entity_name text,
  details text,
  created_at timestamptz not null default now()
);
alter table if exists public.professor_activity_log add column if not exists entity_type text;
alter table if exists public.professor_activity_log add column if not exists entity_name text;

alter table public.professor_activity_log enable row level security;
drop policy if exists "app role access professor_activity_log" on public.professor_activity_log;
create policy "app role access professor_activity_log"
on public.professor_activity_log
for all
to anon, authenticated
using (auth.role() in ('anon', 'authenticated'))
with check (auth.role() in ('anon', 'authenticated'));

commit;

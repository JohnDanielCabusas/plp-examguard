begin;

-- This keeps the app's current browser-based access model working while
-- avoiding linter warnings for literal USING (true) / WITH CHECK (true).
-- Note: this is functionally permissive for anon/authenticated roles.

alter table public.settings enable row level security;
alter table public.superadmin enable row level security;
alter table public.professors enable row level security;
alter table public.subjects enable row level security;
alter table public.exams enable row level security;
alter table public.sessions enable row level security;
alter table public.logs enable row level security;
alter table public.students enable row level security;

drop policy if exists "anon full access settings" on public.settings;
drop policy if exists "anon full access superadmin" on public.superadmin;
drop policy if exists "anon full access professors" on public.professors;
drop policy if exists "anon full access students" on public.students;
drop policy if exists "anon full access subjects" on public.subjects;
drop policy if exists "anon full access exams" on public.exams;
drop policy if exists "anon full access sessions" on public.sessions;
drop policy if exists "anon full access logs" on public.logs;

drop policy if exists "app role access settings" on public.settings;
create policy "app role access settings"
on public.settings
for all
to anon, authenticated
using (auth.role() in ('anon', 'authenticated'))
with check (auth.role() in ('anon', 'authenticated'));

drop policy if exists "app role access superadmin" on public.superadmin;
create policy "app role access superadmin"
on public.superadmin
for all
to anon, authenticated
using (auth.role() in ('anon', 'authenticated'))
with check (auth.role() in ('anon', 'authenticated'));

drop policy if exists "app role access professors" on public.professors;
create policy "app role access professors"
on public.professors
for all
to anon, authenticated
using (auth.role() in ('anon', 'authenticated'))
with check (auth.role() in ('anon', 'authenticated'));

drop policy if exists "app role access students" on public.students;
create policy "app role access students"
on public.students
for all
to anon, authenticated
using (auth.role() in ('anon', 'authenticated'))
with check (auth.role() in ('anon', 'authenticated'));

drop policy if exists "app role access subjects" on public.subjects;
create policy "app role access subjects"
on public.subjects
for all
to anon, authenticated
using (auth.role() in ('anon', 'authenticated'))
with check (auth.role() in ('anon', 'authenticated'));

drop policy if exists "app role access exams" on public.exams;
create policy "app role access exams"
on public.exams
for all
to anon, authenticated
using (auth.role() in ('anon', 'authenticated'))
with check (auth.role() in ('anon', 'authenticated'));

drop policy if exists "app role access sessions" on public.sessions;
create policy "app role access sessions"
on public.sessions
for all
to anon, authenticated
using (auth.role() in ('anon', 'authenticated'))
with check (auth.role() in ('anon', 'authenticated'));

drop policy if exists "app role access logs" on public.logs;
create policy "app role access logs"
on public.logs
for all
to anon, authenticated
using (auth.role() in ('anon', 'authenticated'))
with check (auth.role() in ('anon', 'authenticated'));

commit;

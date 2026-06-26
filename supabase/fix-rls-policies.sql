begin;

alter table public.settings enable row level security;
alter table public.admins enable row level security;
alter table public.subjects enable row level security;
alter table public.exams enable row level security;
alter table public.sessions enable row level security;
alter table public.logs enable row level security;

drop policy if exists "anon full access settings" on public.settings;
drop policy if exists "anon full access admins" on public.admins;
drop policy if exists "anon full access subjects" on public.subjects;
drop policy if exists "anon full access exams" on public.exams;
drop policy if exists "anon full access sessions" on public.sessions;
drop policy if exists "anon full access logs" on public.logs;

drop policy if exists "public read settings" on public.settings;
create policy "public read settings"
on public.settings
for select
to anon, authenticated
using (true);

drop policy if exists "authenticated full access admins" on public.admins;
create policy "authenticated full access admins"
on public.admins
for all
to authenticated
using (auth.role() = 'authenticated')
with check (auth.role() = 'authenticated');

drop policy if exists "public read subjects" on public.subjects;
create policy "public read subjects"
on public.subjects
for select
to anon, authenticated
using (true);

drop policy if exists "authenticated full access subjects" on public.subjects;
create policy "authenticated full access subjects"
on public.subjects
for all
to authenticated
using (auth.role() = 'authenticated')
with check (auth.role() = 'authenticated');

drop policy if exists "public read exams" on public.exams;
create policy "public read exams"
on public.exams
for select
to anon, authenticated
using (true);

drop policy if exists "authenticated full access exams" on public.exams;
create policy "authenticated full access exams"
on public.exams
for all
to authenticated
using (auth.role() = 'authenticated')
with check (auth.role() = 'authenticated');

drop policy if exists "public read sessions" on public.sessions;
create policy "public read sessions"
on public.sessions
for select
to anon, authenticated
using (true);

drop policy if exists "authenticated full access sessions" on public.sessions;
create policy "authenticated full access sessions"
on public.sessions
for all
to authenticated
using (auth.role() = 'authenticated')
with check (auth.role() = 'authenticated');

drop policy if exists "public read logs" on public.logs;
create policy "public read logs"
on public.logs
for select
to anon, authenticated
using (true);

drop policy if exists "authenticated full access logs" on public.logs;
create policy "authenticated full access logs"
on public.logs
for all
to authenticated
using (auth.role() = 'authenticated')
with check (auth.role() = 'authenticated');

commit;

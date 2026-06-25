begin;

create table if not exists public.settings (
  id text primary key,
  school_name text not null,
  logo_url text,
  department text,
  admin_name text,
  admin_email text,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.admins (
  id text primary key,
  username text not null unique,
  password text not null,
  name text not null,
  email text not null unique,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.students (
  id text primary key,
  student_id text not null unique,
  name text not null,
  email text unique,
  password text,
  year_level text,
  section text,
  year_section text,
  department text,
  program text,
  enrolled_subjects jsonb not null default '[]'::jsonb,
  archived boolean not null default false,
  archived_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.subjects (
  id text primary key,
  code text not null unique,
  name text not null,
  description text,
  archived boolean not null default false,
  archived_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.exams (
  id text primary key,
  subject_id text not null references public.subjects(id) on delete restrict,
  title text not null,
  description text,
  time_limit integer not null,
  code text not null unique,
  status text not null,
  shuffle_questions boolean not null default false,
  shuffle_answers boolean not null default false,
  require_camera boolean not null default false,
  require_ai_detection boolean not null default false,
  allow_review boolean not null default false,
  scoring_released boolean not null default false,
  questions jsonb not null default '[]'::jsonb,
  target_year_levels jsonb not null default '[]'::jsonb,
  target_sections jsonb not null default '[]'::jsonb,
  started_at timestamptz,
  closed_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.sessions (
  id text primary key,
  exam_id text not null references public.exams(id) on delete cascade,
  exam_code text,
  student_id text not null,
  student_name text not null,
  year_level text,
  section text,
  year_section text,
  department text,
  program text,
  start_time timestamptz,
  end_time timestamptz,
  answers jsonb not null default '{}'::jsonb,
  warnings integer not null default 0,
  activities jsonb not null default '[]'::jsonb,
  score integer,
  max_score integer,
  submitted boolean not null default false,
  auto_submitted boolean not null default false,
  score_released boolean not null default false,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.logs (
  id text primary key,
  session_id text,
  student_id text,
  exam_id text,
  type text not null,
  details text,
  timestamp timestamptz not null default timezone('utc', now()),
  created_at timestamptz not null default timezone('utc', now())
);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at = timezone('utc', now());
  return new;
end;
$$;

drop trigger if exists trg_settings_updated_at on public.settings;
create trigger trg_settings_updated_at
before update on public.settings
for each row
execute function public.set_updated_at();

drop trigger if exists trg_admins_updated_at on public.admins;
create trigger trg_admins_updated_at
before update on public.admins
for each row
execute function public.set_updated_at();

drop trigger if exists trg_students_updated_at on public.students;
create trigger trg_students_updated_at
before update on public.students
for each row
execute function public.set_updated_at();

drop trigger if exists trg_subjects_updated_at on public.subjects;
create trigger trg_subjects_updated_at
before update on public.subjects
for each row
execute function public.set_updated_at();

drop trigger if exists trg_exams_updated_at on public.exams;
create trigger trg_exams_updated_at
before update on public.exams
for each row
execute function public.set_updated_at();

drop trigger if exists trg_sessions_updated_at on public.sessions;
create trigger trg_sessions_updated_at
before update on public.sessions
for each row
execute function public.set_updated_at();

alter table public.settings enable row level security;
alter table public.admins enable row level security;
alter table public.students enable row level security;
alter table public.subjects enable row level security;
alter table public.exams enable row level security;
alter table public.sessions enable row level security;
alter table public.logs enable row level security;

drop policy if exists "dev full access settings" on public.settings;
drop policy if exists "anon full access settings" on public.settings;
drop policy if exists "public read settings" on public.settings;
create policy "public read settings"
on public.settings
for select
to anon, authenticated
using (true);

drop policy if exists "dev full access admins" on public.admins;
drop policy if exists "anon full access admins" on public.admins;
drop policy if exists "authenticated full access admins" on public.admins;
create policy "authenticated full access admins"
on public.admins
for all
to authenticated
using (auth.role() = 'authenticated')
with check (auth.role() = 'authenticated');

drop policy if exists "dev full access students" on public.students;
drop policy if exists "public read students" on public.students;
create policy "public read students"
on public.students
for select
to anon, authenticated
using (true);

drop policy if exists "anon full access students" on public.students;
drop policy if exists "anon insert students" on public.students;
create policy "anon insert students"
on public.students
for insert
to anon
with check (
  length(trim(id)) > 0
  and student_id ~ '^\d{2}-\d{5}$'
  and length(trim(name)) > 0
  and (email is null or email ~* '^[A-Z0-9._%+-]+@plpasig\.edu\.ph$')
  and (password is null or length(password) >= 6)
);

drop policy if exists "anon update students" on public.students;
create policy "anon update students"
on public.students
for update
to anon
using (
  student_id ~ '^\d{2}-\d{5}$'
  and (email is null or email ~* '^[A-Z0-9._%+-]+@plpasig\.edu\.ph$')
)
with check (
  length(trim(id)) > 0
  and student_id ~ '^\d{2}-\d{5}$'
  and length(trim(name)) > 0
  and (email is null or email ~* '^[A-Z0-9._%+-]+@plpasig\.edu\.ph$')
  and (password is null or length(password) >= 6)
);

drop policy if exists "authenticated full access students" on public.students;
create policy "authenticated full access students"
on public.students
for all
to authenticated
using (auth.role() = 'authenticated')
with check (auth.role() = 'authenticated');

drop policy if exists "dev full access subjects" on public.subjects;
drop policy if exists "anon full access subjects" on public.subjects;
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

drop policy if exists "dev full access exams" on public.exams;
drop policy if exists "anon full access exams" on public.exams;
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

drop policy if exists "dev full access sessions" on public.sessions;
drop policy if exists "anon full access sessions" on public.sessions;
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

drop policy if exists "dev full access logs" on public.logs;
drop policy if exists "anon full access logs" on public.logs;
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

do $$
declare
  tbl text;
begin
  foreach tbl in array array['settings', 'students', 'subjects', 'exams', 'sessions', 'logs']
  loop
    if not exists (
      select 1
      from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = tbl
    ) then
      execute format('alter publication supabase_realtime add table public.%I', tbl);
    end if;
  end loop;
end;
$$;

insert into public.settings (
  id,
  school_name,
  logo_url,
  department,
  admin_name,
  admin_email
)
values (
  'main',
  'Pamantasan ng Lungsod ng Pasig',
  'https://plpasig.edu.ph/wp-content/uploads/2023/01/cropped-logo120.png',
  null,
  'Administrator',
  'admin@school.edu'
)
on conflict (id) do update
set
  school_name = excluded.school_name,
  logo_url = excluded.logo_url,
  department = excluded.department,
  admin_name = excluded.admin_name,
  admin_email = excluded.admin_email,
  updated_at = timezone('utc', now());

commit;

begin;

alter table if exists public.exams
  add column if not exists excluded_student_ids jsonb not null default '[]'::jsonb;

commit;

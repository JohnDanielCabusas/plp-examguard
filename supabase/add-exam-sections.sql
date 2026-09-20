-- Persist professor-defined exam sections independently from the question list.
-- Safe to run repeatedly on existing projects.
alter table if exists public.exams
  add column if not exists exam_sections jsonb not null default '[]'::jsonb;

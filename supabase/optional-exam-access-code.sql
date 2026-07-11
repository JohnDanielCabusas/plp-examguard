begin;

-- Allow exams to have no access code at all.
alter table if exists public.exams alter column code drop not null;

-- Normalize blank strings to null so unlocked exams don't collide.
update public.exams
set code = null
where btrim(coalesce(code, '')) = '';

-- Keep access codes unique only when a code is actually present.
alter table if exists public.exams drop constraint if exists exams_code_key;
drop index if exists public.exams_code_key;
create unique index if not exists exams_code_key
on public.exams using btree (code)
where code is not null;

commit;

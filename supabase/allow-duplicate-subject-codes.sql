begin;

alter table if exists public.subjects
  drop constraint if exists subjects_code_key;

drop index if exists public.subjects_code_key;

create unique index if not exists subjects_owner_admin_id_code_key
  on public.subjects (owner_admin_id, code);

commit;

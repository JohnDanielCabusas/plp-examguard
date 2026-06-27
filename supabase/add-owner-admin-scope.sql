begin;

alter table if exists public.students
  add column if not exists owner_admin_id text;

alter table if exists public.subjects
  add column if not exists owner_admin_id text;

alter table if exists public.exams
  add column if not exists owner_admin_id text;

alter table if exists public.sessions
  add column if not exists owner_admin_id text;

alter table if exists public.logs
  add column if not exists owner_admin_id text;

with first_professor as (
  select id
  from public.professors
  order by created_at nulls first, id
  limit 1
)
update public.subjects
set owner_admin_id = (select id from first_professor)
where owner_admin_id is null;

with first_professor as (
  select id
  from public.professors
  order by created_at nulls first, id
  limit 1
)
update public.students
set owner_admin_id = (select id from first_professor)
where owner_admin_id is null;

update public.exams e
set owner_admin_id = s.owner_admin_id
from public.subjects s
where e.subject_id = s.id
  and e.owner_admin_id is null;

with first_professor as (
  select id
  from public.professors
  order by created_at nulls first, id
  limit 1
)
update public.exams
set owner_admin_id = (select id from first_professor)
where owner_admin_id is null;

update public.sessions sess
set owner_admin_id = e.owner_admin_id
from public.exams e
where sess.exam_id = e.id
  and sess.owner_admin_id is null;

with first_professor as (
  select id
  from public.professors
  order by created_at nulls first, id
  limit 1
)
update public.sessions
set owner_admin_id = (select id from first_professor)
where owner_admin_id is null;

update public.logs l
set owner_admin_id = sess.owner_admin_id
from public.sessions sess
where l.session_id = sess.id
  and l.owner_admin_id is null;

update public.logs l
set owner_admin_id = e.owner_admin_id
from public.exams e
where l.exam_id = e.id
  and l.owner_admin_id is null;

with first_professor as (
  select id
  from public.professors
  order by created_at nulls first, id
  limit 1
)
update public.logs
set owner_admin_id = (select id from first_professor)
where owner_admin_id is null;

commit;

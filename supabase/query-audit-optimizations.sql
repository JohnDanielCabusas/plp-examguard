-- Changes-only message polling, including read receipts and edits.
alter table public.messages add column if not exists updated_at timestamptz not null default now();
create or replace function public.touch_message_updated_at()
returns trigger language plpgsql set search_path = pg_catalog
as $$ begin new.updated_at = clock_timestamp(); return new; end; $$;
drop trigger if exists messages_touch_updated_at on public.messages;
create trigger messages_touch_updated_at before insert or update on public.messages
for each row execute function public.touch_message_updated_at();
create index if not exists messages_owner_updated_idx on public.messages(owner_admin_id, updated_at);
create index if not exists messages_student_updated_idx on public.messages(student_id, updated_at);
create index if not exists logs_owner_id_idx on public.logs(owner_admin_id, id);
create index if not exists logs_student_id_idx on public.logs(student_id, id);
create index if not exists professor_activity_created_idx on public.professor_activity_log(created_at desc);

-- ============================================================
-- ExamGuard — professor-to-professor exam sharing
-- Apply this after the existing bootstrap schema.
-- Safe to re-run.
-- ============================================================

create table if not exists public.exam_shares (
  id text primary key,
  exam_id text,
  sender_professor_id text,
  sender_professor_name text,
  sender_email text,
  recipient_professor_id text not null,
  recipient_professor_name text,
  recipient_email text,
  source_subject_id text,
  source_subject_code text,
  source_subject_name text,
  exam_title text,
  share_mode text not null default 'clone_exam',
  message text,
  status text not null default 'pending',
  decline_reason text,
  recipient_seen_at timestamptz,
  responded_at timestamptz,
  accepted_exam_id text,
  accepted_subject_id text,
  snapshot jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint exam_shares_share_mode_check check (share_mode in ('clone_exam')),
  constraint exam_shares_status_check check (status in ('pending', 'accepted', 'declined', 'cancelled'))
);

create index if not exists exam_shares_sender_professor_id_idx
on public.exam_shares (sender_professor_id);

create index if not exists exam_shares_recipient_professor_id_idx
on public.exam_shares (recipient_professor_id);

create index if not exists exam_shares_status_idx
on public.exam_shares (status);

create index if not exists exam_shares_exam_id_idx
on public.exam_shares (exam_id);

create index if not exists exam_shares_created_at_idx
on public.exam_shares (created_at desc);

create or replace function public.set_exam_shares_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists exam_shares_set_updated_at on public.exam_shares;
create trigger exam_shares_set_updated_at
before update on public.exam_shares
for each row
execute function public.set_exam_shares_updated_at();

do $$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'exam_shares'
  ) then
    alter publication supabase_realtime add table public.exam_shares;
  end if;
exception
  when undefined_object then
    null;
end $$;

alter table public.exam_shares enable row level security;

drop policy if exists "app role access exam shares" on public.exam_shares;
create policy "app role access exam shares"
on public.exam_shares
for all
to anon, authenticated
using (auth.role() in ('anon', 'authenticated'))
with check (auth.role() in ('anon', 'authenticated'));

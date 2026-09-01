-- Preserve the exact cause of every automatic exam submission.
alter table if exists public.sessions
  add column if not exists submit_reason text;

alter table if exists public.sessions
  drop constraint if exists sessions_submit_reason_check;

alter table if exists public.sessions
  add constraint sessions_submit_reason_check
  check (
    submit_reason is null
    or submit_reason in (
      'manual',
      'violations',
      'timeout',
      'force_submit',
      'exam_closed',
      'refresh'
    )
  );

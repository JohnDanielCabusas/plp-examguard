begin;

-- Persist why an attempt ended so a replay dismissal only reopens attempts
-- that were auto-submitted by the warning limit.
alter table public.sessions
  add column if not exists submit_reason text;

alter table public.sessions
  drop constraint if exists sessions_submit_reason_check;
alter table public.sessions
  add constraint sessions_submit_reason_check
  check (submit_reason is null or submit_reason in ('manual', 'violations', 'timeout', 'force_submit', 'exam_closed'));

-- Prevent an edited review decision from applying its warning adjustment twice.
alter table public.violation_evidence
  add column if not exists warning_applied boolean not null default false;

-- Materialize adjustments created by the earlier display-only implementation.
with pending_adjustments as (
  select session_id, sum(warning_adjustment)::integer as adjustment
    from public.violation_evidence
   where warning_applied = false
     and review_status in ('confirmed', 'dismissed')
   group by session_id
)
update public.sessions as sess
   set warnings = greatest(0, coalesce(sess.warnings, 0) + pending.adjustment)
  from pending_adjustments as pending
 where sess.id = pending.session_id
   and pending.adjustment <> 0;

update public.violation_evidence
   set warning_applied = true
 where warning_applied = false
   and review_status in ('confirmed', 'dismissed');

commit;

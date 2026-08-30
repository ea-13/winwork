-- =============================================================================
-- 0020 · A queue you can steer
--
-- Jobs ran strictly first-in-first-out with no way to see the queue, cancel
-- anything, or say "that one matters more". That is fine when one job runs at a
-- time and finishes in a minute. It is not fine when an estimator queues a
-- coverage audit across a plan set, then realises the bid comparison they need
-- for a meeting in ten minutes is sitting behind it.
--
-- Priority rather than a position: an explicit ordering that survives new
-- arrivals. Bumping something to the front should not be undone by the next
-- job somebody queues.
-- =============================================================================

alter table public.job
  add column priority int not null default 0,
  -- Cancelled is a real end state, distinct from failed. A job somebody stopped
  -- on purpose is not a job that went wrong, and a queue that cannot tell them
  -- apart teaches people to ignore failures.
  add column cancelled_at timestamptz,
  add column cancelled_by uuid references public.app_user(id);

create index idx_job_priority on public.job (status, priority desc, created_at);

comment on column public.job.priority is
  'Higher runs first. Explicit rather than positional so a bump is not undone '
  'by the next job queued.';

-- claim_job now respects priority, and refuses anything cancelled.
create or replace function public.claim_job(lease_seconds int default 300)
returns public.job
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  claimed public.job;
begin
  update public.job j
     set status           = 'IN_PROGRESS',
         attempts         = j.attempts + 1,
         lease_expires_at = now() + make_interval(secs => lease_seconds),
         updated_at       = now()
   where j.id = (
     select candidate.id
       from public.job candidate
      where candidate.cancelled_at is null
        and (
          candidate.status = 'QUEUED'
          or (candidate.status = 'IN_PROGRESS' and candidate.lease_expires_at < now())
        )
      -- Priority first, then age. Two jobs of equal priority still run in the
      -- order they arrived, which is what anybody expects of a queue.
      order by candidate.priority desc, candidate.created_at
      limit 1
      for update skip locked
   )
  returning j.* into claimed;

  return claimed;
end;
$$;

revoke execute on function public.claim_job(int) from public, anon, authenticated;

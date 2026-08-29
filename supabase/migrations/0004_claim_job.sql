-- =============================================================================
-- 0004 · Atomic job leasing
--
-- Claiming work is a read-then-write race: two workers that both see the same
-- QUEUED row will both run it. SELECT ... FOR UPDATE SKIP LOCKED is the fix,
-- and it cannot be expressed through PostREST, so it lives here as a function
-- the worker calls by RPC.
--
-- Going through RPC rather than a direct Postgres connection also keeps the
-- deployment simple: the app never needs DATABASE_URL, only the keys it
-- already has. The direct database host is IPv6-only, which not every host can
-- reach.
--
-- Expired leases are reclaimed rather than abandoned: a worker that dies
-- mid-job leaves a row IN_PROGRESS with a stale lease_expires_at, and the next
-- worker picks it up once that passes.
-- =============================================================================

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
      where candidate.status = 'QUEUED'
         or (candidate.status = 'IN_PROGRESS' and candidate.lease_expires_at < now())
      order by candidate.created_at
      limit 1
      for update skip locked
   )
  returning j.* into claimed;

  return claimed;
end;
$$;

comment on function public.claim_job(int) is
  'Leases one job for a worker. Returns null when the queue is empty.';

-- Workers authenticate as service_role, which bypasses RLS; no grant to
-- authenticated, because leasing work is not something a browser session does.
revoke execute on function public.claim_job(int) from public, anon, authenticated;

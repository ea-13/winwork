-- =============================================================================
-- 0003 · Upload metadata and the job queue
--
-- P5 needs a quote row to exist the moment a document lands, before anything
-- has been read out of it. The 0001 schema followed the spec's quote listing,
-- which assumes an already-extracted quote: it has no status, no filename, and
-- a NOT NULL subcontractor_id. At upload time none of those are known -- which
-- bidder sent a PDF is something extraction determines, not something the
-- uploader tells us.
--
-- P6 needs a job queue. Long agent runs must not sit behind an HTTP handler.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- quote: make a row representable before extraction has run
-- -----------------------------------------------------------------------------

alter table public.quote
  alter column subcontractor_id drop not null;

alter table public.quote
  add column status text not null default 'PENDING_EXTRACTION'
    check (status in ('PENDING_EXTRACTION','EXTRACTING','EXTRACTED','FAILED')),
  add column source_filename    text,
  add column source_size_bytes  bigint,
  add column uploaded_at        timestamptz not null default now(),
  add column uploaded_by        uuid references public.app_user(id);

comment on column public.quote.subcontractor_id is
  'Null until extraction identifies the bidder. R1: unknown stays unknown.';

create index idx_quote_status on public.quote (tenant_id, status);


-- -----------------------------------------------------------------------------
-- job: leased work queue
--
-- R3 is enforced here as a check constraint, not only as an API guard. The spec
-- says the gate is "a role check in the API and a constraint in the database --
-- not a policy an agent can argue with". A job whose type reads like an
-- outbound send cannot be written at all, by anyone, including service_role.
-- -----------------------------------------------------------------------------

create table public.job (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references public.tenant(id) on delete cascade,
  job_type          text not null
                      check (job_type !~* '(send|invite|remind|award|submit|email|sms|message)'),
  payload           jsonb not null default '{}'::jsonb,
  status            text not null default 'QUEUED'
                      check (status in ('QUEUED','IN_PROGRESS','DONE','FAILED','DEAD_LETTER')),
  attempts          int not null default 0,
  max_attempts      int not null default 3,
  lease_expires_at  timestamptz,
  last_error        text,
  agent_run_id      uuid references public.agent_run(id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

comment on constraint job_job_type_check on public.job is
  'R3: no outbound send path exists in this system. Absent, not disabled.';

create index idx_job_tenant_id on public.job (tenant_id);
create index idx_job_claimable on public.job (status, lease_expires_at)
  where status in ('QUEUED', 'IN_PROGRESS');
create index idx_job_agent_run_id on public.job (agent_run_id);

alter table public.job enable row level security;

create policy tenant_isolation on public.job
  for all to authenticated
  using (tenant_id = (select public.current_tenant_id()))
  with check (tenant_id = (select public.current_tenant_id()));


-- -----------------------------------------------------------------------------
-- agent_event ordering
--
-- The SSE endpoint replays existing events then streams new ones, so it reads
-- by (agent_run_id, seq) constantly. Also stops two writers producing the same
-- sequence number for one run.
-- -----------------------------------------------------------------------------

create unique index idx_agent_event_run_seq on public.agent_event (agent_run_id, seq);

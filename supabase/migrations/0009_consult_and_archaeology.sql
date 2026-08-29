-- =============================================================================
-- 0009 · Division Expert conversations, and unparking change-order archaeology
--
-- Two additions:
--
-- 1. Conversations with a division expert. Persisted rather than kept in the
--    browser, for three reasons: an estimator's question and the answer they
--    accepted is exactly the labelled data the corpus wants (P28); a question
--    asked against a specific document should still cite that document
--    tomorrow; and an answer nobody can retrieve is an answer nobody can
--    challenge, which fails R6 as surely as no citation at all.
--
-- 2. Change-order archaeology (P14) was parked awaiting a closed job's change
--    orders. The tables existed from 0001; these are the columns that turned
--    out to be missing once the flow was real.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- Consulting a division expert
-- -----------------------------------------------------------------------------

create table public.consult_thread (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenant(id) on delete cascade,
  project_id  uuid references public.project(id) on delete cascade,
  title       text not null default 'New question',
  divisions   text[] not null default '{}',
  -- project_document ids the whole thread is grounded in.
  document_ids uuid[] not null default '{}',
  created_by  uuid references public.app_user(id),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index idx_consult_thread_tenant_id on public.consult_thread (tenant_id);
create index idx_consult_thread_project_id on public.consult_thread (project_id);

create table public.consult_message (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenant(id) on delete cascade,
  thread_id   uuid not null references public.consult_thread(id) on delete cascade,
  seq         int not null,
  role        text not null check (role in ('USER', 'EXPERT')),
  content     text not null,
  -- What the answer rested on: gap_pattern ids, document pages, scope ids.
  citations   jsonb not null default '[]'::jsonb,
  model       text,
  prompt_version text,
  token_cost  numeric,
  at          timestamptz not null default now()
);

create index idx_consult_message_tenant_id on public.consult_message (tenant_id);
create unique index idx_consult_message_thread_seq
  on public.consult_message (thread_id, seq);

alter table public.consult_thread enable row level security;
alter table public.consult_message enable row level security;

create policy tenant_isolation on public.consult_thread
  for all to authenticated
  using (tenant_id = (select public.current_tenant_id()))
  with check (tenant_id = (select public.current_tenant_id()));

create policy tenant_isolation on public.consult_message
  for all to authenticated
  using (tenant_id = (select public.current_tenant_id()))
  with check (tenant_id = (select public.current_tenant_id()));


-- -----------------------------------------------------------------------------
-- P14 · Change-order archaeology
-- -----------------------------------------------------------------------------

-- The bid set a change order is measured against has to be findable, and a
-- past project needs somewhere to hold the documents it is reconstructed from.
alter table public.past_project
  add column project_id uuid references public.project(id) on delete set null,
  add column notes text;

alter table public.change_order
  -- What the classification is worth in the pitch: money that was preventable.
  add column is_preventable boolean,
  add column imported_at timestamptz,
  add column raw_row jsonb;

alter table public.co_classification
  -- The human verdict is the point of this feature. A classification nobody
  -- vetted is a claim, and a wrong "preventable" claim in front of the GC who
  -- ran that job ends the meeting.
  add column verdict_rationale text,
  add column source_location text;

create index idx_change_order_past_project on public.change_order (past_project_id);
create index idx_co_classification_change_order
  on public.co_classification (change_order_id);

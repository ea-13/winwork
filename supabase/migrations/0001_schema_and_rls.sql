-- =============================================================================
-- 0001 · Schema and Row Level Security
--
-- See docs/01-CORE-SPEC.md §4. These invariants are enforced by the database,
-- not by application code, because a convention is something an agent can
-- violate and a constraint is not:
--
--   * every tenant-scoped table carries tenant_id NOT NULL, has RLS enabled,
--     and has a policy restricting rows to the caller's tenant
--   * draft, approval and audit_event are append-only (R2)
--   * approval.rationale and selection.rationale must be non-empty
--
-- Three tables are deliberately NOT tenant-scoped: division_expert,
-- gap_pattern and lead_time. They are the shared CSI knowledge base -- the
-- same reference rows for every tenant, not tenant data. They still have RLS
-- enabled, with a read-only policy. benchmark_range IS tenant-scoped, because
-- calibration is per-tenant (R5).
-- =============================================================================


-- -----------------------------------------------------------------------------
-- Tenancy and identity
-- -----------------------------------------------------------------------------

create table public.tenant (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  created_at  timestamptz not null default now()
);

-- app_user.id is intended to equal auth.users.id. No foreign key to auth.users
-- yet: P4 introduces authentication and is responsible for aligning the ids.
create table public.app_user (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenant(id) on delete cascade,
  email         text not null,
  display_name  text,
  created_at    timestamptz not null default now(),
  unique (tenant_id, email)
);

-- Roles are grants, not an enum: one user commonly holds several (spec section 3).
create table public.user_role (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references public.tenant(id) on delete cascade,
  user_id    uuid not null references public.app_user(id) on delete cascade,
  role       text not null check (role in ('BC','EST','PM','ADMIN')),
  unique (user_id, role)
);


-- -----------------------------------------------------------------------------
-- The spine
-- -----------------------------------------------------------------------------

create table public.project (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenant(id) on delete cascade,
  bid_id      text not null,                   -- PREFIX-YYYY-NNN, permanent
  name        text not null,
  owner_org   text,
  due_at      timestamptz,
  status      text,
  created_at  timestamptz not null default now(),
  unique (tenant_id, bid_id)
);

-- The hub. Every quote line, gap, benchmark and change order joins back here.
create table public.scope_item (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenant(id) on delete cascade,
  project_id      uuid not null references public.project(id) on delete cascade,
  scope_id        text not null,               -- {bid_id}-{csi_division}-{seq}
  csi_division    text,
  csi_section     text,
  title           text not null,
  description     text,
  unit            text,
  quantity        numeric,
  quantity_basis  text,
  is_locked       boolean not null default false,   -- H2
  locked_by       uuid references public.app_user(id),
  locked_at       timestamptz,
  unique (tenant_id, scope_id)
);

create table public.work_package (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references public.tenant(id) on delete cascade,
  project_id     uuid not null references public.project(id) on delete cascade,
  name           text not null,
  csi_divisions  text[],
  status         text not null default 'DRAFT',    -- H3
  approved_by    uuid references public.app_user(id),
  approved_at    timestamptz
);

create table public.package_scope (
  tenant_id      uuid not null references public.tenant(id) on delete cascade,
  package_id     uuid not null references public.work_package(id) on delete cascade,
  scope_item_id  uuid not null references public.scope_item(id) on delete cascade,
  primary key (package_id, scope_item_id)
);


-- -----------------------------------------------------------------------------
-- Subcontractors and solicitation
-- -----------------------------------------------------------------------------

create table public.subcontractor (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references public.tenant(id) on delete cascade,
  name              text not null,
  trade_csi         text[],
  contact_name      text,
  contact_email     text,
  license_no        text,
  license_class     text,
  bonding_capacity  numeric,
  emr               numeric,
  prequal_status    text,
  source            text,
  imported_at       timestamptz,
  raw_row           jsonb                      -- preserves the messy original
);

create table public.package_bidder (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references public.tenant(id) on delete cascade,
  package_id        uuid not null references public.work_package(id) on delete cascade,
  subcontractor_id  uuid not null references public.subcontractor(id) on delete cascade,
  invited_state     text not null default 'CANDIDATE',
  list_approved_by  uuid references public.app_user(id),
  list_approved_at  timestamptz                -- H4
);

-- DRAFTED ONLY. There is no send path anywhere in this system (R3).
create table public.solicitation_draft (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references public.tenant(id) on delete cascade,
  package_id   uuid not null references public.work_package(id) on delete cascade,
  subject      text,
  body         text,
  approved_by  uuid references public.app_user(id),
  approved_at  timestamptz
);


-- -----------------------------------------------------------------------------
-- Quotes and leveling
-- -----------------------------------------------------------------------------

create table public.quote (
  id                     uuid primary key default gen_random_uuid(),
  tenant_id              uuid not null references public.tenant(id) on delete cascade,
  package_id             uuid not null references public.work_package(id) on delete cascade,
  subcontractor_id       uuid not null references public.subcontractor(id) on delete cascade,
  source_file_id         text,
  quoted_total           numeric,
  currency               text not null default 'USD',
  quote_date             date,
  revision               int not null default 1,
  pricing_basis          text,
  extraction_confidence  numeric,
  extraction_run_id      uuid
);

create table public.quote_line (
  id                    uuid primary key default gen_random_uuid(),
  tenant_id             uuid not null references public.tenant(id) on delete cascade,
  quote_id              uuid not null references public.quote(id) on delete cascade,
  scope_item_id         uuid references public.scope_item(id),   -- null until normalised
  original_text         text,
  description           text,
  qty                   numeric,
  unit                  text,
  rate                  numeric,
  line_total            numeric,
  match_confidence      numeric,
  match_basis           text,
  is_lumped             boolean not null default false,
  normalisation_run_id  uuid
);

-- Exclusions are the highest-value extraction. This is where overruns live.
create table public.quote_exclusion (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references public.tenant(id) on delete cascade,
  quote_id            uuid not null references public.quote(id) on delete cascade,
  scope_item_id       uuid references public.scope_item(id),     -- null if unmapped
  excerpt             text,
  source_location     text,
  addback_amount      numeric,
  addback_basis       text check (addback_basis in ('COMPARABLE_BIDS','BENCHMARK','TBC')),
  addback_confidence  numeric
);

create table public.quote_term (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null references public.tenant(id) on delete cascade,
  quote_id           uuid not null references public.quote(id) on delete cascade,
  term_key           text,
  term_value         text,
  standard_position  text,
  deviates           boolean
);

-- adjusted_total = quoted_total + add-backs + risk_allowance.
-- Rank on adjusted_total. Never on quoted_total.
create table public.leveling_result (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references public.tenant(id) on delete cascade,
  package_id        uuid not null references public.work_package(id) on delete cascade,
  quote_id          uuid not null references public.quote(id) on delete cascade,
  quoted_total      numeric,
  addback_total     numeric,
  risk_allowance    numeric,
  adjusted_total    numeric,
  score_price       int,
  score_scope       int,
  score_programme   int,
  score_commercial  int,
  score_risk        int,
  weighted_score    numeric,
  advisory_rank     int,
  computed_at       timestamptz
);

-- H6. EST only, and the rationale is not optional.
create table public.selection (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references public.tenant(id) on delete cascade,
  package_id   uuid not null references public.work_package(id) on delete cascade,
  quote_id     uuid not null references public.quote(id) on delete cascade,
  selected_by  uuid references public.app_user(id),
  selected_at  timestamptz not null default now(),
  rationale    text not null check (length(trim(rationale)) > 0)
);


-- -----------------------------------------------------------------------------
-- Division Expert knowledge base -- shared reference data, not tenant data
-- -----------------------------------------------------------------------------

create table public.division_expert (
  id            uuid primary key default gen_random_uuid(),
  csi_division  text not null,
  title         text,
  status        text check (status in ('SEED_STUB','CALIBRATED'))
);

create table public.gap_pattern (
  id                        uuid primary key default gen_random_uuid(),
  division_expert_id        uuid not null references public.division_expert(id) on delete cascade,
  pattern_text              text not null,
  typical_csi_section       text,
  is_frequent_change_order  boolean,
  detection_hint            text
);

create table public.lead_time (
  id                  uuid primary key default gen_random_uuid(),
  division_expert_id  uuid not null references public.division_expert(id) on delete cascade,
  item                text,
  weeks_low           int,
  weeks_high          int,
  changed_at          timestamptz
);

-- Tenant-scoped: calibration is per-tenant. is_calibrated = false is internal
-- only and may never reach a client-facing surface (R5).
create table public.benchmark_range (
  id                         uuid primary key default gen_random_uuid(),
  tenant_id                  uuid not null references public.tenant(id) on delete cascade,
  csi_section                text,
  description                text,
  unit                       text,
  low                        numeric,
  high                       numeric,
  is_calibrated              boolean not null default false,
  calibrated_from_quote_ids  uuid[],
  changed_at                 timestamptz
);


-- -----------------------------------------------------------------------------
-- Scope gaps -- the risk log. severity is derived, never authored.
-- -----------------------------------------------------------------------------

create table public.scope_gap (
  id                   uuid primary key default gen_random_uuid(),
  tenant_id            uuid not null references public.tenant(id) on delete cascade,
  package_id           uuid not null references public.work_package(id) on delete cascade,
  scope_item_id        uuid not null references public.scope_item(id) on delete cascade,
  gap_type             text check (gap_type in ('UNCOVERED','PARTIAL','UNPRICEABLE','AMBIGUOUS')),
  affected_quote_ids   uuid[],
  exposure_amount      numeric,
  exposure_basis       text,
  confidence           numeric,
  severity             text check (severity in ('CRITICAL','HIGH','MEDIUM','LOW')),
  detected_by_rule     text,
  detected_at          timestamptz,
  division_pattern_id  uuid references public.gap_pattern(id)
);


-- -----------------------------------------------------------------------------
-- Change-order archaeology
-- -----------------------------------------------------------------------------

create table public.past_project (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references public.tenant(id) on delete cascade,
  name              text not null,
  gc_name           text,
  contract_value    numeric,
  completed_at      date,
  bid_set_file_ids  text[]
);

create table public.change_order (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references public.tenant(id) on delete cascade,
  past_project_id  uuid not null references public.past_project(id) on delete cascade,
  co_number        text,
  amount           numeric,
  description      text,
  stated_reason    text,
  issued_at        date,
  source_file_id   text
);

-- Every classification is a draft requiring a human verdict. UNDETERMINED is
-- the default: a wrong "preventable" claim destroys the meeting (R1).
create table public.co_classification (
  id                    uuid primary key default gen_random_uuid(),
  tenant_id             uuid not null references public.tenant(id) on delete cascade,
  change_order_id       uuid not null references public.change_order(id) on delete cascade,
  classification        text check (classification in ('PREVENTABLE_SCOPE_GAP','OWNER_DIRECTED',
                                                       'UNFORESEEN_CONDITION','DESIGN_ERROR',
                                                       'UNDETERMINED')),
  scope_item_ref        text,
  gap_pattern_id        uuid references public.gap_pattern(id),
  reasoning             text,
  confidence            numeric,
  classified_by_run_id  uuid,
  human_verdict         text,
  verified_by           uuid references public.app_user(id),
  verified_at           timestamptz
);


-- -----------------------------------------------------------------------------
-- Evidence, approval and audit
-- -----------------------------------------------------------------------------

create table public.agent_run (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenant(id) on delete cascade,
  agent_type      text not null,
  project_id      uuid references public.project(id) on delete cascade,
  input_ref       text,
  status          text,
  model           text,
  prompt_version  text,
  started_at      timestamptz,
  finished_at     timestamptz,
  token_cost      numeric
);

-- Powers the streaming activity view. Do not hide the latency -- sell it.
create table public.agent_event (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenant(id) on delete cascade,
  agent_run_id  uuid not null references public.agent_run(id) on delete cascade,
  seq           int not null,
  event_type    text,
  message       text,
  payload       jsonb,
  at            timestamptz not null default now()
);

-- IMMUTABLE. Agents write evidence here; they have no path into canonical
-- state (R2). Enforced by trigger below, not by convention.
create table public.draft (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references public.tenant(id) on delete cascade,
  agent_run_id     uuid not null references public.agent_run(id) on delete cascade,
  target_table     text not null,
  target_id        uuid,
  field            text,
  proposed_value   jsonb,
  source_file_id   text,
  source_location  text,
  confidence       numeric,
  fill_tag         text check (fill_tag in ('S','AI','H','L')),
  created_at       timestamptz not null default now()
);

-- APPEND-ONLY. One row per gate crossing, rationale required.
create table public.approval (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenant(id) on delete cascade,
  gate        text check (gate in ('H2','H3','H4','H5','H6')),
  draft_id    uuid references public.draft(id),
  actor_id    uuid references public.app_user(id),
  actor_role  text,
  rationale   text not null check (length(trim(rationale)) > 0),
  at          timestamptz not null default now()
);

-- APPEND-ONLY.
create table public.audit_event (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenant(id) on delete cascade,
  actor_id    uuid references public.app_user(id),
  action      text,
  table_name  text,
  record_id   uuid,
  before      jsonb,
  after       jsonb,
  at          timestamptz not null default now()
);


-- =============================================================================
-- Tenancy resolution
--
-- The spec says policies compare tenant_id against "the tenant_id claim in the
-- JWT". Supabase does not put it there by default, and P4 (auth) does not exist
-- yet, so this resolves it two ways and prefers the claim once P4 supplies it:
--
--   1. app_metadata.tenant_id in the request JWT, when present
--   2. otherwise, look the caller up in app_user by auth.uid()
--
-- SECURITY DEFINER so the app_user lookup is not itself subject to the RLS
-- policy on app_user, which would recurse. STABLE so the planner evaluates it
-- once per statement rather than once per row.
-- =============================================================================

create or replace function public.current_tenant_id()
returns uuid
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(
    nullif(
      current_setting('request.jwt.claims', true)::jsonb #>> '{app_metadata,tenant_id}',
      ''
    ),
    (select au.tenant_id::text from public.app_user au where au.id = auth.uid())
  )::uuid
$$;

comment on function public.current_tenant_id() is
  'Resolves the calling user''s tenant. Used by every RLS policy.';


-- =============================================================================
-- Append-only enforcement (R2)
--
-- Statement-level, not row-level, deliberately: a row-level trigger does not
-- fire when a statement matches no rows, so "UPDATE draft SET field = 'x'" on
-- an empty table would silently succeed. The prohibition is on the operation,
-- not on any particular row.
-- =============================================================================

create or replace function public.reject_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception '% is append-only; % is not permitted', tg_table_name, tg_op
    using errcode = '42501';
end;
$$;

create trigger draft_no_update       before update on public.draft
  for each statement execute function public.reject_mutation();
create trigger draft_no_delete       before delete on public.draft
  for each statement execute function public.reject_mutation();

create trigger approval_no_update    before update on public.approval
  for each statement execute function public.reject_mutation();
create trigger approval_no_delete    before delete on public.approval
  for each statement execute function public.reject_mutation();

create trigger audit_event_no_update before update on public.audit_event
  for each statement execute function public.reject_mutation();
create trigger audit_event_no_delete before delete on public.audit_event
  for each statement execute function public.reject_mutation();


-- =============================================================================
-- Row Level Security
--
-- Applied by loop rather than by hand so that coverage is provable: every base
-- table in public gets RLS enabled and at least one policy, with no chance of
-- one being forgotten in a list of thirty.
--
-- current_tenant_id() is wrapped in a scalar subquery so Postgres hoists it
-- into an InitPlan and evaluates it once per statement instead of per row.
-- =============================================================================

do $$
declare
  reference_tables constant text[] := array['division_expert', 'gap_pattern', 'lead_time'];
  t text;
begin
  for t in
    select tablename from pg_tables
    where schemaname = 'public' and tablename <> 'schema_migrations'
  loop
    execute format('alter table public.%I enable row level security', t);

    if t = any (reference_tables) then
      -- Shared CSI knowledge base: readable by any authenticated user, written
      -- only by service_role (which bypasses RLS).
      execute format(
        'create policy reference_read_only on public.%I for select to authenticated using (true)',
        t
      );
    elsif t = 'tenant' then
      -- The tenant row itself is keyed by id, not tenant_id.
      execute format(
        'create policy tenant_isolation on public.%I for all to authenticated '
        'using (id = (select public.current_tenant_id())) '
        'with check (id = (select public.current_tenant_id()))',
        t
      );
    else
      execute format(
        'create policy tenant_isolation on public.%I for all to authenticated '
        'using (tenant_id = (select public.current_tenant_id())) '
        'with check (tenant_id = (select public.current_tenant_id()))',
        t
      );
    end if;
  end loop;
end;
$$;


-- =============================================================================
-- Indexes
--
-- Generated from the catalogue for the same reason as the policies: "an index
-- on every tenant_id and every foreign key" is a claim that should be true by
-- construction rather than by careful typing.
-- =============================================================================

do $$
declare
  r record;
begin
  -- every tenant_id column
  for r in
    select c.relname as tbl
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    join pg_attribute a on a.attrelid = c.oid
    where n.nspname = 'public' and c.relkind = 'r'
      and a.attname = 'tenant_id' and a.attnum > 0 and not a.attisdropped
  loop
    execute format('create index if not exists %I on public.%I (tenant_id)',
                   left('idx_' || r.tbl || '_tenant_id', 63), r.tbl);
  end loop;

  -- every foreign key, on its constrained columns, in order
  for r in
    select con.conname,
           cl.relname as tbl,
           string_agg(quote_ident(att.attname), ', ' order by k.ord) as cols
    from pg_constraint con
    join pg_class cl on cl.oid = con.conrelid
    join pg_namespace n on n.oid = cl.relnamespace
    cross join lateral unnest(con.conkey) with ordinality as k(attnum, ord)
    join pg_attribute att on att.attrelid = con.conrelid and att.attnum = k.attnum
    where con.contype = 'f' and n.nspname = 'public'
    group by con.conname, cl.relname
  loop
    execute format('create index if not exists %I on public.%I (%s)',
                   left('idx_' || r.conname, 63), r.tbl, r.cols);
  end loop;
end;
$$;

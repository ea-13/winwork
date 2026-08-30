-- =============================================================================
-- 0019 · Cost codes, and quotes that span more than one division
--
-- Two problems with one root.
--
-- The system has organised everything by CSI division since 0001, and CSI is a
-- classification, not a cost structure. Every GC has their own cost codes — some
-- extend CSI, some predate it, most are a house standard nobody will abandon
-- because a piece of software prefers a different one. Their historical data,
-- their accounting, and their estimators' heads are all in that structure, and
-- a tool that insists on CSI makes them translate at every step.
--
-- The second problem follows from the first. `quote.package_id` binds a quote to
-- exactly one package, so a sub who prices work across three divisions — which
-- is most mechanical subs, most sitework subs, and any sub who quotes a scope
-- rather than a trade — cannot be represented at all. Today you would split
-- their $180k into three fictional quotes and lose the fact that it was one bid
-- with one set of terms.
--
-- So: cost codes per tenant, importable from what they already have, and an
-- allocation table that lets one quote carry money into several packages while
-- staying one quote.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- The tenant's own cost structure
-- -----------------------------------------------------------------------------

create table public.cost_code (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenant(id) on delete cascade,
  code          text not null,
  description   text not null,
  -- The CSI division this maps onto, where it maps at all. Nullable because a
  -- house code that spans two divisions is common and forcing a single answer
  -- would be inventing one.
  csi_division  text,
  csi_section   text,
  -- Parent code, for the ones that nest. Self-referential rather than a depth
  -- column so an arbitrary hierarchy works without a migration.
  parent_id     uuid references public.cost_code(id) on delete set null,
  sort_order    int not null default 0,
  is_active     boolean not null default true,
  source        text not null default 'MANUAL'
                  check (source in ('MANUAL','TEMPLATE','IMPORTED','SEED')),
  created_at    timestamptz not null default now(),
  unique (tenant_id, code)
);

create index idx_cost_code_tenant on public.cost_code (tenant_id);
create index idx_cost_code_division on public.cost_code (tenant_id, csi_division);
create index idx_cost_code_parent on public.cost_code (parent_id);

alter table public.cost_code enable row level security;

create policy tenant_isolation on public.cost_code
  for all to authenticated
  using (tenant_id = (select public.current_tenant_id()))
  with check (tenant_id = (select public.current_tenant_id()));

comment on table public.cost_code is
  'The tenant OWN cost structure. CSI stays as the shared vocabulary between '
  'tenants; this is what their estimators and their accounting actually use.';

-- Scope and packages can carry a code. Nullable throughout: a project that
-- never imports a structure must keep working exactly as it does now.
alter table public.scope_item
  add column cost_code_id uuid references public.cost_code(id) on delete set null;

alter table public.work_package
  add column cost_code_id uuid references public.cost_code(id) on delete set null;

create index idx_scope_item_cost_code on public.scope_item (cost_code_id);


-- -----------------------------------------------------------------------------
-- One quote, several packages
-- -----------------------------------------------------------------------------

create table public.quote_allocation (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references public.tenant(id) on delete cascade,
  quote_id     uuid not null references public.quote(id) on delete cascade,
  package_id   uuid not null references public.work_package(id) on delete cascade,
  amount       numeric,
  cost_code_id uuid references public.cost_code(id) on delete set null,
  note         text,
  created_by   uuid references public.app_user(id),
  created_at   timestamptz not null default now(),
  unique (quote_id, package_id)
);

create index idx_quote_allocation_tenant on public.quote_allocation (tenant_id);
create index idx_quote_allocation_quote on public.quote_allocation (quote_id);
create index idx_quote_allocation_package on public.quote_allocation (package_id);

alter table public.quote_allocation enable row level security;

create policy tenant_isolation on public.quote_allocation
  for all to authenticated
  using (tenant_id = (select public.current_tenant_id()))
  with check (tenant_id = (select public.current_tenant_id()));

comment on table public.quote_allocation is
  'How one bid divides across packages. A quote with no allocations belongs '
  'wholly to quote.package_id, which is how every existing quote keeps working. '
  'Allocations must sum to the quoted total, and the UI says so rather than '
  'silently balancing them — an unexplained remainder is somebody money.';

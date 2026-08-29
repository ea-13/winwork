-- =============================================================================
-- 0007 · Subcontractor import fields
--
-- Real sub lists are two very different things:
--
--   * a hand-maintained trade directory — 30 rows, a Scope column, current
--     contacts, and a header row that is not on row 1
--   * an accounting-system vendor master — thousands of rows, a Type column,
--     addresses, and NO trade information whatsoever
--
-- Both are worth importing; only the first can be trade-classified from its own
-- contents. These columns keep what each carries, and raw_row (already present)
-- keeps the original row verbatim so nothing is lost in translation.
-- =============================================================================

alter table public.subcontractor
  add column vendor_code   text,
  add column contact_phone text,
  add column address_line  text,
  add column city          text,
  add column state         text,
  add column postal_code   text,
  add column union_status  text check (union_status in ('UNION','NON_UNION','UNKNOWN')),
  add column import_batch  uuid;

comment on column public.subcontractor.trade_csi is
  'CSI divisions this sub bids. Empty means unclassified, not "no trades" — R1: '
  'an unmatched trade stays unknown rather than being guessed from the name.';

-- Re-importing the same list must update rows rather than duplicate them, and
-- a vendor master keyed by code is the only reliable identity these files have.
create unique index idx_subcontractor_name
  on public.subcontractor (tenant_id, lower(name));

create index idx_subcontractor_vendor_code on public.subcontractor (tenant_id, vendor_code);
create index idx_subcontractor_unclassified
  on public.subcontractor (tenant_id)
  where trade_csi is null or cardinality(trade_csi) = 0;


-- A record of each import, so a bad file can be identified and undone.
create table public.import_batch (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references public.tenant(id) on delete cascade,
  source_kind    text not null check (source_kind in ('SUB_DIRECTORY','VENDOR_MASTER','OTHER')),
  filename       text,
  row_count      int not null default 0,
  imported_count int not null default 0,
  skipped_count  int not null default 0,
  imported_by    uuid references public.app_user(id),
  imported_at    timestamptz not null default now()
);

create index idx_import_batch_tenant_id on public.import_batch (tenant_id);

alter table public.import_batch enable row level security;

create policy tenant_isolation on public.import_batch
  for all to authenticated
  using (tenant_id = (select public.current_tenant_id()))
  with check (tenant_id = (select public.current_tenant_id()));

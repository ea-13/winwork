-- =============================================================================
-- 0006 · Project documents, and packages that are not all "Interior Finishes"
--
-- Two gaps the first screens exposed:
--
-- 1. The only upload path attached a quote to a package. Drawings, specs and
--    addenda belong to the PROJECT — they are the bid set every package and
--    every quote is measured against, and they arrive before any package
--    exists. There was nowhere to put them.
--
-- 2. work_package had no division of its own. A GC buys by trade: one package
--    per division, not one package per project. csi_divisions[] already
--    existed, but nothing recorded which single division a package leads with,
--    which is what a buyout log is organised by.
-- =============================================================================


create table public.project_document (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references public.tenant(id) on delete cascade,
  project_id     uuid not null references public.project(id) on delete cascade,
  kind           text not null default 'OTHER'
                   check (kind in ('DRAWING','SPEC','ADDENDUM','GEOTECH','OTHER')),
  filename       text not null,
  size_bytes     bigint,
  storage_path   text not null unique,
  discipline     text,          -- A, S, M, E, P ... free text, from the sheet set
  revision       text,
  uploaded_by    uuid references public.app_user(id),
  uploaded_at    timestamptz not null default now()
);

create index idx_project_document_tenant_id on public.project_document (tenant_id);
create index idx_project_document_project_id on public.project_document (project_id);
create index idx_project_document_kind on public.project_document (project_id, kind);

alter table public.project_document enable row level security;

create policy tenant_isolation on public.project_document
  for all to authenticated
  using (tenant_id = (select public.current_tenant_id()))
  with check (tenant_id = (select public.current_tenant_id()));


-- The division a package leads with. csi_divisions[] stays, because a package
-- routinely spans more than one — interior finishes carries 07-14 firestopping.
alter table public.work_package
  add column lead_division text,
  add column description text,
  add column budget_amount numeric,      -- the estimate this package is bought against
  add column allowance_amount numeric,   -- carried allowances, buyout log input
  add column contingency_amount numeric; -- carried contingency, buyout log input

comment on column public.work_package.budget_amount is
  'What the estimate carried for this package. The buyout log measures against it.';

update public.work_package
   set lead_division = coalesce(csi_divisions[1], '09')
 where lead_division is null;

create index idx_work_package_lead_division on public.work_package (tenant_id, lead_division);

-- =============================================================================
-- 0011 · The buildout the first real walkthrough asked for
--
-- Six structural gaps, all found by using the app rather than reading it:
--
-- 1. A document had to be labelled BEFORE it was uploaded. That is backwards.
--    You drop a bid set, then you say what each file is — so there has to be a
--    kind that means "not yet said".
--
-- 2. Drawings had nowhere to be indexed. A plan set is one PDF and two hundred
--    sheets; scope drafted from it has to cite a SHEET, not a page number in a
--    file nobody can navigate. R6 needs the sheet index to exist.
--
-- 3. work_package had budget, allowance and contingency but no notes. The
--    reason a number is what it is lives next to the number or it is lost.
--
-- 4. leveling_result is per QUOTE. An estimator levels per SCOPE ITEM — "what
--    did each of these three subs carry for metal stud framing" is the actual
--    question, and there was no row that could answer it.
--
-- 5. A scope gap could be detected and costed but not DISPOSED of. Finding
--    that nobody carried firestopping is half the job; deciding it becomes a
--    $12k allowance is the other half, and that decision had nowhere to live.
--
-- 6. Notes on a leveled number are not a nicety. "20ga assumed, not 18" is the
--    difference between two numbers that look comparable and are not.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1 · Label after upload, not before
-- -----------------------------------------------------------------------------

alter table public.project_document
  drop constraint project_document_kind_check;

alter table public.project_document
  add constraint project_document_kind_check
  check (kind in ('UNFILED','DRAWING','SPEC','ADDENDUM','GEOTECH','OTHER'));

alter table public.project_document
  alter column kind set default 'UNFILED';

comment on column public.project_document.kind is
  'UNFILED until a human says what the file is. Upload is a drop, not a form.';


-- -----------------------------------------------------------------------------
-- 2 · The sheet-set index
--
-- One row per sheet in a drawing set. Written by the indexer agent, corrected
-- by a human like anything else. sheet_number is what an estimator says out
-- loud ("A-201"), so it is what a citation has to carry.
-- -----------------------------------------------------------------------------

alter table public.project_document
  add column page_count int,
  add column indexed_at timestamptz;

create table public.document_sheet (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenant(id) on delete cascade,
  document_id   uuid not null references public.project_document(id) on delete cascade,
  page_number   int not null,
  sheet_number  text,                -- A-201, S-100, M-4.02
  sheet_title   text,
  discipline    text,                -- A, S, M, E, P, C, L, FP
  confidence    numeric,
  indexed_at    timestamptz not null default now(),
  unique (document_id, page_number)
);

create index idx_document_sheet_tenant_id on public.document_sheet (tenant_id);
create index idx_document_sheet_document on public.document_sheet (document_id);
create index idx_document_sheet_number on public.document_sheet (document_id, sheet_number);

alter table public.document_sheet enable row level security;

create policy tenant_isolation on public.document_sheet
  for all to authenticated
  using (tenant_id = (select public.current_tenant_id()))
  with check (tenant_id = (select public.current_tenant_id()));


-- -----------------------------------------------------------------------------
-- 3 · Notes on a package
-- -----------------------------------------------------------------------------

alter table public.work_package
  add column notes text;

comment on column public.work_package.notes is
  'Why the budget, allowance and contingency are what they are. Shown beside them.';


-- -----------------------------------------------------------------------------
-- 4 · The leveled number per scope item, per sub
--
-- rolled_total is derived — the sum of that quote's lines mapped to that scope
-- item. It is recomputed and must never be typed over in place, or the next
-- recompute silently destroys an estimator's judgement.
--
-- override_total is the estimator's own number, and it WINS. Two columns
-- rather than one because "the model said 86,200 and I say 91,000" is exactly
-- the labelled correction the corpus wants (P28), and collapsing them loses it.
-- -----------------------------------------------------------------------------

create table public.scope_leveling (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references public.tenant(id) on delete cascade,
  package_id     uuid not null references public.work_package(id) on delete cascade,
  scope_item_id  uuid not null references public.scope_item(id) on delete cascade,
  quote_id       uuid not null references public.quote(id) on delete cascade,

  -- Derived. Recomputed on every level run.
  rolled_total   numeric,
  line_count     int not null default 0,
  is_excluded    boolean not null default false,   -- the sub named it as excluded
  is_carried     boolean not null default false,   -- any priced line mapped here
  match_basis    text,

  -- The human's. Survives recompute.
  override_total numeric,
  note           text,
  noted_by       uuid references public.app_user(id),
  noted_at       timestamptz,

  computed_at    timestamptz not null default now(),
  unique (package_id, scope_item_id, quote_id)
);

create index idx_scope_leveling_tenant_id on public.scope_leveling (tenant_id);
create index idx_scope_leveling_package on public.scope_leveling (package_id);
create index idx_scope_leveling_scope_item on public.scope_leveling (scope_item_id);
create index idx_scope_leveling_quote on public.scope_leveling (quote_id);

alter table public.scope_leveling enable row level security;

create policy tenant_isolation on public.scope_leveling
  for all to authenticated
  using (tenant_id = (select public.current_tenant_id()))
  with check (tenant_id = (select public.current_tenant_id()));


-- -----------------------------------------------------------------------------
-- 5 · Disposing of a scope gap
--
-- An open gap is an unanswered question. Assigning it an allowance or a
-- contingency is the answer, and the buyout log adds it to the project total —
-- so it is state, it is a human's, and it carries a note saying why.
-- -----------------------------------------------------------------------------

alter table public.scope_gap
  add column assigned_amount numeric,
  add column assigned_type text
    check (assigned_type in ('ALLOWANCE','CONTINGENCY','ACCEPTED','VOID')),
  add column assigned_note text,
  add column assigned_by uuid references public.app_user(id),
  add column assigned_at timestamptz;

create index idx_scope_gap_assigned on public.scope_gap (package_id, assigned_type);

-- =============================================================================
-- 0012 · What a scope item MEANS, and whether saying it worked
--
-- A scope_item today is a title, a quantity and a division. That is enough to
-- ask "did anybody price this", which is the set difference the gap detector
-- already does. It is not enough to ask the question that actually costs money:
--
--     "did anybody price the head-of-wall detail that this item includes?"
--
-- Scope does not leak at the item level. It leaks at the seam — the thing two
-- trades both assume the other carries, the assumption a sub priced against
-- that nobody wrote down. Those live one level below the line item, and until
-- now there was nowhere to put them.
--
-- So: every scope item carries context lines. What it includes, what it
-- explicitly does not, where it touches another trade, what it assumes.
--
-- And then the part that makes it a system rather than a form. Every context
-- line accumulates OUTCOMES — it caught a gap, a bidder excluded exactly it, a
-- change order came back against it anyway. That record is what makes the next
-- project's draft better than this one's, and it is the same corpus P28 wants.
-- A context line nobody can score is an opinion. One with a track record is
-- knowledge.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- The context lines
-- -----------------------------------------------------------------------------

create table public.scope_context (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references public.tenant(id) on delete cascade,
  scope_item_id       uuid not null references public.scope_item(id) on delete cascade,

  kind                text not null check (kind in (
                        'INCLUSION',       -- the sub carries this under this item
                        'EXCLUSION',       -- explicitly NOT here; carried elsewhere
                        'INTERFACE',       -- the seam with another trade or item
                        'ASSUMPTION',      -- what a price here assumes to be true
                        'RISK',            -- what habitually goes wrong here
                        'BASIS_OF_DESIGN'  -- the product or detail priced against
                      )),
  text                text not null check (length(trim(text)) > 0),

  -- Where it came from. DOCUMENT is read off the bid set; PATTERN is division
  -- knowledge; HISTORY is what a past job taught us; HUMAN is the estimator.
  origin              text not null default 'HUMAN'
                        check (origin in ('DOCUMENT','PATTERN','HISTORY','HUMAN')),
  source_location     text,      -- "A-201, keynote 4" or "p. 214, §09 21 16 2.3"
  source_document_id  uuid references public.project_document(id) on delete set null,
  gap_pattern_id      uuid references public.gap_pattern(id),
  confidence          numeric,

  -- Retired, never deleted. "We used to say this and stopped" is a finding, and
  -- the outcomes already recorded against it stay meaningful.
  is_active           boolean not null default true,
  retired_reason      text,

  position            int not null default 0,
  created_by          uuid references public.app_user(id),
  created_at          timestamptz not null default now()
);

create index idx_scope_context_tenant_id on public.scope_context (tenant_id);
create index idx_scope_context_scope_item on public.scope_context (scope_item_id, position);
create index idx_scope_context_pattern on public.scope_context (gap_pattern_id);
create index idx_scope_context_kind on public.scope_context (scope_item_id, kind);

alter table public.scope_context enable row level security;

create policy tenant_isolation on public.scope_context
  for all to authenticated
  using (tenant_id = (select public.current_tenant_id()))
  with check (tenant_id = (select public.current_tenant_id()));


-- -----------------------------------------------------------------------------
-- Whether it worked
--
-- Append-only. This is the training signal, and a training signal that can be
-- quietly revised is worth nothing — the whole value is that it records what
-- actually happened rather than what we would now prefer to have said.
-- -----------------------------------------------------------------------------

create table public.scope_context_outcome (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenant(id) on delete cascade,
  scope_item_id   uuid not null references public.scope_item(id) on delete cascade,
  -- Null when the outcome is about the item as a whole: nothing was written
  -- down, and that absence is itself the thing worth recording.
  context_id      uuid references public.scope_context(id) on delete set null,

  outcome         text not null check (outcome in (
                    'CAUGHT_GAP',          -- a gap was found here; context flagged it
                    'MISSED_GAP',          -- a gap was found here and nothing warned
                    'EXCLUDED_BY_BIDDER',  -- a sub named exactly this as excluded
                    'PRICED_BY_ALL',       -- everyone carried it; the context held
                    'CHANGE_ORDER',        -- it came back as a CO anyway
                    'HUMAN_ADDED',         -- an estimator wrote it in themselves
                    'HUMAN_REMOVED'        -- an estimator retired it
                  )),

  -- What this rests on, so a score can be traced back to a real row.
  evidence_table  text,
  evidence_id     uuid,
  amount          numeric,     -- exposure, or what the change order cost
  note            text,

  recorded_by     uuid references public.app_user(id),
  recorded_at     timestamptz not null default now()
);

create index idx_scope_context_outcome_tenant on public.scope_context_outcome (tenant_id);
create index idx_scope_context_outcome_item on public.scope_context_outcome (scope_item_id);
create index idx_scope_context_outcome_context on public.scope_context_outcome (context_id);
create index idx_scope_context_outcome_kind on public.scope_context_outcome (outcome);
-- One outcome per context line per piece of evidence. Recomputing gaps must
-- not inflate a context line's track record by re-recording the same finding.
create unique index idx_scope_context_outcome_unique
  on public.scope_context_outcome (scope_item_id, coalesce(context_id, scope_item_id), outcome, coalesce(evidence_id, scope_item_id));

alter table public.scope_context_outcome enable row level security;

create policy tenant_isolation on public.scope_context_outcome
  for all to authenticated
  using (tenant_id = (select public.current_tenant_id()))
  with check (tenant_id = (select public.current_tenant_id()));

create trigger scope_context_outcome_no_update before update on public.scope_context_outcome
  for each row execute function public.reject_mutation();

create trigger scope_context_outcome_no_delete before delete on public.scope_context_outcome
  for each row execute function public.reject_mutation();


-- -----------------------------------------------------------------------------
-- Feeding it back
--
-- A gap_pattern is what the drafter reaches for on the NEXT project. These
-- columns are how a pattern earns its place: how often it was proposed, and how
-- often it turned out to matter. An uncalibrated pattern stays usable but says
-- so, exactly as R5 requires of an uncalibrated benchmark.
-- -----------------------------------------------------------------------------

alter table public.gap_pattern
  add column times_proposed int not null default 0,
  add column times_confirmed int not null default 0,
  add column last_confirmed_at timestamptz;

comment on column public.gap_pattern.times_confirmed is
  'How often this pattern preceded a real finding. Proposed-but-never-confirmed '
  'is the signal that a pattern is noise, and noise nobody prunes is what makes '
  'people stop reading the warnings.';

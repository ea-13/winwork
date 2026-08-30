-- =============================================================================
-- 0015 · Doing it by hand
--
-- Everything in the chain assumed a document arrived and an agent read it. That
-- is the interesting path and it is not the only one, and insisting on it makes
-- the product unusable in the two cases that matter most:
--
--   1. A demo. Nobody wants to watch thirteen model calls to see a comparison.
--   2. A GC who already has three quotes in a folder and wants the levelling,
--      not the extraction. That is most of them.
--
-- So a quote may be MANUAL: typed in by a person, no document behind it. It is
-- a distinct status rather than a flag on EXTRACTED because the difference is
-- provenance, and provenance is the thing this product sells. "A human typed
-- this" and "a model read this from page 2" must never be indistinguishable in
-- the record, however similar the number looks.
-- =============================================================================

alter table public.quote
  drop constraint quote_status_check;

alter table public.quote
  add constraint quote_status_check
  check (status in ('PENDING_EXTRACTION','EXTRACTING','EXTRACTED','FAILED','MANUAL'));

comment on column public.quote.status is
  'MANUAL means a person typed this quote in and there is no source document. '
  'It levels exactly like an extracted one; it simply cannot cite a page.';

-- Who typed it, for the same reason every other human write records an actor.
alter table public.quote
  add column entered_by uuid references public.app_user(id);

-- A manual quote line has no extraction behind it either. Recording that on the
-- line rather than inferring it from the quote keeps a hand-corrected line on an
-- extracted quote honest about being hand-corrected.
alter table public.quote_line
  add column is_manual boolean not null default false;

-- =============================================================================
-- 0014 · A quote is part of the bid set too
--
-- Uploading was split by destination: drawings and specs went to the project,
-- sub bids went to a package. That split is real in the data model and wrong
-- at the point of upload, because a GC receives one pile of files and sorts it
-- afterwards. Making them decide which pile a file belongs to BEFORE it is
-- uploaded is the same mistake 0011 fixed for drawings and specs.
--
-- So a project document may be a QUOTE. It sits at project level until somebody
-- says which package it belongs to, at which point it becomes a real quote row
-- against that package and the extraction chain picks it up as normal.
-- =============================================================================

alter table public.project_document
  drop constraint project_document_kind_check;

alter table public.project_document
  add constraint project_document_kind_check
  check (kind in ('UNFILED','DRAWING','SPEC','ADDENDUM','GEOTECH','QUOTE','OTHER'));

-- Which package a project-level quote was routed into, so the same file is not
-- filed against two packages by two people on the same afternoon.
alter table public.project_document
  add column routed_quote_id uuid references public.quote(id) on delete set null;

comment on column public.project_document.routed_quote_id is
  'Set once a QUOTE document has been filed against a package. Non-null means '
  'it is already in the bid chain and must not be routed a second time.';

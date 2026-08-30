-- =============================================================================
-- 0022 · Removing a sub must not erase what they bid
--
-- Found by the QA suite, which deleted its throwaway subcontractors during
-- cleanup and watched an award decision disappear with them.
--
--   quote.subcontractor_id  ON DELETE CASCADE
--   selection.quote_id      ON DELETE CASCADE
--
-- So removing one row from a vendor list silently took every quote that sub had
-- ever given, and with them every H6 selection naming those quotes. A GC tidying
-- up a stale sub would destroy the record of awards, with no warning and nothing
-- in the audit trail to show what went.
--
-- RESTRICT instead. A subcontractor who has bid on anything cannot be deleted,
-- and the error says so — the same shape as a package that carries bids, and for
-- the same reason. A vendor list is tidied by marking somebody inactive, not by
-- deleting the history of what they quoted.
-- =============================================================================

alter table public.quote
  drop constraint quote_subcontractor_id_fkey;

alter table public.quote
  add constraint quote_subcontractor_id_fkey
  foreign key (subcontractor_id) references public.subcontractor(id) on delete restrict;

comment on constraint quote_subcontractor_id_fkey on public.quote is
  'RESTRICT, not CASCADE. Deleting a sub used to take their quotes and every '
  'selection naming those quotes with them. Mark a sub inactive instead.';

-- The way to retire a sub without destroying anything.
alter table public.subcontractor
  add column is_active boolean not null default true;

comment on column public.subcontractor.is_active is
  'False hides a sub from candidate lists without touching what they have bid.';

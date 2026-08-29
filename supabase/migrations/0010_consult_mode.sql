-- =============================================================================
-- 0010 · Two ways to ask
--
-- The division expert has a deliberately narrow brief: reason from gap
-- patterns, cite them, and never produce a dollar figure. That is right for
-- "what does division 22 usually leave out", and wrong for "what does this
-- letter actually say" -- where the honest answer is often just a quote from
-- page four.
--
-- Rather than loosen the expert until it does both badly, a thread declares
-- which kind of question it is.
-- =============================================================================

alter table public.consult_thread
  add column mode text not null default 'EXPERT'
    check (mode in ('EXPERT', 'DOCUMENT'));

comment on column public.consult_thread.mode is
  'EXPERT reasons from division knowledge; DOCUMENT answers from the attached files only.';

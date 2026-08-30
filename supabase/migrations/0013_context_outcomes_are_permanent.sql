-- =============================================================================
-- 0013 · An outcome keeps pointing at the line that earned it
--
-- 0012 gave scope_context_outcome.context_id an ON DELETE SET NULL, which was
-- wrong twice over.
--
-- Wrong on the merits: the whole value of an outcome row is the link between a
-- finding and the context line that did or did not predict it. Null that out
-- and what remains is "something happened somewhere", which teaches nothing.
--
-- Wrong in practice: SET NULL is an UPDATE, and the append-only trigger on
-- scope_context_outcome refuses UPDATE. So deleting a context line already
-- failed — it just failed with
--
--     "scope_context_outcome is append-only; UPDATE is not permitted"
--
-- while the caller was looking at a DELETE against scope_context. An error that
-- names a table you did not touch is one people work around rather than read.
--
-- RESTRICT says the actual rule, and says it against the table the caller
-- asked about: a context line with a track record cannot be deleted. Retire it.
-- That was always the intent — scope_context has is_active and retired_reason
-- precisely so that "we used to say this and stopped" survives.
-- =============================================================================

alter table public.scope_context_outcome
  drop constraint scope_context_outcome_context_id_fkey;

alter table public.scope_context_outcome
  add constraint scope_context_outcome_context_id_fkey
  foreign key (context_id) references public.scope_context(id) on delete restrict;

comment on constraint scope_context_outcome_context_id_fkey on public.scope_context_outcome is
  'RESTRICT, not CASCADE or SET NULL. A context line that has been scored is '
  'part of the record of how a decision was made. Retire it (is_active = false) '
  'rather than deleting it.';

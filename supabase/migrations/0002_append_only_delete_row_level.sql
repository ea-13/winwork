-- =============================================================================
-- 0002 · Append-only enforcement: UPDATE stays statement-level, DELETE moves
--        to row-level
--
-- 0001 made both triggers statement-level so that
--
--     update draft set field = 'x';
--
-- raises even when the table is empty, which is P2's stated acceptance test.
-- That reasoning holds for UPDATE, which never cascades.
--
-- It was wrong for DELETE. A statement-level BEFORE DELETE trigger also fires
-- on the cascade that "delete from tenant" produces, and it fires whether or
-- not that cascade would remove any rows. The effect was that no tenant could
-- ever be deleted -- not even one that had never had a draft, approval or
-- audit_event row. That is a bug, not a policy: the rule we want is "an
-- existing evidence row cannot be removed", which is a statement about rows.
--
-- Row-level triggers express exactly that, and let an empty cascade through.
-- =============================================================================

drop trigger draft_no_delete on public.draft;
drop trigger approval_no_delete on public.approval;
drop trigger audit_event_no_delete on public.audit_event;

create trigger draft_no_delete before delete on public.draft
  for each row execute function public.reject_mutation();

create trigger approval_no_delete before delete on public.approval
  for each row execute function public.reject_mutation();

create trigger audit_event_no_delete before delete on public.audit_event
  for each row execute function public.reject_mutation();

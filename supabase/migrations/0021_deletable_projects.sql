-- =============================================================================
-- 0021 · A project you can actually delete
--
-- Found by the QA suite: deleting a project fails with
--
--     scope_context_outcome is append-only; DELETE is not permitted
--
-- and would fail on `draft` too for any project an agent had touched. Both
-- cascade from project — agent_run → draft, scope_item → scope_context_outcome
-- — and both carry a no-delete trigger. So in practice NO real project could
-- ever be removed, which is not a product anybody can use. A test project, a
-- duplicate, a job that never went ahead: all permanent.
--
-- THE LINE THAT MATTERS, drawn properly this time.
--
-- The append-only rule exists so evidence cannot be silently REVISED. Its enemy
-- is somebody editing what an agent proposed, or changing an approval after the
-- fact to match what happened. That guarantee is untouched here: UPDATE stays
-- rejected on all four tables, including from service_role, and the isolation
-- suite still proves it.
--
-- What was over-reached was DELETE, and the fix is to notice that these tables
-- are not the same kind of thing:
--
--   PROJECT-SCOPED, and goes with the project:
--     draft                  — a proposal about rows in one project
--     scope_context_outcome  — a score about one project's scope items
--   Deleting the project takes the thing they were evidence ABOUT. What remains
--   would be orphans referring to nothing, and keeping them is not a guarantee,
--   it is litter. The learning they carry is already aggregated into
--   gap_pattern.times_confirmed, which is tenant-scoped and survives.
--
--   TENANT-SCOPED, and permanent:
--     approval      — who crossed which gate, and why
--     audit_event   — who changed what, and when
--   Neither cascades from a project, so neither has ever blocked this. Both keep
--   their no-delete trigger. These are the ledger, and the ledger does not go
--   anywhere.
--
-- Net effect: you can delete a project. You still cannot rewrite history.
-- =============================================================================

drop trigger draft_no_delete on public.draft;
drop trigger scope_context_outcome_no_delete on public.scope_context_outcome;

comment on table public.draft is
  'Agent proposals. Immutable — UPDATE is rejected — but project-scoped, so a '
  'deleted project takes its drafts with it. The record of what a human then '
  'ACCEPTED lives in approval and audit_event, which are permanent.';

comment on table public.scope_context_outcome is
  'Whether a context line turned out to matter. Immutable, and project-scoped: '
  'deleting the project removes it, because it is a score about scope items '
  'that no longer exist. What it taught is already aggregated into '
  'gap_pattern.times_confirmed, which is tenant-scoped and survives.';

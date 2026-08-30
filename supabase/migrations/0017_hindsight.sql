-- =============================================================================
-- 0017 · Hindsight — would we have caught it?
--
-- P14 was built as change-order archaeology: read a finished job's change
-- orders and classify why each happened. That is half the tool. The half that
-- sells it is the comparison:
--
--   Take a job that is already finished. Load its bid set and its bids as if it
--   were precon. Run gap detection. THEN put the real change-order list next to
--   the gaps we flagged.
--
-- "Of your 31 change orders, 19 were scope gaps, and we would have flagged 14
-- of them worth $340k before you bought the job" is a different conversation
-- from "here is a tool".
--
-- It is also the only honest way to calibrate. Gap patterns carry
-- times_proposed and times_confirmed (0012) and nothing has ever confirmed one
-- against reality — a backtest is what turns that column from decoration into
-- evidence.
--
-- Note what this is NOT for. Once buyout is complete this tool is finished; it
-- is a precon instrument, and tracking change orders during construction is a
-- different product living somewhere else.
-- =============================================================================

alter table public.change_order
  -- Which scope item this change order actually landed on, once a human says.
  add column scope_item_id uuid references public.scope_item(id) on delete set null,
  -- The detected gap that predicted it, if one did.
  add column matched_gap_id uuid references public.scope_gap(id) on delete set null,

  add column hindsight text not null default 'UNREVIEWED'
    check (hindsight in (
      'UNREVIEWED',       -- nobody has looked at this one yet
      'PREDICTED',        -- a gap was flagged on the scope item this CO hit
      'MISSED',           -- it was a scope gap and we did not flag it
      'NOT_PREVENTABLE'   -- owner-directed, unforeseen, design error — not ours to catch
    )),
  add column hindsight_note text,
  add column reviewed_by uuid references public.app_user(id),
  add column reviewed_at timestamptz;

create index idx_change_order_scope_item on public.change_order (scope_item_id);
create index idx_change_order_hindsight on public.change_order (past_project_id, hindsight);

comment on column public.change_order.hindsight is
  'The verdict of the backtest, and a HUMAN one. A model may propose the match; '
  'claiming "we would have caught this" on a model guess is exactly the claim '
  'that falls apart in the room it was made for.';

comment on column public.change_order.matched_gap_id is
  'Set only when PREDICTED. It is the receipt: the specific gap row, on the '
  'specific scope item, that this change order later landed on.';

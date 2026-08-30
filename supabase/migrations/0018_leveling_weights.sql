-- =============================================================================
-- 0018 · The weights P11 always specified
--
-- P11 asks for owner-set weights — price 30, scope 25, risk 20, commercial 15,
-- programme 10 — "editable, so an estimator can re-weight and watch the ranking
-- move". leveling_result has carried score_price, score_scope, score_programme,
-- score_commercial, score_risk and weighted_score since 0001 and every one of
-- them has been null, because nothing ever computed or stored a weight.
--
-- Weights live on the PROJECT, not the package. A GC weighs the same way across
-- a job — if price matters more than programme on this build, that is true of
-- the plumbing and the drywall alike. Per-package weights would also make two
-- packages incomparable, and the buyout log adds them together.
--
-- The weighted score is ADVISORY AND SECONDARY. advisory_rank stays ranked on
-- adjusted_total, because "rank on adjusted, never on quoted" is the product and
-- a weighting an estimator can move must never be able to reorder the thing the
-- product exists to assert. The weighted view sits beside it, clearly its own
-- column, answering a different question: not "which is cheapest once scope is
-- equalised" but "which would we rather buy".
-- =============================================================================

alter table public.project
  add column weight_price       int not null default 30,
  add column weight_scope       int not null default 25,
  add column weight_risk        int not null default 20,
  add column weight_commercial  int not null default 15,
  add column weight_programme   int not null default 10;

comment on column public.project.weight_price is
  'Owner-set weights, P11. They move the advisory weighted score and never the '
  'adjusted ranking.';

-- Ranked on the weighted score, kept apart from advisory_rank on purpose so a
-- reader can see the two orders disagree.
alter table public.leveling_result
  add column weighted_rank int;

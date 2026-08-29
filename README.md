# WinProjects

Preconstruction software that makes the Scope of Work the enforceable baseline every subcontractor
bid is measured against — and proves who carried it and who did not.

> **"Your low bidder wasn't your low bidder."**

A $500k quote that excludes $80k of scope is a $580k quote. WinProjects normalises every quote onto
one scope baseline, costs the exclusions back in, and hands the estimator an adjusted comparison
plus a ranked log of what nobody priced.

## The chain

**Scope of Work → Sub Solicitation → Bid Leveling**, with a scope-gap risk log as the output.

Deliberately not a preconstruction suite. Takeoff, drawings ingestion, and go/no-go scoring are out
of scope.

## The rules

| | |
|---|---|
| **R1** | Blank stays blank — no invented numbers, ever |
| **R2** | Agents write evidence, humans write state |
| **R3** | No send path exists — absent, not disabled |
| **R4** | Autopilot never crosses a human gate |
| **R5** | Uncalibrated benchmark ranges are internal only |
| **R6** | Cite or stay silent |

## Docs

| File | What it is |
|---|---|
| [`docs/01-CORE-SPEC.md`](docs/01-CORE-SPEC.md) | Entities, tenancy, gates, agent contracts |
| [`docs/02-BUILD-PROMPTS.md`](docs/02-BUILD-PROMPTS.md) | P0–P20, paste into Replit one at a time |
| [`docs/03-DEMO-SCRIPT.md`](docs/03-DEMO-SCRIPT.md) | **The acceptance criteria** |
| [`docs/04-EXECUTION-PLAN.md`](docs/04-EXECUTION-PLAN.md) | Week by week, hours, the go/no-go |

## Stack

Supabase (Postgres + RLS + Auth + Storage) · React + Vite · Express · Anthropic API · hosted on
Replit, source of truth on GitHub.

## Getting started

Start with `docs/04-EXECUTION-PLAN.md` §5, then work `docs/02-BUILD-PROMPTS.md` from P0.

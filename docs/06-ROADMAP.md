# WinProjects — Build Status and Roadmap

**Updated:** 2026-08-29 (second pass) · Read with [`04-EXECUTION-PLAN.md`](04-EXECUTION-PLAN.md) (the why) and
[`05-TECH-DEBT.md`](05-TECH-DEBT.md) (what was deliberately deferred).

Written milestone by milestone rather than prompt by prompt, because the original P0–P20 order
assumed Replit Agent was building it and assumed one package per project. Neither held.

---

## M-numbers and P-numbers

Two numbering schemes exist and they are not the same thing.

- **P0–P20** are the original build prompts in [`02-BUILD-PROMPTS.md`](02-BUILD-PROMPTS.md).
- **M0–M20** are the milestones below. They exist because roughly a third of what got built has no
  P-number — that work came from real files and real use, not from the original plan.

| Milestone | Original prompt | Note |
|---|---|---|
| M0 Foundations | P0, P1 | |
| M1 Data model and tenancy | P2 | |
| M2 Identity and gates | P4 | |
| M3 Documents | P5 | Extended: project-level bid set, direct-to-storage |
| M4 Agent runtime | P6 | |
| M5 Project structure | **none** | Projects CRUD, per-division packages |
| M6 Sub list import | P15 | Parser only so far |
| M6b Audited editing | **none** | Every field human-editable |
| M6c Spreadsheet grid | **none** | |
| M7 Scope of Work grid | **none** | Screens for `scope_item`; P18 is the *agent* that drafts them |
| M7b Import review screen | P15 | |
| **M8 Quote extraction** | **P7** | The hinge |
| M9 Normalisation | P8 | |
| M10 Add-back estimation | P9 | |
| M11 Scope gaps | P10 | |
| M12 Leveling matrix | P11 | |
| M13 Buyout log | **none** | Added at Elie's direction |
| M14 Risk log and export | P12 | |
| M15 Division Experts | P13 | |
| M16 Solicitation screens | P16 | |
| M17 Autopilot + review queue | P17 | |
| M18 SoW drafter | P18 | |
| M19 Provenance and ledger | P19 | |
| M20 Hardening | P20 | |
| — | P3 | Seed, done as part of M1 |
| — | P14 | CO archaeology, parked |
| — | P19/P20 | See M19, M20 |

---

## Done

### M0 · Foundations
Three TypeScript workspaces under project references. npm scripts for dev, build, migrate, seed and
verify. Pre-commit hook that refuses any commit containing a credential — added after real keys
twice landed in a tracked file. `docs/` is the source of truth; GitHub is `ea-13/winwork`.

### M1 · Data model and tenancy
33 tables. Every tenant-scoped one carries `tenant_id`, has RLS enabled, and has a policy — enforced
by catalogue loops rather than by hand, so coverage is true by construction. `draft`, `approval` and
`audit_event` are append-only at the database level (R2). `current_tenant_id()` resolves tenancy
from the JWT claim.

**Proven, not assumed:** `npm run verify:rls` runs 17 checks including a live test that impersonates
one tenant and confirms another's rows are neither readable nor writable.

### M2 · Identity and gates
One seeded login, no signup (week-1 scope). Roles are grants — the demo user holds `BC` and `EST`,
and `requireRole` passes on *any* held role. All five gates (H2–H6) implemented, each requiring a
non-empty rationale and writing an append-only approval row.

**R3 is enforced twice:** API middleware *and* a check constraint on `job.job_type`, so a
send-shaped job is refused even to `service_role`.

### M3 · Documents
Project-level bid set (drawings, specs, addenda, geotech) and package-level sub bids. Direct-to-
storage uploads via signed URLs — bytes never touch the API process. The server mints the storage
key, so the tenant prefix is not negotiable, and reads the object's true size back from storage
rather than trusting the browser. Forged confirm paths refused.

### M4 · Agent runtime
Jobs leased through `claim_job()` (`FOR UPDATE SKIP LOCKED`), retried up to three times, then
dead-lettered. `AgentContext` exposes exactly two methods — `emit()` and `draft()` — and carries no
database handle, so R2 is enforced by the type system rather than by convention.

Activity stream is a screen, not a spinner: SSE replays existing events then streams live, so a
reload mid-run loses nothing.

### M5 · Project structure
Create projects with validated permanent bid IDs. 23 CSI divisions; a package per division, each
carrying budget, allowance and contingency — the buyout log's inputs, in place before the log needs
them.

### M6 · Sub list import (parser)
Handles both real-world shapes: a hand-kept trade directory (header row not on row 1, scope column
present) and an accounting vendor master (thousands of rows, `Type` column, **no trade data at
all**). Detects the header row, maps columns by meaning, and assigns a CSI division **only on an
actual match** — an unmatched trade stays unclassified for a human rather than being guessed from a
company name (R1).

Against the two real files: 33/33 classified from the directory; 943 importable of 2,759 from the
vendor master, 0 classified because no trade column exists.

### M6b · Human editing, audited
Every human-owned field on sixteen tables is editable through one endpoint,
`PATCH /api/records/:table/:id`. Each edit writes an append-only `audit_event` with before, after,
actor and timestamp. Identity, tenancy, gate-controlled state and agent bookkeeping are refused —
a general edit endpoint is exactly the back door R4 forbids.

Unchanged fields write nothing, so the ledger stays meaningful. If the edit lands but the audit row
fails, the response says so rather than reporting success.

**This is also the training corpus.** `draft` (what the agent proposed) joined to `audit_event`
(what the human chose) joined to `approval` (what they accepted) is a supervised training set,
captured as a by-product of normal work. See `05-TECH-DEBT.md` items 19–23.

### M6c · Spreadsheet grid (built, not yet wired)
A keyboard-first grid with the interaction model estimators already have: type to replace, F2 or
double-click to edit in place, Enter down, Tab right, Shift+arrows to select a range, Ctrl+C/V
round-tripping Excel's TSV clipboard, Ctrl+D fill down, Ctrl+Z undo, Delete to clear. Paste of a
block issues one request per row, not per cell.

Decision recorded in `05-TECH-DEBT.md`: **no embedded Google Sheet.** Data outside Supabase is data
outside RLS and outside the ledger, which retires the product's central claim. The escape hatch is
xlsx export and re-import with a diff, not a live link.

**Component compiles and is complete; it is not yet attached to a screen.** That is the next step.


---

## Remaining

| # | Milestone | What it delivers | Blocked on |
|---|---|---|---|
| **M7** | **Scope of Work grid** | Wire the grid to `scope_item`: add, edit, CSI structure, H2 lock. The first screen that is genuinely a workspace | — |
| **M7b** | Import review screen | Preview → assign trades → commit. 943 unclassified vendors need trades, and that is a human act | — |
| **M8** | **Quote extraction (P7)** | Line items, commercial terms, and **exclusions** with page-level citations | **Elie's judgement on output quality** |
| **M9** | Normalisation (P8) | Quote lines mapped onto the scope baseline; ambiguous flagged, never forced | M8 |
| **M10** | Add-back estimation (P9) | Costs exclusions back in: comparable bids → benchmark → TBC. Never a guess | M9 |
| **M11** | Scope gaps (P10) | `UNCOVERED` / `PARTIAL` / `UNPRICEABLE` / `AMBIGUOUS`, severity derived | M9 |
| **M12** | Leveling matrix (P11) | **The flip.** Adjusted totals, ranking on adjusted, never on quoted | M10, M11 |
| **M13** | **Buyout log** | Per-division buyout against budget, with allowances and contingency accounted | M12 |
| **M14** | Risk log and export (P12) | The artefact a prospect asks for a copy of | M11 |
| **M15** | Division Experts, real | Replace 23 stubs with playbook content; retrieval architecture | Vault playbooks |
| **M16** | Solicitation screens (P16) | Bidder lists, package scope summaries. Drafted only — no send (R3) | M7 |
| **M17** | Autopilot + review queue (P17) | Full drafting chain unattended, everything parked at one gate | M8–M12 |
| **M18** | SoW drafter (P18) | Agent drafts scope items from the bid set | M7, M8 |
| **M19** | Provenance and ledger (P19) | Make gate approvals atomic; approval ledger UI | — |
| **M20** | Hardening (P20) | Work `05-TECH-DEBT.md` P0 and P1 items | — |
| **—** | CO archaeology (P14) | **Parked deliberately.** Tables exist, nothing built | A closed job's change orders |

---

## What is blocking what

**Nothing blocks M7, M7b, M19 or M20** — those can proceed at any time.

**M8 is the hinge.** Everything from M9 to M13 sits behind extraction working well enough to trust,
and "well enough" is a judgement only Elie can make: did it find every exclusion, including the one
buried in the cover letter? That is the Day-4 question the execution plan says is undelegable.

**M13 is the commercial output.** The buyout log is what the estimator actually lives in, and it is
the thing this build added beyond the original spec.

---

## Hosting

Replit is **not needed yet**. Everything runs locally, and the only thing hosting buys today is a
URL nobody is visiting. It becomes necessary at the first live demo to a GC — a shareable URL,
always-on, and eventually `winprojects.ai`.

Deploy once M12 lands, so the first deployed version is one that can show the flip.

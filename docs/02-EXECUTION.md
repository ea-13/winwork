# WinProjects — Execution

**The single build file.** What each step delivers, whether it is done, what proves it, and where
the build knowingly departed from the original plan.

Replaces the former `02-BUILD-PROMPTS.md` (the paste-into-Replit sequence) and `06-ROADMAP.md` (the
milestone status). One numbering scheme: **P-numbers**. Steps P0–P20 keep their original meaning;
P21–P28 are work that came out of real use and had no number before.

**Updated:** 2026-08-29 (build-through pass)

| Status | Meaning |
|---|---|
| ✅ | Done and verified |
| 🔸 | Partially done — the gap is named |
| ▶ | Next |
| ⬜ | Not started |
| ⏸ | Parked deliberately |

---

## Sequence

| # | Step | Status | Delivers |
|---|---|---|---|
| **P0** | Setup | ✅ | Supabase, Anthropic key, GitHub, storage limits |
| **P1** | Scaffold | ✅ | Three workspaces, `/api/health` → `db: connected` |
| **P2** | Schema and RLS | ✅ | 33 tables, tenant isolation, append-only evidence |
| **P3** | Seed the demo tenant | ✅ | One login, 18 scope items, 12 subs, planted gaps |
| **P4** | Auth and role guards | ✅ | JWT claims, roles as grants, five gates, no-send guard |
| **P5** | File upload | ✅ | Sub bids per package, typed errors |
| **P6** | Agent runtime | ✅ | Job queue, `AgentContext`, live SSE activity stream |
| **P21** | Projects and packages | ✅ | Project CRUD, 23 CSI divisions, package per division |
| **P22** | Bid-set documents | ✅ | Drawings, specs, addenda at project level |
| **P23** | Direct-to-storage upload | ✅ | Signed URLs, large plan sets, server memory untouched |
| **P15** | Sub list import | ✅ | Parser, preview and commit endpoints |
| **P24** | Audited human editing | ✅ | Every field editable, every edit in the ledger |
| **P25** | Spreadsheet grid | ✅ | Wired to Scope of Work |
| **P26** | Scope of Work screens | ✅ | Create, edit, generated scope ids |
| **P7** | **Quote extraction** | ✅ | Ran on a real quote: 19 exclusions, 35 drafts |
| **P8** | Normalisation | ✅ | Ambiguous below 0.7 goes to a human |
| **P9** | Add-back estimation | ✅ | COMPARABLE_BIDS → BENCHMARK → TBC |
| **P10** | Scope gap detection | ✅ | Set difference, severity derived |
| **P11** | Leveling matrix | ✅ | Both rankings shown side by side |
| **P27** | Buyout log | ✅ | Variance measured on adjusted |
| **P12** | Risk log and export | ✅ | XLSX; uncalibrated suppressed (R5) |
| **P13** | Division Experts | 🔸 | Consult agent built; **stub content, real playbooks missing** |
| **P16** | Solicitation screens | ✅ | Ranked candidates, drafted text, no send |
| **P17** | Autopilot and review queue | 🔸 | Extraction chain + queue; **narrowed, see below** |
| **P18** | Scope of Work drafter | ✅ | Quantities only where stated |
| **P19** | Provenance and ledger | ✅ | Gates atomic; provenance endpoint |
| **P28** | Training corpus export | ✅ | JSONL, labelled ACCEPTED/CORRECTED/PENDING |
| **P20** | Hardening | 🔸 | Isolation sweep + bundle check; **rate limits open** |
| **P14** | Change-order archaeology | ⏸ | Parked — needs a closed job's change orders |

---

# Done

## P0 · Setup ✅
Supabase project (`vjjypyokxpanpdjncvnj`, us-east-1), Anthropic key with a $100 cap, private GitHub
repo `ea-13/winwork`, storage buckets at 5GB.

**Verified:** health endpoint reaches the database; a commit is on GitHub.

**Deviation:** the plan had Replit create the first commit. It doesn't — the build is local and
pushes from here, because letting Replit author commits collides with local history.

## P1 · Scaffold ✅
`client` (React 19, Vite, Tailwind v4, Router), `server` (Express, service-role Supabase client),
`shared` (types only, no secrets). One `.env` at the root. In production the API also serves the
built client, so the deployment is one origin.

**Verified:** `/api/health` returns `{"ok":true,"db":"connected"}` against the real project.

## P2 · Schema and Row Level Security ✅
33 tables. Every tenant-scoped table carries `tenant_id`, has RLS enabled, and has a policy —
applied by catalogue loops so coverage is true by construction rather than by careful typing.
`draft`, `approval` and `audit_event` are append-only via database triggers.

`current_tenant_id()` resolves tenancy from `app_metadata.tenant_id` in the JWT, falling back to an
`app_user` lookup by `auth.uid()`.

**Verified:** `npm run verify:rls` — 17 checks, including a live test that impersonates one tenant
and confirms another's rows are neither readable nor writable. Structural checks alone cannot tell
working RLS from permissive RLS.

**Deviations:** `division_expert`, `gap_pattern` and `lead_time` carry no `tenant_id` — shared CSI
reference data, RLS on with a read-only policy. `package_scope` gained a `tenant_id` the spec
omitted. UPDATE triggers are statement-level; DELETE triggers are row-level, because statement-level
DELETE fired on zero-row cascades and made deleting any tenant impossible.

## P3 · Seed the demo tenant ✅
One tenant, one user holding both `BC` and `EST`, 18 locked scope items across six divisions, one
Interior Finishes package, 12 subcontractors, 5 bidders. Idempotent by construction — every primary
key is a digest of a stable string.

The planted gaps work structurally: **no bidder on the package holds a division 07 trade**, so
`07-14` firestopping is genuinely uncovered rather than merely labelled so.

**Verified:** run twice, counts identical.

## P4 · Auth and role guards ✅
One seeded login, no signup. `tenant_id`, `app_user_id` and `roles` ride in `app_metadata`, writable
only by `service_role`. `requireRole` passes on **any** held role, because roles are grants.

All five gates implemented; each requires a non-empty rationale and writes an append-only approval.

**R3 is enforced twice:** API middleware and a check constraint on `job.job_type`, so a send-shaped
job is refused even to `service_role`.

**Verified:** no token → 401, forged token → 401, gate without rationale → 400, whitespace rationale
→ 400, send-shaped agent type → 403.

**Known gap:** the approval row and the state change it authorises are two statements, not one
transaction. Approval is written first, so a failure records an attempt rather than an unauthorised
change. P19 makes it atomic. Tracked as tech-debt item 1.

## P5 · File upload ✅
Sub bids per package. PDF, XLSX, DOCX. Quote rows are created with `subcontractor_id` null and no
priced fields — which bidder sent a document is something extraction determines.

**Verified:** disallowed type → 415 naming the file and accepted types; PDF → 201 with a
`PENDING_EXTRACTION` quote row.

**Deviation:** the original 25MB cap was sized for a quote PDF. Multer errors were also unhandled,
so an oversized file returned an HTML error page the browser could not parse — which presented as
"upload didn't work". Both fixed; see P23.

## P6 · Agent runtime ✅
Jobs leased through `claim_job()` using `FOR UPDATE SKIP LOCKED`, retried three times, then
dead-lettered. Going through RPC rather than a direct connection means the deployment never needs
`DATABASE_URL`.

`AgentContext` exposes exactly `emit()` and `draft()` and carries no database handle, so R2 is
enforced by the type system: an agent that tries to write canonical state does not compile.

The activity stream replays existing events then streams live, so a reload mid-run loses nothing.
The `agent_run` row is created at enqueue, so the client can watch from the first second.

**Verified:** dummy job → 8 events streamed live, gapless sequence, 3 immutable drafts, run reaches
DONE, a late client replays the full run.

## P21 · Projects and per-division packages ✅
Project creation with `PREFIX-YYYY-NNN` bid IDs, permanent and never reused. 23 CSI divisions; a
package per division carrying `budget_amount`, `allowance_amount` and `contingency_amount`.

**Why this exists:** the original plan assumed one package per project. A GC buys by trade.

## P22 · Bid-set documents ✅
Drawings, specs, addenda and geotech at the **project** level — they are what every package and
quote is measured against, and they arrive before any package exists.

## P23 · Direct-to-storage uploads ✅
The browser uploads straight to Supabase with a short-lived signed URL. The server still mints the
storage key, so the tenant prefix is not negotiable, and reads the object's true size back from
storage rather than trusting the browser.

**Verified:** 54KB and 63MB files both land; a confirm call with a forged path is refused.

Two limits, deliberately distinct: the multipart route stays at 50MB because it buffers in process
memory; the direct path is bounded only by the bucket, now 5GB.

## P15 · Sub list import 🔸 — parser done, review screen missing
Handles both shapes real lists come in:

- **Trade directory** — 33 rows, a Scope column, header row not on row 1
- **Accounting vendor master** — 2,759 rows, a `Type` column with casing and whitespace variants,
  and **no trade information at all**

Header row detected by content, columns mapped by meaning, CSI division assigned **only on an actual
match**. Guessing a trade from a company name would send a package to the wrong bidders.

**Result on the real files:** 33/33 classified from the directory; 943 importable of 2,759 from the
vendor master, 0 classified because the file carries no trade column. That number is the finding,
not a parser failure.

**Remaining:** the review screen — preview, correct the mapping, assign trades in bulk, commit.
943 vendors need trades and that is a human act.

## P24 · Audited human editing ✅
Every human-owned field across sixteen tables is editable through one endpoint,
`PATCH /api/records/:table/:id`. Each edit writes an append-only `audit_event` with before, after,
actor and timestamp.

Refused: identity and tenancy, gate-controlled state, agent bookkeeping. A general edit endpoint is
exactly the back door R4 forbids.

**Verified:** edit → 200 with changed fields; same value again → no audit noise; `approved_by` →
403; `approval` table → 404.

**This is also the training corpus.** See P28.

## P25 · Spreadsheet grid 🔸 — component done, not yet wired
Keyboard-first: type to replace, F2 or double-click to edit in place, Enter down, Tab right,
Shift+arrows to select a range, Ctrl+C/V round-tripping Excel's TSV clipboard, Ctrl+D fill down,
Ctrl+Z undo, Delete to clear. A pasted block issues one request per row, not per cell.

**Decision: no embedded Google Sheet.** Data outside Supabase is outside RLS and outside the ledger,
which retires the product's central claim to a GC. The escape hatch is xlsx export and re-import
with a diff, not a live link.

**Remaining:** attach it to a screen. That is P26.

---

# Built in the build-through pass

## P26 · Scope of Work screens ✅
Wire the grid to `scope_item`: add rows, edit every field, organise by CSI division and section, and
lock the baseline (H2, `EST`, rationale required).

The first screen that is genuinely a workspace rather than a view.

**Verify:** create a scope item, paste a column of quantities from Excel, lock the scope, confirm
the approval row and the audit trail.

## P7 · Quote extraction ✅ — **the hinge**
One quote document in; `quote`, `quote_line[]`, `quote_exclusion[]`, `quote_term[]` out, as drafts.

Two extraction categories: **pricing** (line items, subtotals, prelims, overhead and profit, total,
alternates, pricing basis) and **commercial** — **exclusions first and most carefully**, then
caveats, programme, payment terms, design responsibility, insurance, warranties.

Exclusions hide in appendices, footnotes, "Notes" and "Qualifications" sections, and cover letters —
not in the pricing table. Every extracted value records page and excerpt. Unreadable is `UNKNOWN`,
never a guess.

**Verify:** run on a real quote PDF. **Check the exclusions by hand.** This is the quality bar the
product stands on, and it is Elie's judgement, not a test that can be automated.

**Note:** the sample quote in hand is residential plumbing; the seeded scope baseline is a
commercial interior fit-out. Extraction works regardless, but P8 will have nothing sensible to match
against until there is a plumbing scope baseline or a matching quote.

## P8 · Normalisation ✅
Quote lines mapped onto the locked scope baseline. Match on substance, not wording. Uncertain
equivalences are flagged `AMBIGUOUS`, never assumed. `original_text` is preserved alongside the
mapping, always. Unmatched lines are labelled, never silently dropped.

**Verify:** normalisation runs; ambiguous lines surface rather than vanish.

## P9 · Add-back estimation ✅
Per exclusion, in strict priority: `COMPARABLE_BIDS` (what other bidders priced) → `BENCHMARK`
(internal, flagged, uncalibrated) → `TBC`. A wrong add-back is worse than an honest TBC.

```
adjusted_total = quoted_total + Σ add-backs + risk_allowance
```

**Verify:** hand-check the arithmetic on the seeded package.

## P10 · Scope gap detection ✅
Deterministic set-difference against the locked baseline produces `UNCOVERED` and `PARTIAL` with no
model involved. Model judgement handles `AMBIGUOUS` and matches gaps to `gap_pattern` rows. Severity
is computed from exposure and confidence, never authored.

**Verify:** the planted `07-14` firestopping gap appears as **UNCOVERED / CRITICAL**.

## P11 · Leveling matrix ✅ — the flip
Scope items down, bidders across. Quoted totals, add-backs, risk allowance, adjusted totals.
**Rank on adjusted, never on quoted.** Owner-set weights: price 30, scope 25, risk 20, commercial
15, programme 10 — editable, so an estimator can re-weight and watch the ranking move.

**Verify:** the quoted-versus-adjusted ranking flip is unmistakable.

## P27 · Buyout log ✅
Per-division buyout against budget: budget, allowances carried, contingency carried, selected
bidder, adjusted value, variance, and the scope gaps still open against that package. The
estimator's home screen and the thing this build added beyond the original spec.

## P12 · Risk log and export ✅
Standalone scope-gap risk log, sorted by severity then exposure, filterable. Exports to XLSX and PDF
and must stand alone: project, date, a summary line, then detail.

**Critical:** any `BENCHMARK` basis whose `benchmark_range.is_calibrated` is false is **suppressed
from client-facing exports** and shown internally as "uncalibrated benchmark — internal only" (R5).

## P13 · Division Experts 🔸 — consult agent built, content still stubs
23 divisions seeded as `SEED_STUB` with placeholder gap patterns — common industry checks, not
calibrated knowledge, and the status field says so.

**Remaining:** replace with the real playbook content, and build the Consult agent that checks every
applicable pattern against locked scope and raises advisory flags citing the pattern text.

**Architecture:** Claude models cannot be fine-tuned. A division expert is a specialist system
prompt plus a retrieved knowledge base — editable without retraining, and every claim can cite its
source (R6).

## P16 · Solicitation screens ✅
Package builder (H3), bidder list ranked by trade match, prequal, EMR and bonding — advisory only
(H4), and drafted invitation text.

**There is no send button.** Where one would be: *"Drafted. WinProjects does not send email — copy
this into your own system."* Make it visible; it is the reason a burned GC trusts the product.

## P17 · Autopilot and review queue 🔸 — narrowed, deliberately
Runs extraction across every un-extracted quote in a package unattended, then parks everything in
one review queue. Crosses no gate, at any confidence, after any number of retries.

**Narrowed on purpose, and this is the one place the build says no to its own spec.** P17 asks for
the chain to continue through normalise → add-back → gap detect → level. It does not, because every
one of those steps writes canonical rows, and R2 says promotion to canonical state is a separate,
human-attributed act. An autopilot that promoted its own drafts in order to keep chaining would be
an agent writing state with a human's name on it — which is the exact thing the architecture exists
to prevent.

So the queue is where a human picks it up, and from there each remaining step is one click. If the
"came back from lunch to five levelled packages" story matters more than the guarantee, the honest
way to get it is a per-tenant setting that records who enabled it, not a silent exception.

## P18 · Scope of Work drafter ✅
Agent drafts `scope_item` rows from specifications and scope narratives, each carrying source
document, page and excerpt. Quantities drafted **only where stated** — never inferred from area.

## P19 · Provenance and the approval ledger ✅
Every AI-derived field shows source document, page, excerpt, confidence, model and prompt version.
Fill tags rendered as colour. Approval history per project. Audit trail, filterable.

Also: make gate approvals atomic (tech-debt item 1).

## P28 · Training corpus export ✅
`draft` (what the agent proposed) joined to `audit_event` (what the human chose) joined to
`approval` (what they accepted) is a supervised training set — captured as a by-product of normal
work, never as a data-entry chore.

Needs: JSONL export, a frozen evaluation set, regression scoring on exclusion recall, and a PII
boundary before any corpus leaves a tenant. Tech-debt items 19–23.

## P20 · Hardening 🔸
**Done:** `npm run verify:isolation` creates a second tenant with real data, authenticates as the
first, and sweeps 16 endpoints asserting none returns a foreign row — plus writes, which must fail
too. Negative controls assert a gate without rationale is refused, a send-shaped job is refused even
to `service_role`, and `draft`/`approval`/`audit_event` reject UPDATE. `npm run build` fails if any
server secret reaches the client bundle.

**Open:** per-tenant rate limits and token-cost caps; graceful degradation to `PARTIAL_EXTRACTION`
on scanned or multi-column PDFs.

Plus the P0 and P1 items in [`05-TECH-DEBT.md`](05-TECH-DEBT.md).

---

# Parked

## P14 · Change-order archaeology ⏸
Tables exist (`past_project`, `change_order`, `co_classification`); nothing is built. Needs a closed
job's real change orders to build against, and parked at Elie's direction until then.

The output when it lands: *"of $X in change orders, $Y were preventable scope gaps — and here are
the patterns."*

---

## What blocks what

**Everything through P28 is built.** What remains is content and hardening, not features:

- **P13** needs the real vault playbooks. The consult agent works; it is reasoning against stubs.
- **P17** is narrower than written — see the note in its section.
- **P20** has the isolation sweep and the bundle check; rate limiting and PDF robustness are open.
- **P14** is parked, awaiting a closed job's change orders.

**P7 is the hinge.** P8 through P27 all sit behind extraction being good enough to trust, and "good
enough" is a judgement only Elie can make.

**P27 is the commercial output.** The buyout log is what an estimator lives in.

## Hosting

Replit is not needed until the first live demo. Deploy once P11 lands, so the first deployed version
is one that can show the flip.

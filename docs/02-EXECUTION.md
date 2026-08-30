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
| **P11** | Leveling matrix | 🔸 | Both rankings shown side by side. **The flip itself has never been observed** — see L17 |
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
| **P29–P34** | The walkthrough build | ✅ | Chain nav, uploads, drawings→scope, packages, bid tab, context |
| **P35–P39** | Restructure and first real run | ✅ | Five steps, Excel grid, scope template, real plan set indexed |
| **P11** | Leveling matrix | 🔸 | **2026-08-30** — weights, scoring, H6 selection added; it had been marked done without them. Still 🔸: its acceptance bar is the ranking flip, and that needs line-level bids. See **L17** |
| **P40–P44** | Manual path, workspaces, cost codes | ✅ | Manual bids, blank rows, multi-tenant, cost codes, split bids |
| **P45–P48** | AI-native surface | ✅ | Copilot suggestions, A10 coverage audit, A11 bid comparison, A12 cost-code mapper |
| **P49** | Project assistant | ✅ | Chat with tools over the real project. Reads anything; writes no state |

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

## P11 · Leveling matrix 🔸 — built, and the flip is still unproven
Scope items down, bidders across. Quoted totals, add-backs, risk allowance, adjusted totals.
**Rank on adjusted, never on quoted.** Owner-set weights: price 30, scope 25, risk 20, commercial
15, programme 10 — editable, so an estimator can re-weight and watch the ranking move.

**Verify:** the quoted-versus-adjusted ranking flip is unmistakable.

**That bar has never been cleared, and this section said ✅ anyway.** Twice now.
The first time P11 was marked done without the weights its own acceptance
criterion asked for. This is the same mistake wearing a different hat: the
mechanism is built, tested and correct, and the thing the criterion actually
demands — watching a ranking reorder — has not once been observed, because the
only bids in the system are lump sums.

Three lump-sum totals rank. They cannot reorder, no matter what the add-back
logic does, because there is nothing to add back to: an add-back needs a priced
line to attach to, and a single number has none. Every add-back computed against
the current data has come out zero, which is arithmetically right and
demonstrates nothing.

What clears it: **two or more bids carrying line-level pricing on the same scope
items, where one excludes something the others priced.** Then the adjusted
ranking moves and the criterion is met. Until then this is 🔸 and the demo shows
the mechanism, not the reversal. See **L17**.

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

**Superseded 2026-08-31.** It is deployed and matching local, and it still cannot
show the flip — P11 shipped without clearing that half of its bar. Deploying
early was right; the note above just should not be read as evidence the flip
works. See **L17**.

---

# P29–P34 · The walkthrough build

Everything above was built by working forward through the plan. This block came from the opposite
direction: sitting in front of the running app and writing down what did not work. That produced a
different and more useful list, because three of the six items were not missing features at all —
they were finished work with no way to reach it.

| | | | |
|---|---|---|---|
| **P29** | The chain, made visible | ✅ | One stepper across both page levels, counts not ticks |
| **P30** | Upload as a drop, not a form | ✅ | Real per-file progress, label afterwards |
| **P31** | Drawings and specs into scope | ✅ | Sheet index, per-sheet citation, both read together |
| **P32** | Packages as one long table | ✅ | Collapsible by division, notes, multi-division |
| **P33** | The bid tab sheet | ✅ | Per scope item, per bidder, overrides survive recompute |
| **P34** | Scope context and the learning loop | ✅ | What a line MEANS, and whether saying it worked |

## What was unreachable rather than unbuilt

- **The buyout log existed** and had done since P27. It sat behind a tab nothing pointed at.
- **The scope drafter existed** — agent, endpoint, worker registration, all of it. `grep draft-scope
  client/src` returned nothing. It had never run once.
- **Nothing could promote a scope draft.** Even reached, the drafter's output had no path into the
  baseline. P18 was only ever half a feature, and the half that was missing is the half that makes
  it real.

The lesson is not "wire up the buttons". It is that a step verified end-to-end at the API is not
verified. P18's acceptance bar said "quantities only where stated", which was true and testable and
told us nothing about whether an estimator could obtain a scope of work.

## P29 · The chain, made visible ✅

Documents → Scope → Packages → Bidders → Bids → Leveling → Gaps → Buyout, on every screen, with the
package-level steps marked as needing a package.

Counts, never percentages. "3 of 47 locked" says what to do next; "6% complete" says nothing anybody
can act on. `GET /projects/:id/chain` answers the whole strip in one request.

## P30 · Upload as a drop, not a form ✅

Kind used to be chosen BEFORE dropping. That is backwards — a bid set arrives as one download of
forty files and sorting it is something you do while looking at the list. Everything lands `UNFILED`
and the kind is a dropdown in the table.

Progress is per file and real, read off the request. `uploadToSignedUrl` cannot report progress at
all, so this is XHR against the signed URL — the one thing XHR still does that `fetch` does not.
Three concurrent, because browsers cap connections anyway and a queue showing ten started uploads
while eight sit blocked is a progress bar that lies.

## P31 · Drawings and specs into scope ✅

Specs and drawings are read differently on purpose. A specification says what the work must be, and
is read in page batches and cited by page. A drawing says what and how much there is, and is read by
SHEET — chosen from the sheet index by discipline, cited by sheet number.

That distinction is the whole feature. "A-201, keynote 4" is a reference a sub can act on. "Page 47
of Drawings.pdf" is not, and R6 is not satisfied by a citation nobody can follow.

A new agent (A8) reads every title block and writes `document_sheet`. It is the one canonical write
an agent is trusted with, and the escape hatch is shaped as a method that can only write sheets
rather than a database handle — see the note on `AgentContext.recordSheets`.

Reading them together also surfaces where they disagree, which is drafted as scope with the conflict
stated rather than silently resolved.

## P32 · Packages as one long table ✅

Collapsible by division, because an estimator working division 22 does not want division 03 on
screen. Adding a division adds a head; removing one is refused once anything has been bid against
it, since the cascade would take the record of the decision with it.

Budget, allowance and contingency are typed in place. Notes are a floating panel with a global
show/hide and right-click to open — a note is three sentences about why a number is what it is, and
a table cell is not where three sentences go.

## P33 · The bid tab sheet ✅

`leveling_result` answers "which bid is lowest". This answers "where does the difference come from",
which you have to answer first to defend the other one. One row per scope item, three bidder columns,
swappable, defaulting to the three adjusted-lowest.

`scope_leveling` splits the number in two on purpose. `rolled_total` is derived and replaced on every
run; `override_total` is the estimator's and survives. Two columns rather than one because "the model
said 86,200 and I say 91,000" is exactly the labelled correction P28 wants, and collapsing them loses
it.

**The bug that mattered:** the first version deleted and rebuilt the whole grid on recompute. A quote
that is not yet `EXTRACTED` contributes no cells, so recomputing a package with an unread bid deleted
an estimator's typed-in numbers and put nothing back. Caught by a smoke test asserting survival
across a recompute, which is now the assertion that guards it. Recompute silently eating typed-in
numbers is the single behaviour that would send everybody back to Excel.

## P34 · Scope context and the learning loop ✅

Scope does not leak at the item level. "Metal stud framing, 4,200 SF" is enough to check that
somebody priced framing; it is not enough to check that anybody priced the head-of-wall detail, and
the head-of-wall detail is the change order.

`scope_context` holds what an item includes, excludes, interfaces with, assumes, risks, and is priced
against. Every line is grounded — a gap pattern, a past change order, or the item's own description —
and a line that rests on none of those is not written. General construction wisdom with nothing
behind it is what an estimator cannot act on, because they cannot tell whether it applies to this
job.

**The loop closes in `recordContextOutcomes`,** which runs last on every recompute:

- `CAUGHT_GAP` — a gap opened here and somebody had written that it might.
- `MISSED_GAP` — a gap opened and nothing warned. **This is the valuable one.** It names a seam the
  system does not know about, and it is the row a human turns into a new gap pattern.
- `PRICED_BY_ALL` — everyone carried it. Weak evidence, but it stops a pattern that fires on every
  job and predicts nothing from looking valuable.

Outcomes are append-only and deduplicated on the evidence they rest on, so pressing Recompute five
times cannot turn one finding into a track record of five. `gap_pattern` gained `times_proposed` and
`times_confirmed`, and the UI shows the raw counts rather than a score — "caught 3" is a fact an
estimator can check, "87% reliable" is a model's opinion with the workings hidden.

Promotion into patterns is deliberately manual. A system that promotes its own failures into rules
unsupervised gets worse in a way nobody notices until it is expensive.

### A consequence worth knowing

A context line that has been scored cannot be deleted (0013). The outcome must keep pointing at the
line that earned it, or what remains is "something happened somewhere". Retire it instead —
`is_active`, with a reason, which is itself a signal: a line retired on three projects running is a
pattern that should come out of the knowledge base.

---

# Where we stand

**As of 2026-08-31 · roughly 85% of a presentable MVP.**

Down from the 87% written earlier today, and the number went down because the
record got more honest rather than because anything broke. P11 was carrying a ✅
against an acceptance bar it has never cleared — see **L17** — and a build record
that grades itself generously is worse than no build record, because it is the
one thing you cannot check by reading the code.

Read this and the list below before anything else. `npm run resume` points here.

## The 15% is calibration, not features

The gap between this and a sellable product is **not** more screens. It is two
things that need Elie's data rather than more code:

1. **Real division-expert playbooks.** All 21 divisions exist with placeholder
   gap patterns marked `SEED_STUB`. They are common industry checks, not
   calibrated knowledge, and R5 keeps them internal until they are.
2. **A closed job's change-order list.** `gap_pattern.times_confirmed` has never
   been checked against reality. P14 exists end to end — import, matching,
   verdicts, report, XLSX, screen — and has never seen a real CO.

Everything else on the open list is a day's work each.

## Build status

| | |
|---|---|
| **Complete** | P0–P10, P12, P15–P28 (except P11), P29–P49 |
| **Partial** | **P11** leveling — built and correct; its acceptance bar is the ranking flip and that has never been observed (**L17**) · **P13** division experts — agent built, playbook content is stubs · **P17** autopilot — narrowed deliberately, see that section · **P20** hardening — isolation sweep and bundle check done, rate limits open |
| **P14** | No longer parked. API, screen and QA are done; it is waiting on data |
| **Scale** | 22 migrations · 24 route files · 11 agents · 32 screens and components · 25 template divisions |

## One grey, not two

The client was 394 `slate-*` references against 496 `ink-*` — half the app in
Tailwind's default cool grey, half in the warm grey this product actually chose
in `index.css`. Nobody can name that when they see it and everybody feels it; it
is the difference between a product and an assembly of parts. All 394 are now
`ink-*`. **If a new screen reaches for `slate-`, that is the regression.**

## The verification bar

Four commands. All four must be clean before a push, and they are the only
claim this project makes about itself that is worth anything.

```
npx tsc -b        TS = 0
npm run build     client + server clean; check-bundle finds no server secret
npm run verify    3 suites — RLS, agent runtime, cross-tenant isolation
npm run qa        108 feature checks against a throwaway project
```

`verify` proves the RULES hold. `qa` proves the FEATURES do. They fail
differently and both are needed: a broken rule is a breach, a broken feature is a
morning where nothing works and nobody can say why.

## Next steps, in the order to take them

1. **Line-level bids on one package (L17).** Everything else on this list is
   worth less than this. It clears P11's acceptance bar, it is the demo, and it
   is the only one of these that cannot be worked around by being good in the
   room. Two bids on the same scope items is enough — it does not need four.
2. **One closed job through Hindsight (L16).** Unlocks the outreach claim, and
   it is the cheapest thing to ask a prospect for.
3. **Load the rest of the real demo data.** L1 and L2 will surface failures no
   amount of building finds.
4. **L15, then L4.** A day each, and both are the same complaint already made
   once: a proposal you have to leave the table to look at is a proposal nobody
   looks at, and every table should be the grid.
5. **Rate limiting (L7)** before this is exposed to anyone outside the building.

**The two things that are not features, and are not optional.** Both were
deferred by Elie's own choice, correctly, while there was building to do. That
window has closed — the building is done and these are now what stands between
this and a sellable demo:

- **L17 · the flip.** Line-level bid data. Without it P11's acceptance bar is
  unmet and the demo shows a mechanism rather than a reversal.
- **L16 · the backtest.** One closed job's change orders. Without it there is no
  catch rate, and no honest number to put in front of anybody.

Still genuinely deferred: real division-expert playbooks. As a service Elie's own
expertise fills that gap on every engagement — which is fine, and is also the
thing that does not scale. Not urgent for the first three clients; blocking by
the tenth.

---

# What is left

**This is the running list.** Update it as things land; it is the first thing to
read when picking the build back up, and `npm run resume` points at it.

## Open

| | What | Why it matters |
|---|---|---|
| **L17** | **The flip has never been observed.** P11's own acceptance bar — "the quoted-versus-adjusted ranking flip is unmistakable" — is unmet | The single most persuasive thing this product does, and the reason anyone believes the rest of it. Needs 2+ bids with line-level pricing on the same scope items where one excludes what the others priced. Three lump sums rank and never reorder. **Highest priority; Elie is collecting the data.** |
| **L1** | Drawing→scope still loses a batch to output truncation on a real stamped set | Batch isolation means the run survives it, but ~8% of sheets go unread. `effort: 'low'` is the current mitigation and has not been tested across a full 13-batch run |
| **L2** | Spec-side drafting has never run on a real specification | Every fix so far came from drawings. A 200-page text spec is a different shape and will have its own failure |
| **L4** | `Solicitation` still carries a hand-rolled table | Scope, buyout and the bid tab are on the grid. Solicitation is the last one that is not |
| **L5** | Formulas are per-cell and browser-local | A formula is lost on reload and cannot reference another package's total. Fine for entry, not for a model |
| **L7** | Rate limiting, and PDF robustness on malformed files | Carried from P20 |
| **L15** | Drafted **context** is still accepted from a banner, not in the table | Exactly the complaint that produced the in-table scope review. Context lines are read one scope item at a time in a side panel, and there is no way to see all of a run's proposals at once |
| **L16** | Hindsight needs one real closed job through it end to end | Every piece is built and tested against seeded data. It has never seen a real change-order log, and that is the only thing that calibrates `gap_pattern.times_confirmed` |

### Done 2026-08-31 · third pass

- **The cancel button, which did work.** Reported as broken; it had been writing
  `cancelled_at` correctly the whole time. Two things conspired to hide it:
  `/queue` returned the FIRST fifteen finished jobs from a list ordered the way
  `claim_job` orders it — priority desc, oldest first — which is right for what
  runs next and exactly wrong for what just happened, so a job cancelled a second
  ago was never in the response. And the running-work panel decided "is this
  live" from the RUN, which stays `RUNNING` until the worker notices, so the row
  kept offering Cancel and never offered dismiss. The job is what was cancelled,
  so the job now decides, and a cancelled-but-still-running job reads
  **stopping…** rather than pretending it has already stopped. Regression test
  added: cancel an in-flight job, then assert it is still visible in the queue
  and reports as CANCELLED.

- **The copilot is quiet by default.** It sat expanded at the top of every
  project screen offering advice nobody asked for on that visit, and advice that
  reappears expanded every time stops being advice and becomes furniture you
  read past. It now opens collapsed, remembers the choice per browser, and keeps
  the blocking count visible in its one collapsed line — so nothing urgent is
  hidden, but nothing routine is shouted.
- **CSI division is a column on the scope grid**, as a dropdown reading
  `22 · Plumbing` while storing `22`. It is the most consequential field on a
  scope row — it decides which package the work is bought under and which expert
  reads it — and it was not on the grid at all: set once from a picker above the
  table, then unreachable. As a grid column it is fixable in place, fillable
  with Ctrl+D, and pasteable from any other line.
- **Select columns accept a paste.** `GridColumn.options` now takes
  `{ value, label }` as well as a plain string, and pasted text is resolved
  against the choices — exact value, then label, then case-insensitively, then
  the leading token, which is what catches `22 - Plumbing` pasted out of
  somebody's spreadsheet. Text that matches nothing is **skipped, not written**:
  a column with a fixed set of values is where junk does the most damage
  downstream, and silently storing an unmatched string would be the worst of the
  available options.
- **Tech debt #15 closed.** `/api/health` queried `_health_probe`, a table that
  has never existed, and treated "undefined table" as success. Correct before P2
  created the schema, and quietly wrong every day since — it would have gone on
  reporting `connected` with the schema dropped, which is the one moment a health
  check exists for. It now counts `tenant`. Replit's deployment gate reads this
  endpoint, so it was the wrong one to leave lying.
- **QA 103 → 104.**

### Done 2026-08-31 · second pass

- **Buyout and levelling: one step, two views.** Merging them was right about
  the data and wrong about the screen. They are one dataset answering two
  questions and only one can have the top of the page — *what does this job
  cost* versus *which sub, and why*. A toggle switches between them and the
  choice is in the URL (`?step=buyout&view=leveling`), so a link lands where it
  meant to and a reload does not put you back on the money grid mid-bid-day. In
  levelling, every package with bids opens by default and the money grid is gone
  entirely. **This is deliberately not a fifth chain step** — the step count was
  the thing wrong with the old arrangement.
- **The running-work panel can be put away, and acted on.** It covered the
  corner of every screen with no way to dismiss it and nothing to do with it.
  Now: a `hide` control that collapses it to one pill (remembered per browser,
  still pulsing so hiding never means losing track of money being spent), and
  inline cancel, move-to-front and run-again. Each active run carries the job
  behind it, because all three are operations on the JOB, not the run.
- **Requeue** (`POST /jobs/:jobId/retry`), and a `run again` control on the
  Activity page. A failed job was a dead end: the payload that would do the work
  was sitting right there, and the only way forward was to find whichever screen
  started it. It queues a NEW job rather than resetting the old one, so
  `attempts` stays honest and `last_error` survives — the two things you would
  most want on a fourth failure.
- **Hindsight rebuilt as the flow it actually is.** It was half a screen whose
  empty state pointed at an Archaeology page that is not in the navigation, so
  the only way in was through a door taken off the building. It is now four
  numbered steps — name the job, link the project holding its bid set, drop the
  change-order log, run the match — ending in the two answers it exists to give:
  **what the scope of work includes**, division by division, and **what the
  bidders missed**, with the gaps that came back as change orders called out.
  `/archaeology` and its page are deleted; the router file keeps the endpoints.
- **`past_project.project_id` is editable.** That link is the whole backtest —
  without it there is no baseline to have missed anything against — and setting
  it is an ordinary human edit, not a gate crossing.
- **ChainNav** lost two branches that could not be taken and a ternary whose arms
  were identical, and the active step's hint got real contrast: `ink-400` on
  `ink-900` was barely legible, and the hint is the half that says what to do next.
- **QA 100 → 103.**

### Done 2026-08-31

- **The review-and-accept flow, rebuilt.** Drafted scope items are no longer
  announced as a count in a banner. They appear as shaded rows inside the scope
  table, grouped with the package they would join, editable cell by cell,
  rejectable row by row, and accepted at the bottom with a reason. Edits ride
  along as overrides: they land on the scope item, and the draft still says what
  the agent said. The audit event records which fields a human changed and which
  drafts they threw out, so "did they accept it as written" is answerable.
- **Multi-select on the grid.** Row numbers pick rows, shift-click spans a range.
  Picked rows can be merged, deleted, or talked to — the table command scopes
  itself to a pick, so four lines can be changed by saying so once instead of
  describing them.
- **Merging scope lines** (`POST /projects/:id/scope-items/merge`). Keeps the
  `scope_id` every quote line, gap and change order joins on; fills only blank
  fields on the kept row; carries context lines and package membership across;
  and refuses to sum quantities, reporting the dropped ones instead. Two rows may
  be duplicates or may be two real numbers, and nothing in the merge can tell
  which — R1 says the guess does not get written.
- **L3** — the nine thin template divisions filled in: 01, 04, 11, 12, 13, 14,
  25, 27, 32. Twenty-four divisions now carry real inclusions, interfaces and
  assumptions rather than a heading.
- **L6** — a `MISSED_GAP` outcome can be promoted to a `gap_pattern` from the
  scope context panel, creating a division expert stub if the division has none.
  The learning loop closes.
- **L13** — Hindsight has a screen, at `/hindsight`. Four tiles, per-CO verdict
  buttons, XLSX export, and the catch rate withheld below five reviewed change
  orders.
- **L14** — workspace invites. Creates the auth user, the `app_user` row, the
  roles and the membership, and hands back a one-time password, because R3 means
  there is no send path and there is not going to be one.
- **`verify:rls` corrected.** It was still asserting the rule migration 0021
  deliberately changed, so the suite failed on purpose-built behaviour. Both
  directions are now asserted: a draft CAN be deleted (a project you cannot
  delete is not a product) and a draft still CANNOT be updated.
- **QA suite 69 → 100 checks**, including the accept-with-changes path proven
  end to end against seeded drafts — the override lands, the rejected row is
  never written, and the draft is unchanged afterwards.

### Done 2026-08-30

- **L9** — Leveling folded into Buyout. Four steps, not five: the buyout log is
  the summary sheet and levelling is what you find when you open a package, via
  the division header. The comparison and the sub-by-sub bid tab both live there.
- **L10** — Cost codes have a page, an import that scans for the header row
  rather than assuming row one, and a column on the scope grid.
- **L11** — Splitting a bid across divisions has a control on the bid itself.
  The remainder is shown and never silently corrected.
- **L12** — P14 hindsight: the report, the human verdict endpoint, and the XLSX
  export. `PREDICTED` is refused unless it names the gap that predicted it, and
  the catch rate is withheld below five reviewed change orders, because a hit
  rate over three is not a hit rate.

## Known, accepted, not bugs

- **A context line that has been scored cannot be deleted** (0013). Retire it.
  The outcome must keep pointing at the line that earned it.
- **A quote sitting at `EXTRACTED` with nothing promoted has no lines to
  normalise.** That is the gate working. The preload script now always accepts
  rather than assuming `EXTRACTED` means accepted.
- **One retired context line labelled `SMOKE`** on the demo project, left by a
  test. It cannot be removed, by design.

## Environment traps, since they cost a day

- Orphaned Node children survive a stopped dev server on Windows and keep
  running their own job worker. Two workers on one queue means whichever process
  holds the older code can claim the job.
- tsx caches compiled output in `%LOCALAPPDATA%\Temp\tsx-<user>`. A stale entry
  serves code that is not in the repo and every symptom points somewhere else.

`npm run resume` clears both before doing anything else.

## Added 2026-08-30

| | What | Why it matters |
|---|---|---|
| **L9** | Leveling and Buyout are still separate steps | Asked for as one surface: buyout as the summary, leveling as the per-sub detail reached by clicking a division header rather than a tab |
| **L10** | Cost codes exist and import, but nothing is organised by them yet | Scope and packages carry `cost_code_id`; no screen groups or sorts by it, and the Excel import has no UI |
| **L11** | Quote splitting has no UI | The API is done and tested — one bid across two packages levels correctly at each allocated amount. There is no screen to do it |
| **L12** | P14 hindsight is schema-only | `change_order` carries `scope_item_id`, `matched_gap_id` and a `hindsight` verdict. No matching logic, no report, no screen. Elie is bringing a closed job's CO list this week |

### What P14 is actually for

Clarified 2026-08-30 and worth writing down, because the original framing was
wrong. It is **not** a change-order tracker. It is a **backtest**:

> Load a finished job's bid set and bids as if it were precon. Run gap detection.
> Put the real change-order list next to the gaps we flagged.

"Of your 31 change orders, 19 were scope gaps, and we would have flagged 14 of
them worth $340k before you bought the job" is the sales argument, and it is also
the only honest way to calibrate `gap_pattern.times_confirmed` — which has never
been confirmed against reality.

Once buyout is complete this tool is finished. Tracking change orders during
construction is a different product living somewhere else.


## P45–P48 · Making it AI-native

Seven agents existed before this block. Every one was a button on a screen you
had to think to visit, which is a tool that HAS AI — it only works for somebody
already taught it.

**The suggestion engine** (`server/src/lib/suggestions.ts`) reads real state and
says what is worth doing and why, ordered BLOCKING → HIGH → NORMAL. It is
deliberately deterministic: not one line asks a model what you should do next,
because a suggestion engine that is sometimes confidently wrong gets ignored
within a week and takes the agents behind it down with it. The models do the
work; rules decide when the work is worth doing. Every suggestion states a
reason, not an instruction — an argument is something you can disagree with.

**Three new agents:**

| | | |
|---|---|---|
| **A10** | Scope coverage auditor | Reads the bid set back against the drafted scope and reports what the documents require that nothing covers. Drafting finds what is there; this finds what is missing. Writes findings, never scope |
| **A11** | Bid comparability analyst | Reads N bids side by side and writes why they are not comparable. Never states a price, never recommends a bidder — the arithmetic is deterministic and the choice is H6 |
| **A12** | Cost code mapper | Maps scope onto the tenant's own structure. Only ever returns codes that exist; a proposed code not in the list is dropped, not drafted |

**The bid pane was rebuilt.** It read `Extract → Accept extraction → Normalise →
Accept mapping`. Every one of those is a real operation and not one is a thing an
estimator does — "normalise" and "accept mapping" were our internal vocabulary on
the screen. It is now **Read the bid** → review and correct inline → **Publish to
project**. The same two model passes, the same H5 gate, the same approval and
audit rows; what went away was needing to know our words.

### Two API facts worth not rediscovering

- `thinking: { type: 'enabled', budget_tokens: N }` is **rejected** by
  claude-sonnet-5 with a 400 telling you to use `output_config.effort`. Thinking
  and output share one budget, so where the hard part is volume rather than
  judgement, `effort: 'low'` is what leaves room for the answer.
- The SDK refuses a non-streaming call whose estimated duration passes ten
  minutes, and the estimate scales with `max_tokens` — so a large output budget
  is refused before the request is sent. Everything structured goes through
  `messages.stream()`, whose `finalMessage()` still carries `parsed_output`.


## P49 · The project assistant

The Ask panel could reason about a trade and read a document. It could not see
the project — so "what is still open on this job" was a question the product
could not answer about itself.

`server/src/lib/chat-tools.ts` gives the assistant tools over the real data:
project state, scope, context, package detail, bid detail, buyout, suggestions,
and the leveling arithmetic. Everything runs through the caller's own database
client, so RLS applies to the assistant exactly as it applies to them — an
assistant running as `service_role` would be a way to read another tenant by
asking nicely.

**The rule line is unchanged.** Every tool is either a read, or a run of
something that produces drafts or deterministic arithmetic. There is no tool
that writes a scope item, accepts an extraction, disposes of a gap or selects a
bidder. Those are gate crossings and they belong to a human with a written
rationale — an assistant that could cross one would make the audit trail a
record of what a model decided, which is what this product is sold against.

Asked "what is still open on this job", it read three tools and answered with
real scope ids, the four undecided gaps, the $44k exposure, and the fact that
none of it is in the carried total yet. That is the product explaining itself.

The tool loop is capped at eight rounds. A model calling tools in a circle is
the failure that burns an API budget quietly.

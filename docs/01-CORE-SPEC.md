# WinProjects — Core Specification

**Version:** 1.0 · **Date:** 2026-08-26 · **Owner:** Elie Al Chaer
**Status:** Approved for build

---

## 1. What this is

WinProjects is preconstruction software that makes a general contractor's **Scope of Work the
enforceable baseline every subcontractor bid is measured against** — and proves who carried it and
who did not.

It is deliberately **not** a preconstruction suite. It is one chain:

> **Scope of Work → Sub Solicitation → Bid Leveling**, with a scope-gap risk log as the output.

### The pitch, in one line

> *"Your low bidder wasn't your low bidder."*

A $500k quote that excludes $80k of scope is a $580k quote. Most GCs award on the headline number
because normalising five quotes onto one scope baseline by hand takes a day per package and they
have two estimators. WinProjects does the normalisation, costs the exclusions, and hands the
estimator an adjusted comparison plus a ranked list of what nobody priced.

### The proof

Feed it a **closed project** — original bid set, the sub quotes as bid, and the change orders that
followed. It shows which change orders were **preventable scope gaps** that existed in the bid
documents on day one. The customer sees their own money.

### Buyer

| | |
|---|---|
| **Primary** | Owner / President of a commercial GC |
| **Secondary** | Head of Preconstruction |
| **Size** | $20M – $250M annual revenue |
| **Shape** | Fewer than 3–4 estimators; running on spreadsheets, Procore, or BuildingConnected |
| **Geography** | Unrestricted |

---

## 2. Non-negotiable rules

These are architectural constraints, not preferences. Every one is a selling point to a buyer who
has been burned by software. **Any build prompt that violates one of these is wrong.**

### R1 — Blank stays blank
An agent may never infer a quantity, a price, a compliance state, a selected bidder, or an approval.
Missing values persist as explicit `UNKNOWN` or `TBC` and surface as warnings. A plausible-sounding
invented number reaching a client quote is the failure mode that ends the company.

### R2 — Agents write evidence, humans write state
Every agent output lands as an **immutable draft** carrying its source document, page location,
extraction confidence, and the model plus prompt version that produced it. Promotion to canonical
state is a separate, human-attributed, append-only act. An agent has **no write path** into
canonical state.

### R3 — No send path exists
No email, SMS, invitation, reminder, clarification, or award notification is implemented. Not
disabled behind a flag — **absent from the codebase**. Any job whose type matches
`send|invite|remind|award|submit|email|sms|message` is refused at creation. Outbound is a separate
future product decision with its own authorisation and audit review.

### R4 — Autopilot never crosses a gate
Autopilot runs the entire *drafting* chain unattended and parks **everything** in one review queue.
No confidence score, retry count, or threshold permits an agent to cross a human gate. The gate is a
role check in the API and a constraint in the database — not a policy an agent can argue with.

### R5 — Benchmark ranges are internal only
Uncalibrated unit-cost ranges from the Division Expert knowledge base are a **calibration tool**.
They render visually distinct, never sum into a total, never appear in any client-facing export, and
are replaced the moment a real quote prices that line. `is_calibrated = false` gates every external
surface.

### R6 — Cite or stay silent
Every extracted value carries its source. Every gap carries the rule that found it. Every add-back
carries its basis. If it cannot be cited, it is `TBC`, not a number.

---

## 3. Roles and gates

### Roles are grants, not an enum

A user holds **one or more** roles. A two-estimator GC gives one person `BC` + `EST` and they see
every gate. A larger GC splits them. Same code, same enforcement.

| Role | Owns |
|---|---|
| `BC` | Bid Coordinator — pursuit, documents, comms, sub packages, submission |
| `EST` | Estimator — scope, takeoff, leveling, pricing, the QA gate |
| `PM` | Principal — margin, go/no-go, escalation, sign-off |
| `ADMIN` | Tenant administration, user management |

### The gates

| Gate | Decision | Role | Enforced where |
|---|---|---|---|
| **H2** | Scope of Work locked | `EST` | API guard + DB constraint |
| **H3** | Work package approved | `BC` | API guard + DB constraint |
| **H4** | Bidder list + message approved | `BC` | API guard + DB constraint |
| **H5** | Clarifications released | `EST` | API guard (drafted only — R3) |
| **H6** | Bidder selected / awarded | `EST` | API guard + DB constraint |

Each gate crossing writes an `approval` row: actor, role, timestamp, rationale text (**required,
non-empty**), and the draft id being promoted. Append-only. No updates, no deletes.

### Fill tags

Every field carries one. This is a field-level authorization model, not documentation.

| Tag | Meaning | Who writes |
|---|---|---|
| `[S]` | System — retrieved, calculated, timestamped | Agent or system, freely |
| `[AI]` | Draft, then vet | Agent proposes, human confirms |
| `[H]` | Human judgement | Human only. API rejects agent writes |
| `[L]` | Linked foreign key | Workflow sets |

---

## 4. Data model

Postgres on Supabase. **Every table carries `tenant_id` with RLS enforced.** No exceptions.

### Tenancy and identity

```
tenant            id, name, created_at
app_user          id, tenant_id, email, display_name, created_at
user_role         id, tenant_id, user_id, role       -- multi-grant; (user_id, role) unique
```

RLS policy on every table compares `tenant_id` against the `tenant_id` claim in the JWT.

### The spine

```
project           id, tenant_id, bid_id, name, owner_org, due_at, status, created_at
                  -- bid_id format: PREFIX-YYYY-NNN, permanent, never reused

scope_item        id, tenant_id, project_id, scope_id, csi_division, csi_section,
                  title, description, unit, quantity, quantity_basis,
                  is_locked, locked_by, locked_at          -- H2
                  -- scope_id format: {bid_id}-{csi_division}-{seq}

work_package      id, tenant_id, project_id, name, csi_divisions[],
                  status, approved_by, approved_at         -- H3
package_scope     package_id, scope_item_id                -- many-to-many
```

**`scope_item` is the hub.** Every quote line, gap, benchmark and change order joins back to a
`scope_id`. Tables stay separate and join by key.

### Subcontractors and solicitation

```
subcontractor     id, tenant_id, name, trade_csi[], contact_name, contact_email,
                  license_no, license_class, bonding_capacity, emr, prequal_status,
                  source, imported_at, raw_row jsonb   -- raw_row preserves the messy original

package_bidder    id, tenant_id, package_id, subcontractor_id, invited_state,
                  list_approved_by, list_approved_at       -- H4

solicitation_draft id, tenant_id, package_id, subject, body, approved_by, approved_at
                  -- DRAFTED ONLY. There is no send. See R3.
```

### Quotes and leveling

```
quote             id, tenant_id, package_id, subcontractor_id, source_file_id,
                  quoted_total, currency, quote_date, revision, pricing_basis,
                  extraction_confidence, extraction_run_id

quote_line        id, tenant_id, quote_id, scope_item_id,      -- nullable until normalised
                  original_text, description, qty, unit, rate, line_total,
                  match_confidence, match_basis, is_lumped, normalisation_run_id

quote_exclusion   id, tenant_id, quote_id, scope_item_id,      -- nullable if unmapped
                  excerpt, source_location, addback_amount, addback_basis,
                  addback_confidence
                  -- addback_basis in (COMPARABLE_BIDS, BENCHMARK, TBC)   see R1

quote_term        id, tenant_id, quote_id, term_key, term_value, standard_position, deviates
                  -- the ~23 standard commercial terms per SOP-11

leveling_result   id, tenant_id, package_id, quote_id,
                  quoted_total, addback_total, risk_allowance, adjusted_total,
                  score_price, score_scope, score_programme, score_commercial, score_risk,
                  weighted_score, advisory_rank, computed_at

selection         id, tenant_id, package_id, quote_id, selected_by, selected_at, rationale
                  -- H6. rationale NOT NULL, length > 0. EST only.
```

**Owner-set scoring weights** (from SOP-11, Decision #3, scope/risk-led — these override the
commonly shipped 40/20/15/15/10):

| Criterion | Weight |
|---|---|
| Price | 30 |
| Scope | 25 |
| Risk | 20 |
| Commercial | 15 |
| Programme | 10 |

Score 1–5 per criterion. Keep the weights editable so an estimator can re-weight and see the
ranking move.

**The adjusted comparison is the analytical heart:**

```
adjusted_total = quoted_total
               + sum(addback_amount for each exclusion)
               + risk_allowance for caveats
```

Rank on `adjusted_total`. **Never rank on `quoted_total`.**

### Scope gaps — the risk log

```
scope_gap         id, tenant_id, package_id, scope_item_id, gap_type,
                  affected_quote_ids[], exposure_amount, exposure_basis,
                  confidence, severity, detected_by_rule, detected_at,
                  division_pattern_id                     -- nullable link to DIV knowledge
```

| `gap_type` | Meaning | Why it matters |
|---|---|---|
| `UNCOVERED` | In the SoW, priced by **nobody** | **The dangerous one.** Silently becomes the GC's cost |
| `PARTIAL` | Priced by some bidders, excluded by others | Drives the add-back math |
| `UNPRICEABLE` | Excluded, no comparable to cost it from | Renders as `TBC — request clarification` (R1) |
| `AMBIGUOUS` | A quote line *might* map to this scope item | Substance-match uncertain; a human resolves it |

**`severity` is derived, never authored:**

```
severity = normalise(exposure_amount) × confidence
```

Rendered `CRITICAL | HIGH | MEDIUM | LOW` by threshold. Nobody hand-tunes a risk score.

Surfaced two ways: **inline** on the leveling matrix (the cell shows its own gap) and as a
**standalone exportable risk log**. The export is what a prospect asks for a copy of — which is the
follow-up.

### Division Expert knowledge base

```
division_expert   id, csi_division, title, status         -- SEED_STUB | CALIBRATED
gap_pattern       id, division_expert_id, pattern_text, typical_csi_section,
                  is_frequent_change_order, detection_hint
benchmark_range   id, tenant_id, csi_section, description, unit,
                  low, high, is_calibrated, calibrated_from_quote_ids[], changed_at
                  -- is_calibrated = false  =>  INTERNAL ONLY. See R5.
lead_time         id, division_expert_id, item, weeks_low, weeks_high, changed_at
```

Seeded from the 7 existing playbooks: **DIV-07** Thermal & Moisture, **DIV-08** Openings,
**DIV-09** Finishes, **DIV-11** Equipment, **DIV-22** Plumbing, **DIV-23** HVAC, **DIV-26**
Electrical.

The `gap_pattern` rows are the high-value content — each playbook's §4 "Common scope gaps /
missing-line patterns" section. Example from DIV-09: *"Missing slab moisture mitigation line under
resilient/epoxy floors"*, flagged `is_frequent_change_order = true`.

All 7 playbooks are marked SEED STUB and every unit cost says "placeholder — calibrate". The gap
patterns are sound; the dollar ranges are not. Hence R5.

### Change-order archaeology

```
past_project      id, tenant_id, name, gc_name, contract_value, completed_at, bid_set_file_ids[]

change_order      id, tenant_id, past_project_id, co_number, amount, description,
                  stated_reason, issued_at, source_file_id

co_classification id, tenant_id, change_order_id, classification, scope_item_ref,
                  gap_pattern_id, reasoning, confidence, classified_by_run_id,
                  human_verdict, verified_by, verified_at   -- [AI] draft, then [H] vet
```

| `classification` | Meaning |
|---|---|
| `PREVENTABLE_SCOPE_GAP` | The bid documents contained it; nobody carried it. **This is the money** |
| `OWNER_DIRECTED` | Genuine scope addition by the owner. Not preventable |
| `UNFORESEEN_CONDITION` | Differing site condition. Not preventable |
| `DESIGN_ERROR` | Architect/engineer omission. Arguably recoverable, not a precon failure |
| `UNDETERMINED` | Insufficient evidence. **The default.** See R1 |

Output: *"of $X in change orders, $Y were preventable scope gaps — and here are the patterns."*

### Evidence, approval and audit

```
agent_run         id, tenant_id, agent_type, project_id, input_ref, status,
                  model, prompt_version, started_at, finished_at, token_cost

agent_event       id, tenant_id, agent_run_id, seq, event_type, message, payload jsonb, at
                  -- powers the streaming activity view

draft             id, tenant_id, agent_run_id, target_table, target_id, field, proposed_value,
                  source_file_id, source_location, confidence, fill_tag, created_at
                  -- IMMUTABLE. No UPDATE, no DELETE.

approval          id, tenant_id, gate, draft_id, actor_id, actor_role, rationale, at
                  -- APPEND-ONLY. rationale NOT NULL.

audit_event       id, tenant_id, actor_id, action, table_name, record_id,
                  before jsonb, after jsonb, at
                  -- APPEND-ONLY.
```

`draft` and `approval` are enforced immutable **at the database level via triggers**, not by
convention. A convention is something an agent can violate; a trigger is not.

---

## 5. Agent contracts

Every agent leases a job, reads sources, emits `agent_event` rows as it works, writes `draft` rows,
and never writes canonical state. Every run records `model` and `prompt_version` so a result is
reproducible and a regression is attributable.

### A1 · Quote Extraction Agent `[AI]`

**Input:** one quote PDF/XLSX/DOCX
**Output:** `quote`, `quote_line[]`, `quote_exclusion[]`, `quote_term[]`

Two extraction categories:

1. **Pricing** — line items (description, qty, unit, rate, total), section subtotals, prelims,
   overhead and profit, total, alternates, daywork rates, pricing basis.
2. **Commercial** — **exclusions first and most carefully**, then caveats and qualifications,
   programme, payment terms, design responsibility, insurance, warranties, key personnel,
   assumptions.

> **Exclusions are the highest-value extraction — this is where overruns live.** Mine appendices,
> footnotes, "Notes" and "Qualifications" sections, and cover letters. Exclusions hide there, not in
> the pricing table.

Every extracted value records `source_location` (page plus excerpt). Unreadable becomes `UNKNOWN`,
never a guess.

**May never:** invent a line item, total a partial extraction as if complete, or set `selected`.

### A2 · Normalisation Agent `[AI]`

**Input:** `quote_line[]` plus the locked `scope_item[]` baseline
**Output:** `scope_item_id` and `match_confidence` per line

- **Match on substance, not wording.** "Drywall and ceilings" may map to `09-21` plus `09-51`.
- **Flag uncertain equivalences as `AMBIGUOUS`. Never assume.**
- Preserve `original_text` alongside the normalised mapping, always.
- Detect and label: scope gaps (item not priced), additions (item not in scope), lumped items
  (`is_lumped`), and differing pricing bases.

**May never:** silently drop an unmatched line, or force a match below the confidence threshold.

### A3 · Add-back Estimation Agent `[AI]`

**Input:** a `quote_exclusion`, comparable bids, the benchmark
**Output:** `addback_amount` and `addback_basis`

Priority order, and it is strict:

1. `COMPARABLE_BIDS` — the average of what other bidders priced for that scope item. **Preferred.**
2. `BENCHMARK` — internal uncalibrated range midpoint. **Flagged, internal only (R5).**
3. `TBC` — no basis exists. **Emit `TBC — request clarification`, not a number (R1).**

Be conservative. A wrong add-back is worse than an honest `TBC`.

### A4 · Scope Gap Detector `[S]` and `[AI]`

Deterministic rules produce `UNCOVERED` and `PARTIAL` — a set-difference against the locked
baseline, pure `[S]`, no model involved. Model judgement handles `AMBIGUOUS` and matches gaps to
`gap_pattern` rows (`[AI]`). `severity` is computed, never authored.

### A5 · Division Expert Consult `[AI]`

**Input:** locked scope plus the CSI divisions in play
**Output:** advisory gap flags, each citing its `gap_pattern`

Reasons against **vetted scope only**. Advisory. Always cites the checklist item behind the flag.
Never emits an uncalibrated dollar range to any client-facing surface (R5).

### A6 · CO Archaeologist `[AI]`

**Input:** original bid set, change orders, `gap_pattern[]`
**Output:** `co_classification[]`

For each change order, ask: was this scope present in the original bid documents?

- Present and unpriced → `PREVENTABLE_SCOPE_GAP`, citing the document location.
- Not present → `OWNER_DIRECTED`.
- Site condition → `UNFORESEEN_CONDITION`.
- Drawing or spec conflict → `DESIGN_ERROR`.
- **Cannot establish → `UNDETERMINED`. This is the default (R1).**

Every classification is a **draft requiring a human verdict.** Never presented as fact. A wrong
"preventable" claim in front of the GC who ran that job destroys the meeting.

### A7 · Scope of Work Drafter `[AI]`

Drafts the CSI scope matrix from bid documents into `scope_item` rows as drafts. `EST` vets and
locks (H2). Scrappy and internal in early weeks; shown to prospects from week 4.

### A8 · Solicitation Drafter `[AI]`

Drafts package scope summaries and invitation text. **Writes to `solicitation_draft` only.**
There is no send (R3). The absence is a demo feature: *"it cannot email your subs."*

---

## 6. Operating modes

### Copilot
The user triggers each step. Every agent run streams into the activity view. Drafts appear for
review as they land.

### Autopilot
Runs the full drafting chain unattended — extract, normalise, add-back, gap detect, level — then
**parks everything in a single review queue**. No gate is crossed (R4).

The story is *"went to lunch, came back, five packages leveled and waiting for me."*
Not *"the machine awarded a sub."*

### The activity stream

**A first-class screen, not a loading state.** Agent runs take 30–90 seconds, and that time is the
most persuasive part of the product because it shows an estimator's own work being done.

```
> reading Bidder C quote — 14 pages
> extracted 47 line items, 12 commercial terms
> scanning qualifications section...
! exclusion found p.11: "waterproofing at grade by others"
> estimating add-back from 3 comparable bids -> $41,200
! UNCOVERED: 07-14 firestopping — priced by no bidder
> adjusted total: $584,700 (quoted $503,500)
```

Emitted as `agent_event` rows, streamed to the client. **Do not hide the latency — sell it.**

---

## 7. Stack

| Layer | Choice | Why |
|---|---|---|
| Database | **Supabase Postgres** | RLS gives real tenant isolation without app-layer code |
| Auth | Supabase Auth, `tenant_id` in JWT claims | Week 1: one seeded login, no signup flow |
| Storage | Supabase Storage | Quote PDFs, bid sets, change orders |
| App | **Replit** (Core plan) | Live URL, always-on, custom domain to `winprojects.ai` |
| Source of truth | **Private GitHub repo** | The escape hatch. Enables Claude Code on the hard logic |
| Model | Anthropic API, **separate key** | The product's agents bill separately from your Claude Code |
| Agent runs | Job rows plus a worker loop | Long runs must not sit behind a request handler |

---

## 8. Explicitly out of scope

| | Why |
|---|---|
| Any outbound send | R3 — a separate product decision with its own review |
| Takeoff / quantity measurement | Hardest AI in the building; deferred |
| Drawings ingestion, symbol libraries | Deferred |
| Go/No-Go scoring | Optional add-on, later |
| Proposal assembly, submission | A different phase of the chain |
| Signup, invites, password reset | Nobody demos it; week 4 or later |
| BuildingConnected integration | Entitlement-gated — a purchase, not a code problem |

---

## 9. Where this came from

| Spec section | Source |
|---|---|
| Leveling method, add-back logic, weights | `SOP-11_Bid-Leveling.md` (v2.1) |
| Scope definition, `scope_id` spine | `SOP-08_Scope-Definition.md`, vault `CLAUDE.md` §2 |
| Solicitation flow | `SOP-10_Sub-Solicitation.md` |
| Sub prequal fields | `SOP-28_Sub-Qualification-Network-Building.md` |
| Gap patterns, lead times, benchmark ranges | `Division-Experts/DIV-07, 08, 09, 11, 22, 23, 26` |
| Fill tags, gate model, evidence/state split | vault `CLAUDE.md` §3, `Engineering/product-architecture.md` |
| ICP, buyer, positioning | `CGA - Company/operating-charter.md`, plus this build's design session |

The governance model (R1–R6) is ported **by concept** from the existing AGC spine — per-field
provenance, the append-only approval ledger, the no-send job guard. Those three ideas are what make
this safe to sell to a general contractor. They are cheap to implement now and expensive to
retrofit later.

---

## 10. Schema changes since v1.0

The data model in section 4 is the design. What is actually deployed has grown, and every change is
recorded in `supabase/migrations/`. Deltas worth knowing when reading section 4:

| Change | Migration | Why |
|---|---|---|
| `package_scope` gained `tenant_id` | 0001 | The spec listing omitted it, which would have left one table outside the RLS policy |
| `division_expert`, `gap_pattern`, `lead_time` have **no** `tenant_id` | 0001 | Shared CSI reference data, identical for every tenant. RLS is enabled with a read-only policy |
| `draft`/`approval`/`audit_event` UPDATE is statement-level, DELETE is row-level | 0002 | Statement-level DELETE fired on the zero-row cascade from `delete from tenant`, making tenant deletion impossible |
| `quote.subcontractor_id` is nullable; `status`, `source_filename`, `source_size_bytes`, `uploaded_at`, `uploaded_by` added | 0003 | A quote row exists from upload, before extraction knows which bidder sent it. R1: unknown stays unknown |
| `job` table | 0003 | Long agent runs must not sit behind an HTTP handler. `job_type` carries a check constraint refusing send-shaped work (R3) |
| `claim_job()` function | 0004 | Atomic leasing needs `FOR UPDATE SKIP LOCKED`, which PostgREST cannot express |
| `project_document` table | 0006 | Drawings, specs and addenda belong to the project and arrive before any package exists |
| `work_package` gained `lead_division`, `description`, `budget_amount`, `allowance_amount`, `contingency_amount` | 0006 | A GC buys by trade, and the buyout log measures against budget with allowances and contingency |
| `subcontractor` gained `vendor_code`, `contact_phone`, address fields, `union_status`, `import_batch` | 0007 | Real sub lists carry these; `raw_row` keeps the original verbatim |
| `import_batch` table | 0007 | So a bad import can be identified and undone |

### Tenancy resolution

Section 4 says policies compare `tenant_id` against "the `tenant_id` claim in the JWT". The
implementation is `public.current_tenant_id()`, which reads `app_metadata.tenant_id` from the
request JWT and falls back to an `app_user` lookup by `auth.uid()`. `app_metadata` is writable only
by `service_role`, so a user cannot grant themselves a tenant or a role.

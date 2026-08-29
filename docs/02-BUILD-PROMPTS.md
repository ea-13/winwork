# WinProjects — Build Prompts

> **Status note (2026-08-29).** These prompts were written to be pasted into Replit Agent. That is
> not how the build happened: it was written directly against this repo instead, and the sequence
> diverged in three places that matter.
>
> - **P2** assumed one package per project. A GC buys by trade, so packages are per CSI division.
> - **P5** capped uploads at 25MB, sized for a quote PDF. A stamped plan set is far larger, and
>   uploads now go directly to storage rather than through the API.
> - **P13** asked for Division Experts as knowledge rows. The intended mechanism is retrieval plus a
>   specialist prompt, since Claude models cannot be fine-tuned.
>
> **Read [`06-ROADMAP.md`](06-ROADMAP.md) for what is actually built.** This file remains the record
> of the original intent, and the verification criteria in it are still the bar each area must meet.


Paste these into **Replit Agent one at a time, in order.** Do not batch them. After each, run the
stated verification before moving on — a broken foundation compounds, and Replit will happily build
on top of something that does not work.

**Convention:** everything inside a fenced block is what you paste. Everything outside it is for you.

---

## P0 · Setup (you, not Replit) — 20 minutes

### 1. Supabase
1. Go to `supabase.com`, sign up, **New project**.
2. Name it `winprojects`. Pick a strong database password and **save it in a password manager**.
3. Region: closest to you.
4. Wait ~2 minutes for provisioning.
5. **Settings → API**, copy three values into a scratch file:
   - Project URL
   - `anon` `public` key
   - `service_role` key — **secret, server-side only, never in frontend code**

### 2. Anthropic API key
1. Go to `console.anthropic.com`, sign in, **API Keys → Create Key**.
2. Copy it. **This is separate from your Claude Code subscription** — the product's own agents bill
   against this key.
3. Set a **$50 monthly spend limit** while developing. Billing → Limits.

### 3. Replit
1. `replit.com`, sign up, subscribe to **Core** (~$25/mo — you need always-on for a live URL).
2. **Create Repl → Import from GitHub** is *not* the path yet. Choose **Node.js** blank Repl, name
   it `winprojects`.
3. **Tools → Secrets**, add four:
   - `SUPABASE_URL`
   - `SUPABASE_ANON_KEY`
   - `SUPABASE_SERVICE_ROLE_KEY`
   - `ANTHROPIC_API_KEY`

### 4. GitHub
1. `github.com`, create a **private** repo named `winprojects`. No README.
2. In Replit: **Version Control → Connect to GitHub**, select the repo, initial commit and push.
3. Verify the code appears on GitHub. **This connection is your escape hatch — confirm it works now,
   not later.**

**Verify P0:** the Repl runs, Secrets are set, and a commit is visible on GitHub.

---

# WEEK 1 — The demo spine

## P1 · Scaffold

```
Build a full-stack TypeScript app.

Frontend: React + Vite + TypeScript, Tailwind CSS, React Router.
Backend: Express + TypeScript.
Database: Supabase (Postgres). Use the @supabase/supabase-js client.

Read these from environment variables, never hardcode:
SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY, ANTHROPIC_API_KEY

Two Supabase clients:
- Frontend uses the anon key, subject to Row Level Security.
- Backend uses the service_role key ONLY in server-side code. It must never be
  imported into, bundled with, or referenced by any frontend file.

Structure:
  /client   React app
  /server   Express API
  /shared   TypeScript types shared by both

Create a health check at GET /api/health returning { ok: true, db: "connected" }
after a real query against Supabase.

Do not build any features yet. Scaffold only.
```

**Verify:** app runs, `/api/health` returns `db: "connected"`.

---

## P2 · Schema and Row Level Security

> This is the most important prompt in the build. Multi-tenant isolation cannot be retrofitted.

```
Generate a single SQL migration creating the schema below. I will paste it into the
Supabase SQL editor myself.

EVERY table has a tenant_id uuid NOT NULL referencing tenant(id).
EVERY table has Row Level Security ENABLED with a policy restricting rows to the
tenant_id claim in the JWT. No table is exempt.

Tables:

tenant(id uuid pk, name text, created_at timestamptz default now())
app_user(id uuid pk, tenant_id, email text, display_name text, created_at)
user_role(id uuid pk, tenant_id, user_id fk app_user, role text
          check role in ('BC','EST','PM','ADMIN'), unique(user_id, role))

project(id uuid pk, tenant_id, bid_id text, name text, owner_org text,
        due_at timestamptz, status text, created_at, unique(tenant_id, bid_id))

scope_item(id uuid pk, tenant_id, project_id fk, scope_id text, csi_division text,
           csi_section text, title text, description text, unit text,
           quantity numeric, quantity_basis text,
           is_locked boolean default false, locked_by uuid, locked_at timestamptz,
           unique(tenant_id, scope_id))

work_package(id uuid pk, tenant_id, project_id fk, name text, csi_divisions text[],
             status text default 'DRAFT', approved_by uuid, approved_at timestamptz)
package_scope(package_id fk, scope_item_id fk, primary key(package_id, scope_item_id))

subcontractor(id uuid pk, tenant_id, name text, trade_csi text[], contact_name text,
              contact_email text, license_no text, license_class text,
              bonding_capacity numeric, emr numeric, prequal_status text,
              source text, imported_at timestamptz, raw_row jsonb)

package_bidder(id uuid pk, tenant_id, package_id fk, subcontractor_id fk,
               invited_state text default 'CANDIDATE',
               list_approved_by uuid, list_approved_at timestamptz)

solicitation_draft(id uuid pk, tenant_id, package_id fk, subject text, body text,
                   approved_by uuid, approved_at timestamptz)

quote(id uuid pk, tenant_id, package_id fk, subcontractor_id fk, source_file_id text,
      quoted_total numeric, currency text default 'USD', quote_date date,
      revision int default 1, pricing_basis text,
      extraction_confidence numeric, extraction_run_id uuid)

quote_line(id uuid pk, tenant_id, quote_id fk, scope_item_id uuid null,
           original_text text, description text, qty numeric, unit text,
           rate numeric, line_total numeric, match_confidence numeric,
           match_basis text, is_lumped boolean default false,
           normalisation_run_id uuid)

quote_exclusion(id uuid pk, tenant_id, quote_id fk, scope_item_id uuid null,
                excerpt text, source_location text, addback_amount numeric,
                addback_basis text check addback_basis in
                  ('COMPARABLE_BIDS','BENCHMARK','TBC'),
                addback_confidence numeric)

quote_term(id uuid pk, tenant_id, quote_id fk, term_key text, term_value text,
           standard_position text, deviates boolean)

leveling_result(id uuid pk, tenant_id, package_id fk, quote_id fk,
                quoted_total numeric, addback_total numeric, risk_allowance numeric,
                adjusted_total numeric, score_price int, score_scope int,
                score_programme int, score_commercial int, score_risk int,
                weighted_score numeric, advisory_rank int, computed_at timestamptz)

selection(id uuid pk, tenant_id, package_id fk, quote_id fk, selected_by uuid,
          selected_at timestamptz, rationale text NOT NULL
          check length(trim(rationale)) > 0)

scope_gap(id uuid pk, tenant_id, package_id fk, scope_item_id fk, gap_type text
          check gap_type in ('UNCOVERED','PARTIAL','UNPRICEABLE','AMBIGUOUS'),
          affected_quote_ids uuid[], exposure_amount numeric, exposure_basis text,
          confidence numeric, severity text
          check severity in ('CRITICAL','HIGH','MEDIUM','LOW'),
          detected_by_rule text, detected_at timestamptz, division_pattern_id uuid null)

division_expert(id uuid pk, csi_division text, title text,
                status text check status in ('SEED_STUB','CALIBRATED'))
gap_pattern(id uuid pk, division_expert_id fk, pattern_text text,
            typical_csi_section text, is_frequent_change_order boolean,
            detection_hint text)
benchmark_range(id uuid pk, tenant_id, csi_section text, description text, unit text,
                low numeric, high numeric, is_calibrated boolean default false,
                calibrated_from_quote_ids uuid[], changed_at timestamptz)
lead_time(id uuid pk, division_expert_id fk, item text, weeks_low int,
          weeks_high int, changed_at timestamptz)

past_project(id uuid pk, tenant_id, name text, gc_name text, contract_value numeric,
             completed_at date, bid_set_file_ids text[])
change_order(id uuid pk, tenant_id, past_project_id fk, co_number text,
             amount numeric, description text, stated_reason text,
             issued_at date, source_file_id text)
co_classification(id uuid pk, tenant_id, change_order_id fk, classification text
                  check classification in ('PREVENTABLE_SCOPE_GAP','OWNER_DIRECTED',
                    'UNFORESEEN_CONDITION','DESIGN_ERROR','UNDETERMINED'),
                  scope_item_ref text, gap_pattern_id uuid null, reasoning text,
                  confidence numeric, classified_by_run_id uuid,
                  human_verdict text, verified_by uuid, verified_at timestamptz)

agent_run(id uuid pk, tenant_id, agent_type text, project_id uuid null,
          input_ref text, status text, model text, prompt_version text,
          started_at, finished_at, token_cost numeric)
agent_event(id uuid pk, tenant_id, agent_run_id fk, seq int, event_type text,
            message text, payload jsonb, at timestamptz default now())

draft(id uuid pk, tenant_id, agent_run_id fk, target_table text, target_id uuid,
      field text, proposed_value jsonb, source_file_id text, source_location text,
      confidence numeric, fill_tag text check fill_tag in ('S','AI','H','L'),
      created_at timestamptz default now())

approval(id uuid pk, tenant_id, gate text check gate in ('H2','H3','H4','H5','H6'),
         draft_id uuid null, actor_id uuid, actor_role text,
         rationale text NOT NULL check length(trim(rationale)) > 0,
         at timestamptz default now())

audit_event(id uuid pk, tenant_id, actor_id uuid, action text, table_name text,
            record_id uuid, before jsonb, after jsonb, at timestamptz default now())

CRITICAL — add these triggers, they are load-bearing:

1. draft, approval and audit_event are APPEND-ONLY. Create BEFORE UPDATE and
   BEFORE DELETE triggers on each that RAISE EXCEPTION. Immutability must be
   enforced by the database, not by application convention.

2. Add indexes on every tenant_id column and every foreign key.

Output the migration as one SQL file I can copy and paste.
```

**Verify:** paste into Supabase SQL editor, runs clean. Then in Table Editor confirm RLS shows
enabled on **every** table. Try `UPDATE draft SET field='x'` — it must error.

---

## P3 · Seed the demo tenant

```
Create /server/scripts/seed.ts, runnable with `npm run seed`, using the
service_role key. It seeds one realistic demo tenant:

- tenant "Demo Construction Co"
- app_user "demo@winprojects.ai" holding BOTH roles: BC and EST
  (a small GC has one person doing both — the product must support this)
- project: bid_id "DEMO-2026-001", name "Riverside Medical Office TI",
  owner_org "Riverside Health", due 30 days out
- 18 scope_item rows across CSI divisions 07, 08, 09, 22, 23, 26 with realistic
  titles, units and quantities. All is_locked = true (scope is already vetted).
  scope_id format: DEMO-2026-001-09-001
- one work_package "Interior Finishes" covering the division 09 scope items,
  status APPROVED
- 12 subcontractor rows with realistic names, trades, license classes, EMR values
- 5 package_bidder rows linked to that package

The 09 scope items must include:
  09-21 metal stud framing and gypsum board
  09-51 acoustical ceilings
  09-65 resilient flooring
  09-67 fluid-applied epoxy flooring
  09-91 painting
  07-14 firestopping at penetrations   <-- the planted UNCOVERED gap
  09-72 FRP wall protection            <-- the planted PARTIAL gap

Make it idempotent: safe to re-run.
```

**Verify:** `npm run seed`, then confirm rows in Supabase Table Editor.

---

## P4 · Auth and role guards

```
Add authentication using Supabase Auth.

Week 1 scope: ONE seeded login. No signup, no invites, no password reset.

- Custom access token hook (or a server-side claim mapper) puts tenant_id and the
  user's roles array into the JWT.
- Frontend: a login page, session persistence, protected routes.
- Backend: middleware that verifies the JWT, extracts tenant_id and roles, and
  attaches them to the request.

Add a requireRole(...roles) middleware. A user passes if they hold ANY of the
listed roles — roles are GRANTS, not an enum, and one user commonly holds several.

Add these gate guards now even though the endpoints come later:
  H2 scope lock            -> requireRole('EST')
  H3 package approve       -> requireRole('BC')
  H4 bidder list approve   -> requireRole('BC')
  H5 clarifications        -> requireRole('EST')
  H6 selection             -> requireRole('EST')

Every gate endpoint MUST require a non-empty rationale string in the body and
write an approval row. Reject with 400 if rationale is missing or blank.

Also add a global guard: reject creation of any job or agent run whose type matches
/send|invite|remind|award|submit|email|sms|message/i. This product has no outbound
send path by design. Return 403 with "No outbound send path exists in this system."
```

**Verify:** log in as the demo user; hitting a gate endpoint without a rationale returns 400.

---

## P5 · File upload

```
Add quote document upload.

- Supabase Storage bucket "quote-documents", private, tenant-scoped paths:
  {tenant_id}/{package_id}/{filename}
- Accept PDF, XLSX, DOCX. Max 25MB.
- Upload UI on a package page: drag-and-drop, multi-file, per-file progress.
- On upload, create a quote row with status PENDING_EXTRACTION and store
  source_file_id.
- List uploaded documents with filename, size, upload time, extraction status.

Do not extract anything yet.
```

**Verify:** upload a PDF; file lands in Storage under the tenant path; `quote` row created.

---

## P6 · Agent runtime and activity stream

> The infrastructure every agent uses. Build it once, properly.

```
Build the agent runtime.

1. A jobs table and a worker loop (setInterval polling is fine at this stage) that
   leases jobs, marks them IN_PROGRESS with a lease expiry, and retries up to 3
   times before dead-lettering. Long agent runs must NOT sit behind an HTTP handler.

2. An AgentRun abstraction:
   - creates an agent_run row recording agent_type, model, prompt_version
   - exposes emit(event_type, message, payload) writing sequential agent_event rows
   - exposes draft(target_table, target_id, field, value, source, location,
     confidence, fill_tag) writing immutable draft rows
   - agents may ONLY write via draft(). They must have no direct write access to
     canonical tables. Enforce this in the abstraction's type signature.

3. Streaming: GET /api/agent-runs/:id/stream as Server-Sent Events, replaying
   existing agent_event rows then streaming new ones live.

4. Anthropic client wrapper reading ANTHROPIC_API_KEY, using model
   "claude-sonnet-5", recording token cost onto the agent_run row.

5. An ActivityStream React component subscribing to the SSE endpoint and rendering
   events as they arrive. Info lines in normal weight; WARNING events highlighted
   in amber with an alert icon. Auto-scroll. Show elapsed time.

This component is a FIRST-CLASS SCREEN, not a loading spinner. A 60-second agent run
is the most persuasive part of this product — it shows the work being done. Design it
to be watched.
```

**Verify:** trigger a dummy job; events stream live to the UI.

---

## P7 · Quote Extraction Agent

> The hardest and most valuable prompt in the build. Expect to iterate.

```
Build the Quote Extraction Agent.

Input: one uploaded quote document. Output: quote totals, quote_line rows,
quote_exclusion rows, quote_term rows — ALL as drafts.

Extract in two categories:

1. PRICING — line items (description, qty, unit, rate, total), section subtotals,
   preliminaries, overhead and profit, quoted total, alternates, daywork rates,
   pricing basis.

2. COMMERCIAL — extract EXCLUSIONS FIRST AND MOST CAREFULLY, then caveats and
   qualifications, programme/duration, payment terms, retention, design
   responsibility, insurance levels, warranties, key personnel, assumptions.

CRITICAL INSTRUCTION for the model prompt, state it explicitly:

  "Exclusions are the highest-value extraction in this task — this is where cost
   overruns live. They rarely appear in the pricing table. Search the appendices,
   the footnotes, any 'Notes', 'Qualifications', 'Clarifications' or 'By Others'
   section, and the cover letter. Extract each exclusion with the exact quoted
   text and its page number."

HARD RULES, enforce them in the prompt and in code:
- Every extracted value records source_location as page number plus a short excerpt.
- If a value cannot be read, emit UNKNOWN. NEVER guess, never interpolate,
  never carry a value forward from another quote.
- If extraction is partial, mark the quote PARTIAL_EXTRACTION. Do NOT present a
  partial total as if it were complete.
- The agent may never set a selected bidder.

Emit agent_event lines as it works, so the activity stream shows real progress:
  "reading Bidder C quote — 14 pages"
  "extracted 47 line items, 12 commercial terms"
  "scanning qualifications section..."
  WARNING "exclusion found p.11: waterproofing at grade by others"

Include prompt_version in the agent_run row so results stay reproducible.
```

**Verify:** run on a real quote PDF. **Check the exclusions by hand.** This is the quality bar the
whole product rests on — if exclusions are missed, iterate the prompt before continuing.

---

## P8 · Normalisation Agent

```
Build the Normalisation Agent.

Input: quote_line rows from one quote, plus the locked scope_item baseline for
the package. Output: scope_item_id and match_confidence per line.

RULES:
- Match on SUBSTANCE, not wording. "Drywall & ceilings" may map to BOTH 09-21
  and 09-51. A bidder's phrasing will never equal your scope wording.
- Preserve original_text on every line, always. Never overwrite it.
- Set is_lumped = true when one quote line covers multiple scope items, and flag
  it "not directly comparable".
- If match confidence is below 0.7, do NOT force the match. Create a scope_gap of
  type AMBIGUOUS and leave scope_item_id null.
- NEVER silently drop an unmatched line. An unmatched line is either an addition
  (not in scope) or an ambiguity — label it, do not discard it.
- Record match_basis explaining WHY the line maps where it does.

Emit activity events per line matched, and a WARNING for each ambiguity.
```

**Verify:** normalisation runs; ambiguous lines surface rather than vanish.

---

## P9 · Add-back estimation and the adjusted comparison

> This is the analytical heart. Get the arithmetic exactly right.

```
Build add-back estimation and the adjusted comparison.

For each quote_exclusion, estimate addback_amount using this STRICT priority:

1. COMPARABLE_BIDS — average what other bidders priced for that same scope_item.
   Preferred whenever two or more comparables exist.
2. BENCHMARK — midpoint of the internal benchmark_range for that csi_section.
   Only when no comparable exists. Mark addback_basis = 'BENCHMARK'.
3. TBC — when neither exists, set addback_amount = NULL and
   addback_basis = 'TBC'. Render as "TBC — request clarification".

NEVER invent a number to fill a blank. An honest TBC is correct; a plausible
guess is a product-ending bug.

Then compute leveling_result per quote:

  adjusted_total = quoted_total
                 + SUM(addback_amount for all exclusions where amount is not null)
                 + risk_allowance

Rank on adjusted_total. NEVER rank on quoted_total.

Where any exclusion is TBC, mark the adjusted_total INCOMPLETE and display it as
"$X + unpriced items" — never as a clean number that implies completeness.

Weighted scoring, 1-5 per criterion, with these owner-set weights:
  Price 30, Scope 25, Risk 20, Commercial 15, Programme 10
Store weights in config so an estimator can re-weight and watch the ranking move.
```

**Verify:** hand-check the arithmetic on the seeded package. A $503,500 quote with $81,200 of
exclusions must show $584,700.

---

## P10 · Scope gap detection

```
Build scope gap detection. Deterministic rules first, model judgement only where
genuinely needed.

DETERMINISTIC (no model — pure set operations against the locked baseline):
- UNCOVERED: a scope_item in the package that NO quote priced. This is the most
  dangerous gap type — it silently becomes the GC's own cost.
- PARTIAL: a scope_item priced by some bidders and excluded by others.
- UNPRICEABLE: an exclusion with addback_basis = 'TBC'.

MODEL JUDGEMENT:
- AMBIGUOUS: carried over from normalisation confidence.
- Match gaps to gap_pattern rows from the Division Expert knowledge base.

SEVERITY IS DERIVED, NEVER AUTHORED:
  normalise exposure_amount across the package to 0..1, multiply by confidence
  CRITICAL >= 0.75, HIGH >= 0.5, MEDIUM >= 0.25, else LOW
Nobody hand-tunes a risk score. Do not expose severity as an editable field.

Every gap records detected_by_rule naming the rule that found it.
```

**Verify:** the planted `07-14` firestopping gap appears as **UNCOVERED / CRITICAL**.

---

## P11 · Leveling matrix UI

```
Build the leveling matrix — the primary screen of this product.

Layout: scope items down the left, bidders across the top.

Each cell shows the bidder's price for that scope item, and carries its own state:
  - priced normally         -> plain value
  - EXCLUDED                -> amber, strikethrough, with the add-back shown beneath
  - NOT PRICED              -> red, "not priced"
  - AMBIGUOUS match         -> blue, with a "?" affordance
  - TBC add-back            -> "TBC — request clarification", never a number

Hovering or clicking a cell shows provenance: the original quote text, the page,
and the extraction confidence. Every number must be traceable to its source.

Summary rows at the bottom, in this order and clearly separated:
  Quoted Total
  + Add-backs
  + Risk Allowance
  = ADJUSTED TOTAL     <- visually dominant, this is the answer
  Weighted Score
  Advisory Rank

Make the contrast between Quoted Total and Adjusted Total the loudest thing on
the screen. The entire product argument is that these two numbers differ and that
the ranking flips between them. If the low quoted bidder is not the low adjusted
bidder, say so explicitly in a banner.

Selection: an EST-only control requiring a written rationale before it will submit.
Label it "Recommended for review" never "Awarded" — the system recommends, the
estimator decides.
```

**Verify:** the seeded package renders and the quoted-vs-adjusted ranking flip is unmistakable.

---

**END OF WEEK 1.** Stop here. Run the week-1 go/no-go in `04-EXECUTION-PLAN.md` before continuing.

---

# WEEK 2 — The sales weapon

## P12 · Risk log and export

```
Build the standalone scope-gap risk log.

Table view of all scope_gap rows for a project: severity, type, scope item,
CSI section, exposure amount and its basis, affected bidders, the rule that
detected it, and the linked division gap pattern if any.

Sort by severity then exposure. Filter by type, severity and division.

Export to XLSX and PDF. The export is what a prospect asks for a copy of, so it
must stand alone: project name, date, a summary line ("14 gaps, $312k exposure,
4 critical"), then the detail table.

CRITICAL — export filtering: any exposure_basis of 'BENCHMARK' where the
underlying benchmark_range has is_calibrated = false MUST be suppressed from
client-facing exports. Show it in the internal UI clearly labelled
"uncalibrated benchmark — internal only". Uncalibrated ranges are a calibration
tool, never a client-facing number.
```

## P13 · Division Expert knowledge base

```
Seed the Division Expert knowledge base and build an admin view.

Create division_expert rows for CSI 07, 08, 09, 11, 22, 23, 26, all with
status = 'SEED_STUB'.

For each, create gap_pattern rows from the "common scope gaps / missing-line
patterns" for that division. Mark is_frequent_change_order = true where the
pattern is a known change-order generator. Examples for division 09:
  - "Missing slab moisture mitigation line under resilient/epoxy floors"
    (frequent change order, section 09-65)
  - "Wall protection (corner guards, FRP, wall rails) omitted in circulation"
  - "Transition strips and expansion joints in flooring not carried"
  - "Ceiling seismic bracing / compression struts not carried"
  - "Sound caulking at rated partitions omitted"

Also seed benchmark_range rows with is_calibrated = false, and lead_time rows.

Build the Division Expert Consult agent: given the locked scope for a project,
check every applicable gap_pattern against it and raise advisory flags for
patterns with no corresponding scope item. Every flag cites its pattern text.

The agent reasons against VETTED scope only, is advisory only, and never emits an
uncalibrated dollar figure to a client-facing surface.
```

## P14 · Change-order archaeology

> The strongest feature in the product. Handle with care — a wrong "preventable"
> claim in front of the GC who ran that job ends the meeting.

```
Build change-order archaeology.

Input: a past_project with its original bid set documents, the sub quotes as bid,
and the change orders that followed.

For each change order, the CO Archaeologist agent asks one question:
"Was this scope present in the original bid documents?"

Classify:
  PREVENTABLE_SCOPE_GAP  - present in the bid documents, priced by nobody.
                           MUST cite the document, page and excerpt proving it
                           was there. No citation means no claim.
  OWNER_DIRECTED         - genuine scope addition by the owner after award
  UNFORESEEN_CONDITION   - differing site condition
  DESIGN_ERROR           - architect/engineer omission
  UNDETERMINED           - insufficient evidence. THIS IS THE DEFAULT.

Bias hard toward UNDETERMINED. Claiming "preventable" without document evidence
is far worse than admitting you cannot tell.

Every classification is a DRAFT requiring a human verdict before it is reportable.
Show confidence and reasoning on each.

Results screen:
  "Of $X in change orders across this project, $Y were preventable scope gaps."
  Breakdown by classification, then by division, then the matched gap_pattern rows.
  Each preventable item links to its evidence in the bid documents.

Then close the loop: those matched patterns become checks that run against
CURRENT projects. That is the retention story — the product learns the customer's
own failure modes.
```

---

# WEEK 3 — The chain

## P15 · Sub list import

```
Build subcontractor list import.

Accept XLSX and CSV. Every GC's sub list is a different mess, so:
- Detect the header row even when it is not row 1.
- Fuzzy-map columns to fields (company/name/firm -> name;
  trade/csi/division -> trade_csi; email/contact -> contact_email; etc.)
- Show a mapping preview and let the user correct it before committing.
- Preserve the complete original row in raw_row jsonb, always.
- Flag but never drop rows with missing required fields.
- Report coverage gaps: which CSI divisions have no qualified subs.

Handling a messy list gracefully is itself a demo moment — do not make the user
clean their file first.
```

## P16 · Solicitation screens

```
Build the solicitation flow.

- Package builder: select scope items into a work_package (H3, BC approval,
  rationale required).
- Bidder list: rank candidate subs by trade match, prequal status, EMR and
  bonding capacity. Advisory ranking only (H4, BC approval, rationale required).
- Message drafting: the agent drafts an invitation and package scope summary
  into solicitation_draft.

THE NO-SEND BOUNDARY IS A FEATURE, NOT A LIMITATION.

There is no send button. Where one would be, show:
  "Drafted. WinProjects does not send email — copy this into your own system."
  with a copy-to-clipboard control.

Make this visible and explain it in the UI. A GC owner who has been burned by
software auto-contacting his subs will read this as the reason to trust the
product.
```

## P17 · Autopilot and the review queue

```
Build the two operating modes.

COPILOT: the user triggers each agent step manually. Current behaviour.

AUTOPILOT: chains extract -> normalise -> add-back -> gap detect -> level across
every uploaded quote in a package, unattended, then parks EVERYTHING in a single
review queue.

AUTOPILOT NEVER CROSSES A HUMAN GATE. Not at any confidence level, not after any
number of retries. H2, H3, H4, H5 and H6 remain human-only and the API rejects
agent attempts regardless of mode. This is architectural, not configurable.

Review queue screen: every draft awaiting human review, grouped by gate, with the
evidence attached and approve/reject controls. Rejection returns the item to the
agent for another pass. Approval requires a rationale.

The story this tells: "went to lunch, came back, five packages leveled and waiting
for me." NOT "the machine awarded a sub."
```

---

# WEEK 4 — The spine and hardening

## P18 · Scope of Work drafter

```
Build the Scope of Work drafting agent.

Input: bid documents (specifications, scope narratives).
Output: draft scope_item rows organised by CSI division and section.

Each drafted item carries its source document, page and excerpt. Quantities are
drafted ONLY where the document states them — never inferred from area, never
estimated. An unstated quantity is UNKNOWN.

EST reviews, edits and locks (H2, rationale required). Until locked, no package
may be built from it and no quote may be normalised against it.
```

## P19 · Provenance and the approval ledger

```
Surface the evidence model in the UI.

- Every AI-derived field shows a provenance affordance: source document, page,
  excerpt, confidence, and the model plus prompt version that produced it.
- Fill tags rendered as colour: S system, AI draft, H human, L linked.
- An approval history view per project: every gate crossing, who, when, and the
  rationale they wrote.
- An audit trail view: append-only, filterable by actor and record.

This is what makes the product defensible when a GC asks "where did this number
come from?" — the answer is always one click away.
```

## P20 · Tenant isolation and hardening

```
Harden for a second customer.

1. Write automated tests proving tenant isolation: create two tenants with data,
   authenticate as tenant A, and assert that EVERY endpoint returns zero tenant B
   rows. Test every table. This is the test that prevents a company-ending demo.

2. Verify the service_role key never reaches the client bundle. Add a build-time
   check that fails the build if it does.

3. Prove the negative controls hold, as automated tests:
   - an agent cannot write canonical state directly
   - an agent cannot cross H2/H3/H4/H5/H6
   - a job whose type matches the outbound pattern is refused at creation
   - draft, approval and audit_event reject UPDATE and DELETE

4. Rate-limit agent runs per tenant. Add per-tenant token cost tracking.

5. Robustness pass on arbitrary quote PDFs: scanned documents, multi-column
   layouts, quotes with no line items. Fail gracefully to PARTIAL_EXTRACTION,
   never crash and never fabricate.
```

---

## When Replit gets stuck

It will. The pattern that works:

1. **Do not let it retry the same failure twice.** Two failed attempts means the prompt is wrong,
   not the model.
2. **Push to GitHub, clone locally, run `claude` in the repo.** Hand the failure to me with the real
   code in front of me — that is what the GitHub connection is for.
3. **The expensive column is mine, not Replit's.** Anything involving extraction quality,
   substance-matching, add-back judgement or CO classification will go faster in Claude Code than in
   Replit Agent. Replit builds screens; I build judgement.

# WinProjects — Tech Debt and Hardening Register

**Purpose:** the handover list. Everything deliberately deferred during the prototype build, with
enough context that an engineer who has never seen this repo can pick an item up and finish it.

**Rule:** nothing gets deferred silently. If a shortcut is taken, it lands here in the same commit.

**Status key:** `OPEN` · `IN PROGRESS` · `DONE` · `WONTFIX`

---

## P0 — must fix before a paying customer

| # | Item | Why it matters | Where |
|---|---|---|---|
| 1 | **Gate approvals are not atomic** | The `approval` row and the state change it authorises are two separate statements; supabase-js cannot span a transaction. A failure between them leaves an approval recording an attempt that did not land. Approval is written first deliberately, so the failure mode is a recorded non-event rather than an unauthorised change — but the ledger is the product's integrity claim and it should be exact. **Fix:** move each gate into a single `security definer` Postgres function and call it by RPC. | `server/src/routes/gates.ts` |
| 2 | **No storage object cleanup** | Deleting a `quote` or `project_document` row leaves the file in Supabase Storage forever. **Fix:** a delete endpoint that removes both, or a scheduled reconciliation job. | `server/src/routes/documents.ts` |
| 3 | **Signed-upload confirm is not idempotent** | Calling `/confirm` twice for the same path creates two rows for one object. `project_document.storage_path` is unique so it fails loudly there; `quote.source_file_id` has no such constraint. **Fix:** unique index on `quote.source_file_id`. | migration needed |
| 4 | **No rate limiting anywhere** | Every endpoint is unthrottled. An authenticated user can enqueue unlimited agent runs, each of which spends Anthropic tokens. **Fix:** per-tenant job quota plus request rate limiting before any external exposure. | `server/src/index.ts` |
| 5 | **Worker runs in the API process** | `startWorker()` is called from `index.ts`. Two Replit instances means two workers competing; `claim_job` makes that safe, but the API's memory and CPU are shared with agent runs. **Fix:** separate worker process before scaling beyond one instance. | `server/src/index.ts` |

---

## P1 — before the product is shown widely

| # | Item | Why it matters | Where |
|---|---|---|---|
| 6 | **50MB upload ceiling** | Supabase free plan caps per-file storage at 50MB. Real stamped plan sets exceed it (the sample in hand is 63MB). **Fix:** Supabase Pro raises the limit; the direct-to-storage path already bypasses server memory, so nothing else changes. | Supabase billing |
| 7 | **No upload progress** | Direct upload reports "uploading file N of M" but no percentage. A 50MB file over a slow connection looks frozen. **Fix:** `uploadToSignedUrl` has no progress callback — use a resumable/TUS upload or XHR with `onprogress`. | `client/src/lib/upload.ts` |
| 8 | **Division Experts are stubs** | All 21 divisions exist with placeholder gap patterns marked `SEED_STUB`. They are common industry checks, not calibrated knowledge. **Fix:** replace with the real DIV-07/08/09/11/22/23/26 playbook section 4 content from the vault; extend to the remaining divisions from code and license-course material. See "Division Expert architecture" below. | `server/src/scripts/seed.ts` |
| 9 | **CO archaeology not built** | P14 (change-order archaeology) is a placeholder. Tables exist (`past_project`, `change_order`, `co_classification`); no agent, no screens. Needs a closed job's real change orders to build against. | not started |
| 10 | **No test suite** | Verification is two end-to-end scripts (`verify:rls`, `verify:app`) that run against the live database. There are no unit tests and no CI. **Fix:** Vitest for the deterministic logic (add-back math, gap detection, buyout roll-up) — that is where a silent regression costs money. | none |
| 11 | **`agent_event` polling, not push** | The SSE endpoint polls Postgres every 700ms per open stream. Fine for one user; it is a query per stream per second. **Fix:** Postgres `LISTEN`/`NOTIFY` or Supabase Realtime. | `server/src/routes/agent-runs.ts` |
| 12 | **No error boundary in the client** | A render error blanks the page with no message. **Fix:** React error boundary around the router. | `client/src/App.tsx` |

---

## P2 — quality and maintainability

| # | Item | Why it matters | Where |
|---|---|---|---|
| 13 | **No generated database types** | Every Supabase query returns `any`-shaped rows that are hand-typed at each call site. A column rename breaks at runtime, not at compile time. **Fix:** `supabase gen types typescript` into `shared/`. | whole server |
| 14 | **Duplicate row-to-camelCase mapping** | Each route hand-maps snake_case rows to camelCase DTOs. **Fix:** one mapper per entity. | `server/src/routes/*` |
| 15 | **`health` endpoint still probes a fake table** | It queries `_health_probe` and treats "undefined table" as success — correct before P2, obsolete now. **Fix:** query `tenant`. | `server/src/routes/health.ts` |
| 16 | **No pagination anywhere** | Every list endpoint returns everything. Fine at demo scale, wrong at a hundred projects. | `server/src/routes/*` |
| 17 | **Client refetches whole collections** | After every mutation the page reloads all lists. **Fix:** a query cache (TanStack Query) when the screens settle. | `client/src/pages/*` |
| 18 | **No `.replit` in the repo** | Deployment config lives only in the Replit UI, so it is neither reviewable nor reproducible. | repo root |

---

## Division Expert architecture — the intended design

The goal is a division-specific construction expert per CSI division. **Fine-tuning is not the
mechanism** — Claude models cannot be fine-tuned. The equivalent, and the better engineering answer,
is retrieval plus a specialist prompt:

1. **Knowledge base per division** — building code sections, license-course material, the vault
   playbooks, and accumulated gap patterns, stored as rows against `division_expert`.
2. **A specialist system prompt per division**, carrying that division's vocabulary, the trades that
   commonly split scope, and the gaps that recur.
3. **Retrieval at inference** — the relevant slice is passed into the agent run for the divisions in
   play, rather than baked into weights.

Advantages over fine-tuning: knowledge is editable without retraining, each claim can cite its
source (R6), and an uncalibrated range stays flagged (R5). `division_expert.status` moves
`SEED_STUB` → `CALIBRATED` only when a human has vetted that division's content.

---

## Training corpus and evaluation data lake

**This is a product capability, not just cleanup.** Every human edit over an agent's proposal is a
labelled correction, and this is the only place that data will ever exist.

What is already capturing it:

- `draft` — what an agent proposed, with its model, prompt version, source document and page
  location. Immutable.
- `audit_event` — what a human then chose, with before and after values, actor and timestamp.
  Append-only. Written by `PATCH /api/records/:table/:id` for every edited field.
- `approval` — which gate crossings a human accepted, and the stated reason.

Join those three and you have supervised training pairs: *(document, agent proposal, human
correction, rationale)*.

### To build

| # | Item | Notes |
|---|---|---|
| 19 | **Dataset export** | An endpoint that emits draft/edit/approval triples as JSONL, scoped to a tenant, with documents referenced by storage path. This is the corpus. |
| 20 | **Held-out evaluation set** | Freeze a set of quotes with human-verified extractions. Every prompt change runs against it before shipping. Without this, "the agent got better" is an opinion. |
| 21 | **Regression scoring** | Per-agent metrics that matter: exclusions found versus exclusions present (recall is what counts here — a missed exclusion is the failure that costs money), false-positive rate, add-back basis distribution. |
| 22 | **Edit-reason capture** | An optional short "why" on a correction. A correction with a reason is worth several without one. |
| 23 | **PII boundary before any training use** | Sub contacts, vendor emails and phone numbers are in `subcontractor` and `raw_row`. Strip or tokenise before any corpus leaves the tenant. |

**Design constraint:** the corpus is a by-product of normal use, never a separate data-entry chore.
If capturing it changes how an estimator works, it will not get captured.

---

## Spreadsheet editing — decision

Elie asked whether to embed Excel or Google Sheets. **Recommendation: no embed, a grid inside the
app plus xlsx round-trip.**

Embedding Sheets moves the data outside Supabase, which means RLS no longer applies, `audit_event`
no longer records who changed what, and the append-only ledger — the product's core claim to a GC —
stops being true for anything edited that way. The demo argument "nothing reaches your bid without
your estimator approving it, and we can prove who did" cannot survive data living in a Google
document.

What gets the same ergonomics without that cost:

| # | Item | Notes |
|---|---|---|
| 24 | **In-app editable grid** | Keyboard navigation, tab-to-next-cell, paste a block from Excel. Every cell commit goes through `PATCH /api/records/...`, so it is audited. |
| 25 | **xlsx export and re-import** | Work offline in Excel, upload the edited file, review a diff before it commits. Round-trip, not a live link. |
| 26 | **Bulk paste from clipboard** | Paste a column of quantities from a takeoff without leaving the row. |

---

## Deliberate non-goals

Recorded so nobody "fixes" them later:

- **No outbound send path** (R3). Not disabled — absent. Enforced by a check constraint on
  `job.job_type` as well as by API middleware.
- **`draft`, `approval`, `audit_event` cannot be updated or deleted** (R2). Database triggers, not
  convention. This is why deleting a tenant with evidence rows fails, and that is correct.
- **Blank stays blank** (R1). Missing values are `UNKNOWN`/`TBC`, never inferred.

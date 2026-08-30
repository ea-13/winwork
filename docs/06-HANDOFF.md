# Engineering handoff

**Read this first.** Fifteen minutes here should be enough to make a change safely.
Everything else in `docs/` is reference you go to when you need it.

---

## 1 · What the product is

Preconstruction software for a general contractor's estimating team. It makes the
**Scope of Work** the enforceable baseline that every subcontractor bid is measured
against, then proves who carried which scope and who did not.

> A $500k quote that excludes $80k of scope is a $580k quote.

The chain, and the whole product, is three steps: **Scope of Work → Sub Solicitation
→ Bid Leveling**, with a scope-gap risk log and a buyout log as the output.

Deliberately **not** a preconstruction suite. Takeoff and go/no-go scoring are out of
scope and should stay out.

## 2 · The six rules

These are not aspirations. Each is enforced in code, and a change that breaks one is a
bug however good it looks.

| | Rule | Where it bites |
|---|---|---|
| **R1** | Blank stays blank — no invented numbers, ever | An unstated quantity is `null`, never `0`. A blank cell contributes nothing to a `SUM`; it is not zero. Templates ship units, never quantities |
| **R2** | Agents write evidence, humans write state | `AgentContext` has no database handle. An agent can `emit()` and `draft()` and nothing else — the restriction is in the *type*, so an agent that tries to write state does not compile |
| **R3** | No send path exists — absent, not disabled | Job types matching `/send\|invite\|remind\|award\|submit\|email\|sms/` are refused, at the API *and* by a database check constraint |
| **R4** | Autopilot never crosses a human gate | Autopilot extracts and parks in review. It does not chain onward, because the next steps write canonical rows |
| **R5** | Uncalibrated benchmark ranges are internal only | The XLSX export replaces them with `TBC`. They may appear in the internal UI, labelled |
| **R6** | Cite or stay silent | Drawings cite a **sheet number**, specs cite a **page**. "Page 47 of Drawings.pdf" is not a citation anybody can act on |

There is exactly one place an agent writes canonical state: `AgentContext.recordSheets`,
which can only write a drawing sheet index. Read the comment on it before deciding it is
a precedent — it is deliberately shaped as a method that can write one thing, not as a
door.

## 3 · Getting it running

```bash
npm install
cp .env.example .env      # fill it in; NEVER put values in .env.example, it is tracked
npm run resume            # cleans, migrates, seeds, typechecks, reports state
npm run dev               # API :3001, client :5173
```

`npm run resume` exists because two environment problems cost a full day and both look
like application bugs when you meet them cold:

- **Orphaned Node processes survive a stopped dev server on Windows**, and each one runs
  its own job-queue worker. Two workers on one queue means a job can be claimed by
  whichever process holds the *older* code.
- **tsx caches compiled output** in `%LOCALAPPDATA%\Temp\tsx-<user>`. A stale entry
  serves code that is not in the repo, and every symptom points somewhere else.

Run `resume` before you debug anything strange.

### Commands worth knowing

| Command | Does |
|---|---|
| `npm run resume` | The above. Start here, every time |
| `npm run dev` | API and client, watch mode |
| `npm run build` | Client, secret-leak check, then server. Fails if a secret reaches the browser bundle |
| `npm run verify` | 46 checks across three suites — RLS, app behaviour, cross-tenant isolation |
| `npm run migrate` | Applies `supabase/migrations/*.sql` in order, once each |
| `npm run seed` | Idempotent demo tenant. Also resets the demo password from `.env` |
| `npm run preload:demo` | Wires the sample plumbing quote through the whole chain |

## 4 · Architecture in one page

```
client/    React 19 · Vite · Tailwind v4 · React Router
server/    Express · TypeScript · agents · job worker
shared/    Types imported by both. Nothing secret — it ships to the browser
supabase/  Migrations. The schema is the source of truth
```

**Database is Supabase Postgres, and tenancy is enforced by RLS, not by app code.**
Every table carries `tenant_id`; every policy checks `current_tenant_id()`, which reads
a JWT claim. The server holds the caller's own token and lets Postgres decide. This is
why there is no `WHERE tenant_id = ?` scattered through the routes, and why forgetting
one is not a data leak.

**Agents run in a worker, not in a request.** `POST` enqueues a job and returns a run id
immediately; the client opens an SSE stream against that run. A model call that takes
four minutes must never sit behind an HTTP connection.

**Every agent proposal is a `draft` row.** Immutable. A human promotes it, and the
promotion writes an `approval` and an `audit_event` naming them. `draft`, `approval` and
`audit_event` reject `UPDATE` and `DELETE` at the database level — including from
`service_role`. That is tested.

### The five gates

`H2` scope lock · `H3` package approval · `H4` solicitation · `H5` extraction accept ·
`H6` selection. Every crossing requires a non-empty rationale and is atomic. Nothing may
route around one, which is what R4 means in practice.

## 5 · Where the interesting code is

| Path | Why you would open it |
|---|---|
| `server/src/lib/leveling.ts` | The analytical heart: add-backs, gap detection, the adjusted comparison, the per-scope bid tab, and the context outcome loop. **Deterministic — no model touches the arithmetic** |
| `server/src/lib/agent-run.ts` | What an agent is allowed to do. Read the type before adding a capability |
| `server/src/lib/promote.ts` | The seam between agent output and canonical state |
| `server/src/lib/pdf.ts` | Page/byte batching. Both ceilings are real and they bind in different places |
| `server/src/lib/editable.ts` | What a human may type over, per table. Gate-controlled columns are deliberately absent |
| `client/src/components/Grid.tsx` | The spreadsheet surface — navigation, ranges, clipboard, formulas, blank rows |
| `supabase/migrations/` | Read these in order. Each header explains *why*, not just what |

The migration headers are the best single source of design reasoning in the repo. If a
schema decision looks odd, the answer is almost always in the migration that made it.

## 6 · Things that will bite you

- **`.env.example` is tracked.** Real values there get published. Audit both files before
  every commit. A pre-commit hook in `.githooks/` blocks credentials — a fresh clone needs
  `git config core.hooksPath .githooks`.
- **Direct Postgres (`db.<ref>.supabase.co`) is IPv6-only** and unreachable from most
  networks. Use the session pooler in `DATABASE_URL`.
- **`tsc -b` is incremental and will lie.** Delete `dist` without deleting
  `tsconfig.tsbuildinfo` and it reports success while emitting nothing. The server build
  uses `--force` for exactly this reason.
- **Replit runs the production path** (`npm run start`, which serves the built client on
  one port). The workspace `run` builds first — without that it serves a stale `dist` and
  looks subtly different from local.
- **A scored context line cannot be deleted** (migration 0013). Retire it. The outcome has
  to keep pointing at the line that earned it.
- **A quote at `EXTRACTED` with nothing promoted has no lines to normalise.** That is the
  gate working, not a bug.

## 7 · Verifying a change

```bash
npm run build && npm run verify
```

46 checks must pass, including negative controls that assert the append-only triggers
reject writes from `service_role`. If you are touching tenancy, `verify:isolation` is the
one that matters — it probes 16 endpoints with a second tenant's credentials.

**A step verified at the API is not a verified step.** The most expensive lesson in this
codebase: three features were complete, tested and unreachable, because nothing in the UI
called them. Click the thing.

## 8 · What to work on

`docs/02-EXECUTION.md` is the running record — every step P0–P39 with its status and its
verification bar, then a **"What is left"** section (L1–L8) at the end. That list is the
backlog. Update it as things land; it is the file that tells the next person where the
build actually is.

`docs/05-TECH-DEBT.md` is the register of everything deliberately deferred, and why.

## 9 · The rest of the docs

| File | What it is |
|---|---|
| `docs/01-CORE-SPEC.md` | Entities, tenancy, gates, agent contracts |
| `docs/02-EXECUTION.md` | **The build record** — every step, its status, what is left |
| `docs/03-DEMO-SCRIPT.md` | The acceptance criteria |
| `docs/04-EXECUTION-PLAN.md` | Week by week, hours, the go/no-go |
| `docs/05-TECH-DEBT.md` | The handover register |
| `docs/06-HANDOFF.md` | This file |

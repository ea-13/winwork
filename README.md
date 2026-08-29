# WinProjects

Preconstruction software that makes the Scope of Work the enforceable baseline every subcontractor
bid is measured against — and proves who carried it and who did not.

> **"Your low bidder wasn't your low bidder."**

A $500k quote that excludes $80k of scope is a $580k quote. WinProjects normalises every quote onto
one scope baseline, costs the exclusions back in, and hands the estimator an adjusted comparison
plus a ranked log of what nobody priced.

## The chain

**Scope of Work → Sub Solicitation → Bid Leveling**, with a scope-gap risk log and a buyout log as
the output.

Deliberately not a preconstruction suite. Takeoff and go/no-go scoring are out of scope.

## The rules

| | |
|---|---|
| **R1** | Blank stays blank — no invented numbers, ever |
| **R2** | Agents write evidence, humans write state |
| **R3** | No send path exists — absent, not disabled |
| **R4** | Autopilot never crosses a human gate |
| **R5** | Uncalibrated benchmark ranges are internal only |
| **R6** | Cite or stay silent |

Each is enforced in code, not documented as an aspiration — see
[`docs/02-EXECUTION.md`](docs/02-EXECUTION.md) for where.

## Docs

| File | What it is |
|---|---|
| [`docs/01-CORE-SPEC.md`](docs/01-CORE-SPEC.md) | Entities, tenancy, gates, agent contracts |
| [`docs/02-EXECUTION.md`](docs/02-EXECUTION.md) | **The build file** — every step P0–P28, status, and what proves it |
| [`docs/03-DEMO-SCRIPT.md`](docs/03-DEMO-SCRIPT.md) | **The acceptance criteria** |
| [`docs/04-EXECUTION-PLAN.md`](docs/04-EXECUTION-PLAN.md) | Week by week, hours, the go/no-go |
| [`docs/05-TECH-DEBT.md`](docs/05-TECH-DEBT.md) | **The handover register** — everything deferred, and why |

**Start at [`02-EXECUTION.md`](docs/02-EXECUTION.md)** for where the build actually is. It carries
every step with its status, its verification bar, and any deviation from the original plan.

## Stack

| Layer | Choice |
|---|---|
| Database | Supabase Postgres — RLS gives real tenant isolation without app-layer code |
| Auth | Supabase Auth, `tenant_id` and roles as JWT claims |
| Storage | Supabase Storage, private buckets, direct-to-storage signed uploads |
| API | Express + TypeScript |
| Client | React 19 + Vite + Tailwind v4 + React Router |
| Agents | Anthropic API (`claude-sonnet-5`), separate key from any Claude subscription |
| Source of truth | This repo |
| Hosting | Not deployed yet — host chosen at P11, see `02-EXECUTION.md` |

## Running it

```bash
npm install
cp .env.example .env      # then fill it in — never commit .env
npm run migrate           # applies supabase/migrations/*.sql
npm run seed              # demo tenant, one login, 23 division experts
npm run dev               # API on :3001, client on :5173
```

Log in with `DEMO_USER_EMAIL` / `DEMO_USER_PASSWORD` from `.env`.

### Scripts

| Command | Does |
|---|---|
| `npm run dev` | API and client together, watch mode |
| `npm run build` | Builds client then server |
| `npm start` | Production server; also serves the built client on one port |
| `npm run migrate` | Applies pending migrations, then re-applies the index rules |
| `npm run seed` | Idempotent demo tenant and division-expert stubs |
| `npm run typecheck` | `tsc -b` across all three workspaces |
| `npm run verify:rls` | 17 checks: RLS coverage, append-only, live cross-tenant isolation |
| `npm run verify:app` | 20 end-to-end checks: auth, gates, upload, agent runtime |
| `npm run verify` | Both |

`verify:app` needs the server running.

## Repository layout

```
client/      React app
server/      Express API, agents, job worker, seed
shared/      Types crossing the client/server line — no secrets
scripts/     Migration runner and verification suites
supabase/    SQL migrations, applied in filename order
docs/        Specs, roadmap, tech debt
samples/     Real documents for testing — gitignored, never committed
```

## Conventions worth knowing before changing anything

- **Migrations are immutable.** The runner refuses a file whose contents changed after it was
  applied. Add a new one.
- **`draft`, `approval` and `audit_event` cannot be updated or deleted.** Database triggers enforce
  it. Deleting a tenant that holds evidence rows fails, and that is correct.
- **A pre-commit hook blocks committed credentials.** A fresh clone needs
  `git config core.hooksPath .githooks` once.
- **Nothing gets deferred silently.** A shortcut lands in `docs/05-TECH-DEBT.md` in the same commit.

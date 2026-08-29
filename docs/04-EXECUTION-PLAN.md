# WinProjects — Execution Plan

> **Status note (2026-08-29).** Section 2 and 3 assign roughly 80% of code volume to Replit Agent.
> That decision was reversed on day one: the build is written directly against this repo, and Replit
> is hosting only — currently not deployed at all.
>
> What did not change is the part that matters: **judging agent output is not delegable.** Sections
> 3 and 5 still describe the only work that cannot be automated away.
>
> Live status is in [`06-ROADMAP.md`](06-ROADMAP.md).


**Owner:** Elie Al Chaer · **Started:** 2026-08-26 · **Product:** winprojects.ai

The plan we abide by. It exists to answer three questions: *how much of my time*, *who does what*,
and *where do I go to keep working*.

---

## 1. The one thing to internalise

**You are not committing to four weeks. You are committing to week one.**

At the end of week 1 you run a go/no-go on yourself — the same discipline you apply to a bid.
Weeks 2–4 are a sequenced backlog, not a promise. Nothing past week 1 is owed to anyone.

This is deliberate. The question this project actually answers is *"does this narrow subset sell?"* —
the question that killed the broader Pre-Con Win Engine offer. Week 1 buys that answer for about ten
hours. Four weeks of building before asking it would be the same mistake in a more expensive form.

---

## 2. Where the work lives

Three surfaces, each doing what it is good at.

```
   VAULT (G: drive)          GITHUB (private, yours)          REPLIT
   the SOPs                  source of truth                  hosting
   the source material  ──►  docs/ + code              ◄──►   live URL
                                    ▲                         Agent for UI
                                    │
                             CLAUDE CODE (local)
                       the expensive column · extraction
                       prompts · normalisation · debugging
```

| Surface | Used for | Not used for |
|---|---|---|
| **Replit** | Hosting, the live URL, screens, CRUD, uploads, custom domain | Extraction logic, agent prompts, anything involving judgement |
| **GitHub** | Source of truth, backup, your IP boundary | — |
| **Claude Code (local)** | The hard logic, debugging, prompt iteration, weeks 2–4 | Deployment |
| **The vault** | Reference: the 39 SOPs, the Division Expert playbooks | Storing this venture's code or docs — that is the IP line |

**The GitHub connection is the hinge.** Confirm it works on day 1. Everything downstream — including
my ability to help you — depends on the code being clonable.

### Continuing work after week 1

```bash
cd C:\Users\eliea\winprojects
git pull
claude
```

That is it. I read the real code, not a description of it. Make a change, commit, push, and Replit
redeploys.

**Rule of thumb for which surface:** if the task involves a screen, a table, or a button, Replit
Agent is faster. If it involves a model, a dollar, or a judgement call, bring it to Claude Code.

---

## 3. Who does what

| | Does | Cannot do |
|---|---|---|
| **Replit Agent** | Schema, migrations, RLS, screens, uploads, exports, auth, routing — roughly 80% of the code volume | Anything in the expensive column. It writes plausible-looking extraction logic that fails on the second PDF |
| **Claude (me)** | Specs, build prompts, agent prompts, extraction and normalisation logic, debugging when Replit stalls | Work while you are not in session. I run in sessions, not continuously over weeks |
| **You** | Paste prompts, run migrations, and — the irreplaceable part — **judge the output** | Nothing about the judging is delegable. It is the domain expertise the product encodes |

### What "judging the output" means

It is the real work and it is only yours. After each agent run you answer:

- Did it find every exclusion, or did it miss one buried in the cover letter?
- Is that add-back number defensible, or is it nonsense a GC would laugh at?
- Is that scope match right — does "drywall and ceilings" really cover both 09-21 and 09-51?
- Is that gap real, or an artifact of a bad match?

**No one else can answer these.** This is why the product is worth building and why your hours are
the bottleneck.

---

## 4. Time budget

| Week | Your hours | Shape |
|---|---|---|
| **1** | **8–12** | ~2/day. Paste, run, judge extraction quality. Front-loaded on purpose |
| 2 | 6–10 | Plus one ask to a GC contact for the corpus |
| 3 | 6–8 | Mostly reviewing; less iteration |
| 4 | 6–8 | Polish and hardening |

**This is not a full-time project.** Week 1 is heaviest because extraction quality is the foundation
everything else stands on — get it wrong and weeks 2–4 build on sand.

### Cost

| | |
|---|---|
| Replit Core | ~$25/mo |
| Supabase | Free tier is sufficient through week 4 |
| Anthropic API | ~$20–50 for week 1 — **set a $50 limit in the console** |
| **Total to the go/no-go** | **~$75–100** |

---

## 5. Week 1 — day by day

**Goal:** upload real quotes, watch an agent read them, see the ranking flip.

| Day | Prompts | Hours | Done when |
|---|---|---|---|
| **1** | P0 setup, P1 scaffold | 2–3 | `/api/health` returns `db: connected`; a commit is on GitHub |
| **2** | P2 schema + RLS, P3 seed | 2–3 | RLS enabled on every table; `UPDATE draft` errors; demo data visible |
| **3** | P4 auth, P5 upload, P6 agent runtime | 2–3 | Login works; a PDF uploads; dummy events stream live |
| **4** | **P7 quote extraction** | 3–4 | An agent reads a real quote and **finds the exclusions** |
| **5** | P8 normalise, P9 add-back, P10 gaps, P11 matrix | 3–4 | The seeded package renders and the ranking flips |

**Day 4 is the day that matters.** If extraction quality is poor, do not proceed to day 5 — stay on
P7 and iterate the prompt. Everything downstream is worthless if exclusions are missed.

### Long-lead item — start on day 1

**Ask a GC contact for a closed project:** the original bid set, the sub quotes as received, and the
change orders that followed. Insist on *as bid*, not *as built* — a final as-built set makes the
archaeology impossible.

This gates all of week 2 and it depends on someone else's calendar. Ask in week 1, not week 2.

---

## 6. The week-1 go/no-go

Run this on yourself. Written rationale, same as any gate in the product.

### The question

> **Did the agent find something I would have missed?**

### The test

1. Take a real sub quote — ideally one from a package you know.
2. Read it yourself first. Write down every exclusion you find.
3. Run it through the agent.
4. Compare.

| Outcome | Decision |
|---|---|
| Agent found exclusions you missed | **GO.** Proceed to week 2. The product has a reason to exist |
| Agent matched you exactly | **GO, cautiously.** It compresses a day into a minute — that alone sells. Proceed |
| Agent missed things you caught | **HOLD.** Stay on P7. Do not build features on bad extraction |
| Agent invented things that were not there | **STOP.** This is an R1 violation and it is fatal. Fix before anything else |

### The secondary test

Record a 5-minute screen capture you would be **willing to send to a lead**. If you would not send
it, week 1 is not done — regardless of what works.

---

## 7. Weeks 2–4 — the backlog

Sequenced, not committed. Each is entered only after the prior week's output holds up.

### Week 2 — the sales weapon (P12–P14)
Risk log and export · Division Expert knowledge base (7 divisions, patterns only, costs suppressed) ·
**change-order archaeology**.

**Gated on:** the corpus arriving. If it has not, do week 3 instead and return to this.
**Output:** *"Send me a closed job"* becomes a repeatable, self-running Free Leak Analysis.

### Week 3 — the chain (P15–P17)
Sub list import · solicitation screens with the visible no-send boundary · autopilot and the review
queue.

**Output:** the product becomes a chain rather than a single tool. Autopilot is the story that makes
it feel like software rather than a utility.

### Week 4 — the spine and hardening (P18–P20)
Scope of Work drafter (scrappy, now shown) · provenance surfaced in the UI · approval ledger ·
**tenant isolation tests**.

**Output:** safe for a second customer. The isolation tests in P20 are what prevent a
company-ending demo — do not skip them the moment a real prospect appears.

---

## 8. Standing rules

These survive every week and every shortcut.

| | Rule |
|---|---|
| **R1** | Blank stays blank. Never let an invented number reach a screen |
| **R2** | Agents write evidence, humans write state |
| **R3** | No send path. Not disabled — absent |
| **R4** | Autopilot never crosses a gate |
| **R5** | Uncalibrated benchmark ranges are internal only, never client-facing |
| **R6** | Cite or stay silent |

**If a build prompt violates one of these, the prompt is wrong.** These are also, not
coincidentally, the entire trust argument you sell on.

---

## 9. Known risks

| Risk | Likelihood | What to do |
|---|---|---|
| **Extraction quality is poor on real PDFs** | High | The main risk. Budget day 4 entirely for it; bring it to Claude Code, not Replit |
| **The corpus never arrives** | Medium | Ask multiple contacts in week 1. Reorder to week 3 if needed |
| **Replit stalls on the agent runtime** | Medium | Clone locally, run `claude`, fix with the real code in hand |
| **The demo becomes production** | Medium | Week-1 code has a seeded login. If a prospect says yes early, week 4 is mandatory, not optional |
| **Scope creep back toward 39 SOPs** | Medium | The chain is Scope → Solicit → Level. Takeoff, drawings and go/no-go are explicitly out |
| **IP line with CGA** | Low, but real | The venture is separate. Keep code and docs off the shared drive; draw a clean line with Noel before there are customers |

---

## 10. Open items

Not blocking week 1, but they need answers before there is a customer.

- [ ] **Register winprojects.ai** — do this now, it is cheap and the name is decided
- [ ] Clean IP line with Noel / CGA regarding the SOPs and the ported governance concepts
- [ ] Pricing — the existing CGA ladder has a $20–50k Custom App rung; this may be a different shape
- [ ] Entity: does this sit under an existing company or a new one
- [ ] Where the corpus comes from beyond the first contact
- [ ] Calibrating the benchmark ranges from real quote data (a week-2 by-product)

---

## 11. Files

| File | What it is |
|---|---|
| `01-CORE-SPEC.md` | Entities, tenancy, gates, agent contracts, the six rules |
| `02-BUILD-PROMPTS.md` | P0–P20, paste into Replit one at a time |
| `03-DEMO-SCRIPT.md` | **The acceptance criteria.** Ten minutes, beat by beat |
| `04-EXECUTION-PLAN.md` | This file |

**Read `03-DEMO-SCRIPT.md` before you start building.** It is written backwards from the money
moment so that week 1 produces something that sells rather than something that merely works.

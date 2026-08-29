# WinProjects — Demo Script

**This document is the acceptance criteria.** If the build cannot perform this script, it is not
done — regardless of what is checked off elsewhere.

Read it before building. It is written backwards from the money moment on purpose, so that week 1
produces a thing that sells rather than a thing that merely works.

---

## The shape

**10 minutes. Live, not rails.** One human-in-the-loop guarantee carries the risk.

| Beat | Minutes | What happens |
|---|---|---|
| 1 · The problem, in their words | 0–2 | You ask, they describe their own pain |
| 2 · The package | 2–3 | A real bid package, five quotes, the spreadsheet they know |
| 3 · The agent works | 3–6 | Live extraction, narrated on screen |
| 4 · **The flip** | 6–7 | Low bidder is not low bidder. *The money moment* |
| 5 · The gap nobody priced | 7–8 | UNCOVERED / CRITICAL |
| 6 · The gate | 8–9 | It stops. It cannot send. It cannot award |
| 7 · The ask | 9–10 | Send me a closed job |

---

## Beat 1 · The problem, in their words (0–2 min)

**Do not open the app yet.** Ask:

> "When you get five quotes back on a package, how do you compare them?"

Then wait. Let them describe the spreadsheet. Almost every GC in your band says a version of the
same thing: an estimator builds a comparison by hand, it takes most of a day per package, and
exclusions get read once and half-remembered.

Follow up with the question that sets up everything:

> "How do you catch what nobody priced?"

**There is no good answer to that question.** That silence is the product.

> **Why this beat exists:** if you open with software, you are selling software. If you open with
> their process, everything that follows is measured against it.

---

## Beat 2 · The package (2–3 min)

Open to a real bid package. Five subcontractor quotes, uploaded, already extracted.

> "This is an interior finishes package. Five bidders. Same documents went to all of them."

Show the quoted totals — plain, unremarkable, sorted low to high. Let the low bidder sit there
looking like the obvious answer.

> "On this list you'd award to Bidder C. That's what the spreadsheet says."

**Do not editorialise.** Let them agree with the wrong answer. The flip only lands if they have
committed to it first.

---

## Beat 3 · The agent works (3–6 min)

Upload a sixth quote — one that has genuinely never been processed. Live.

**The activity stream is the demo here.** Do not talk over the whole thing; let them read it.

```
> reading Bidder F quote — 14 pages
> extracted 47 line items, 12 commercial terms
> scanning qualifications section...
! exclusion found p.11: "waterproofing at grade by others"
> estimating add-back from 3 comparable bids -> $41,200
! exclusion found p.12: "firestopping by others"
> no comparable bids priced this item
! TBC — request clarification
> adjusted total: $584,700 (quoted $503,500)
```

What to say, once, while it runs:

> "It reads the appendix and the cover letter, not just the pricing table. That's where exclusions
> hide."

Then stop talking. Sixty seconds of an agent narrating its own work is more persuasive than
anything you can say over it.

> **Why this beat exists:** it converts latency from a weakness into the proof. They are watching an
> estimator's day compressed into a minute.

### ⚠ When it gets something wrong

It will, eventually. **This is the beat you prepared for, and it is a gift.** Say:

> "There — it flagged that as ambiguous rather than guessing. That's the whole design. Nothing it
> produces reaches your bid until your estimator approves it. I'd rather it hand me twelve things to
> check than one number I can't trace."

Then click into the review queue and show the gate.

**You have just demoed your differentiator instead of apologising for a bug.** A rails demo can
never do this. This is why live is worth it.

---

## Beat 4 · The flip — the money moment (6–7 min)

Switch to the adjusted comparison.

> "Here's the same five bidders, with every exclusion costed back in."

**The ranking flips.** Bidder C, the apparent low bidder, is now third.

> "Bidder C quoted $503,500. They excluded $81,200 of scope that three other bidders carried. They
> were never the low bidder — they were just the least complete."

Let it sit. Do not rush to the next screen.

Then the line the whole product exists to earn:

> **"Your low bidder wasn't your low bidder."**

> **Why this beat exists:** this is the entire value proposition in one screen. Every other feature
> is supporting evidence for this moment.

---

## Beat 5 · The gap nobody priced (7–8 min)

Open the risk log. Filter to CRITICAL.

> "This one's different. Firestopping at penetrations — division 07-14. It's in the scope, it's in
> the documents, and **no bidder priced it.** Not one."

> "Every bid you got is wrong by the same amount. So it doesn't show up in any comparison — and it
> becomes your cost the day you award."

Show the four gap types briefly, then land on why UNCOVERED is the dangerous one: **a gap every
bidder shares is invisible to every method of comparing bidders.**

If they are an estimator, this is the beat that convinces them. If they are an owner, this is the
beat where they think about a job that went sideways.

---

## Beat 6 · The gate (8–9 min)

Attempt to award. The system stops you.

> "It won't let me award. Selection requires a written reason and it has to be the estimator."

Then the part that matters more:

> "And it can't email your subs. There's no send button anywhere in this product — not disabled,
> not there. It drafts the invitation and you paste it into your own system."

Watch for the reaction. In your buyer band, someone in that room has been burned by software
contacting subcontractors on their behalf.

> "The agent drafts. A person decides. Everything it produces carries the document, the page, and
> the confidence, so when your PM asks where a number came from, it's one click."

> **Why this beat exists:** it converts every constraint into a reason to trust. The things this
> product *cannot* do are the reason it is safe to put between an estimator and a bid.

---

## Beat 7 · The ask (9–10 min)

Do not pitch. Do not price. Make one specific, low-friction request:

> **"Send me a project you already closed. The original bid set, the sub quotes you got, and the
> change orders that came after. I'll show you which of those change orders were sitting in the bid
> documents the whole time."**

Why this closes:

- It costs them nothing but a folder.
- It is not a commitment to buy.
- It answers the only question that matters — *would this have worked on my jobs?* — with their own
  data instead of your demo data.
- When you come back with *"$340k of your change orders were preventable scope gaps, and here are
  the four patterns that caused them"* — that is not a sales call any more.

**Insist on the project as bid, not as built.** The original bid set, the quotes as received, and
the change orders with their stated reasons. A final as-built set makes the archaeology impossible.

---

## What must work before you run this

Week 1 build, in order of how badly it breaks the demo:

| | Requirement | Breaks which beat |
|---|---|---|
| 1 | Quote extraction finds exclusions reliably in appendices and cover letters | 3, 4 — the whole demo |
| 2 | Adjusted total arithmetic is correct and the ranking genuinely flips | 4 — the money moment |
| 3 | Activity stream renders live with warnings highlighted | 3 |
| 4 | At least one UNCOVERED gap detected at CRITICAL severity | 5 |
| 5 | Gate rejection on selection without rationale | 6 |
| 6 | No send path anywhere, and the UI says so | 6 |
| 7 | Upload of a genuinely unseen document completes without crashing | 3 |

**Rehearse item 7 at least five times with different PDFs before showing anyone.** It is the only
beat that can fail in a way the human-in-the-loop line does not cover — a crash is not a gate, it is
a crash.

---

## The one number to plant

The seeded demo package should carry a deliberate, defensible spread:

| | |
|---|---|
| Apparent low bidder | **$503,500** |
| Their exclusions | **$81,200** across 3 items |
| Adjusted total | **$584,700** |
| True low bidder | $541,000 quoted, $12,400 excluded, **$553,400 adjusted** |
| The uncovered gap | 07-14 firestopping, ~$38,000, priced by **nobody** |

The flip must be unambiguous — not a $2,000 difference that looks like rounding. Make it a spread
any estimator in the room recognises as real money on a package that size.

---

## After the demo

Same day, send:

1. The **risk log export** from whatever package you showed. It is the artifact they remember.
2. One line: *"Send me a closed job and I'll run the change orders."*
3. Nothing else. No deck, no pricing, no follow-up sequence.

The corpus request is the close. Everything else is noise around it.

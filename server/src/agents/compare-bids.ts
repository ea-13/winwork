import { z } from 'zod';
import type { AgentContext } from '../lib/agent-run.js';
import { extractStructured } from '../lib/anthropic.js';

/**
 * A11 · Bid comparability analyst.
 *
 * The leveling matrix proves the flip arithmetically: costs the exclusions back
 * in and reranks. What it cannot do is say it in a sentence, and the sentence is
 * what an estimator repeats in the meeting.
 *
 * This reads the bids side by side and writes down what actually differs
 * underneath the totals — one assumed customer-supplied fixtures, one excluded
 * trenching, one carries permits and the other says the owner does. Those are
 * the reasons three numbers are not three comparable numbers, and they are
 * sitting in the extracted exclusions and terms already; nobody reads to the
 * end of nineteen exclusions.
 *
 * It never produces a number and never picks a winner. The arithmetic is
 * deterministic and lives in leveling.ts, the choice is H6 and belongs to a
 * human, and an analyst that did either would be doing the two things this
 * product deliberately refuses to automate.
 */

export const COMPARE_BIDS_PROMPT_VERSION = 'compare-bids-1';

const Difference = z.object({
  /** What the bids disagree about, in an estimator's words. */
  topic: z.string(),
  /** Per bidder, what THIS bid says about it. Bidders not addressing it say so. */
  positions: z.array(z.object({ bidder: z.string(), position: z.string() })),
  /** Why it matters to the comparison. */
  consequence: z.string(),
  materiality: z.enum(['HIGH', 'MEDIUM', 'LOW']),
});

const Comparison = z.object({
  /** Two or three sentences an estimator could read out. */
  summary: z.string(),
  differences: z.array(Difference),
  /** Questions to send back before this comparison can be trusted. */
  clarifications: z.array(z.string()),
});

const SYSTEM = `You compare subcontractor bids on one package and explain why
they are not comparable.

You are given each bid's stated total, its exclusions, its terms, and the scope
items it priced. Everything you say must rest on that material.

RULES YOU MAY NOT BREAK:

- NEVER STATE A PRICE, A RATE, OR AN ADJUSTED TOTAL. The arithmetic is done
  elsewhere, deterministically, and it is not yours to redo or to summarise. You
  may say "excludes trenching"; you may not say "which is worth about $8,000".
- NEVER RECOMMEND A BIDDER. Selection is a human decision with a written
  rationale. You describe the differences; somebody else weighs them.
- GROUND EVERYTHING. Every position you attribute to a bidder comes from their
  exclusions, their terms, or what they priced. If a bid is silent on something,
  say it is silent — that is frequently the most important finding, because an
  unstated assumption is the one nobody argues about until it costs money.
- WRITE FOR SOMEBODY MID-TASK. Short sentences. No preamble, no "in conclusion",
  no restating the question. An estimator reading this has the bids open.
- MATERIALITY IS ABOUT WHETHER IT CHANGES THE DECISION. HIGH means a reasonable
  person might award differently knowing it. Do not mark everything HIGH.
- The clarifications are questions to send to a sub. Make them specific enough
  to answer in one line.`;

type BidInput = {
  bidder: string;
  quotedTotal: number | null;
  exclusions: string[];
  terms: { key: string; value: string }[];
  pricedScope: string[];
  unpricedScope: string[];
};

export async function runBidComparison(
  ctx: AgentContext,
  payload: Record<string, unknown>,
): Promise<void> {
  const bids = (payload.bids ?? []) as BidInput[];
  const packageName = String(payload.packageName ?? 'this package');

  if (bids.length < 2) {
    throw new Error(
      'Comparing bids needs at least two of them. With one bid there is nothing to be ' +
        'incomparable with.',
    );
  }

  await ctx.emit('INFO', `comparing ${bids.length} bids on ${packageName}`);

  const described = bids
    .map((bid) =>
      [
        `BIDDER: ${bid.bidder}`,
        bid.quotedTotal === null
          ? '  stated total: none given'
          : '  stated total: given (do not restate it)',
        bid.exclusions.length > 0
          ? `  exclusions (${bid.exclusions.length}):\n${bid.exclusions.map((line) => `    - ${line}`).join('\n')}`
          : '  exclusions: none stated',
        bid.terms.length > 0
          ? `  terms:\n${bid.terms.map((term) => `    - ${term.key}: ${term.value}`).join('\n')}`
          : '  terms: none captured',
        bid.pricedScope.length > 0
          ? `  priced: ${bid.pricedScope.join('; ')}`
          : '  priced: nothing mapped to scope items yet',
        bid.unpricedScope.length > 0
          ? `  did NOT price: ${bid.unpricedScope.join('; ')}`
          : '  did not price: nothing — covered the whole package scope',
      ].join('\n'),
    )
    .join('\n\n');

  const { value, costUsd } = await extractStructured({
    system: SYSTEM,
    schema: Comparison,
    instruction: [
      `PACKAGE: ${packageName}`,
      '',
      described,
      '',
      '---',
      '',
      'Explain why these bids are not directly comparable.',
    ].join('\n'),
    maxTokens: 16000,
    effort: 'low',
  });

  await ctx.emit('RESULT', value.summary, { costUsd });

  for (const difference of value.differences) {
    const positions = difference.positions
      .map((entry) => `${entry.bidder}: ${entry.position}`)
      .join(' · ');

    await ctx.emit(
      difference.materiality === 'HIGH' ? 'WARNING' : 'INFO',
      `[${difference.materiality}] ${difference.topic} — ${positions}. ${difference.consequence}`,
      { topic: difference.topic, materiality: difference.materiality },
    );
  }

  for (const question of value.clarifications) {
    await ctx.emit('INFO', `ask them: ${question}`, { clarification: true });
  }

  await ctx.emit(
    'INFO',
    `${value.differences.length} material difference(s), ${value.clarifications.length} question(s) ` +
      'worth sending back. Nothing here is a recommendation — the ranking is arithmetic and the ' +
      'choice is yours at H6.',
  );
}

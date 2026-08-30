import { z } from 'zod';
import type { AgentContext } from '../lib/agent-run.js';
import { extractStructured } from '../lib/anthropic.js';

/**
 * A9 · Scope context drafter.
 *
 * Writes down what a scope item actually MEANS: what the sub carries under it,
 * what it explicitly does not include, where it touches another trade, and what
 * a price against it assumes.
 *
 * This is the layer where money leaks. A line that says "metal stud framing,
 * 4,200 SF" is enough to check whether somebody priced framing; it is not
 * enough to check whether anybody priced the head-of-wall detail, and the
 * head-of-wall detail is the change order. Scope does not go missing at the
 * item level, it goes missing at the seam.
 *
 * Grounded in three things, in order of weight:
 *
 *   1. What the documents said, carried through from the scope draft.
 *   2. Division gap patterns — the recurring seams for that CSI section, each
 *      with a track record of how often flagging it turned out to matter.
 *   3. Past change orders classified as preventable against this section.
 *
 * It is a knowledge pass, not a second read of the bid set. The drawings were
 * already read to produce the item; asking a model to read two hundred sheets
 * again per line item is both slow and worse, because the useful signal here is
 * what a division expert knows rather than what page 47 says.
 */

export const SCOPE_CONTEXT_PROMPT_VERSION = 'scope-context-1';

const KINDS = [
  'INCLUSION',
  'EXCLUSION',
  'INTERFACE',
  'ASSUMPTION',
  'RISK',
  'BASIS_OF_DESIGN',
] as const;

const Line = z.object({
  /** Index into the scope items given, so the model does not restate ids. */
  item_index: z.number(),
  kind: z.enum(KINDS),
  text: z.string(),
  /** The gap pattern id in square brackets this rests on, if any. */
  pattern_ref: z.string().nullable(),
  /** PATTERN when it rests on division knowledge, HISTORY on a past job. */
  origin: z.enum(['PATTERN', 'HISTORY', 'DOCUMENT']),
  confidence: z.number(),
});

const Draft = z.object({
  lines: z.array(Line),
  /** Items deliberately left without context, and why. */
  skipped: z.array(z.string()),
});

const SYSTEM = `You write the context that sits underneath a general contractor's
scope of work line items.

For each scope item you are given, write the lines an estimator needs so that a
subcontractor's quote can be checked against it properly.

THE KINDS, AND WHAT EACH IS FOR:

- INCLUSION — work the sub carries under this item that the line title does not
  say out loud. This is the most valuable kind. "Metal stud framing" includes
  deflection track, backing for wall-hung items, and head-of-wall treatment, and
  none of those are in the words "metal stud framing".
- EXCLUSION — work a reader would reasonably assume is here and is NOT, because
  it is carried under a different item or by a different trade. Say where it
  actually sits.
- INTERFACE — the seam with another trade. Name both sides. "Firestopping at
  the top of rated partitions: framer installs, FP sub seals" is useful;
  "coordinate with other trades" is not.
- ASSUMPTION — what a price against this item takes to be true. Gauge, height,
  finish level, sequence, access, working hours.
- RISK — what habitually goes wrong here, stated as the specific failure, not as
  a category.
- BASIS_OF_DESIGN — the product or detail the price assumes, where the documents
  name one.

RULES YOU MAY NOT BREAK:

- GROUND EVERY LINE. Each rests on a gap pattern you were given (cite its id in
  square brackets, and set origin to PATTERN), on a past change order you were
  shown (origin HISTORY), or on the item's own description (origin DOCUMENT). If
  a line rests on none of those, do not write it. General construction wisdom
  with nothing behind it is exactly what an estimator cannot act on, because
  they cannot tell whether it applies to THIS job.
- NO PRICES. Not a dollar figure, not a unit rate, not a percentage of the
  line. Costing is a separate step with its own rules.
- NO QUANTITIES you were not given. Do not infer one from the item's quantity.
- BE SPECIFIC ENOUGH TO CHECK. Every line should be something you could read a
  sub's quote against and get a yes or a no. "Ensure proper coordination" fails
  that test. "Deflection track at head of all full-height partitions" passes it.
- FEWER, BETTER LINES. Four lines an estimator reads beat twelve they skim. If
  an item genuinely has nothing worth saying — a simple allowance, a clearly
  bounded supply-only item — skip it and say why.
- Do not restate the item's own title as an inclusion.`;

type ScopeItemInput = {
  id: string;
  scopeId: string;
  csiDivision: string | null;
  csiSection: string | null;
  title: string;
  description: string | null;
  quantity: number | null;
  unit: string | null;
};

type PatternInput = {
  id: string;
  division: string;
  section: string | null;
  text: string;
  frequentChangeOrder: boolean;
  timesProposed: number;
  timesConfirmed: number;
};

type HistoryInput = {
  section: string | null;
  description: string;
  statedReason: string | null;
  classification: string | null;
};

/** How many scope items go into one model call. */
const BATCH = 12;

export async function runScopeContextDrafter(
  ctx: AgentContext,
  payload: Record<string, unknown>,
): Promise<void> {
  const items = (payload.scopeItems ?? []) as ScopeItemInput[];
  const patterns = (payload.patterns ?? []) as PatternInput[];
  const history = (payload.history ?? []) as HistoryInput[];

  if (items.length === 0) {
    throw new Error('draft_scope_context requires at least one scope item');
  }

  await ctx.emit(
    'INFO',
    `writing context for ${items.length} scope item${items.length === 1 ? '' : 's'}, ` +
      `grounded in ${patterns.length} division pattern(s) and ${history.length} past change order(s)`,
  );

  if (patterns.length === 0 && history.length === 0) {
    await ctx.emit(
      'WARNING',
      'No division patterns or change-order history loaded for these divisions. ' +
        'Context can only be drafted from the items own descriptions, which is the weakest of the three sources.',
    );
  }

  let drafted = 0;
  let cost = 0;

  for (let start = 0; start < items.length; start += BATCH) {
    const batch = items.slice(start, start + BATCH);

    const itemLines = batch
      .map(
        (item, index) =>
          `  [${index}] ${item.scopeId} — div ${item.csiDivision ?? '?'}` +
          (item.csiSection ? ` sec ${item.csiSection}` : '') +
          `\n      ${item.title}` +
          (item.description ? `\n      ${item.description}` : '') +
          (item.quantity !== null ? `\n      quantity: ${item.quantity} ${item.unit ?? ''}` : '\n      quantity: not stated'),
      )
      .join('\n');

    // Only the patterns for the divisions actually in this batch. Handing a
    // model every pattern it has and asking it to pick is how you get context
    // about roofing attached to a plumbing item.
    const divisions = new Set(batch.map((item) => item.csiDivision).filter(Boolean));
    const relevant = patterns.filter((pattern) => divisions.has(pattern.division));

    const patternLines =
      relevant.length === 0
        ? '  (none loaded for these divisions)'
        : relevant
            .map(
              (pattern) =>
                `  [${pattern.id.slice(0, 8)}] div ${pattern.division}` +
                (pattern.section ? ` sec ${pattern.section}` : '') +
                (pattern.frequentChangeOrder ? ' (frequent change order)' : '') +
                (pattern.timesProposed > 0
                  ? ` (confirmed ${pattern.timesConfirmed}/${pattern.timesProposed} times)`
                  : ' (never yet tested)') +
                `: ${pattern.text}`,
            )
            .join('\n');

    const historyLines =
      history.length === 0
        ? '  (no change-order history for these sections)'
        : history
            .map(
              (entry) =>
                `  sec ${entry.section ?? '?'}` +
                (entry.classification ? ` [${entry.classification}]` : '') +
                `: ${entry.description}` +
                (entry.statedReason ? ` — reason given: ${entry.statedReason}` : ''),
            )
            .join('\n');

    await ctx.emit(
      'INFO',
      `batch ${Math.floor(start / BATCH) + 1} — items ${start + 1}–${start + batch.length}`,
    );

    const { value, costUsd } = await extractStructured({
      system: SYSTEM,
      schema: Draft,
      instruction: [
        'SCOPE ITEMS (refer to them by the index in square brackets):',
        itemLines,
        '',
        'DIVISION GAP PATTERNS (cite by the id in square brackets):',
        patternLines,
        '',
        'PAST CHANGE ORDERS ON THESE SECTIONS:',
        historyLines,
        '',
        '---',
        '',
        'Write the context lines. Ground every one of them.',
      ].join('\n'),
      maxTokens: 16000,
    });

    cost += costUsd;

    ctx.spent(costUsd);

    for (const line of value.lines) {
      const item = batch[line.item_index];
      if (!item) continue;

      // Resolve the short pattern reference back to a real id, so the draft
      // carries a foreign key rather than eight characters of hope.
      const pattern = line.pattern_ref
        ? relevant.find((entry) => entry.id.startsWith(line.pattern_ref!.replace(/[[\]]/g, '')))
        : undefined;

      await ctx.draft({
        targetTable: 'scope_context',
        targetId: null,
        field: `${item.scopeId}:${line.kind}`,
        value: {
          scope_item_id: item.id,
          kind: line.kind,
          text: line.text,
          origin: line.origin,
          gap_pattern_id: pattern?.id ?? null,
        },
        sourceLocation: pattern
          ? `gap pattern ${pattern.id.slice(0, 8)}`
          : line.origin === 'HISTORY'
            ? 'change-order history'
            : `${item.scopeId} description`,
        confidence: line.confidence,
        fillTag: 'AI',
      });

      drafted += 1;
    }

    for (const note of value.skipped) {
      await ctx.emit('INFO', `no context drafted: ${note}`);
    }
  }

  await ctx.emit(
    'RESULT',
    `${drafted} context line(s) drafted across ${items.length} scope item(s). ` +
      'Review and accept them in the review queue — an agent proposes context, it does not set it.',
    { drafted, items: items.length, costUsd: cost },
  );
}

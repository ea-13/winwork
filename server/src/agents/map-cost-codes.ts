import { z } from 'zod';
import type { AgentContext } from '../lib/agent-run.js';
import { extractStructured } from '../lib/anthropic.js';

/**
 * A12 · Cost code mapper.
 *
 * A tenant's cost codes are their own structure — imported from a template or
 * lifted out of a past bid — and scope items arrive classified by CSI, because
 * that is what the documents use. Somebody has to reconcile the two, and doing
 * it by hand across two hundred scope items is the kind of task that gets
 * skipped, which leaves the whole estimate unable to talk to their accounting.
 *
 * The mapping is a proposal, always. A code is how money is filed inside a
 * business and a wrong one is discovered at the worst possible moment, so these
 * go to drafts and a human accepts them like anything else (R2).
 *
 * Where nothing matches, it says nothing matched. An estimator would rather see
 * twelve blanks they can fill than twelve confident wrong codes they have to
 * find (R1).
 */

export const MAP_COST_CODES_PROMPT_VERSION = 'map-cost-codes-1';

const Mapping = z.object({
  /** Index into the scope items given. */
  item_index: z.number(),
  /** The code, exactly as it appears in the tenant's list. Null when unsure. */
  cost_code: z.string().nullable(),
  reasoning: z.string(),
  confidence: z.number(),
});

const Result = z.object({
  mappings: z.array(Mapping),
  /** Codes that look like they should cover something and do not. */
  unused_notes: z.array(z.string()),
});

const SYSTEM = `You map a general contractor's scope items onto their own cost
code structure.

You are given their cost codes and a batch of scope items. Assign each item the
code it belongs under.

RULES YOU MAY NOT BREAK:

- USE ONLY CODES FROM THE LIST. Never invent a code, never adjust the format of
  one, never merge two. If the right code is not in the list, return null.
- NULL IS A REAL ANSWER AND OFTEN THE RIGHT ONE. A scope item that does not
  clearly belong under any code they have gets null and a short reason. A wrong
  code is worse than a blank: a blank gets filled in by somebody who knows, and
  a wrong one gets reconciled against for a year.
- MATCH ON THE WORK, NOT THE WORDS. "Metal stud framing" belongs under a
  framing code whether or not either string contains the word "framing". A code
  whose description is about a different trade is not a match because the
  numbers happen to be close.
- WHERE A DIVISION IS GIVEN ON THE CODE, IT IS STRONG EVIDENCE. A division 22
  scope item under a code marked division 23 needs a reason better than similar
  wording.
- Confidence is how sure you are this is the code THEY would have picked, not
  how sure you are the item exists.`;

type CodeInput = { id: string; code: string; description: string; division: string | null };
type ItemInput = { id: string; scopeId: string; division: string | null; title: string; description: string | null };

/** How many scope items per model call. */
const BATCH = 25;

export async function runCostCodeMapper(
  ctx: AgentContext,
  payload: Record<string, unknown>,
): Promise<void> {
  const codes = (payload.codes ?? []) as CodeInput[];
  const items = (payload.items ?? []) as ItemInput[];

  if (codes.length === 0) {
    throw new Error(
      'No cost codes are set up for this tenant yet. Import your structure first — mapping onto ' +
        'nothing would just be inventing codes.',
    );
  }
  if (items.length === 0) {
    throw new Error('Every scope item already has a cost code.');
  }

  await ctx.emit(
    'INFO',
    `mapping ${items.length} scope item(s) onto ${codes.length} cost code(s)`,
  );

  const codeList = codes
    .map(
      (code) =>
        `  ${code.code}` +
        (code.division ? ` [div ${code.division}]` : '') +
        ` — ${code.description}`,
    )
    .join('\n');

  const byCode = new Map(codes.map((code) => [code.code.toLowerCase().trim(), code]));

  let mapped = 0;
  let unmatched = 0;
  let cost = 0;

  for (let start = 0; start < items.length; start += BATCH) {
    const batch = items.slice(start, start + BATCH);

    const itemList = batch
      .map(
        (item, index) =>
          `  [${index}] ${item.scopeId} [div ${item.division ?? '?'}] ${item.title}` +
          (item.description ? `\n        ${item.description.slice(0, 200)}` : ''),
      )
      .join('\n');

    await ctx.emit(
      'INFO',
      `batch ${Math.floor(start / BATCH) + 1} — items ${start + 1}–${start + batch.length}`,
    );

    const { value, costUsd } = await extractStructured({
      system: SYSTEM,
      schema: Result,
      instruction: [
        'COST CODES:',
        codeList,
        '',
        'SCOPE ITEMS (refer to them by the index in square brackets):',
        itemList,
      ].join('\n'),
      maxTokens: 16000,
      effort: 'low',
    });

    cost += costUsd;

    for (const mapping of value.mappings) {
      const item = batch[mapping.item_index];
      if (!item) continue;

      if (mapping.cost_code === null) {
        unmatched += 1;
        continue;
      }

      // The model may only return a code that exists. Anything else is a
      // hallucinated code and is dropped rather than drafted.
      const code = byCode.get(mapping.cost_code.toLowerCase().trim());
      if (!code) {
        await ctx.emit(
          'WARNING',
          `${item.scopeId}: proposed "${mapping.cost_code}", which is not in your code list. Dropped.`,
        );
        unmatched += 1;
        continue;
      }

      await ctx.draft({
        targetTable: 'scope_item',
        targetId: item.id,
        field: 'cost_code_id',
        value: { cost_code_id: code.id, cost_code: code.code },
        sourceLocation: `cost code ${code.code} — ${code.description}`,
        confidence: mapping.confidence,
        fillTag: 'AI',
      });

      mapped += 1;
    }

    for (const note of value.unused_notes) {
      await ctx.emit('INFO', note);
    }
  }

  await ctx.emit(
    'RESULT',
    `${mapped} scope item(s) matched to a cost code, ${unmatched} left unmatched. ` +
      'Accept them in the review queue. Unmatched items are not a failure — they are the ones ' +
      'your structure does not have a home for yet.',
    { mapped, unmatched, costUsd: cost },
  );
}

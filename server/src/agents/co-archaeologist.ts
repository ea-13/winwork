import { z } from 'zod';
import type { AgentContext } from '../lib/agent-run.js';
import { extractStructured } from '../lib/anthropic.js';

/**
 * A6 · Change-Order Archaeologist.
 *
 * Takes a closed job — the original bid set and the change orders that
 * followed — and asks, of each change order: was this scope present in the bid
 * documents on day one?
 *
 * The answer, when it is yes, is the most persuasive sentence this product can
 * produce: *of $X in change orders, $Y were preventable scope gaps, and here
 * are the patterns.* It shows a GC their own money.
 *
 * Which is exactly why the bar is high. Every classification is a DRAFT
 * requiring a human verdict, never presented as fact, and UNDETERMINED is the
 * default rather than the fallback. A wrong "preventable" claim in front of the
 * person who ran that job does not cost you a point in the argument — it ends
 * the meeting.
 */

export const CO_ARCHAEOLOGY_PROMPT_VERSION = 'co-archaeologist-1';

const Classification = z.object({
  change_order_id: z.string(),
  classification: z.enum([
    'PREVENTABLE_SCOPE_GAP',
    'OWNER_DIRECTED',
    'UNFORESEEN_CONDITION',
    'DESIGN_ERROR',
    'UNDETERMINED',
  ]),
  /** Where in the bid documents this scope appears, when it does. */
  source_location: z.string().nullable(),
  /** The scope item or spec reference this change order maps back to. */
  scope_item_ref: z.string().nullable(),
  /** A gap pattern this matches, when one does. */
  gap_pattern_id: z.string().nullable(),
  reasoning: z.string(),
  confidence: z.number(),
});

const Archaeology = z.object({
  classifications: z.array(Classification),
  /** What a human would need to settle the ones left undetermined. */
  needed_to_resolve: z.array(z.string()),
});

const SYSTEM = `You are reconstructing why a completed construction project ran
over. You have the original bid documents and the change orders that followed.

For each change order, decide which of these it was:

  PREVENTABLE_SCOPE_GAP  The scope WAS in the bid documents, and nobody carried
                         it. Cite where it appears. This is the finding that
                         matters, and it is the one you must be strictest about.
  OWNER_DIRECTED         A genuine addition the owner asked for after bidding.
                         Not preventable.
  UNFORESEEN_CONDITION   A differing site condition nobody could have seen.
                         Not preventable.
  DESIGN_ERROR           A drawing or specification conflict. Arguably
                         recoverable from the design team, not a precon failure.
  UNDETERMINED           You cannot establish which. THIS IS THE DEFAULT.

RULES YOU MAY NOT BREAK:

- UNDETERMINED is not a failure, it is an honest answer, and it is where you
  land unless the documents actually settle it. Do not reach for
  PREVENTABLE_SCOPE_GAP because it is the interesting one.
- To call something PREVENTABLE you must cite the place in the bid documents
  where that scope appears. No citation, no claim — if you cannot point at it,
  it is UNDETERMINED.
- A change order's own stated reason is evidence, not a verdict. "Unforeseen
  condition" written on a change order is what someone wanted it called.
- Never total anything. Never produce a percentage. You classify; the arithmetic
  is done elsewhere from your classifications after a human has vetted them.`;

type ChangeOrder = {
  id: string;
  co_number: string | null;
  amount: number | null;
  description: string | null;
  stated_reason: string | null;
  issued_at: string | null;
};

type Pattern = { id: string; pattern_text: string; typical_csi_section: string | null };

export async function runChangeOrderArchaeology(
  ctx: AgentContext,
  payload: Record<string, unknown>,
): Promise<void> {
  const pastProjectId = String(payload.pastProjectId ?? '');
  const changeOrders = (payload.changeOrders ?? []) as ChangeOrder[];
  const patterns = (payload.patterns ?? []) as Pattern[];
  const storagePaths = (payload.bidSetPaths ?? []) as { path: string; filename: string }[];

  if (!pastProjectId) throw new Error('co_archaeology requires a pastProjectId');
  if (changeOrders.length === 0) {
    throw new Error('This past project has no change orders to classify');
  }

  await ctx.emit(
    'INFO',
    `reconstructing ${changeOrders.length} change orders against the bid set`,
  );

  // The bid set is what makes "was it in the documents" answerable. Without it
  // every honest answer is UNDETERMINED, and the run is worth saying so about.
  let bidSet: Buffer | null = null;
  let bidSetName = '';

  for (const document of storagePaths.slice(0, 1)) {
    if (!document.filename.toLowerCase().endsWith('.pdf')) continue;
    bidSet = await ctx.readFile('project-documents', document.path);
    bidSetName = document.filename;
    if (bidSet) break;
  }

  if (!bidSet) {
    await ctx.emit(
      'WARNING',
      'no readable bid set attached — every classification will be UNDETERMINED, ' +
        'because "was this in the documents" cannot be answered without them',
    );
  } else {
    await ctx.emit('INFO', `reading ${bidSetName} (${(bidSet.length / 1024).toFixed(0)} KB)`);
  }

  const { value: result, costUsd } = await extractStructured({
    system: SYSTEM,
    schema: Archaeology,
    ...(bidSet ? { pdf: bidSet } : {}),
    instruction: [
      bidSet
        ? 'The attached document is the original bid set.'
        : 'NO BID SET IS ATTACHED. You cannot establish whether scope was in the ' +
          'documents, so every classification must be UNDETERMINED.',
      '',
      'CHANGE ORDERS:',
      JSON.stringify(
        changeOrders.map((order) => ({
          id: order.id,
          number: order.co_number,
          amount: order.amount,
          description: order.description,
          stated_reason: order.stated_reason,
          issued: order.issued_at,
        })),
        null,
        1,
      ),
      '',
      'KNOWN GAP PATTERNS (cite by id where one matches):',
      JSON.stringify(
        patterns.map((pattern) => ({
          id: pattern.id,
          pattern: pattern.pattern_text,
          section: pattern.typical_csi_section,
        })),
        null,
        1,
      ),
      '',
      'Classify every change order, using the exact ids given.',
    ].join('\n'),
    maxTokens: 16000,
  });

  const byId = new Map(changeOrders.map((order) => [order.id, order]));
  const tally: Record<string, number> = {};
  let preventableAmount = 0;

  for (const classification of result.classifications) {
    const order = byId.get(classification.change_order_id);
    if (!order) continue;

    tally[classification.classification] = (tally[classification.classification] ?? 0) + 1;

    // A preventable claim with no citation is downgraded here, not trusted.
    // The prompt forbids it; this makes the rule structural.
    const cited = Boolean(classification.source_location?.trim());
    const finalClass =
      classification.classification === 'PREVENTABLE_SCOPE_GAP' && !cited
        ? 'UNDETERMINED'
        : classification.classification;

    if (finalClass !== classification.classification) {
      await ctx.emit(
        'WARNING',
        `CO ${order.co_number ?? order.id.slice(0, 8)} claimed preventable with no citation — ` +
          'downgraded to UNDETERMINED',
      );
    }

    if (finalClass === 'PREVENTABLE_SCOPE_GAP') {
      preventableAmount += Number(order.amount ?? 0);
      await ctx.emit(
        'WARNING',
        `CO ${order.co_number ?? ''} preventable — in the bid set at ${classification.source_location}: ` +
          `${(order.description ?? '').slice(0, 100)}`,
        { amount: order.amount, location: classification.source_location },
      );
    }

    await ctx.draft({
      targetTable: 'co_classification',
      targetId: order.id,
      field: 'classification',
      value: {
        change_order_id: order.id,
        classification: finalClass,
        scope_item_ref: classification.scope_item_ref,
        gap_pattern_id: classification.gap_pattern_id,
        reasoning: classification.reasoning,
        source_location: classification.source_location,
      },
      sourceLocation: classification.source_location,
      confidence: classification.confidence,
      fillTag: 'AI',
    });
  }

  for (const needed of result.needed_to_resolve) {
    await ctx.emit('INFO', `to settle an undetermined one: ${needed}`);
  }

  const total = changeOrders.reduce((sum, order) => sum + Number(order.amount ?? 0), 0);
  const preventable = tally.PREVENTABLE_SCOPE_GAP ?? 0;

  await ctx.emit(
    'RESULT',
    preventable === 0
      ? `${changeOrders.length} change orders classified, none established as preventable`
      : `of ${total.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })} ` +
        `in change orders, ${preventableAmount.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })} ` +
        `across ${preventable} were preventable scope gaps — every one needs your verdict before it is shown to anyone`,
    { tally, total, preventableAmount, costUsd },
  );
}

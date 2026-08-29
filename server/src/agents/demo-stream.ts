import type { AgentContext } from '../lib/agent-run.js';

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A scripted run that exercises the whole runtime without calling the model:
 * job leasing, agent_run, sequential events, draft writes, and the SSE stream.
 *
 * It exists so the plumbing can be proven — and watched — before extraction is
 * built on top of it, and so the activity stream can be developed without
 * spending tokens on every reload. The narration is the shape from the demo
 * script: findings arrive as WARNING lines, which is what makes an estimator
 * look up.
 */
export async function runDemoStream(ctx: AgentContext): Promise<void> {
  await ctx.emit('INFO', 'reading Bidder F quote — 14 pages');
  await pause(900);

  await ctx.emit('INFO', 'extracted 47 line items, 12 commercial terms', {
    lineItems: 47,
    terms: 12,
  });
  await pause(900);

  await ctx.emit('INFO', 'scanning qualifications section...');
  await pause(1100);

  await ctx.emit('WARNING', 'exclusion found p.11: "waterproofing at grade by others"', {
    page: 11,
  });
  await ctx.draft({
    targetTable: 'quote_exclusion',
    field: 'excerpt',
    value: 'waterproofing at grade by others',
    sourceLocation: 'p.11',
    confidence: 0.94,
    fillTag: 'AI',
  });
  await pause(800);

  await ctx.emit('INFO', 'estimating add-back from 3 comparable bids -> $41,200', {
    basis: 'COMPARABLE_BIDS',
    amount: 41200,
  });
  await ctx.draft({
    targetTable: 'quote_exclusion',
    field: 'addback_amount',
    value: 41200,
    sourceLocation: 'p.11',
    confidence: 0.81,
    fillTag: 'AI',
  });
  await pause(900);

  await ctx.emit('WARNING', 'exclusion found p.12: "firestopping by others"', { page: 12 });
  await pause(700);

  // R1: no comparable, no benchmark, so no number. TBC is the honest answer.
  await ctx.emit('WARNING', 'no comparable bids priced this item — TBC, request clarification', {
    basis: 'TBC',
  });
  await ctx.draft({
    targetTable: 'quote_exclusion',
    field: 'addback_basis',
    value: 'TBC',
    sourceLocation: 'p.12',
    confidence: null,
    fillTag: 'AI',
  });
  await pause(900);

  await ctx.emit('RESULT', 'adjusted total: $584,700 (quoted $503,500)', {
    quotedTotal: 503500,
    adjustedTotal: 584700,
  });
}

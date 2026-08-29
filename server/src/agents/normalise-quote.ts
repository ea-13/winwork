import { z } from 'zod';
import type { AgentContext } from '../lib/agent-run.js';
import { extractStructured } from '../lib/anthropic.js';

/**
 * A2 · Normalisation Agent.
 *
 * Maps a quote's lines onto the locked scope baseline so five bidders become
 * comparable. This is the step that makes "who priced what" answerable, and
 * every downstream number depends on it being honest about uncertainty.
 *
 * Match on substance, not wording: "drywall and ceilings" may cover 09-21 and
 * 09-51 both. But an uncertain equivalence is flagged AMBIGUOUS and left for a
 * human — a forced match produces a comparison that looks complete and is
 * wrong, which is worse than an obvious gap.
 */

export const NORMALISE_PROMPT_VERSION = 'normalise-quote-1';

const Match = z.object({
  quote_line_id: z.string(),
  /** The scope item this line prices, or null when nothing matches. */
  scope_item_id: z.string().nullable(),
  /** 0–1. Below the threshold this becomes AMBIGUOUS regardless. */
  match_confidence: z.number(),
  /** Why, in one line, citing the words that decided it. */
  match_basis: z.string(),
  /** True when one price covers several scope items. */
  is_lumped: z.boolean(),
  /** Scope items also covered when the line is lumped. */
  additional_scope_item_ids: z.array(z.string()),
});

const ExclusionMatch = z.object({
  exclusion_id: z.string(),
  scope_item_id: z.string().nullable(),
  match_confidence: z.number(),
  match_basis: z.string(),
});

const Normalisation = z.object({
  matches: z.array(Match),
  exclusion_matches: z.array(ExclusionMatch),
  /** Lines that price work nobody put in the scope. */
  additions: z.array(z.object({ quote_line_id: z.string(), note: z.string() })),
});

/** Below this, a match is not a match — it is a question for a human. */
const AMBIGUOUS_BELOW = 0.7;

const SYSTEM = `You map subcontractor quote lines onto a general contractor's scope baseline.

Match on SUBSTANCE, not wording. A line reading "drywall and ceilings" may cover
both a metal-stud-and-gypsum scope item and an acoustical-ceiling one — that is
a lumped line covering two scope items, not a failed match.

RULES YOU MAY NOT BREAK:

- Never force a match. If you are not confident the line prices that scope item,
  set scope_item_id to null and say why in match_basis. An honest gap is worth
  more than a plausible wrong mapping, because the wrong mapping makes a bidder
  look complete when they are not.
- Never silently drop a line. Every quote line you are given appears exactly
  once in your output, matched or not.
- A line that prices work absent from the scope is an ADDITION. List it. Do not
  discard it and do not invent a scope item for it.
- match_confidence is your real belief, not a courtesy. Values below 0.7 are
  treated as ambiguous and sent to a human, which is the correct outcome for a
  genuine judgement call.`;

type ScopeItem = {
  id: string;
  scope_id: string;
  csi_division: string | null;
  csi_section: string | null;
  title: string;
  description: string | null;
  unit: string | null;
  quantity: number | null;
};

type QuoteLine = {
  id: string;
  description: string | null;
  original_text: string | null;
  qty: number | null;
  unit: string | null;
  rate: number | null;
  line_total: number | null;
};

type Exclusion = { id: string; excerpt: string | null; source_location: string | null };

export async function runNormalisation(
  ctx: AgentContext,
  payload: Record<string, unknown>,
): Promise<void> {
  const quoteId = String(payload.quoteId ?? '');
  const scopeItems = (payload.scopeItems ?? []) as ScopeItem[];
  const lines = (payload.quoteLines ?? []) as QuoteLine[];
  const exclusions = (payload.exclusions ?? []) as Exclusion[];

  if (!quoteId) throw new Error('normalise_quote requires a quoteId');
  if (scopeItems.length === 0) {
    throw new Error(
      'This package has no locked scope items. Normalisation compares against the ' +
        'baseline, so there is nothing to compare to yet.',
    );
  }
  if (lines.length === 0) throw new Error('This quote has no promoted lines to normalise');

  await ctx.emit(
    'INFO',
    `normalising ${lines.length} quote lines against ${scopeItems.length} scope items`,
  );

  const { value: result, costUsd } = await extractStructured({
    system: SYSTEM,
    schema: Normalisation,
    instruction: [
      'SCOPE BASELINE:',
      JSON.stringify(
        scopeItems.map((item) => ({
          id: item.id,
          scope_id: item.scope_id,
          section: item.csi_section,
          title: item.title,
          description: item.description,
          unit: item.unit,
          quantity: item.quantity,
        })),
        null,
        1,
      ),
      '',
      'QUOTE LINES:',
      JSON.stringify(
        lines.map((line) => ({
          id: line.id,
          text: line.original_text ?? line.description,
          qty: line.qty,
          unit: line.unit,
          rate: line.rate,
          total: line.line_total,
        })),
        null,
        1,
      ),
      '',
      'EXCLUSIONS (map each to the scope item it removes, if any):',
      JSON.stringify(
        exclusions.map((exclusion) => ({ id: exclusion.id, excerpt: exclusion.excerpt })),
        null,
        1,
      ),
      '',
      'Map every quote line. Use the exact ids given.',
    ].join('\n'),
    maxTokens: 16000,
  });

  const known = new Set(scopeItems.map((item) => item.id));
  let matched = 0;
  let ambiguous = 0;

  for (const match of result.matches) {
    const valid = match.scope_item_id !== null && known.has(match.scope_item_id);
    const isAmbiguous = valid && match.match_confidence < AMBIGUOUS_BELOW;

    if (valid && !isAmbiguous) matched += 1;
    if (isAmbiguous || (match.scope_item_id !== null && !valid)) ambiguous += 1;

    await ctx.draft({
      targetTable: 'quote_line',
      targetId: match.quote_line_id,
      field: 'scope_item_id',
      value: {
        scope_item_id: valid && !isAmbiguous ? match.scope_item_id : null,
        match_confidence: match.match_confidence,
        match_basis: isAmbiguous ? `AMBIGUOUS — ${match.match_basis}` : match.match_basis,
        is_lumped: match.is_lumped,
        additional_scope_item_ids: match.additional_scope_item_ids.filter((id) => known.has(id)),
      },
      confidence: match.match_confidence,
      fillTag: 'AI',
    });

    if (isAmbiguous) {
      await ctx.emit('WARNING', `ambiguous match — ${match.match_basis}`, match);
    }
  }

  for (const exclusionMatch of result.exclusion_matches) {
    await ctx.draft({
      targetTable: 'quote_exclusion',
      targetId: exclusionMatch.exclusion_id,
      field: 'scope_item_id',
      value: {
        scope_item_id:
          exclusionMatch.scope_item_id && known.has(exclusionMatch.scope_item_id)
            ? exclusionMatch.scope_item_id
            : null,
        match_basis: exclusionMatch.match_basis,
      },
      confidence: exclusionMatch.match_confidence,
      fillTag: 'AI',
    });
  }

  for (const addition of result.additions) {
    await ctx.emit('WARNING', `addition — priced but not in the scope: ${addition.note}`, addition);
    await ctx.draft({
      targetTable: 'quote_line',
      targetId: addition.quote_line_id,
      field: 'match_basis',
      value: `ADDITION — ${addition.note}`,
      fillTag: 'AI',
    });
  }

  const unmatched = result.matches.length - matched - ambiguous;

  await ctx.emit(
    'RESULT',
    `${matched} matched, ${ambiguous} ambiguous, ${unmatched} unmatched, ` +
      `${result.additions.length} additions`,
    { matched, ambiguous, unmatched, additions: result.additions.length, costUsd },
  );
}

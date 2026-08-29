import { z } from 'zod';
import type { AgentContext } from '../lib/agent-run.js';
import { extractStructured } from '../lib/anthropic.js';

/**
 * A5 · Division Expert Consult.
 *
 * Reads the locked scope for the divisions in play and asks, for each known gap
 * pattern in those divisions, whether the scope covers it. Anything uncovered
 * becomes an advisory flag citing the pattern that raised it.
 *
 * Advisory is the operative word. This agent reasons against VETTED scope only,
 * it raises questions rather than adding scope, and it never emits an
 * uncalibrated dollar figure to anything client-facing (R5). Every flag cites
 * its checklist item, because a flag without a citation is an opinion (R6).
 */

export const CONSULT_PROMPT_VERSION = 'division-consult-1';

const Flag = z.object({
  gap_pattern_id: z.string(),
  /** Is this pattern's work present in the scope baseline? */
  covered: z.boolean(),
  /** The scope item that covers it, when one does. */
  covering_scope_item_id: z.string().nullable(),
  confidence: z.number(),
  /** One line. Cites the pattern and what is or is not in the scope. */
  reasoning: z.string(),
});

const Consult = z.object({ findings: z.array(Flag) });

const SYSTEM = `You are a construction division expert reviewing a general
contractor's scope of work against a checklist of gaps that commonly appear in
your division.

For each pattern you are given, decide whether the scope baseline covers that
work. Cite the scope item that covers it, or say plainly that nothing does.

RULES YOU MAY NOT BREAK:

- You are ADVISORY. You do not add scope, you raise a question an estimator
  answers. Say "no scope item covers rated firestopping at penetrations", not
  "add firestopping".
- Never claim coverage on a maybe. A pattern half-covered by an adjacent item is
  not covered; say so and let a human decide.
- Never produce a dollar figure. Costing is a different step with its own rules.
- Every finding cites the pattern that raised it. A flag with no citation is an
  opinion, and this product does not ship opinions.`;

type Pattern = {
  id: string;
  pattern_text: string;
  typical_csi_section: string | null;
  is_frequent_change_order: boolean | null;
  division: string | null;
};

type ScopeItem = {
  id: string;
  scope_id: string;
  csi_section: string | null;
  title: string;
  description: string | null;
};

export async function runDivisionConsult(
  ctx: AgentContext,
  payload: Record<string, unknown>,
): Promise<void> {
  const patterns = (payload.patterns ?? []) as Pattern[];
  const scopeItems = (payload.scopeItems ?? []) as ScopeItem[];
  const packageId = String(payload.packageId ?? '');

  if (patterns.length === 0) {
    throw new Error('No gap patterns for the divisions in this package');
  }
  if (scopeItems.length === 0) {
    throw new Error('No locked scope items to review. Lock a baseline (H2) first.');
  }

  await ctx.emit(
    'INFO',
    `checking ${patterns.length} known gap patterns against ${scopeItems.length} locked scope items`,
  );

  const { value: result, costUsd } = await extractStructured({
    system: SYSTEM,
    schema: Consult,
    instruction: [
      'LOCKED SCOPE BASELINE:',
      JSON.stringify(
        scopeItems.map((item) => ({
          id: item.id,
          section: item.csi_section,
          title: item.title,
          description: item.description,
        })),
        null,
        1,
      ),
      '',
      'GAP PATTERNS TO CHECK:',
      JSON.stringify(
        patterns.map((pattern) => ({
          id: pattern.id,
          division: pattern.division,
          pattern: pattern.pattern_text,
          typical_section: pattern.typical_csi_section,
          frequent_change_order: pattern.is_frequent_change_order,
        })),
        null,
        1,
      ),
      '',
      'Return one finding per pattern, using the exact ids given.',
    ].join('\n'),
  });

  const patternById = new Map(patterns.map((pattern) => [pattern.id, pattern]));
  let flagged = 0;

  for (const finding of result.findings) {
    const pattern = patternById.get(finding.gap_pattern_id);
    if (!pattern) continue;
    if (finding.covered) continue;

    flagged += 1;
    const frequent = pattern.is_frequent_change_order ? ' — frequent change order' : '';

    await ctx.emit(
      'WARNING',
      `no scope covers: ${pattern.pattern_text}${frequent}`,
      { patternId: pattern.id, reasoning: finding.reasoning },
    );

    await ctx.draft({
      targetTable: 'scope_gap',
      targetId: packageId || null,
      field: 'division_expert_advisory',
      value: {
        gap_pattern_id: pattern.id,
        pattern_text: pattern.pattern_text,
        typical_csi_section: pattern.typical_csi_section,
        is_frequent_change_order: pattern.is_frequent_change_order,
        reasoning: finding.reasoning,
        // No number. Costing is a different step with different rules (R5).
        exposure_amount: null,
      },
      sourceLocation: `division expert pattern ${pattern.id}`,
      confidence: finding.confidence,
      fillTag: 'AI',
    });
  }

  await ctx.emit(
    'RESULT',
    flagged === 0
      ? 'every known gap pattern for these divisions is covered by the scope'
      : `${flagged} of ${patterns.length} known gap patterns are not covered by the scope`,
    { flagged, checked: patterns.length, costUsd },
  );
}

import { z } from 'zod';
import type { AgentContext } from '../lib/agent-run.js';
import { extractStructured } from '../lib/anthropic.js';

/**
 * A7 · Scope of Work Drafter.
 *
 * Reads a specification or scope narrative and drafts scope_item rows organised
 * by CSI division and section. Every item carries the document, page and
 * excerpt it came from.
 *
 * Quantities are drafted ONLY where the document states them. Never inferred
 * from an area, never estimated, never carried across from a similar project.
 * An unstated quantity is UNKNOWN, and an estimator would rather see a blank
 * than a number they have to go and disprove.
 */

export const DRAFT_SCOPE_PROMPT_VERSION = 'draft-scope-1';

const Item = z.object({
  csi_division: z.string(),
  csi_section: z.string().nullable(),
  title: z.string(),
  description: z.string(),
  unit: z.string().nullable(),
  /** Only when the document states it. Null otherwise — always. */
  quantity: z.number().nullable(),
  quantity_basis: z.string().nullable(),
  source_location: z.string(),
  confidence: z.number(),
});

const Draft = z.object({
  items: z.array(Item),
  /** Sections read but deliberately not turned into scope, and why. */
  skipped: z.array(z.string()),
});

const SYSTEM = `You draft a general contractor's scope of work from specification
and scope-narrative documents.

Produce discrete, biddable scope items organised by CSI division and section.
One item is one thing a subcontractor would price as a line.

RULES YOU MAY NOT BREAK:

- QUANTITIES ONLY WHERE STATED. If the document does not give a quantity, set it
  to null. Do not infer one from an area, a room count, a drawing scale or
  anything else. An unstated quantity is UNKNOWN, and inventing one puts a
  number into a bid comparison that nobody can defend.
- Every item cites where it came from: page, and section or paragraph.
- Do not restate the whole specification. Draft what a sub would bid, not what
  an architect wrote — general conditions, submittal procedures and warranty
  boilerplate are not scope items.
- If a passage is ambiguous about who carries the work, draft it and say so in
  the description. Ambiguity that reaches an estimator is useful; ambiguity you
  resolve silently is not.`;

export async function runScopeDrafter(
  ctx: AgentContext,
  payload: Record<string, unknown>,
): Promise<void> {
  const storagePath = String(payload.storagePath ?? '');
  const filename = String(payload.filename ?? 'document');
  const bidId = String(payload.bidId ?? '');
  const divisions = (payload.divisions ?? []) as string[];

  if (!storagePath) throw new Error('draft_scope requires a stored document');

  await ctx.emit('INFO', `reading ${filename}`);

  const bytes = await ctx.readFile('project-documents', storagePath);
  if (!bytes) throw new Error('Could not download that document from storage');

  if (!filename.toLowerCase().endsWith('.pdf')) {
    throw new Error(`${filename} is not a PDF. Only PDF drafting is implemented so far.`);
  }

  await ctx.emit('INFO', `${(bytes.length / 1024).toFixed(0)} KB — reading for scope`);

  const { value: result, costUsd } = await extractStructured({
    system: SYSTEM,
    schema: Draft,
    pdf: bytes,
    instruction:
      divisions.length > 0
        ? `Draft scope items from this document, limited to CSI divisions ${divisions.join(', ')}.`
        : 'Draft scope items from this document across every division it covers.',
    maxTokens: 16000,
  });

  await ctx.emit('INFO', `drafted ${result.items.length} scope items`);

  // Sequence within division, mirroring how scope_id is generated elsewhere.
  const perDivision = new Map<string, number>();

  for (const item of result.items) {
    const division = item.csi_division.padStart(2, '0').slice(0, 2);
    const seq = (perDivision.get(division) ?? 0) + 1;
    perDivision.set(division, seq);

    await ctx.draft({
      targetTable: 'scope_item',
      field: `${division}-${String(seq).padStart(3, '0')}`,
      value: {
        scope_id: bidId ? `${bidId}-${division}-${String(seq).padStart(3, '0')}` : null,
        csi_division: division,
        csi_section: item.csi_section,
        title: item.title,
        description: item.description,
        unit: item.unit,
        quantity: item.quantity,
        quantity_basis: item.quantity_basis,
      },
      sourceFileId: storagePath,
      sourceLocation: item.source_location,
      confidence: item.confidence,
      fillTag: 'AI',
    });

    if (item.quantity === null) {
      await ctx.emit(
        'INFO',
        `${item.title} — quantity not stated in the document, left UNKNOWN`,
        { section: item.csi_section },
      );
    }
  }

  for (const skipped of result.skipped) {
    await ctx.emit('INFO', `not drafted as scope: ${skipped}`);
  }

  const withQuantity = result.items.filter((item) => item.quantity !== null).length;

  await ctx.emit(
    'RESULT',
    `${result.items.length} scope items drafted, ${withQuantity} with a stated quantity. ` +
      'Review and lock (H2) before any package is built from them.',
    { drafted: result.items.length, withQuantity, costUsd },
  );
}

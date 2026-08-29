import { z } from 'zod';
import type { AgentContext } from '../lib/agent-run.js';
import { extractStructured } from '../lib/anthropic.js';

/**
 * A1 · Quote Extraction Agent.
 *
 * One quote document in; line items, commercial terms and — most importantly —
 * exclusions out, every one carrying the page it came from.
 *
 * Exclusions are the highest-value extraction in this product. They do not live
 * in the pricing table; they live in appendices, footnotes, "Notes" and
 * "Qualifications" sections, and cover letters. A quote that excludes $80k of
 * scope is $80k more expensive than it looks, and finding that is the entire
 * commercial argument.
 *
 * Everything lands as a draft. This agent has no write path into canonical
 * state — see AgentContext.
 */

export const PROMPT_VERSION = 'extract-quote-1';

const nullableNumber = z.number().nullable();

const LineItem = z.object({
  description: z.string(),
  qty: nullableNumber,
  unit: z.string().nullable(),
  rate: nullableNumber,
  line_total: nullableNumber,
  /** Page and where on it, e.g. "p.3 pricing table". R6: cite or stay silent. */
  source_location: z.string(),
  /** True when several scope items are bundled into one price. */
  is_lumped: z.boolean(),
});

const Exclusion = z.object({
  /** The bidder's own words, verbatim. Never paraphrased. */
  excerpt: z.string(),
  source_location: z.string(),
  /** What the estimator has to go find a price for. */
  what_is_excluded: z.string(),
  confidence: z.number(),
});

const Term = z.object({
  term_key: z.string(),
  term_value: z.string(),
  source_location: z.string(),
});

const Extraction = z.object({
  bidder_name: z.string().nullable(),
  quote_date: z.string().nullable(),
  currency: z.string().nullable(),
  quoted_total: nullableNumber,
  pricing_basis: z.string().nullable(),
  /** 0–1. How much of the document was legible and unambiguous. */
  extraction_confidence: z.number(),
  page_count: z.number().nullable(),
  line_items: z.array(LineItem),
  exclusions: z.array(Exclusion),
  terms: z.array(Term),
  /** Anything that could not be read, rather than a guess at what it said. */
  unreadable: z.array(z.string()),
});

export type QuoteExtraction = z.infer<typeof Extraction>;

const SYSTEM = `You extract subcontractor quotes for a general contractor's preconstruction team.

Two categories, and the second matters more:

1. PRICING — line items with description, quantity, unit, rate and total; section
   subtotals; prelims; overhead and profit; the quoted total; alternates; the
   pricing basis (lump sum, unit rate, T&M, allowance).

2. COMMERCIAL — EXCLUSIONS FIRST AND MOST CAREFULLY, then caveats,
   qualifications, programme, payment terms, design responsibility, insurance,
   warranties, key personnel and assumptions.

EXCLUSIONS ARE THE HIGHEST-VALUE THING IN THIS DOCUMENT. They rarely appear in
the pricing table. Read the appendices, the footnotes, any section headed
"Notes", "Qualifications", "Clarifications" or "Assumptions", and the cover
letter. A phrase like "by others", "not included", "excludes", "assumes provided
by", "no allowance for", "unless otherwise noted" almost always marks one. Quote
the bidder's own words verbatim in excerpt, and say plainly in what_is_excluded
what work the GC would now have to buy elsewhere.

RULES YOU MAY NOT BREAK:

- Never invent a number. If a quantity, rate or total is not stated, it is null.
  A plausible-looking invented figure reaching a client quote is the failure that
  ends this company.
- Never total a partial extraction as if it were complete. If you could not read
  part of the document, list it in unreadable and lower extraction_confidence.
- Every extracted value records where it came from, as a page reference and
  enough context to find it again.
- Do not normalise, map or interpret scope. Report what the document says.`;

export async function runQuoteExtraction(
  ctx: AgentContext,
  payload: Record<string, unknown>,
): Promise<void> {
  const quoteId = String(payload.quoteId ?? '');
  if (!quoteId) throw new Error('extract_quote requires a quoteId');

  const quote = await ctx.read<{
    id: string;
    source_file_id: string | null;
    source_filename: string | null;
    source_size_bytes: number | null;
  }>('quote', quoteId);

  if (!quote?.source_file_id) throw new Error('That quote has no stored document');

  const filename = quote.source_filename ?? 'quote';
  await ctx.emit('INFO', `reading ${filename}`);

  const bytes = await ctx.readFile('quote-documents', quote.source_file_id);
  if (!bytes) throw new Error('Could not download the quote document from storage');

  if (!filename.toLowerCase().endsWith('.pdf')) {
    // XLSX and DOCX need conversion before the model can see them; that is a
    // separate piece of work rather than something to fake here.
    throw new Error(`${filename} is not a PDF. Only PDF extraction is implemented so far.`);
  }

  await ctx.emit('INFO', `${(bytes.length / 1024).toFixed(0)} KB — sending to the model`);

  const { value: result, costUsd, inputTokens, outputTokens } = await extractStructured({
    system: SYSTEM,
    schema: Extraction,
    pdf: bytes,
    instruction:
      'Extract this subcontractor quote. Find every exclusion, including any in ' +
      'the cover letter, notes, qualifications or appendices.',
  });

  await ctx.emit(
    'INFO',
    `extracted ${result.line_items.length} line items, ${result.terms.length} commercial terms`,
    { lineItems: result.line_items.length, terms: result.terms.length },
  );

  // Quote-level fields, as one draft each so a human can accept them piecemeal.
  const quoteFields: [string, unknown][] = [
    ['subcontractor_name', result.bidder_name],
    ['quoted_total', result.quoted_total],
    ['quote_date', result.quote_date],
    ['currency', result.currency],
    ['pricing_basis', result.pricing_basis],
  ];

  for (const [field, value] of quoteFields) {
    if (value === null || value === undefined) continue;
    await ctx.draft({
      targetTable: 'quote',
      targetId: quoteId,
      field,
      value,
      sourceFileId: quote.source_file_id,
      confidence: result.extraction_confidence,
      fillTag: 'AI',
    });
  }

  for (const [index, line] of result.line_items.entries()) {
    await ctx.draft({
      targetTable: 'quote_line',
      field: `line_${index + 1}`,
      value: line,
      sourceFileId: quote.source_file_id,
      sourceLocation: line.source_location,
      confidence: result.extraction_confidence,
      fillTag: 'AI',
    });
  }

  // Exclusions are the findings. They get their own amber line each, because
  // these are the ones an estimator needs to look up at.
  if (result.exclusions.length === 0) {
    await ctx.emit('WARNING', 'no exclusions found — verify this by hand, it is unusual');
  }

  for (const exclusion of result.exclusions) {
    await ctx.emit(
      'WARNING',
      `exclusion ${exclusion.source_location}: "${exclusion.excerpt.slice(0, 140)}"`,
      exclusion,
    );
    await ctx.draft({
      targetTable: 'quote_exclusion',
      field: 'exclusion',
      value: exclusion,
      sourceFileId: quote.source_file_id,
      sourceLocation: exclusion.source_location,
      confidence: exclusion.confidence,
      fillTag: 'AI',
    });
  }

  for (const term of result.terms) {
    await ctx.draft({
      targetTable: 'quote_term',
      field: term.term_key,
      value: term,
      sourceFileId: quote.source_file_id,
      sourceLocation: term.source_location,
      confidence: result.extraction_confidence,
      fillTag: 'AI',
    });
  }

  for (const unreadable of result.unreadable) {
    await ctx.emit('WARNING', `could not read: ${unreadable} — left as UNKNOWN, not guessed`);
  }

  await ctx.emit(
    'RESULT',
    result.quoted_total === null
      ? `no quoted total stated — ${result.exclusions.length} exclusions found`
      : `quoted total ${result.quoted_total.toLocaleString('en-US', {
          style: 'currency',
          currency: result.currency ?? 'USD',
          maximumFractionDigits: 0,
        })} · ${result.exclusions.length} exclusions found`,
    {
      quotedTotal: result.quoted_total,
      exclusions: result.exclusions.length,
      confidence: result.extraction_confidence,
      costUsd,
      inputTokens,
      outputTokens,
    },
  );
}

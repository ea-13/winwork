import { z } from 'zod';
import type { AgentContext, SheetIndexRow } from '../lib/agent-run.js';
import { extractStructured } from '../lib/anthropic.js';
import { SHEET_INDEX_BATCH, pageCount, splitPages } from '../lib/pdf.js';

/**
 * A8 · Sheet-set indexer.
 *
 * Reads a drawing set and writes down what is in it: one row per page, with
 * the sheet number and title off the title block.
 *
 * This exists because of R6. Scope drafted from drawings has to cite where it
 * came from, and "page 47 of Drawings.pdf" is not something an estimator can
 * take to a subcontractor — "A-201, Enlarged Restroom Plans" is. The index is
 * also what makes drafting affordable: with it, drafting division 22 scope
 * reads the twelve plumbing sheets instead of all two hundred.
 *
 * The model is asked for exactly what is printed in the title block, and
 * nothing else. It is not asked what the sheet shows, because a summary of a
 * drawing is a paraphrase, and a paraphrase is not a citation.
 */

export const INDEX_SHEETS_PROMPT_VERSION = 'index-sheets-1';

const Sheet = z.object({
  /** 1-based, within the batch it was read from. Rebased before it is stored. */
  page_in_batch: z.number(),
  /** Exactly as printed. Null if this page has no title block. */
  sheet_number: z.string().nullable(),
  sheet_title: z.string().nullable(),
  /** A, S, M, E, P, C, L, FP, FA. Null if it cannot be told. */
  discipline: z.string().nullable(),
  confidence: z.number(),
});

const Batch = z.object({ sheets: z.array(Sheet) });

const SYSTEM = `You read the title blocks of construction drawings.

For every page you are given, report what is printed in its title block. That
is all. You are building an index so that somebody can find a sheet later.

RULES YOU MAY NOT BREAK:

- REPORT WHAT IS PRINTED. The sheet number is a string like A-201, S1.02,
  M-4.02, E001. Copy it exactly, including punctuation and leading zeros. Do
  not normalise it, do not reformat it, do not correct what looks like a typo.
- If a page has no title block — a cover sheet, a photograph, a blank divider —
  return it with a null sheet number and say so in the title if the page names
  itself.
- The title is the sheet's own name, as printed: "ENLARGED RESTROOM PLANS".
  Do not describe what the drawing shows. Do not summarise it. If the printed
  title is abbreviated, keep the abbreviation.
- Discipline is the single letter or short code the sheet number begins with —
  A architectural, S structural, M mechanical, E electrical, P plumbing,
  C civil, L landscape, FP fire protection, FA fire alarm. If the sheet number
  does not begin with a recognisable code, return null.
- Report EVERY page you were given, in order, including the ones with nothing
  on them. A missing page makes every page number after it wrong.

Confidence is how clearly you could read the title block, not how sure you are
that the drawing is correct.`;

export async function runSheetIndexer(
  ctx: AgentContext,
  payload: Record<string, unknown>,
): Promise<void> {
  const documentId = String(payload.documentId ?? '');
  const storagePath = String(payload.storagePath ?? '');
  const filename = String(payload.filename ?? 'drawing set');

  if (!documentId || !storagePath) {
    throw new Error('index_sheets requires a stored document');
  }

  await ctx.emit('INFO', `reading ${filename}`);

  const bytes = await ctx.readFile('project-documents', storagePath);
  if (!bytes) throw new Error('Could not download that document from storage');

  if (!filename.toLowerCase().endsWith('.pdf')) {
    throw new Error(`${filename} is not a PDF. Drawing sets are indexed from PDF only.`);
  }

  const pages = await pageCount(bytes);
  await ctx.emit('INFO', `${pages} page${pages === 1 ? '' : 's'} — indexing in batches of ${SHEET_INDEX_BATCH}`);

  const batches = await splitPages(bytes, SHEET_INDEX_BATCH);
  const sheets: SheetIndexRow[] = [];
  let cost = 0;

  for (const [index, batch] of batches.entries()) {
    await ctx.emit(
      'INFO',
      `batch ${index + 1} of ${batches.length} — pages ${batch.firstPage}–${batch.lastPage} ` +
        `(${(batch.bytes.length / 1048576).toFixed(1)} MB)`,
    );

    const { value, costUsd } = await extractStructured({
      system: SYSTEM,
      schema: Batch,
      pdf: batch.bytes,
      instruction:
        `Index all ${batch.pages.length} pages of this excerpt. ` +
        'Number them 1, 2, 3 … in the order given, regardless of what the sheets say.',
      maxTokens: 8000,
    });

    cost += costUsd;

    for (const sheet of value.sheets) {
      // Rebase onto the real document by looking the page up in the batch's own
      // list, rather than assuming the batch is a contiguous run. It is today;
      // an oversized batch that gets halved is still contiguous, but arithmetic
      // that quietly depends on that is arithmetic that breaks the first time
      // batching changes, and a wrong page number is a wrong citation.
      const pageNumber = batch.pages[sheet.page_in_batch - 1];
      if (pageNumber === undefined) continue;

      sheets.push({
        pageNumber,
        sheetNumber: sheet.sheet_number,
        sheetTitle: sheet.sheet_title,
        discipline: sheet.discipline,
        confidence: sheet.confidence,
      });
    }
  }

  // One row per page, at most. A duplicate page number would violate the unique
  // index and fail the whole insert, so the first read of a page wins.
  const seen = new Set<number>();
  const unique = sheets.filter((sheet) => {
    if (seen.has(sheet.pageNumber)) return false;
    seen.add(sheet.pageNumber);
    return true;
  });

  const written = await ctx.recordSheets(documentId, unique);

  const identified = unique.filter((sheet) => sheet.sheetNumber !== null).length;
  const disciplines = [...new Set(unique.map((sheet) => sheet.discipline).filter(Boolean))].sort();

  if (identified < pages) {
    await ctx.emit(
      'WARNING',
      `${pages - identified} page(s) had no readable sheet number. They are still indexed by page.`,
    );
  }

  await ctx.emit(
    'RESULT',
    `${written} sheets indexed, ${identified} with a sheet number. ` +
      `Disciplines found: ${disciplines.join(', ') || 'none identified'}.`,
    { written, identified, disciplines, costUsd: cost },
  );
}

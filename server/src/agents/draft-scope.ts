import { z } from 'zod';
import type { AgentContext } from '../lib/agent-run.js';
import { extractStructured } from '../lib/anthropic.js';
import {
  DRAWING_DRAFT_BATCH,
  SCOPE_BATCH,
  extractPageGroups,
  pageCount,
  splitPages,
} from '../lib/pdf.js';

/**
 * A7 · Scope of Work Drafter.
 *
 * Reads the bid set — specifications and drawings both — and drafts scope_item
 * rows organised by CSI division and section. Every item carries the document
 * and the place in it that it came from.
 *
 * Quantities are drafted ONLY where the document states them. Never inferred
 * from an area, never scaled off a drawing, never estimated, never carried
 * across from a similar project. An unstated quantity is UNKNOWN, and an
 * estimator would rather see a blank than a number they have to disprove.
 *
 * Specs and drawings are read differently on purpose:
 *
 *   - A specification says what the work must be. It is read in page batches,
 *     start to finish, and cited by page.
 *   - A drawing says what and how much there is. It is read by SHEET, chosen
 *     from the sheet index by discipline, and cited by sheet number — because
 *     "A-201" is a reference a sub can act on and "page 47" is not (R6).
 *
 * The two disagree constantly, and where they do that disagreement is the most
 * valuable thing on the page. It is drafted as scope with the conflict stated,
 * not silently resolved.
 */

export const DRAFT_SCOPE_PROMPT_VERSION = 'draft-scope-2';

/**
 * Which drawing disciplines carry which CSI divisions.
 *
 * Used only to narrow what gets read when the estimator asked for specific
 * divisions. Deliberately generous — a division listed against two disciplines
 * reads both, because missing a sheet costs more than reading a spare one.
 */
const DISCIPLINE_BY_DIVISION: Record<string, string[]> = {
  '02': ['C', 'A'],
  '03': ['S', 'A'],
  '04': ['S', 'A'],
  '05': ['S', 'A'],
  '06': ['A', 'S'],
  '07': ['A'],
  '08': ['A'],
  '09': ['A'],
  '10': ['A'],
  '11': ['A'],
  '12': ['A'],
  '13': ['A', 'S'],
  '14': ['A', 'S'],
  '21': ['FP'],
  '22': ['P'],
  '23': ['M'],
  '25': ['E', 'M'],
  '26': ['E'],
  '27': ['E'],
  '28': ['E', 'FA'],
  '31': ['C', 'S'],
  '32': ['C', 'L'],
  '33': ['C'],
};

const Item = z.object({
  csi_division: z.string(),
  csi_section: z.string().nullable(),
  title: z.string(),
  description: z.string(),
  unit: z.string().nullable(),
  /** Only when the document states it. Null otherwise — always. */
  quantity: z.number().nullable(),
  quantity_basis: z.string().nullable(),
  /** Page number for a spec, sheet number for a drawing. As given. */
  source_location: z.string(),
  confidence: z.number(),
});

const Draft = z.object({
  items: z.array(Item),
  /** Sections read but deliberately not turned into scope, and why. */
  skipped: z.array(z.string()),
});

const COMMON_RULES = `RULES YOU MAY NOT BREAK:

- QUANTITIES ONLY WHERE STATED. If the document does not give a quantity, set it
  to null. Do not infer one from an area, a room count, a drawing scale or
  anything else. An unstated quantity is UNKNOWN, and inventing one puts a
  number into a bid comparison that nobody can defend.
- Every item cites where it came from, in the form the instruction asks for.
- Do not restate the whole document. Draft what a sub would bid, not what an
  architect drew or wrote — general conditions, submittal procedures and
  warranty boilerplate are not scope items.
- If a passage is ambiguous about who carries the work, draft it and say so in
  the description. Ambiguity that reaches an estimator is useful; ambiguity you
  resolve silently is not.`;

const SPEC_SYSTEM = `You draft a general contractor's scope of work from
specification and scope-narrative documents.

Produce discrete, biddable scope items organised by CSI division and section.
One item is one thing a subcontractor would price as a line.

${COMMON_RULES}

Cite as the page number you were told this excerpt starts at, plus the section
or paragraph: "p. 214, §09 21 16 2.3".`;

const DRAWING_SYSTEM = `You draft a general contractor's scope of work from
construction drawings.

Produce discrete, biddable scope items organised by CSI division and section.
One item is one thing a subcontractor would price as a line.

${COMMON_RULES}

READING DRAWINGS SPECIFICALLY:

- A schedule on a drawing — door schedule, fixture schedule, finish schedule —
  is a stated quantity. Count it and say you counted it. That is reading, not
  inferring, and it is the most valuable thing on a drawing set.
- A dimension printed on the drawing is stated. A dimension you would get by
  measuring, scaling, or multiplying two printed numbers together is NOT, and
  must be left null. Scaling a drawing is exactly the error this rule exists to
  prevent.
- General notes and keynotes carry scope that appears nowhere else. Read them.
- Where a drawing contradicts what a specification would normally require, draft
  the item and state the conflict in the description. Do not pick a winner.

Cite as the SHEET NUMBER, exactly as given to you in the sheet list, plus the
detail or note reference: "A-201, keynote 4" or "M-4.02, equipment schedule".
Never cite a page number for a drawing.`;

type DocumentInput = {
  id: string;
  storagePath: string;
  filename: string;
  kind: string;
  sheets?: { pageNumber: number; sheetNumber: string | null; sheetTitle: string | null; discipline: string | null }[];
};

type Drafted = z.infer<typeof Item> & { sourceFileId: string; sourceFilename: string };

/**
 * Runs batches concurrently, keeping at most `limit` in flight.
 *
 * The first version read the sheets one after another, which on a 25-sheet set
 * is thirteen streaming calls of two-and-a-half minutes each and half an hour
 * of staring at a progress line. The work is entirely independent — one batch
 * of drawings tells you nothing about another — so serialising it bought
 * nothing at all.
 *
 * Four at a time rather than all of them: the model API rate-limits, and a
 * burst of thirteen large multimodal requests is the shape that gets throttled
 * and then retried, which is slower than not bursting.
 */
async function inParallel<T, R>(
  items: T[],
  limit: number,
  work: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      results[index] = await work(items[index] as T, index);
    }
  };

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}

/** How many model calls are in flight at once when reading a drawing set. */
const BATCH_CONCURRENCY = 4;



/** Which sheets are worth reading for the divisions asked for. */
function sheetsForDivisions(
  sheets: NonNullable<DocumentInput['sheets']>,
  divisions: string[],
): NonNullable<DocumentInput['sheets']> {
  if (divisions.length === 0) return sheets;

  const wanted = new Set(divisions.flatMap((division) => DISCIPLINE_BY_DIVISION[division] ?? []));
  if (wanted.size === 0) return sheets;

  const matched = sheets.filter((sheet) => sheet.discipline && wanted.has(sheet.discipline));

  // A sheet set whose disciplines we could not read is not a sheet set to
  // silently skip. Read all of it rather than drafting nothing.
  return matched.length === 0 ? sheets : matched;
}

export async function runScopeDrafter(
  ctx: AgentContext,
  payload: Record<string, unknown>,
): Promise<void> {
  const bidId = String(payload.bidId ?? '');
  const divisions = (payload.divisions ?? []) as string[];
  const documents = (payload.documents ?? []) as DocumentInput[];

  if (documents.length === 0) {
    throw new Error('draft_scope requires at least one document to read');
  }

  await ctx.emit(
    'INFO',
    `reading ${documents.length} document${documents.length === 1 ? '' : 's'}` +
      (divisions.length > 0 ? ` for division${divisions.length === 1 ? '' : 's'} ${divisions.join(', ')}` : ''),
  );

  const drafted: Drafted[] = [];
  const skipped: string[] = [];
  let cost = 0;

  for (const document of documents) {
    if (!document.filename.toLowerCase().endsWith('.pdf')) {
      await ctx.emit('WARNING', `${document.filename} is not a PDF — skipped`);
      continue;
    }

    const bytes = await ctx.readFile('project-documents', document.storagePath);
    if (!bytes) {
      await ctx.emit('WARNING', `${document.filename} could not be downloaded — skipped`);
      continue;
    }

    const isDrawing = document.kind === 'DRAWING';
    const pages = await pageCount(bytes);

    if (isDrawing) {
      cost += await draftFromDrawing(ctx, document, bytes, pages, divisions, drafted, skipped);
    } else {
      cost += await draftFromSpec(ctx, document, bytes, pages, divisions, drafted, skipped);
    }
  }

  // The same scope routinely appears in both the spec and the drawings. Merge
  // rather than drafting it twice: two identical items in a bid comparison is
  // a double count waiting to happen, and the two citations together are
  // strictly better evidence than either alone.
  const merged = new Map<string, Drafted>();

  for (const item of drafted) {
    const key = `${item.csi_division}|${item.title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()}`;
    const existing = merged.get(key);

    if (!existing) {
      merged.set(key, item);
      continue;
    }

    existing.source_location = `${existing.source_location}; ${item.sourceFilename}: ${item.source_location}`;
    // A quantity found in one document and not the other is still a stated
    // quantity. Prefer the one that has it; never average two.
    if (existing.quantity === null && item.quantity !== null) {
      existing.quantity = item.quantity;
      existing.unit = item.unit;
      existing.quantity_basis = item.quantity_basis;
    }
    existing.confidence = Math.max(existing.confidence, item.confidence);
  }

  const items = [...merged.values()].sort(
    (a, b) => a.csi_division.localeCompare(b.csi_division) || a.title.localeCompare(b.title),
  );

  if (drafted.length > items.length) {
    await ctx.emit(
      'INFO',
      `${drafted.length - items.length} item(s) appeared in more than one document and were merged`,
    );
  }

  // Sequence within division, mirroring how scope_id is generated elsewhere.
  const perDivision = new Map<string, number>();

  for (const item of items) {
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
      sourceFileId: item.sourceFileId,
      sourceLocation: `${item.sourceFilename}: ${item.source_location}`,
      confidence: item.confidence,
      fillTag: 'AI',
    });
  }

  for (const note of skipped) {
    await ctx.emit('INFO', `not drafted as scope: ${note}`);
  }

  const withQuantity = items.filter((item) => item.quantity !== null).length;

  await ctx.emit(
    'RESULT',
    `${items.length} scope items drafted from ${documents.length} document(s), ` +
      `${withQuantity} with a stated quantity. ` +
      'Review and lock (H2) before any package is built from them.',
    { drafted: items.length, withQuantity, costUsd: cost },
  );
}

/** A specification, read start to finish in page batches. */
async function draftFromSpec(
  ctx: AgentContext,
  document: DocumentInput,
  bytes: Buffer,
  pages: number,
  divisions: string[],
  drafted: Drafted[],
  skipped: string[],
): Promise<number> {
  // Always through the splitter, even for a short document. A forty-page
  // scanned addendum is well inside the page ceiling and nowhere near inside
  // the byte one, and the shortcut that skipped this only looked safe because
  // the first documents tested were text.
  const batches = await splitPages(bytes, SCOPE_BATCH);

  await ctx.emit(
    'INFO',
    `${document.filename} — ${pages} page${pages === 1 ? '' : 's'}` +
      (batches.length > 1 ? ` in ${batches.length} batches` : ''),
  );

  let cost = 0;

  const costs = await inParallel(batches, BATCH_CONCURRENCY, async (batch, index) => {
    if (batches.length > 1) {
      await ctx.emit(
        'INFO',
        `${document.filename} — batch ${index + 1} of ${batches.length}, pages ${batch.firstPage}–${batch.lastPage}`,
      );
    }

    try {
      const { value, costUsd } = await extractStructured({
        system: SPEC_SYSTEM,
        schema: Draft,
        pdf: batch.bytes,
        instruction:
          `Draft scope items from this excerpt. It begins at page ${batch.firstPage} of the ` +
          `full document, so cite pages from ${batch.firstPage} onwards.` +
          (divisions.length > 0 ? ` Limit to CSI divisions ${divisions.join(', ')}.` : ''),
        maxTokens: 48000,
        effort: 'low',
      });

      for (const item of value.items) {
        drafted.push({ ...item, sourceFileId: document.id, sourceFilename: document.filename });
      }
      skipped.push(...value.skipped.map((note) => `${document.filename}: ${note}`));
      ctx.spent(costUsd);
      return costUsd;
    } catch (caught) {
      await ctx.emit(
        'WARNING',
        `${document.filename} — could not read pages ${batch.firstPage}–${batch.lastPage}: ` +
          `${caught instanceof Error ? caught.message : String(caught)}. ` +
          'The rest of the document was still read.',
      );
      return 0;
    }
  });

  cost += costs.reduce((total, value) => total + value, 0);

  return cost;
}

/**
 * A drawing set, read by sheet.
 *
 * Without a sheet index there is nothing to cite, so an unindexed set is read
 * whole and cited by page — with a warning, because those citations are worse.
 */
async function draftFromDrawing(
  ctx: AgentContext,
  document: DocumentInput,
  bytes: Buffer,
  pages: number,
  divisions: string[],
  drafted: Drafted[],
  skipped: string[],
): Promise<number> {
  const sheets = document.sheets ?? [];

  if (sheets.length === 0) {
    await ctx.emit(
      'WARNING',
      `${document.filename} has no sheet index — reading it by page. ` +
        'Index the set first and the citations become sheet numbers a sub can act on.',
    );
    return draftFromSpec(ctx, document, bytes, pages, divisions, drafted, skipped);
  }

  const relevant = sheetsForDivisions(sheets, divisions);

  await ctx.emit(
    'INFO',
    `${document.filename} — ${relevant.length} of ${sheets.length} sheets selected` +
      (divisions.length > 0 ? ` for divisions ${divisions.join(', ')}` : ''),
  );

  let cost = 0;

  // The selected sheets are scattered through the set, so they are pulled into
  // their own document: reading 12 plumbing sheets is both cheaper and better
  // than reading the 180 pages they sit inside. The splitter owns the page AND
  // byte ceilings, because scanned large-format sheets blow the byte one long
  // before they come near the page one.
  const byPage = new Map(relevant.map((sheet) => [sheet.pageNumber, sheet]));
  const groups = await extractPageGroups(
    bytes,
    relevant.map((sheet) => sheet.pageNumber),
    DRAWING_DRAFT_BATCH,
  );

  // Four at a time. The batches are independent, so the only thing serialising
  // them ever bought was a tidier activity stream.
  const costs = await inParallel(groups, BATCH_CONCURRENCY, async (group) => {
    const inGroup = group.pages
      .map((page) => byPage.get(page))
      .filter(Boolean) as NonNullable<DocumentInput['sheets']>;

    const manifest = inGroup
      .map(
        (sheet, index) =>
          `  ${index + 1}. ${sheet.sheetNumber ?? `(unnumbered, page ${sheet.pageNumber})`}` +
          (sheet.sheetTitle ? ` — ${sheet.sheetTitle}` : ''),
      )
      .join('\n');

    const label =
      `${inGroup[0]?.sheetNumber ?? '?'}` +
      (inGroup.length > 1 ? ` through ${inGroup[inGroup.length - 1]?.sheetNumber ?? '?'}` : '');

    await ctx.emit(
      'INFO',
      `${document.filename} — reading ${inGroup.length} sheet(s): ${label} ` +
        `(${(group.bytes.length / 1048576).toFixed(1)} MB)`,
    );

    try {
      const { value, costUsd } = await extractStructured({
        system: DRAWING_SYSTEM,
        schema: Draft,
        pdf: group.bytes,
        instruction:
          'Draft scope items from these drawings. The pages you have been given are, in order:\n' +
          `${manifest}\n\n` +
          'Cite the sheet number from that list, never a page number.' +
          (divisions.length > 0 ? ` Limit to CSI divisions ${divisions.join(', ')}.` : ''),
        maxTokens: 48000,
        // Reading is the easy part here; writing it all down is the long part,
        // and the two share one budget.
        effort: 'low',
      });

      for (const item of value.items) {
        drafted.push({ ...item, sourceFileId: document.id, sourceFilename: document.filename });
      }
      skipped.push(...value.skipped.map((note) => `${document.filename}: ${note}`));
      ctx.spent(costUsd);
      return costUsd;
    } catch (caught) {
      // One batch failing must not lose the others. A run over a 25-sheet set is
      // thirteen requests and several minutes of billed work; throwing on the
      // twelfth threw away eleven good batches and charged for them.
      await ctx.emit(
        'WARNING',
        `${document.filename} — could not read ${label}: ` +
          `${caught instanceof Error ? caught.message : String(caught)}. ` +
          'No scope was drafted from those sheets; the rest of the set was still read.',
        { sheets: label },
      );
      return 0;
    }
  });

  cost += costs.reduce((total, value) => total + value, 0);

  return cost;
}

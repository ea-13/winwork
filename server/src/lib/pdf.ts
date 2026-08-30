import { PDFDocument } from 'pdf-lib';

/**
 * Page-level handling for documents too big to send whole.
 *
 * A specification is forty pages of text and fits in one request. A stamped
 * plan set is twenty-five scanned sheets at two and a half megabytes each, and
 * does not — not because of the page count, but because of the bytes.
 *
 * Both ceilings are real and they bind in different places:
 *
 *   - the model accepts at most 100 pages in one document
 *   - the whole request must fit in 32MB, and the PDF is base64 encoded on the
 *     way there, which costs a third again on top of its real size
 *
 * Batching on page count alone is the mistake that looks fine on a text spec
 * and fails on the first real drawing set. So batches are capped by both, and
 * every result carries the true page number in the original file — a citation
 * that says "page 12 of batch 3" is not one anybody can follow (R6).
 */

/** The model's own page ceiling is 100; smaller batches get better answers. */
export const SHEET_INDEX_BATCH = 20;
export const SCOPE_BATCH = 25;

/**
 * Sheets per request when DRAFTING from drawings.
 *
 * Far smaller than the indexing batch, and the reason is output, not input.
 * Indexing a sheet produces one short row. Drafting from one produces every
 * biddable item on it — seven architectural sheets overran a 16,000 token
 * budget mid-structure and the whole batch was lost.
 *
 * Two, because four still overran a 32,000 token budget on a real stamped set
 * — adaptive thinking takes its share of that budget before any answer is
 * written. The cost of being wrong in this direction is one extra request; the
 * cost of being wrong in the other is a truncated answer that cannot be parsed
 * at all, which loses the whole batch.
 */
export const DRAWING_DRAFT_BATCH = 2;

/**
 * Binary bytes allowed in one request, before base64.
 *
 * The API limit is 32MB on the encoded payload. Base64 inflates by 4/3, and the
 * prompt and schema also have to fit, so the usable binary budget is nearer
 * 22MB. 20MB leaves room to be wrong about the overhead without failing a job
 * that has already spent money on earlier batches.
 */
export const MAX_DOCUMENT_BYTES = 20 * 1024 * 1024;

export type PageBatch = {
  /** 1-based, inclusive, in the ORIGINAL document. What a human calls the page. */
  firstPage: number;
  lastPage: number;
  /** Every original page number in this batch, in order. */
  pages: number[];
  bytes: Buffer;
};

export async function pageCount(pdf: Buffer): Promise<number> {
  const document = await PDFDocument.load(pdf, { ignoreEncryption: true });
  return document.getPageCount();
}

/** Copies an arbitrary set of 1-based page numbers into a new PDF. */
async function build(source: PDFDocument, pages: number[]): Promise<Buffer> {
  const slice = await PDFDocument.create();
  const copied = await slice.copyPages(
    source,
    pages.map((page) => page - 1),
  );
  for (const page of copied) slice.addPage(page);
  return Buffer.from(await slice.save());
}

/**
 * Splits a list of pages into batches that fit both ceilings.
 *
 * The page budget is estimated from the average page size first, which gets it
 * right in one pass for the overwhelmingly common case of a set whose sheets
 * are all much the same size. Anything still over budget is halved until it
 * fits — that handles the set with one enormous site plan in it without making
 * every other batch pay for it.
 */
async function batch(
  source: PDFDocument,
  pages: number[],
  maxPages: number,
  maxBytes: number,
  averagePageBytes: number,
): Promise<PageBatch[]> {
  const byEstimate = Math.max(1, Math.floor(maxBytes / Math.max(averagePageBytes, 1)));
  const size = Math.max(1, Math.min(maxPages, byEstimate));

  const batches: PageBatch[] = [];

  for (let start = 0; start < pages.length; start += size) {
    const group = pages.slice(start, start + size);
    const queue: number[][] = [group];

    while (queue.length > 0) {
      const candidate = queue.shift();
      if (!candidate || candidate.length === 0) continue;

      const bytes = await build(source, candidate);

      // A single page over budget is sent anyway. Dropping it silently would
      // lose a sheet from the index, and a set with a hole in it is worse than
      // one request that fails loudly.
      if (bytes.length <= maxBytes || candidate.length === 1) {
        batches.push({
          firstPage: candidate[0] as number,
          lastPage: candidate[candidate.length - 1] as number,
          pages: candidate,
          bytes,
        });
        continue;
      }

      const middle = Math.ceil(candidate.length / 2);
      queue.unshift(candidate.slice(0, middle), candidate.slice(middle));
    }
  }

  return batches.sort((a, b) => a.firstPage - b.firstPage);
}

/**
 * Splits a whole PDF into consecutive batches.
 *
 * Loads the source once and copies pages out of it rather than re-parsing per
 * batch: a 300MB plan set parsed twelve times is the difference between a job
 * that finishes and one that gets killed.
 */
export async function splitPages(
  pdf: Buffer,
  maxPages: number,
  maxBytes: number = MAX_DOCUMENT_BYTES,
): Promise<PageBatch[]> {
  const source = await PDFDocument.load(pdf, { ignoreEncryption: true });
  const total = source.getPageCount();
  if (total === 0) return [];

  const pages = Array.from({ length: total }, (_, index) => index + 1);
  return batch(source, pages, maxPages, maxBytes, pdf.length / total);
}

/**
 * Pulls a chosen set of pages out, batched to fit.
 *
 * Used once a sheet index exists: rather than reading every drawing again to
 * draft division 22 scope, read the twelve plumbing sheets. Page numbers are
 * 1-based, and anything outside the document is dropped rather than throwing —
 * an index row pointing at a page that no longer exists should not fail a run.
 */
export async function extractPageGroups(
  pdf: Buffer,
  pageNumbers: number[],
  maxPages: number,
  maxBytes: number = MAX_DOCUMENT_BYTES,
): Promise<PageBatch[]> {
  const source = await PDFDocument.load(pdf, { ignoreEncryption: true });
  const total = source.getPageCount();
  if (total === 0) return [];

  const wanted = [...new Set(pageNumbers)]
    .filter((page) => page >= 1 && page <= total)
    .sort((a, b) => a - b);

  if (wanted.length === 0) return [];

  return batch(source, wanted, maxPages, maxBytes, pdf.length / total);
}

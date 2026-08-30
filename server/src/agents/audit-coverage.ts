import { z } from 'zod';
import type { AgentContext } from '../lib/agent-run.js';
import { extractStructured } from '../lib/anthropic.js';
import { DRAWING_DRAFT_BATCH, SCOPE_BATCH, extractPageGroups, splitPages } from '../lib/pdf.js';

/**
 * A10 · Scope coverage auditor.
 *
 * Drafting answers "what is in these documents". This answers the harder and
 * more valuable question: "what is in these documents that my scope does NOT
 * cover".
 *
 * They are not the same pass and cannot be. A drafter reads a document and
 * writes down what it says; it has no idea what you already have, and it will
 * happily produce forty items that duplicate your baseline while missing the
 * one thing nobody captured. This reads the documents WITH the current scope
 * list in hand and is asked only for the difference.
 *
 * It writes findings, never scope. An auditor that silently adds items is a
 * drafter with extra steps, and the entire value here is that a human looks at
 * a short list of "you did not cover this" and decides.
 */

export const AUDIT_COVERAGE_PROMPT_VERSION = 'audit-coverage-1';

const Finding = z.object({
  csi_division: z.string(),
  title: z.string(),
  /** What the document says, and why it is not covered by what exists. */
  description: z.string(),
  source_location: z.string(),
  /** HIGH when it is biddable work nobody could price from the current scope. */
  severity: z.enum(['HIGH', 'MEDIUM', 'LOW']),
  confidence: z.number(),
});

const Audit = z.object({
  findings: z.array(Finding),
  /** Explicitly confirmed as already covered, so the reader can trust the pass. */
  confirmed_covered: z.array(z.string()),
});

const SYSTEM = `You audit a general contractor's scope of work against the
documents it was drafted from, and report ONLY what is missing.

You are given the current scope items and an excerpt of the bid set. Your job is
the difference between them.

RULES YOU MAY NOT BREAK:

- REPORT ONLY WHAT IS NOT COVERED. If an existing scope item covers it, even
  loosely, even under a different name, it is covered. Say so in
  confirmed_covered and move on. A list padded with things already on the
  baseline is a list an estimator stops reading, and then the one real finding
  in it is lost.
- BIDDABLE WORK ONLY. General conditions, submittal procedures, warranty
  boilerplate and the architect's instructions to himself are not scope items
  and are not findings.
- CITE. Every finding says where in the document it came from — sheet number for
  a drawing, page for a specification. A finding nobody can go and check is a
  finding nobody will act on.
- NO QUANTITIES. You are reporting an absence, not pricing it.
- SEVERITY IS ABOUT MONEY AND SURPRISE. HIGH means real biddable work that no
  subcontractor could have priced from the current scope, so it becomes the
  GC's cost. LOW means a detail worth noting. Do not mark everything HIGH; a
  list where everything is urgent is a list where nothing is.
- FEWER, BETTER. Five findings an estimator acts on beat thirty they skim.`;

type DocumentInput = {
  id: string;
  storagePath: string;
  filename: string;
  kind: string;
  sheets?: { pageNumber: number; sheetNumber: string | null; sheetTitle: string | null }[];
};

type ScopeLine = { scopeId: string; division: string | null; title: string };

export async function runCoverageAuditor(
  ctx: AgentContext,
  payload: Record<string, unknown>,
): Promise<void> {
  const documents = (payload.documents ?? []) as DocumentInput[];
  const scope = (payload.scope ?? []) as ScopeLine[];

  if (documents.length === 0) throw new Error('audit_coverage requires documents to read');
  if (scope.length === 0) {
    throw new Error(
      'There is no scope to audit yet. Draft the scope of work first — an audit against nothing ' +
        'would just be a second draft.',
    );
  }

  await ctx.emit(
    'INFO',
    `auditing ${scope.length} scope items against ${documents.length} document(s)`,
  );

  // The whole baseline goes into every request. It is short compared to a set of
  // drawings, and an auditor that only sees part of the scope will report things
  // as missing that are sitting in the part it was not shown.
  const baseline = scope
    .map((item) => `  ${item.scopeId} [div ${item.division ?? '?'}] ${item.title}`)
    .join('\n');

  let total = 0;
  let cost = 0;

  for (const document of documents) {
    if (!document.filename.toLowerCase().endsWith('.pdf')) continue;

    const bytes = await ctx.readFile('project-documents', document.storagePath);
    if (!bytes) {
      await ctx.emit('WARNING', `${document.filename} could not be downloaded — skipped`);
      continue;
    }

    const isDrawing = document.kind === 'DRAWING';
    const sheets = document.sheets ?? [];

    const batches =
      isDrawing && sheets.length > 0
        ? await extractPageGroups(
            bytes,
            sheets.map((sheet) => sheet.pageNumber),
            DRAWING_DRAFT_BATCH,
          )
        : await splitPages(bytes, SCOPE_BATCH);

    await ctx.emit('INFO', `${document.filename} — ${batches.length} batch(es)`);

    for (const batch of batches) {
      const where = isDrawing
        ? batch.pages
            .map((page) => sheets.find((sheet) => sheet.pageNumber === page)?.sheetNumber ?? `p.${page}`)
            .join(', ')
        : `pages ${batch.firstPage}–${batch.lastPage}`;

      try {
        const { value, costUsd } = await extractStructured({
          system: SYSTEM,
          schema: Audit,
          pdf: batch.bytes,
          instruction: [
            'THE CURRENT SCOPE OF WORK:',
            baseline,
            '',
            `THIS EXCERPT: ${where} of ${document.filename}.`,
            isDrawing
              ? 'Cite sheet numbers from that list.'
              : `Cite pages, starting from ${batch.firstPage}.`,
            '',
            'Report only what this excerpt requires that the scope above does not cover.',
          ].join('\n'),
          maxTokens: 32000,
          effort: 'low',
        });

        cost += costUsd;

        for (const finding of value.findings) {
          total += 1;

          // A finding is evidence, not a proposal to be promoted into scope.
          // It goes into the activity stream where a human reads it and
          // decides — writing it as a draft would make "accept all" add scope
          // nobody looked at, which is the opposite of the point.
          await ctx.emit(
            finding.severity === 'HIGH' ? 'WARNING' : 'INFO',
            `[${finding.severity}] div ${finding.csi_division} — ${finding.title}: ` +
              `${finding.description} (${document.filename}: ${finding.source_location})`,
            {
              division: finding.csi_division,
              title: finding.title,
              severity: finding.severity,
              sourceLocation: finding.source_location,
              confidence: finding.confidence,
            },
          );
        }
      } catch (caught) {
        await ctx.emit(
          'WARNING',
          `${document.filename} — could not audit ${where}: ` +
            `${caught instanceof Error ? caught.message : String(caught)}. The rest was still read.`,
        );
      }
    }
  }

  await ctx.emit(
    'RESULT',
    total === 0
      ? 'Nothing found in these documents that the scope does not already cover. That is a real ' +
          'result, not an empty one — it means the baseline holds against what was read.'
      : `${total} thing(s) in the documents that no scope item covers. Each one is either scope ` +
          'to add or a deliberate exclusion to write down; both are better than finding it after buyout.',
    { findings: total, costUsd: cost },
  );
}

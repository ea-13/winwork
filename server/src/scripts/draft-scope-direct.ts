/**
 * Runs the scope drafter directly, outside the job queue.
 *
 * Diagnostic: the queued path was failing with an error string that exists
 * nowhere in the source, so this proves whether the AGENT works and isolates
 * the fault to the worker.
 */
import type { AgentContext, DraftInput, SheetIndexRow } from '../lib/agent-run.js';
import { runScopeDrafter } from '../agents/draft-scope.js';
import { supabaseAdmin } from '../lib/supabase.js';

const [{ data: job }] = [
  await supabaseAdmin
    .from('job')
    .select('payload')
    .eq('job_type', 'draft_scope')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle(),
];

if (!job?.payload) {
  console.error('no draft_scope job payload to replay');
  process.exit(1);
}

const drafts: DraftInput[] = [];

const ctx: AgentContext = {
  runId: 'direct',
  tenantId: String((job.payload as Record<string, unknown>).tenantId ?? ''),
  async emit(type, message) {
    console.log(`   [${type}] ${message}`);
  },
  async draft(input) {
    drafts.push(input);
  },
  async read() {
    return null;
  },
  async readFile(bucket, path) {
    const { data, error } = await supabaseAdmin.storage.from(bucket).download(path);
    if (error || !data) return null;
    return Buffer.from(await data.arrayBuffer());
  },
  async recordSheets(_documentId: string, sheets: SheetIndexRow[]) {
    return sheets.length;
  },
};

try {
  await runScopeDrafter(ctx, job.payload as Record<string, unknown>);
  console.log(`\nDIRECT RUN OK — ${drafts.length} drafts produced\n`);
  for (const draft of drafts.slice(0, 60)) {
    const v = draft.value as Record<string, unknown>;
    console.log(`div ${v.csi_division}  ${v.title}`);
    console.log(`    qty ${v.quantity ?? '—'} ${v.unit ?? ''}   cite: ${draft.sourceLocation}`);
  }
} catch (caught) {
  console.error('\nDIRECT RUN FAILED:', caught instanceof Error ? caught.message : caught);
  process.exitCode = 1;
}

import type { AgentContext } from './agent-run.js';
import { AgentRun } from './agent-run.js';
import { runDemoStream } from '../agents/demo-stream.js';
import { runQuoteExtraction } from '../agents/extract-quote.js';
import { runChangeOrderArchaeology } from '../agents/co-archaeologist.js';
import { runDivisionConsult } from '../agents/division-consult.js';
import { runScopeDrafter } from '../agents/draft-scope.js';
import { runSheetIndexer } from '../agents/index-sheets.js';
import { runScopeContextDrafter } from '../agents/scope-context.js';
import { runCoverageAuditor } from '../agents/audit-coverage.js';
import { runBidComparison } from '../agents/compare-bids.js';
import { runCostCodeMapper } from '../agents/map-cost-codes.js';
import { runNormalisation } from '../agents/normalise-quote.js';
import { supabaseAdmin } from './supabase.js';

/**
 * An agent receives a context and a payload. It gets no database handle, so the
 * only writes available to it are emit() and draft() — the R2 split is enforced
 * by what this signature does not offer.
 */
type Agent = (ctx: AgentContext, payload: Record<string, unknown>) => Promise<void>;

const AGENTS: Record<string, Agent> = {
  demo_stream: (ctx) => runDemoStream(ctx),
  extract_quote: (ctx, payload) => runQuoteExtraction(ctx, payload),
  normalise_quote: (ctx, payload) => runNormalisation(ctx, payload),
  division_consult: (ctx, payload) => runDivisionConsult(ctx, payload),
  draft_scope: (ctx, payload) => runScopeDrafter(ctx, payload),
  index_sheets: (ctx, payload) => runSheetIndexer(ctx, payload),
  draft_scope_context: (ctx, payload) => runScopeContextDrafter(ctx, payload),
  audit_coverage: (ctx, payload) => runCoverageAuditor(ctx, payload),
  compare_bids: (ctx, payload) => runBidComparison(ctx, payload),
  map_cost_codes: (ctx, payload) => runCostCodeMapper(ctx, payload),
  co_archaeology: (ctx, payload) => runChangeOrderArchaeology(ctx, payload),
};

/**
 * Status bookkeeping on the row an agent is working from.
 *
 * The worker does this, not the agent: quote.status is system state with a [S]
 * fill tag, and giving AgentContext a way to write it would put a hole in the
 * guarantee that agents cannot touch canonical rows.
 */
async function setQuoteStatus(job: JobRow, status: string): Promise<void> {
  const quoteId = job.payload?.quoteId;
  if (job.job_type !== 'extract_quote' || typeof quoteId !== 'string') return;
  await supabaseAdmin.from('quote').update({ status }).eq('id', quoteId);
}

type JobRow = {
  id: string;
  tenant_id: string;
  job_type: string;
  payload: Record<string, unknown>;
  attempts: number;
  max_attempts: number;
  agent_run_id: string | null;
};

const POLL_INTERVAL_MS = 1_000;
const LEASE_SECONDS = 300;

let running = false;
let timer: NodeJS.Timeout | null = null;

async function finish(
  job: JobRow,
  status: 'DONE' | 'FAILED' | 'DEAD_LETTER' | 'QUEUED',
  lastError?: string,
): Promise<void> {
  await supabaseAdmin
    .from('job')
    .update({
      status,
      last_error: lastError ?? null,
      lease_expires_at: null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', job.id);
}

async function runOne(): Promise<boolean> {
  const { data, error } = await supabaseAdmin.rpc('claim_job', { lease_seconds: LEASE_SECONDS });

  if (error) {
    console.error(`worker: could not claim a job — ${error.message}`);
    return false;
  }

  const job = data as JobRow | null;
  if (!job || !job.id) return false;

  const agent = AGENTS[job.job_type];
  if (!agent) {
    await finish(job, 'DEAD_LETTER', `No agent registered for job type "${job.job_type}"`);
    return true;
  }

  let run: AgentRun | null = null;
  try {
    run = job.agent_run_id
      ? await AgentRun.resume(job.agent_run_id, job.tenant_id)
      : await AgentRun.start({ tenantId: job.tenant_id, agentType: job.job_type });

    await setQuoteStatus(job, 'EXTRACTING');
    await agent(run, job.payload ?? {});
    await run.finish('DONE');
    await setQuoteStatus(job, 'EXTRACTED');
    await finish(job, 'DONE');
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : String(caught);

    // Retries are bounded. A job that keeps failing is dead-lettered rather
    // than looped on forever, so a broken agent cannot burn the queue or the
    // API budget.
    const exhausted = job.attempts >= job.max_attempts;
    if (run) {
      await run.emit('ERROR', message).catch(() => undefined);
      if (exhausted) await run.finish('FAILED').catch(() => undefined);
    }
    if (exhausted) await setQuoteStatus(job, 'FAILED').catch(() => undefined);
    // Back to QUEUED so claim_job picks it up again, until the attempt budget
    // is spent — attempts was already incremented by the claim.
    await finish(job, exhausted ? 'DEAD_LETTER' : 'QUEUED', message);
    console.error(`worker: job ${job.id} failed (attempt ${job.attempts}) — ${message}`);
  }
  return true;
}

/**
 * Polls for work. setInterval is deliberate at this stage: a long agent run
 * must not sit behind an HTTP handler, and a poll loop is the least machinery
 * that achieves it. Swap for a queue when there is a reason to.
 */
export function startWorker(): void {
  if (timer) return;

  timer = setInterval(() => {
    if (running) return; // one job at a time; the lease makes this safe anyway
    running = true;
    void runOne()
      .catch((error: unknown) => console.error('worker: unexpected error', error))
      .finally(() => {
        running = false;
      });
  }, POLL_INTERVAL_MS);

  console.log('worker: polling for jobs');
}

export function stopWorker(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

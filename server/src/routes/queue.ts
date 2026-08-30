import { Router } from 'express';
import { requireRole } from '../lib/auth.js';
import { supabaseForUser } from '../lib/supabase.js';

export const queueRouter = Router();

/**
 * The work queue, and the controls to steer it.
 *
 * Jobs ran first-in-first-out with no way to see the queue, stop anything, or
 * say "that one matters more". Fine when one job runs at a time and finishes in
 * a minute. Not fine when somebody queues a coverage audit across a plan set and
 * then realises the bid comparison they need for a meeting in ten minutes is
 * sitting behind it.
 *
 * Agents are the expensive, slow part of this product. Making them steerable is
 * the difference between a tool that runs work for you and one you wait on.
 */

const LABEL: Record<string, string> = {
  draft_scope: 'Drafting scope',
  index_sheets: 'Indexing sheets',
  draft_scope_context: 'Writing scope context',
  audit_coverage: 'Auditing coverage',
  compare_bids: 'Comparing bids',
  map_cost_codes: 'Mapping cost codes',
  extract_quote: 'Reading a bid',
  normalise_quote: 'Matching to scope',
  co_archaeology: 'Reading change orders',
  division_consult: 'Asking an expert',
  demo_stream: 'Demo',
};

/** Everything queued or running, in the order it will actually be worked. */
queueRouter.get('/queue', async (req, res) => {
  const auth = req.auth;
  if (!auth) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }

  const db = supabaseForUser(auth.token);

  const { data: jobs, error } = await db
    .from('job')
    .select(
      'id, job_type, status, priority, attempts, max_attempts, last_error, agent_run_id, created_at, cancelled_at',
    )
    // Same ordering as claim_job, so what you see is what will happen.
    .order('priority', { ascending: false })
    .order('created_at')
    .limit(60);

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }

  const runIds = (jobs ?? [])
    .map((job) => job.agent_run_id as string | null)
    .filter(Boolean) as string[];

  const { data: runs } = runIds.length
    ? await db
        .from('agent_run')
        .select('id, project_id, input_ref, started_at, finished_at, token_cost')
        .in('id', runIds)
    : { data: [] as Record<string, unknown>[] };

  const runById = new Map((runs ?? []).map((run) => [run.id as string, run]));

  const shaped = (jobs ?? []).map((job) => {
    const run = runById.get(job.agent_run_id as string);
    return {
      id: job.id,
      label: LABEL[job.job_type as string] ?? String(job.job_type).replace(/_/g, ' '),
      jobType: job.job_type,
      status: job.cancelled_at ? 'CANCELLED' : job.status,
      priority: job.priority,
      attempts: job.attempts,
      maxAttempts: job.max_attempts,
      lastError: job.last_error,
      runId: job.agent_run_id,
      projectId: run?.project_id ?? null,
      inputRef: run?.input_ref ?? null,
      startedAt: run?.started_at ?? null,
      cost: run?.token_cost ?? null,
      createdAt: job.created_at,
    };
  });

  const waiting = shaped.filter((job) => job.status === 'QUEUED');

  res.json({
    running: shaped.filter((job) => job.status === 'IN_PROGRESS'),
    // Position is 1-based and reflects the real ordering, so "you are third"
    // means third.
    queued: waiting.map((job, index) => ({ ...job, position: index + 1 })),
    finished: shaped
      .filter((job) => ['DONE', 'FAILED', 'DEAD_LETTER', 'CANCELLED'].includes(job.status))
      .slice(0, 15),
  });
});

/**
 * Stops a job.
 *
 * A queued job never starts. A running one is marked cancelled and finishes its
 * current model call anyway — there is no way to interrupt a request already in
 * flight, and pretending otherwise would mean showing "cancelled" while the
 * money is still being spent. It stops before the next batch, which on a plan
 * set is the difference between one more request and twelve.
 */
queueRouter.post('/jobs/:jobId/cancel', requireRole('EST', 'BC', 'ADMIN'), async (req, res) => {
  const jobId = req.params.jobId ?? '';
  const auth = req.auth;
  if (!auth) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }

  const db = supabaseForUser(auth.token);

  const { data: job } = await db
    .from('job')
    .select('id, status, job_type, agent_run_id')
    .eq('id', jobId)
    .maybeSingle();

  if (!job) {
    res.status(404).json({ error: 'No such job' });
    return;
  }

  if (['DONE', 'FAILED', 'DEAD_LETTER'].includes(String(job.status))) {
    res.status(409).json({ error: 'That job has already finished' });
    return;
  }

  const wasRunning = job.status === 'IN_PROGRESS';

  const { error } = await db
    .from('job')
    .update({
      cancelled_at: new Date().toISOString(),
      cancelled_by: auth.userId,
      // A queued job is closed out immediately. A running one keeps its status
      // until the worker notices, so the two never disagree about what is
      // happening right now.
      ...(wasRunning ? {} : { status: 'FAILED', last_error: 'Cancelled before it started' }),
      updated_at: new Date().toISOString(),
    })
    .eq('id', jobId);

  if (error) {
    res.status(400).json({ error: error.message });
    return;
  }

  await db.from('audit_event').insert({
    tenant_id: auth.tenantId,
    actor_id: auth.userId,
    action: 'CANCEL_JOB',
    table_name: 'job',
    record_id: jobId,
    before: { status: job.status },
    after: { cancelled: true },
  });

  res.json({
    cancelled: true,
    note: wasRunning
      ? 'It will stop after the request already in flight. Anything it has produced so far is kept.'
      : 'Stopped before it started.',
  });
});

/**
 * Moves a job up or down the queue.
 *
 * Priority rather than position, so a bump is not undone by whatever gets
 * queued next.
 */
queueRouter.post('/jobs/:jobId/priority', requireRole('EST', 'BC', 'ADMIN'), async (req, res) => {
  const jobId = req.params.jobId ?? '';
  const auth = req.auth;
  if (!auth) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }

  const body = (req.body ?? {}) as { direction?: string };
  const direction = body.direction === 'down' ? 'down' : 'up';

  const db = supabaseForUser(auth.token);

  const { data: waiting } = await db
    .from('job')
    .select('id, priority')
    .eq('status', 'QUEUED')
    .is('cancelled_at', null);

  const rows = waiting ?? [];
  if (!rows.some((row) => row.id === jobId)) {
    res.status(409).json({ error: 'Only a job that has not started can be reordered' });
    return;
  }

  const priorities = rows.map((row) => Number(row.priority ?? 0));
  const target =
    direction === 'up' ? Math.max(...priorities, 0) + 1 : Math.min(...priorities, 0) - 1;

  const { error } = await db
    .from('job')
    .update({ priority: target, updated_at: new Date().toISOString() })
    .eq('id', jobId);

  if (error) {
    res.status(400).json({ error: error.message });
    return;
  }

  res.json({ priority: target, direction });
});

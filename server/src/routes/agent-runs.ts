import { Router } from 'express';
import type { AgentEvent } from 'shared';
import { PROMPT_VERSION } from '../agents/extract-quote.js';
import { MODEL } from '../lib/anthropic.js';
import { refuseSendPaths } from '../lib/auth.js';
import { supabaseForUser } from '../lib/supabase.js';

export const agentRunsRouter = Router();

/**
 * Enqueues a scripted run so the runtime can be exercised end to end.
 *
 * The agent_run row is created here rather than by the worker, so the client
 * gets a run id immediately and can open the activity stream before a worker
 * has claimed the job. Otherwise the first seconds of a run — the part that
 * makes it feel alive — are spent polling to find out where to look.
 */
agentRunsRouter.post('/agent-runs/demo', refuseSendPaths, async (req, res) => {
  const auth = req.auth;
  if (!auth) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }

  const db = supabaseForUser(auth.token);

  const { data: run, error: runError } = await db
    .from('agent_run')
    .insert({
      tenant_id: auth.tenantId,
      agent_type: 'demo_stream',
      status: 'QUEUED',
      prompt_version: 'demo-1',
    })
    .select('id')
    .single();

  if (runError || !run) {
    res.status(500).json({ error: runError?.message ?? 'Could not create the agent run' });
    return;
  }

  const { error: jobError } = await db.from('job').insert({
    tenant_id: auth.tenantId,
    job_type: 'demo_stream',
    agent_run_id: run.id,
    payload: {},
  });

  if (jobError) {
    res.status(500).json({ error: jobError.message });
    return;
  }

  res.status(202).json({ runId: run.id });
});

/**
 * Runs extraction over one uploaded quote. Returns immediately with a run id;
 * the work happens in the worker, and the client watches the activity stream.
 */
agentRunsRouter.post('/quotes/:quoteId/extract', refuseSendPaths, async (req, res) => {
  const auth = req.auth;
  if (!auth) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }

  const db = supabaseForUser(auth.token);

  const { data: quote } = await db
    .from('quote')
    .select('id, source_file_id, source_filename, package_id')
    .eq('id', req.params.quoteId)
    .maybeSingle();

  if (!quote) {
    res.status(404).json({ error: 'No such quote' });
    return;
  }
  if (!quote.source_file_id) {
    res.status(400).json({ error: 'That quote has no uploaded document' });
    return;
  }

  const { data: run, error: runError } = await db
    .from('agent_run')
    .insert({
      tenant_id: auth.tenantId,
      agent_type: 'extract_quote',
      status: 'QUEUED',
      input_ref: quote.source_filename ?? quote.source_file_id,
      model: MODEL,
      prompt_version: PROMPT_VERSION,
    })
    .select('id')
    .single();

  if (runError || !run) {
    res.status(500).json({ error: runError?.message ?? 'Could not create the agent run' });
    return;
  }

  const { error: jobError } = await db.from('job').insert({
    tenant_id: auth.tenantId,
    job_type: 'extract_quote',
    agent_run_id: run.id,
    payload: { quoteId: quote.id },
  });

  if (jobError) {
    res.status(500).json({ error: jobError.message });
    return;
  }

  res.status(202).json({ runId: run.id });
});

agentRunsRouter.get('/agent-runs', async (req, res) => {
  const auth = req.auth;
  if (!auth) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }

  const { data, error } = await supabaseForUser(auth.token)
    .from('agent_run')
    .select('id, agent_type, status, model, started_at, finished_at, token_cost')
    .order('started_at', { ascending: false, nullsFirst: false })
    .limit(20);

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }
  res.json(data ?? []);
});

/**
 * Server-Sent Events. Replays everything already written, then streams new
 * events as they land, so a client that connects late still sees the whole run
 * — a reload during a 60-second run must not lose the narration.
 *
 * Polling rather than Postgres LISTEN: the connection budget on a pooled
 * database is small, and a one-second poll is indistinguishable from live at
 * the pace an agent narrates.
 */
agentRunsRouter.get('/agent-runs/:id/stream', async (req, res) => {
  const auth = req.auth;
  if (!auth) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }

  const runId = req.params.id;
  const db = supabaseForUser(auth.token);

  // RLS decides whether this run is visible; a missing row and another
  // tenant's row are indistinguishable from here, which is the point.
  const { data: run } = await db.from('agent_run').select('id').eq('id', runId).maybeSingle();
  if (!run) {
    res.status(404).json({ error: 'No such agent run' });
    return;
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  let open = true;
  req.on('close', () => {
    open = false;
  });

  const send = (event: string, data: unknown): void => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  let lastSeq = 0;
  let idleTicks = 0;

  while (open) {
    const { data: events } = await db
      .from('agent_event')
      .select('seq, event_type, message, payload, at')
      .eq('agent_run_id', runId)
      .gt('seq', lastSeq)
      .order('seq', { ascending: true });

    for (const row of events ?? []) {
      const event: AgentEvent = {
        seq: row.seq,
        eventType: row.event_type,
        message: row.message,
        payload: row.payload,
        at: row.at,
      };
      send('agent-event', event);
      lastSeq = row.seq;
    }

    const { data: status } = await db
      .from('agent_run')
      .select('status, token_cost')
      .eq('id', runId)
      .maybeSingle();

    if (status && ['DONE', 'FAILED'].includes(status.status)) {
      // One more pass has already run above, so everything is flushed.
      send('agent-run-finished', { status: status.status, tokenCost: status.token_cost });
      break;
    }

    // A comment line keeps proxies from closing an idle connection.
    idleTicks += 1;
    if (idleTicks % 15 === 0) res.write(': keep-alive\n\n');

    await new Promise((resolve) => setTimeout(resolve, 700));
  }

  res.end();
});

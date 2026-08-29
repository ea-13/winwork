import { Router } from 'express';
import { CONSULT_PROMPT_VERSION } from '../agents/division-consult.js';
import { PROMPT_VERSION as EXTRACT_PROMPT_VERSION } from '../agents/extract-quote.js';
import { MODEL } from '../lib/anthropic.js';
import { requireRole } from '../lib/auth.js';
import { supabaseForUser } from '../lib/supabase.js';

export const autopilotRouter = Router();

/**
 * P17 · Autopilot.
 *
 * Runs the drafting chain unattended across every un-extracted quote in a
 * package, then parks everything in one review queue. The story is "went to
 * lunch, came back, five packages waiting for me" — not "the machine awarded a
 * sub".
 *
 * WHERE AUTOPILOT STOPS, AND WHY. It runs the steps that produce evidence:
 * extraction, and the division-expert consult. It does not promote anything.
 *
 * That is a narrower chain than P17 describes, and the narrowing is deliberate.
 * Normalisation, add-backs, gap detection and leveling all write canonical
 * rows, and R2 says promotion to canonical state is a separate, human-attributed
 * act. An autopilot that promoted its own drafts in order to keep chaining
 * would be an agent writing state with a human's name on it. The queue is where
 * the human picks it up, and from there the remaining steps are one click each.
 */
autopilotRouter.post('/packages/:packageId/autopilot', requireRole('EST', 'BC'), async (req, res) => {
  const packageId = req.params.packageId ?? '';
  const auth = req.auth;
  if (!auth) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }

  const db = supabaseForUser(auth.token);

  const { data: quotes } = await db
    .from('quote')
    .select('id, source_filename, status')
    .eq('package_id', packageId)
    .in('status', ['PENDING_EXTRACTION', 'FAILED']);

  const queued: string[] = [];

  for (const quote of quotes ?? []) {
    const { data: run } = await db
      .from('agent_run')
      .insert({
        tenant_id: auth.tenantId,
        agent_type: 'extract_quote',
        status: 'QUEUED',
        input_ref: quote.source_filename,
        model: MODEL,
        prompt_version: EXTRACT_PROMPT_VERSION,
      })
      .select('id')
      .single();

    if (!run) continue;

    await db.from('job').insert({
      tenant_id: auth.tenantId,
      job_type: 'extract_quote',
      agent_run_id: run.id,
      payload: { quoteId: quote.id },
    });
    queued.push(run.id);
  }

  await db.from('audit_event').insert({
    tenant_id: auth.tenantId,
    actor_id: auth.userId,
    action: 'AUTOPILOT_START',
    table_name: 'work_package',
    record_id: packageId,
    before: null,
    after: { queuedRuns: queued.length },
  });

  res.status(202).json({
    queued: queued.length,
    runIds: queued,
    note:
      queued.length === 0
        ? 'Nothing to extract — every quote on this package has already been read.'
        : 'Extraction queued. Everything will wait in the review queue; no gate is crossed.',
  });
});

/**
 * The review queue: every draft awaiting a human, grouped by the run that
 * produced it, with the evidence attached.
 *
 * A draft is "awaiting" when its run finished and nothing has promoted it yet —
 * which is recorded by the audit_event promotion writes, not by mutating the
 * draft. Drafts are immutable; a queue that marked them read would be lying
 * about that.
 */
autopilotRouter.get('/review-queue', async (req, res) => {
  const auth = req.auth;
  if (!auth) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }

  const db = supabaseForUser(auth.token);

  const { data: runs } = await db
    .from('agent_run')
    .select('id, agent_type, status, input_ref, model, prompt_version, started_at, finished_at, token_cost')
    .eq('status', 'DONE')
    .order('finished_at', { ascending: false })
    .limit(50);

  const runIds = (runs ?? []).map((run) => run.id as string);
  if (runIds.length === 0) {
    res.json({ groups: [] });
    return;
  }

  const [{ data: drafts }, { data: promotions }] = await Promise.all([
    db
      .from('draft')
      .select('id, agent_run_id, target_table, field, proposed_value, source_location, confidence, fill_tag')
      .in('agent_run_id', runIds),
    db
      .from('audit_event')
      .select('after, at, actor_id')
      .in('action', ['PROMOTE_EXTRACTION', 'PROMOTE_NORMALISATION']),
  ]);

  const promoted = new Set(
    (promotions ?? [])
      .map((row) => (row.after as { agent_run_id?: string } | null)?.agent_run_id)
      .filter(Boolean) as string[],
  );

  const groups = (runs ?? [])
    .map((run) => {
      const runDrafts = (drafts ?? []).filter((draft) => draft.agent_run_id === run.id);
      const byTable: Record<string, number> = {};
      for (const draft of runDrafts) {
        byTable[draft.target_table] = (byTable[draft.target_table] ?? 0) + 1;
      }
      return {
        run,
        accepted: promoted.has(run.id as string),
        draftCount: runDrafts.length,
        byTable,
        // Enough evidence to judge without shipping every draft to the browser.
        sample: runDrafts.slice(0, 12),
      };
    })
    .filter((group) => group.draftCount > 0);

  res.json({
    groups,
    awaiting: groups.filter((group) => !group.accepted).length,
  });
});

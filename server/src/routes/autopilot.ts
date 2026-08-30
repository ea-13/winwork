import { Router } from 'express';
import { CONSULT_PROMPT_VERSION } from '../agents/division-consult.js';
import { PROMPT_VERSION as EXTRACT_PROMPT_VERSION } from '../agents/extract-quote.js';
import { MODEL } from '../lib/anthropic.js';
import { requireRole } from '../lib/auth.js';
import { promoteContextDrafts, promoteScopeDrafts } from '../lib/promote.js';
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
      .in('action', ['PROMOTE_EXTRACTION', 'PROMOTE_NORMALISATION', 'PROMOTE_SCOPE', 'PROMOTE_CONTEXT']),
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

/**
 * Accepts a scope-drafting run into the project's baseline.
 *
 * Deliberately not automatic. A drafter that wrote straight into the scope of
 * work would be an agent writing canonical state, which is the one thing R2
 * forbids — and the baseline is the thing every bid is measured against, so it
 * is the last place to relax that.
 */
autopilotRouter.post('/runs/:runId/promote-scope', requireRole('EST', 'BC'), async (req, res) => {
  const runId = req.params.runId ?? '';
  const auth = req.auth;
  if (!auth) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }

  const rationale =
    typeof (req.body ?? {}).rationale === 'string' ? String(req.body.rationale).trim() : '';
  if (rationale === '') {
    res.status(400).json({ error: 'A rationale is required to accept drafted scope.' });
    return;
  }

  const db = supabaseForUser(auth.token);

  const { data: run } = await db
    .from('agent_run')
    .select('id, project_id, agent_type, status')
    .eq('id', runId)
    .maybeSingle();

  if (!run) {
    res.status(404).json({ error: 'No such run' });
    return;
  }
  if (!run.project_id) {
    res.status(400).json({ error: 'That run is not attached to a project' });
    return;
  }

  try {
    const body = (req.body ?? {}) as {
      overrides?: Record<string, Record<string, unknown>>;
      drop?: string[];
    };

    const result = await promoteScopeDrafts(db, {
      tenantId: auth.tenantId,
      actorId: auth.userId,
      projectId: run.project_id as string,
      runId,
      overrides: body.overrides ?? {},
      drop: Array.isArray(body.drop) ? body.drop : [],
    });

    await db.from('approval').insert({
      tenant_id: auth.tenantId,
      gate: 'H2',
      actor_id: auth.userId,
      rationale,
      target_table: 'scope_item',
      target_id: run.project_id,
    });

    const notes: string[] = [];
    if (result.skippedLocked > 0) {
      notes.push(
        `${result.skippedLocked} locked item(s) were left alone. Unlocking is a gate crossing, not a re-draft.`,
      );
    }
    if (result.edited > 0) {
      notes.push(`${result.edited} row(s) went in with your edits, not as drafted.`);
    }
    if (result.dropped > 0) {
      notes.push(`${result.dropped} row(s) you rejected were not written.`);
    }

    res.json({ ...result, note: notes.length > 0 ? notes.join(' ') : null });
  } catch (caught) {
    res.status(400).json({ error: caught instanceof Error ? caught.message : String(caught) });
  }
});

/**
 * The scope an agent has proposed for this project and nobody has accepted yet,
 * shaped like scope items so the table can show them inline.
 *
 * This exists because a review queue on its own does not work. An estimator
 * asked "accept 34 drafted scope items?" with a count and no rows will either
 * accept blind or never accept at all, and both are worse than not drafting.
 * The proposals belong in the scope table, next to the scope they are proposals
 * about, coloured so nobody mistakes one for baseline.
 *
 * Nothing here is a scope item yet. Every row carries the draft id it came from,
 * because acceptance is per draft and the audit trail is per draft.
 */
autopilotRouter.get('/projects/:projectId/proposed-scope', async (req, res) => {
  const auth = req.auth;
  if (!auth) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }

  const projectId = req.params.projectId ?? '';
  const db = supabaseForUser(auth.token);

  const { data: runs } = await db
    .from('agent_run')
    .select('id, agent_type, input_ref, finished_at')
    .eq('project_id', projectId)
    .eq('status', 'DONE')
    .order('finished_at', { ascending: false })
    .limit(50);

  const runIds = (runs ?? []).map((run) => run.id as string);
  if (runIds.length === 0) {
    res.json({ runs: [], rows: [] });
    return;
  }

  const [{ data: drafts }, { data: promotions }, { data: existing }] = await Promise.all([
    db
      .from('draft')
      .select('id, agent_run_id, proposed_value, source_location, confidence, fill_tag')
      .eq('target_table', 'scope_item')
      .in('agent_run_id', runIds),
    db
      .from('audit_event')
      .select('after')
      .eq('action', 'PROMOTE_SCOPE'),
    db.from('scope_item').select('id, scope_id').eq('project_id', projectId),
  ]);

  const promoted = new Set(
    (promotions ?? [])
      .map((row) => (row.after as { agent_run_id?: string } | null)?.agent_run_id)
      .filter(Boolean) as string[],
  );

  const byScopeId = new Map((existing ?? []).map((item) => [item.scope_id as string, item.id as string]));

  const pending = (drafts ?? []).filter((draft) => !promoted.has(draft.agent_run_id as string));

  const rows = pending.map((draft) => {
    const value = (draft.proposed_value ?? {}) as Record<string, unknown>;
    const scopeId = (value.scope_id as string | null) ?? null;
    return {
      draftId: draft.id as string,
      runId: draft.agent_run_id as string,
      scope_id: scopeId,
      csi_division: (value.csi_division as string | null) ?? null,
      csi_section: (value.csi_section as string | null) ?? null,
      title: (value.title as string | null) ?? null,
      description: (value.description as string | null) ?? null,
      unit: (value.unit as string | null) ?? null,
      // R1 all the way through: an unstated quantity arrives null and stays
      // null. It is not zero on the way to the screen either.
      quantity: (value.quantity as number | null) ?? null,
      quantity_basis: (value.quantity_basis as string | null) ?? null,
      confidence: (draft.confidence as number | null) ?? null,
      source_location: (draft.source_location as string | null) ?? null,
      // Whether accepting would overwrite an item that already exists, which
      // is the one thing worth knowing before clicking accept.
      replacesExistingId: scopeId ? (byScopeId.get(scopeId) ?? null) : null,
    };
  });

  const usedRunIds = new Set(rows.map((row) => row.runId));

  res.json({
    runs: (runs ?? [])
      .filter((run) => usedRunIds.has(run.id as string))
      .map((run) => ({
        id: run.id,
        agentType: run.agent_type,
        inputRef: run.input_ref,
        finishedAt: run.finished_at,
      })),
    rows,
  });
});

/** Accepts a context-drafting run onto its scope items. */
autopilotRouter.post(
  '/runs/:runId/promote-context',
  requireRole('EST', 'BC'),
  async (req, res) => {
    const runId = req.params.runId ?? '';
    const auth = req.auth;
    if (!auth) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }

    const rationale =
      typeof (req.body ?? {}).rationale === 'string' ? String(req.body.rationale).trim() : '';
    if (rationale === '') {
      res.status(400).json({ error: 'A rationale is required to accept drafted context.' });
      return;
    }

    const db = supabaseForUser(auth.token);

    try {
      const result = await promoteContextDrafts(db, {
        tenantId: auth.tenantId,
        actorId: auth.userId,
        runId,
      });
      res.json(result);
    } catch (caught) {
      res.status(400).json({ error: caught instanceof Error ? caught.message : String(caught) });
    }
  },
);

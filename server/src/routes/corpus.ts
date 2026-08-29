import { Router } from 'express';
import { requireRole } from '../lib/auth.js';
import { supabaseForUser } from '../lib/supabase.js';

export const corpusRouter = Router();

/**
 * P28 · The training corpus.
 *
 * Every human edit over an agent's proposal is a labelled correction, and this
 * is the only place that data will ever exist. Joined:
 *
 *   draft         what the agent proposed, with model and prompt version
 *   audit_event   what the human chose instead, with before and after
 *   approval      which gate crossings they accepted, and why
 *
 * The corpus is a by-product of ordinary work. If capturing it changed how an
 * estimator works, it would not get captured.
 *
 * PII WARNING, and it is not decorative: subcontractor contacts, vendor emails
 * and phone numbers live in `subcontractor` and in `raw_row`. This export
 * carries agent proposals and human corrections only, and never joins to
 * subcontractor rows — but any future widening must strip or tokenise contact
 * data before it leaves the tenant. Tech-debt item 23.
 */
corpusRouter.get('/corpus/export', requireRole('ADMIN', 'PM', 'EST'), async (req, res) => {
  const auth = req.auth;
  if (!auth) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }

  const db = supabaseForUser(auth.token);
  const since = typeof req.query.since === 'string' ? req.query.since : null;

  const runsQuery = db
    .from('agent_run')
    .select('id, agent_type, model, prompt_version, started_at, finished_at, token_cost')
    .eq('status', 'DONE');

  const { data: runs } = since ? await runsQuery.gte('started_at', since) : await runsQuery;
  const runIds = (runs ?? []).map((run) => run.id as string);

  const [{ data: drafts }, { data: edits }, { data: approvals }] = await Promise.all([
    runIds.length
      ? db
          .from('draft')
          .select('id, agent_run_id, target_table, target_id, field, proposed_value, source_file_id, source_location, confidence, fill_tag, created_at')
          .in('agent_run_id', runIds)
      : Promise.resolve({ data: [] as Record<string, unknown>[] }),
    db
      .from('audit_event')
      .select('id, action, table_name, record_id, before, after, at')
      .in('action', ['HUMAN_EDIT', 'PROMOTE_EXTRACTION', 'PROMOTE_NORMALISATION']),
    db.from('approval').select('id, gate, actor_role, rationale, at'),
  ]);

  const runById = new Map((runs ?? []).map((run) => [run.id as string, run]));

  // One JSONL record per proposal, carrying the human's response where there
  // was one. Corrections are the label; an accepted proposal is also a label.
  const lines: string[] = [];

  for (const draft of drafts ?? []) {
    const run = runById.get(draft.agent_run_id as string);
    const correction = (edits ?? []).find(
      (edit) =>
        edit.table_name === draft.target_table &&
        edit.record_id === draft.target_id &&
        edit.action === 'HUMAN_EDIT' &&
        Object.prototype.hasOwnProperty.call(edit.after ?? {}, draft.field as string),
    );

    const promotion = (edits ?? []).find(
      (edit) =>
        (edit.after as { agent_run_id?: string } | null)?.agent_run_id === draft.agent_run_id,
    );

    lines.push(
      JSON.stringify({
        draft_id: draft.id,
        agent_type: run?.agent_type ?? null,
        model: run?.model ?? null,
        prompt_version: run?.prompt_version ?? null,
        target_table: draft.target_table,
        field: draft.field,
        proposed_value: draft.proposed_value,
        source_file_id: draft.source_file_id,
        source_location: draft.source_location,
        agent_confidence: draft.confidence,
        fill_tag: draft.fill_tag,
        proposed_at: draft.created_at,
        accepted: Boolean(promotion),
        accepted_at: promotion?.at ?? null,
        // Present only where a human typed over the agent afterwards.
        human_before: correction ? (correction.before as Record<string, unknown>)[draft.field as string] ?? null : null,
        human_after: correction ? (correction.after as Record<string, unknown>)[draft.field as string] ?? null : null,
        corrected_at: correction?.at ?? null,
        label: correction ? 'CORRECTED' : promotion ? 'ACCEPTED' : 'PENDING',
      }),
    );
  }

  res.setHeader('Content-Type', 'application/x-ndjson');
  res.setHeader('Content-Disposition', 'attachment; filename="winprojects-corpus.jsonl"');
  res.send(lines.join('\n'));
});

/** Counts, so the corpus can be watched growing without downloading it. */
corpusRouter.get('/corpus/stats', async (req, res) => {
  const auth = req.auth;
  if (!auth) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }

  const db = supabaseForUser(auth.token);

  const [drafts, edits, approvals, runs] = await Promise.all([
    db.from('draft').select('*', { count: 'exact', head: true }),
    db.from('audit_event').select('*', { count: 'exact', head: true }).eq('action', 'HUMAN_EDIT'),
    db.from('approval').select('*', { count: 'exact', head: true }),
    db.from('agent_run').select('*', { count: 'exact', head: true }).eq('status', 'DONE'),
  ]);

  res.json({
    agentProposals: drafts.count ?? 0,
    humanCorrections: edits.count ?? 0,
    gateApprovals: approvals.count ?? 0,
    completedRuns: runs.count ?? 0,
  });
});

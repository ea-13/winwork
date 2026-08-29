import { Router } from 'express';
import { EDITABLE, diff, validatePatch } from '../lib/editable.js';
import { supabaseForUser } from '../lib/supabase.js';

export const recordsRouter = Router();

/** Which fields a client may render as editable, so the UI and API agree. */
recordsRouter.get('/editable', (_req, res) => {
  res.json(EDITABLE);
});

/**
 * Edit any human-owned field on any record.
 *
 * One endpoint rather than a bespoke handler per table: the rule is uniform —
 * a human may type over canonical state, the change is attributed, and the
 * before and after are recorded. Writing that fifteen times would produce
 * fifteen chances to forget the audit row.
 *
 * The update runs through the caller's own client, so RLS decides whether the
 * row is theirs. A wrong id is indistinguishable from another tenant's row.
 */
recordsRouter.patch('/records/:table/:id', async (req, res) => {
  const auth = req.auth;
  if (!auth) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }

  const { table, id } = req.params;
  const patch = (req.body ?? {}) as Record<string, unknown>;

  const invalid = validatePatch(table, patch);
  if (invalid) {
    res.status(invalid.status).json({ error: invalid.error });
    return;
  }

  const db = supabaseForUser(auth.token);

  const { data: before, error: readError } = await db
    .from(table)
    .select('*')
    .eq('id', id)
    .maybeSingle();

  if (readError) {
    res.status(500).json({ error: readError.message });
    return;
  }
  if (!before) {
    res.status(404).json({ error: 'No such record' });
    return;
  }

  const changed = diff(before as Record<string, unknown>, patch);
  if (Object.keys(changed.after).length === 0) {
    res.json({ record: before, changed: [] });
    return;
  }

  const { data: after, error: writeError } = await db
    .from(table)
    .update(changed.after)
    .eq('id', id)
    .select('*')
    .single();

  if (writeError) {
    res.status(400).json({ error: writeError.message });
    return;
  }

  // Append-only, so this cannot be revised later. It is both the audit trail
  // and the labelled record of what a human chose over what was there before.
  const { error: auditError } = await db.from('audit_event').insert({
    tenant_id: auth.tenantId,
    actor_id: auth.userId,
    action: 'HUMAN_EDIT',
    table_name: table,
    record_id: id,
    before: changed.before,
    after: changed.after,
  });

  if (auditError) {
    // The edit landed; the ledger did not. Say so rather than reporting success
    // — an unrecorded change is exactly what this product promises never to do.
    res.status(500).json({
      error: `Saved, but the audit record failed: ${auditError.message}`,
      record: after,
    });
    return;
  }

  res.json({ record: after, changed: Object.keys(changed.after) });
});

/** The edit history of one record, newest first. */
recordsRouter.get('/records/:table/:id/history', async (req, res) => {
  const auth = req.auth;
  if (!auth) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }

  const { data, error } = await supabaseForUser(auth.token)
    .from('audit_event')
    .select('id, actor_id, action, before, after, at')
    .eq('table_name', req.params.table)
    .eq('record_id', req.params.id)
    .order('at', { ascending: false })
    .limit(100);

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }
  res.json(data ?? []);
});

/**
 * P19 · Where a value came from.
 *
 * Every agent-derived field can answer "where did this number come from?" in
 * one request: the proposal, its source document and page, its confidence, and
 * the model plus prompt version that produced it — alongside every human edit
 * since. That answer being one click away is what makes the product defensible
 * when a GC asks.
 */
recordsRouter.get('/records/:table/:id/provenance', async (req, res) => {
  const auth = req.auth;
  if (!auth) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }

  const db = supabaseForUser(auth.token);
  const { table, id } = req.params;

  const [{ data: drafts }, { data: history }] = await Promise.all([
    db
      .from('draft')
      .select('id, agent_run_id, field, proposed_value, source_file_id, source_location, confidence, fill_tag, created_at')
      .eq('target_table', table)
      .eq('target_id', id)
      .order('created_at', { ascending: false }),
    db
      .from('audit_event')
      .select('id, actor_id, action, before, after, at')
      .eq('table_name', table)
      .eq('record_id', id)
      .order('at', { ascending: false }),
  ]);

  const runIds = [...new Set((drafts ?? []).map((draft) => draft.agent_run_id as string))];
  const { data: runs } = runIds.length
    ? await db
        .from('agent_run')
        .select('id, agent_type, model, prompt_version, started_at')
        .in('id', runIds)
    : { data: [] as Record<string, unknown>[] };

  const runById = new Map((runs ?? []).map((run) => [run.id as string, run]));

  res.json({
    proposals: (drafts ?? []).map((draft) => ({
      ...draft,
      run: runById.get(draft.agent_run_id as string) ?? null,
    })),
    history: history ?? [],
  });
});

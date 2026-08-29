import { Router } from 'express';
import { NORMALISE_PROMPT_VERSION } from '../agents/normalise-quote.js';
import { MODEL } from '../lib/anthropic.js';
import { readRationale, requireRole } from '../lib/auth.js';
import { promoteExtraction, promoteNormalisation } from '../lib/promote.js';
import { supabaseForUser } from '../lib/supabase.js';

export const quotesRouter = Router();

/** Everything extracted from one quote, for review and for the leveling matrix. */
quotesRouter.get('/quotes/:quoteId', async (req, res) => {
  const auth = req.auth;
  if (!auth) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }

  const db = supabaseForUser(auth.token);
  const quoteId = req.params.quoteId;

  const [quote, lines, exclusions, terms] = await Promise.all([
    db.from('quote').select('*').eq('id', quoteId).maybeSingle(),
    db
      .from('quote_line')
      .select('id, description, original_text, qty, unit, rate, line_total, scope_item_id, match_confidence, match_basis, is_lumped')
      .eq('quote_id', quoteId)
      .order('id'),
    db
      .from('quote_exclusion')
      .select('id, excerpt, source_location, scope_item_id, addback_amount, addback_basis, addback_confidence')
      .eq('quote_id', quoteId)
      .order('id'),
    db.from('quote_term').select('id, term_key, term_value, deviates').eq('quote_id', quoteId),
  ]);

  if (!quote.data) {
    res.status(404).json({ error: 'No such quote' });
    return;
  }

  res.json({
    quote: quote.data,
    lines: lines.data ?? [],
    exclusions: exclusions.data ?? [],
    terms: terms.data ?? [],
  });
});

/**
 * Accepts an extraction run's drafts as canonical rows.
 *
 * This is the R2 seam: the agent proposed, a human is accepting. It requires a
 * rationale for the same reason a gate does — an unexplained acceptance is not
 * an audit trail.
 */
quotesRouter.post('/quotes/:quoteId/promote', requireRole('EST', 'BC'), async (req, res) => {
  const quoteId = req.params.quoteId ?? '';
  const auth = req.auth;
  if (!auth) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }

  const rationale = readRationale(req, res);
  if (rationale === null) return;

  const db = supabaseForUser(auth.token);

  const body = (req.body ?? {}) as Record<string, unknown>;
  let runId = typeof body.runId === 'string' ? body.runId : '';

  if (!runId) {
    // Default to the most recent completed extraction for this quote.
    const { data: quote } = await db
      .from('quote')
      .select('source_file_id, source_filename')
      .eq('id', quoteId)
      .maybeSingle();

    const { data: runs } = await db
      .from('agent_run')
      .select('id, finished_at')
      .eq('agent_type', 'extract_quote')
      .eq('input_ref', quote?.source_filename ?? quote?.source_file_id ?? '')
      .eq('status', 'DONE')
      .order('finished_at', { ascending: false })
      .limit(1);

    runId = runs?.[0]?.id ?? '';
  }

  if (!runId) {
    res.status(400).json({ error: 'No completed extraction run found for this quote' });
    return;
  }

  try {
    const result = await promoteExtraction(db, {
      tenantId: auth.tenantId,
      actorId: auth.userId,
      quoteId,
      runId,
    });
    res.json({ ...result, runId, rationale });
  } catch (caught) {
    res.status(400).json({ error: caught instanceof Error ? caught.message : String(caught) });
  }
});

/**
 * Normalises a promoted quote against the package's locked scope baseline.
 *
 * The scope items and quote lines are gathered here rather than by the agent,
 * so the agent receives its inputs and still has no route to anything else.
 */
quotesRouter.post('/quotes/:quoteId/normalise', requireRole('EST', 'BC'), async (req, res) => {
  const auth = req.auth;
  if (!auth) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }

  const db = supabaseForUser(auth.token);
  const quoteId = req.params.quoteId;

  const { data: quote } = await db
    .from('quote')
    .select('id, package_id')
    .eq('id', quoteId)
    .maybeSingle();

  if (!quote) {
    res.status(404).json({ error: 'No such quote' });
    return;
  }

  // The baseline is the scope in this package. Locked items only: normalising
  // against a moving baseline produces numbers nobody can defend (H2).
  const { data: packageScope } = await db
    .from('package_scope')
    .select('scope_item_id')
    .eq('package_id', quote.package_id);

  const scopeIds = (packageScope ?? []).map((row) => row.scope_item_id);

  const { data: scopeItems } = scopeIds.length
    ? await db
        .from('scope_item')
        .select('id, scope_id, csi_division, csi_section, title, description, unit, quantity')
        .in('id', scopeIds)
        .eq('is_locked', true)
    : { data: [] as unknown[] };

  const [{ data: lines }, { data: exclusions }] = await Promise.all([
    db
      .from('quote_line')
      .select('id, description, original_text, qty, unit, rate, line_total')
      .eq('quote_id', quoteId),
    db.from('quote_exclusion').select('id, excerpt, source_location').eq('quote_id', quoteId),
  ]);

  if (!scopeItems || scopeItems.length === 0) {
    res.status(400).json({
      error:
        'This package has no locked scope items. Lock a scope baseline (H2) before ' +
        'normalising — there is nothing to compare against.',
    });
    return;
  }

  const { data: run, error: runError } = await db
    .from('agent_run')
    .insert({
      tenant_id: auth.tenantId,
      agent_type: 'normalise_quote',
      status: 'QUEUED',
      input_ref: quoteId,
      model: MODEL,
      prompt_version: NORMALISE_PROMPT_VERSION,
    })
    .select('id')
    .single();

  if (runError || !run) {
    res.status(500).json({ error: runError?.message ?? 'Could not create the agent run' });
    return;
  }

  const { error: jobError } = await db.from('job').insert({
    tenant_id: auth.tenantId,
    job_type: 'normalise_quote',
    agent_run_id: run.id,
    payload: { quoteId, scopeItems, quoteLines: lines ?? [], exclusions: exclusions ?? [] },
  });

  if (jobError) {
    res.status(500).json({ error: jobError.message });
    return;
  }

  res.status(202).json({ runId: run.id });
});

/** Accepts a normalisation run's mappings. */
quotesRouter.post('/quotes/:quoteId/promote-normalisation', requireRole('EST', 'BC'), async (req, res) => {
  const quoteId = req.params.quoteId ?? '';
  const auth = req.auth;
  if (!auth) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }

  const rationale = readRationale(req, res);
  if (rationale === null) return;

  const db = supabaseForUser(auth.token);
  const body = (req.body ?? {}) as Record<string, unknown>;
  let runId = typeof body.runId === 'string' ? body.runId : '';

  if (!runId) {
    const { data: runs } = await db
      .from('agent_run')
      .select('id')
      .eq('agent_type', 'normalise_quote')
      .eq('input_ref', quoteId)
      .eq('status', 'DONE')
      .order('finished_at', { ascending: false })
      .limit(1);
    runId = runs?.[0]?.id ?? '';
  }

  if (!runId) {
    res.status(400).json({ error: 'No completed normalisation run found for this quote' });
    return;
  }

  try {
    const result = await promoteNormalisation(db, {
      tenantId: auth.tenantId,
      actorId: auth.userId,
      quoteId,
      runId,
    });
    res.json({ ...result, runId, rationale });
  } catch (caught) {
    res.status(400).json({ error: caught instanceof Error ? caught.message : String(caught) });
  }
});

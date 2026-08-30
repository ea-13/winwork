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

/**
 * A quote typed in rather than extracted.
 *
 * Status MANUAL, not EXTRACTED — see 0015. It levels identically; the
 * difference is that it can never cite a page, and the record should say so
 * rather than let a typed number and a read number look alike.
 *
 * The bidder can be named rather than chosen: an estimator entering three
 * quotes off their desk should not have to go and create three subcontractors
 * first, come back, and start again.
 */
quotesRouter.post('/packages/:packageId/quotes/manual', requireRole('BC', 'EST'), async (req, res) => {
  const packageId = req.params.packageId ?? '';
  const auth = req.auth;
  if (!auth) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }

  const body = (req.body ?? {}) as Record<string, unknown>;
  const bidderName = typeof body.bidderName === 'string' ? body.bidderName.trim() : '';
  const subcontractorId =
    typeof body.subcontractorId === 'string' && body.subcontractorId ? body.subcontractorId : null;

  if (!subcontractorId && bidderName === '') {
    res.status(400).json({ error: 'Name the bidder, or pick an existing subcontractor' });
    return;
  }

  const db = supabaseForUser(auth.token);

  const { data: pkg } = await db
    .from('work_package')
    .select('id, name')
    .eq('id', packageId)
    .maybeSingle();

  if (!pkg) {
    res.status(404).json({ error: 'No such package' });
    return;
  }

  let bidder = subcontractorId;

  if (!bidder) {
    const { data: existing } = await db
      .from('subcontractor')
      .select('id')
      .ilike('name', bidderName)
      .maybeSingle();

    if (existing) {
      bidder = existing.id as string;
    } else {
      const { data: created, error: subError } = await db
        .from('subcontractor')
        .insert({ tenant_id: auth.tenantId, name: bidderName, trade_csi: [] })
        .select('id')
        .single();

      if (subError || !created) {
        res.status(400).json({ error: subError?.message ?? 'Could not create the bidder' });
        return;
      }
      bidder = created.id as string;
    }
  }

  // R1 holds here too. A bid entered without a total is a bid whose total is
  // not yet known, and that is different from a bid of nothing.
  const total =
    typeof body.quotedTotal === 'number' && Number.isFinite(body.quotedTotal)
      ? body.quotedTotal
      : null;

  const { data: quote, error } = await db
    .from('quote')
    .insert({
      tenant_id: auth.tenantId,
      package_id: packageId,
      subcontractor_id: bidder,
      quoted_total: total,
      status: 'MANUAL',
      source_filename: null,
      entered_by: auth.userId,
      quote_date: typeof body.quoteDate === 'string' ? body.quoteDate : null,
      pricing_basis: typeof body.pricingBasis === 'string' ? body.pricingBasis.trim() || null : null,
    })
    .select('*')
    .single();

  if (error) {
    res.status(400).json({ error: error.message });
    return;
  }

  await db.from('audit_event').insert({
    tenant_id: auth.tenantId,
    actor_id: auth.userId,
    action: 'MANUAL_QUOTE',
    table_name: 'quote',
    record_id: quote.id,
    before: null,
    after: { packageId, bidder, quotedTotal: total },
  });

  res.status(201).json(quote);
});

/** Removes a bid. Refused once it has been selected at H6. */
quotesRouter.delete('/quotes/:quoteId', requireRole('BC', 'EST'), async (req, res) => {
  const quoteId = req.params.quoteId ?? '';
  const auth = req.auth;
  if (!auth) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }

  const db = supabaseForUser(auth.token);

  const { count } = await db
    .from('selection')
    .select('id', { count: 'exact', head: true })
    .eq('quote_id', quoteId);

  if ((count ?? 0) > 0) {
    res.status(409).json({
      error: 'That bid has been selected at H6. Removing it would delete the record of the award decision.',
    });
    return;
  }

  const { data: before } = await db.from('quote').select('*').eq('id', quoteId).maybeSingle();
  const { error } = await db.from('quote').delete().eq('id', quoteId);

  if (error) {
    res.status(400).json({ error: error.message });
    return;
  }

  await db.from('audit_event').insert({
    tenant_id: auth.tenantId,
    actor_id: auth.userId,
    action: 'DELETE_QUOTE',
    table_name: 'quote',
    record_id: quoteId,
    before,
    after: null,
  });

  res.json({ deleted: quoteId });
});

// -----------------------------------------------------------------------------
// One bid, several packages
// -----------------------------------------------------------------------------

/** How a quote currently divides across packages, with what is left over. */
quotesRouter.get('/quotes/:quoteId/allocations', async (req, res) => {
  const quoteId = req.params.quoteId ?? '';
  const auth = req.auth;
  if (!auth) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }

  const db = supabaseForUser(auth.token);

  const { data: quote } = await db
    .from('quote')
    .select('id, package_id, quoted_total, source_filename, subcontractor_id')
    .eq('id', quoteId)
    .maybeSingle();

  if (!quote) {
    res.status(404).json({ error: 'No such quote' });
    return;
  }

  const { data: allocations } = await db
    .from('quote_allocation')
    .select('id, package_id, amount, cost_code_id, note')
    .eq('quote_id', quoteId);

  const allocated = (allocations ?? []).reduce(
    (sum, row) => sum + Number(row.amount ?? 0),
    0,
  );

  res.json({
    quoteId,
    quotedTotal: quote.quoted_total,
    homePackageId: quote.package_id,
    allocations: allocations ?? [],
    allocated,
    // Named rather than silently balanced. An unexplained remainder on a bid is
    // somebody's money, and the estimator is the one who gets to say whose.
    unallocated:
      quote.quoted_total === null ? null : Number(quote.quoted_total) - allocated,
  });
});

/**
 * Splits a bid across packages.
 *
 * Plenty of subs price a scope rather than a trade — mechanical across 22 and
 * 23, a sitework sub across 31, 32 and 33 — and until now the only way to
 * represent that was to invent three separate quotes, which loses the fact that
 * it was one bid with one set of terms and one bidder to hold to them.
 *
 * The allocations are replaced wholesale rather than merged: an estimator
 * redoing a split is redoing it, and leaving a stale line behind is how the
 * parts stop adding up to the whole.
 */
quotesRouter.post('/quotes/:quoteId/allocations', requireRole('BC', 'EST'), async (req, res) => {
  const quoteId = req.params.quoteId ?? '';
  const auth = req.auth;
  if (!auth) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }

  const body = (req.body ?? {}) as {
    allocations?: { packageId?: string; amount?: number; costCodeId?: string; note?: string }[];
  };

  const rows = Array.isArray(body.allocations) ? body.allocations : [];

  const db = supabaseForUser(auth.token);

  const { data: quote } = await db
    .from('quote')
    .select('id, quoted_total')
    .eq('id', quoteId)
    .maybeSingle();

  if (!quote) {
    res.status(404).json({ error: 'No such quote' });
    return;
  }

  const clean = rows
    .filter((row) => typeof row.packageId === 'string' && row.packageId)
    .map((row) => ({
      tenant_id: auth.tenantId,
      quote_id: quoteId,
      package_id: row.packageId as string,
      amount:
        typeof row.amount === 'number' && Number.isFinite(row.amount) ? row.amount : null,
      cost_code_id: typeof row.costCodeId === 'string' && row.costCodeId ? row.costCodeId : null,
      note: typeof row.note === 'string' ? row.note.trim() || null : null,
      created_by: auth.userId,
    }));

  // Same package twice would make the totals ambiguous, and the unique index
  // would reject the insert anyway — say so clearly instead.
  const packages = new Set(clean.map((row) => row.package_id));
  if (packages.size !== clean.length) {
    res.status(400).json({ error: 'Each package may appear once in a split' });
    return;
  }

  await db.from('quote_allocation').delete().eq('quote_id', quoteId);

  if (clean.length > 0) {
    const { error } = await db.from('quote_allocation').insert(clean);
    if (error) {
      res.status(400).json({ error: error.message });
      return;
    }
  }

  const allocated = clean.reduce((sum, row) => sum + Number(row.amount ?? 0), 0);
  const total = quote.quoted_total === null ? null : Number(quote.quoted_total);

  await db.from('audit_event').insert({
    tenant_id: auth.tenantId,
    actor_id: auth.userId,
    action: 'SPLIT_QUOTE',
    table_name: 'quote',
    record_id: quoteId,
    before: null,
    after: { allocations: clean.length, allocated, quotedTotal: total },
  });

  res.json({
    allocations: clean.length,
    allocated,
    unallocated: total === null ? null : total - allocated,
    // Reported, never corrected. A split that does not add up is a question for
    // the estimator, not something to round away.
    balanced: total === null ? null : Math.abs(total - allocated) < 0.005,
  });
});

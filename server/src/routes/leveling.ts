import { Router } from 'express';
import { requireRole } from '../lib/auth.js';
import { computeAddBacks, computeLeveling, detectGaps } from '../lib/leveling.js';
import { supabaseForUser } from '../lib/supabase.js';

export const levelingRouter = Router();

/**
 * Recomputes the whole analytical picture for a package: add-backs, gaps, and
 * the adjusted comparison, in that order because each feeds the next.
 *
 * It is a POST because it writes, but nothing here is a judgement — re-running
 * it on unchanged inputs produces an identical result. That property is what
 * lets an estimator defend a number to a GC.
 */
levelingRouter.post('/packages/:packageId/level', requireRole('EST', 'BC'), async (req, res) => {
  const packageId = req.params.packageId ?? '';
  const auth = req.auth;
  if (!auth) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }

  const db = supabaseForUser(auth.token);

  const { data: pkg } = await db
    .from('work_package')
    .select('id')
    .eq('id', packageId)
    .maybeSingle();

  if (!pkg) {
    res.status(404).json({ error: 'No such package' });
    return;
  }

  try {
    const addBacks = await computeAddBacks(db, { tenantId: auth.tenantId, packageId });
    const gaps = await detectGaps(db, { tenantId: auth.tenantId, packageId });
    const leveling = await computeLeveling(db, { tenantId: auth.tenantId, packageId });

    await db.from('audit_event').insert({
      tenant_id: auth.tenantId,
      actor_id: auth.userId,
      action: 'RECOMPUTE_LEVELING',
      table_name: 'work_package',
      record_id: packageId,
      before: null,
      after: { addBacks, gaps, ranked: leveling.length },
    });

    res.json({ addBacks, gaps, leveling });
  } catch (caught) {
    res.status(500).json({ error: caught instanceof Error ? caught.message : String(caught) });
  }
});

/** The leveling matrix: one row per bidder, quoted against adjusted. */
levelingRouter.get('/packages/:packageId/leveling', async (req, res) => {
  const packageId = req.params.packageId ?? '';
  const auth = req.auth;
  if (!auth) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }

  const db = supabaseForUser(auth.token);

  const [{ data: results }, { data: quotes }, { data: subs }] = await Promise.all([
    db
      .from('leveling_result')
      .select('*')
      .eq('package_id', packageId)
      .order('advisory_rank'),
    db
      .from('quote')
      .select('id, subcontractor_id, quoted_total, source_filename, status')
      .eq('package_id', packageId),
    db.from('subcontractor').select('id, name'),
  ]);

  const subName = new Map((subs ?? []).map((row) => [row.id as string, row.name as string]));
  const quoteById = new Map((quotes ?? []).map((row) => [row.id as string, row]));

  const rows = (results ?? []).map((row) => {
    const quote = quoteById.get(row.quote_id as string);
    return {
      ...row,
      bidder:
        (quote?.subcontractor_id ? subName.get(quote.subcontractor_id) : null) ??
        quote?.source_filename ??
        'Unidentified bidder',
      sourceFilename: quote?.source_filename ?? null,
    };
  });

  res.json(rows);
});

/** The risk log for a package: every gap, worst first. */
levelingRouter.get('/packages/:packageId/gaps', async (req, res) => {
  const packageId = req.params.packageId ?? '';
  const auth = req.auth;
  if (!auth) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }

  const db = supabaseForUser(auth.token);

  const { data: gaps } = await db
    .from('scope_gap')
    .select('*')
    .eq('package_id', packageId)
    .order('exposure_amount', { ascending: false, nullsFirst: false });

  const scopeIds = [...new Set((gaps ?? []).map((gap) => gap.scope_item_id as string))];
  const { data: items } = scopeIds.length
    ? await db.from('scope_item').select('id, scope_id, csi_section, title').in('id', scopeIds)
    : { data: [] as { id: string; scope_id: string; csi_section: string; title: string }[] };

  const itemById = new Map((items ?? []).map((row) => [row.id as string, row]));

  const severityOrder = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 } as Record<string, number>;

  const rows = (gaps ?? [])
    .map((gap) => ({
      ...gap,
      scope: itemById.get(gap.scope_item_id as string) ?? null,
    }))
    .sort(
      (a, b) =>
        (severityOrder[a.severity as string] ?? 9) - (severityOrder[b.severity as string] ?? 9) ||
        Number(b.exposure_amount ?? 0) - Number(a.exposure_amount ?? 0),
    );

  res.json(rows);
});

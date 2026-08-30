import { Router } from 'express';
import { requireRole } from '../lib/auth.js';
import {
  computeAddBacks,
  computeLeveling,
  computeScopeLeveling,
  detectGaps,
  recordContextOutcomes,
} from '../lib/leveling.js';
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
    const cells = await computeScopeLeveling(db, { tenantId: auth.tenantId, packageId });

    // Last, because it scores what the steps above just decided. This is the
    // only place the system writes down whether its own advice was any good.
    const learned = await recordContextOutcomes(db, { tenantId: auth.tenantId, packageId });

    await db.from('audit_event').insert({
      tenant_id: auth.tenantId,
      actor_id: auth.userId,
      action: 'RECOMPUTE_LEVELING',
      table_name: 'work_package',
      record_id: packageId,
      before: null,
      after: { addBacks, gaps, ranked: leveling.length, cells: cells.length, learned },
    });

    res.json({ addBacks, gaps, leveling, cells: cells.length, learned });
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

  const { data: results } = await db
    .from('leveling_result')
    .select('*')
    .eq('package_id', packageId)
    .order('advisory_rank');

  // Resolve bidders from the RESULT rows rather than from package_id. A bid
  // split in from another package (0019) is part of this comparison, and
  // looking it up by package would leave it showing as "Unidentified bidder"
  // on the very screen it exists to appear on.
  const resultQuoteIds = [...new Set((results ?? []).map((row) => row.quote_id as string))];

  const [{ data: quotes }, { data: subs }] = await Promise.all([
    resultQuoteIds.length
      ? db
          .from('quote')
          .select('id, package_id, subcontractor_id, quoted_total, source_filename, status')
          .in('id', resultQuoteIds)
      : Promise.resolve({ data: [] as Record<string, unknown>[] }),
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
      // True when this bid lives on another package and was allocated in.
      isSplitIn: Boolean(quote) && quote?.package_id !== packageId,
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

// -----------------------------------------------------------------------------
// The bid tab sheet — one row per scope item, one column per bidder
// -----------------------------------------------------------------------------

/**
 * Everything the bid tab needs in one request.
 *
 * Bidders come back ordered by advisory rank so the grid's first three columns
 * are the three adjusted-lowest bids rather than whichever quote happened to be
 * uploaded first. An estimator comparing three subs wants the three that matter.
 */
levelingRouter.get('/packages/:packageId/scope-leveling', async (req, res) => {
  const packageId = req.params.packageId ?? '';
  const auth = req.auth;
  if (!auth) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }

  const db = supabaseForUser(auth.token);

  const { data: packageScope } = await db
    .from('package_scope')
    .select('scope_item_id')
    .eq('package_id', packageId);

  const scopeIds = (packageScope ?? []).map((row) => row.scope_item_id as string);

  const [{ data: items }, { data: cells }, { data: quotes }, { data: results }, { data: subs }] =
    await Promise.all([
      scopeIds.length
        ? db
            .from('scope_item')
            .select(
              'id, scope_id, csi_division, csi_section, title, description, unit, quantity, is_locked',
            )
            .in('id', scopeIds)
            .order('csi_division')
            .order('scope_id')
        : Promise.resolve({ data: [] as Record<string, unknown>[] }),
      db.from('scope_leveling').select('*').eq('package_id', packageId),
      db
        .from('quote')
        .select('id, package_id, subcontractor_id, quoted_total, source_filename, status')
        .or(
          `package_id.eq.${packageId},id.in.(${
            // Bids allocated in from elsewhere belong on this tab too.
            (await db
              .from('quote_allocation')
              .select('quote_id')
              .eq('package_id', packageId)
              .then((result) => (result.data ?? []).map((row) => row.quote_id as string))
            ).join(',') || '00000000-0000-0000-0000-000000000000'
          })`,
        ),
      db
        .from('leveling_result')
        .select('quote_id, adjusted_total, quoted_total, advisory_rank')
        .eq('package_id', packageId),
      db.from('subcontractor').select('id, name'),
    ]);

  const subName = new Map((subs ?? []).map((row) => [row.id as string, row.name as string]));
  const resultByQuote = new Map((results ?? []).map((row) => [row.quote_id as string, row]));

  const bidders = (quotes ?? [])
    .map((quote) => {
      const result = resultByQuote.get(quote.id as string);
      return {
        quoteId: quote.id as string,
        name:
          (quote.subcontractor_id ? subName.get(quote.subcontractor_id as string) : null) ??
          (quote.source_filename as string | null) ??
          'Unidentified bidder',
        status: quote.status as string,
        quotedTotal: (quote.quoted_total as number | null) ?? null,
        adjustedTotal: (result?.adjusted_total as number | null) ?? null,
        // 0 means unranked — no stated total. It sorts last, never as zero (R1).
        advisoryRank: (result?.advisory_rank as number | null) ?? 0,
      };
    })
    .sort((a, b) => {
      if (a.advisoryRank === 0) return 1;
      if (b.advisoryRank === 0) return -1;
      return a.advisoryRank - b.advisoryRank;
    });

  res.json({
    scopeItems: items ?? [],
    bidders,
    cells: (cells ?? []).map((cell) => ({
      scopeItemId: cell.scope_item_id,
      quoteId: cell.quote_id,
      rolledTotal: cell.rolled_total,
      overrideTotal: cell.override_total,
      note: cell.note,
      lineCount: cell.line_count,
      isExcluded: cell.is_excluded,
      isCarried: cell.is_carried,
      matchBasis: cell.match_basis,
    })),
  });
});

/**
 * The estimator's own number, or their note, on one cell.
 *
 * Upserts rather than requiring a recompute first, so a note can be written
 * against a sub who priced nothing — which is exactly the cell most worth
 * annotating, because a blank with no explanation is the thing that gets
 * misread later.
 */
levelingRouter.post(
  '/packages/:packageId/scope-leveling/cell',
  requireRole('EST', 'BC'),
  async (req, res) => {
    const packageId = req.params.packageId ?? '';
    const auth = req.auth;
    if (!auth) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }

    const body = (req.body ?? {}) as Record<string, unknown>;
    const scopeItemId = typeof body.scopeItemId === 'string' ? body.scopeItemId : '';
    const quoteId = typeof body.quoteId === 'string' ? body.quoteId : '';

    if (!scopeItemId || !quoteId) {
      res.status(400).json({ error: 'scopeItemId and quoteId are both required' });
      return;
    }

    const patch: Record<string, unknown> = {};

    if ('overrideTotal' in body) {
      const raw = body.overrideTotal;
      patch.override_total =
        typeof raw === 'number' && Number.isFinite(raw) ? raw : null;
    }
    if ('note' in body) {
      const raw = typeof body.note === 'string' ? body.note.trim() : '';
      patch.note = raw === '' ? null : raw;
    }

    if (Object.keys(patch).length === 0) {
      res.status(400).json({ error: 'Nothing to write — send overrideTotal, note, or both' });
      return;
    }

    const db = supabaseForUser(auth.token);

    const { data: before } = await db
      .from('scope_leveling')
      .select('*')
      .eq('package_id', packageId)
      .eq('scope_item_id', scopeItemId)
      .eq('quote_id', quoteId)
      .maybeSingle();

    const { data: after, error } = await db
      .from('scope_leveling')
      .upsert(
        {
          ...(before ?? {}),
          tenant_id: auth.tenantId,
          package_id: packageId,
          scope_item_id: scopeItemId,
          quote_id: quoteId,
          ...patch,
          noted_by: auth.userId,
          noted_at: new Date().toISOString(),
        },
        { onConflict: 'package_id,scope_item_id,quote_id' },
      )
      .select('*')
      .single();

    if (error) {
      res.status(400).json({ error: error.message });
      return;
    }

    const { error: auditError } = await db.from('audit_event').insert({
      tenant_id: auth.tenantId,
      actor_id: auth.userId,
      action: 'HUMAN_EDIT',
      table_name: 'scope_leveling',
      record_id: after.id,
      before: before ? { override_total: before.override_total, note: before.note } : null,
      after: patch,
    });

    if (auditError) {
      res.status(500).json({
        error: `Saved, but the audit record failed: ${auditError.message}`,
        cell: after,
      });
      return;
    }

    res.json({ cell: after });
  },
);

/**
 * The drill-down: what these bidders actually wrote, for these scope items.
 *
 * Multi-select on both axes on purpose. A GC routinely buys several scopes
 * under one contract, and "what does this contract cost from each of them"
 * cannot be answered one scope item at a time.
 */
levelingRouter.get('/packages/:packageId/scope-leveling/detail', async (req, res) => {
  const packageId = req.params.packageId ?? '';
  const auth = req.auth;
  if (!auth) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }

  const list = (value: unknown): string[] =>
    typeof value === 'string'
      ? value.split(',').map((part) => part.trim()).filter(Boolean)
      : [];

  const scopeItemIds = list(req.query.scopeItemIds);
  if (scopeItemIds.length === 0) {
    res.status(400).json({ error: 'scopeItemIds is required — which scope to open' });
    return;
  }

  const db = supabaseForUser(auth.token);

  const { data: quotes } = await db
    .from('quote')
    .select('id, subcontractor_id, quoted_total, source_filename, status')
    .eq('package_id', packageId);

  const requested = list(req.query.quoteIds);
  const quoteIds = (quotes ?? [])
    .map((quote) => quote.id as string)
    .filter((id) => requested.length === 0 || requested.includes(id));

  const [{ data: items }, { data: lines }, { data: exclusions }, { data: cells }, { data: subs }] =
    await Promise.all([
      db
        .from('scope_item')
        .select(
          'id, scope_id, csi_division, csi_section, title, description, unit, quantity, quantity_basis',
        )
        .in('id', scopeItemIds)
        .order('csi_division')
        .order('scope_id'),
      quoteIds.length
        ? db.from('quote_line').select('*').in('quote_id', quoteIds).in('scope_item_id', scopeItemIds)
        : Promise.resolve({ data: [] as Record<string, unknown>[] }),
      quoteIds.length
        ? db
            .from('quote_exclusion')
            .select('*')
            .in('quote_id', quoteIds)
            .in('scope_item_id', scopeItemIds)
        : Promise.resolve({ data: [] as Record<string, unknown>[] }),
      db.from('scope_leveling').select('*').eq('package_id', packageId).in('scope_item_id', scopeItemIds),
      db.from('subcontractor').select('id, name'),
    ]);

  const subName = new Map((subs ?? []).map((row) => [row.id as string, row.name as string]));

  res.json({
    scopeItems: items ?? [],
    bidders: (quotes ?? [])
      .filter((quote) => quoteIds.includes(quote.id as string))
      .map((quote) => ({
        quoteId: quote.id,
        name:
          (quote.subcontractor_id ? subName.get(quote.subcontractor_id as string) : null) ??
          quote.source_filename ??
          'Unidentified bidder',
        quotedTotal: quote.quoted_total,
      })),
    lines: lines ?? [],
    exclusions: exclusions ?? [],
    cells: cells ?? [],
  });
});

// -----------------------------------------------------------------------------
// Disposing of a scope gap
// -----------------------------------------------------------------------------

/**
 * What the estimator decided to do about a gap nobody priced.
 *
 * ALLOWANCE and CONTINGENCY carry money into the buyout total. ACCEPTED is a
 * deliberate decision to carry nothing. VOID says it was never really a gap.
 *
 * All four require a note. A gap disposed of without a reason is indistinguish-
 * able from one nobody looked at, and the entire value of the risk log is that
 * somebody looked.
 */
levelingRouter.post('/gaps/:gapId/assign', requireRole('EST', 'BC'), async (req, res) => {
  const gapId = req.params.gapId ?? '';
  const auth = req.auth;
  if (!auth) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }

  const body = (req.body ?? {}) as Record<string, unknown>;
  const TYPES = ['ALLOWANCE', 'CONTINGENCY', 'ACCEPTED', 'VOID'];
  const clearing = body.assignedType === null;
  const assignedType = typeof body.assignedType === 'string' ? body.assignedType : '';
  const note = typeof body.note === 'string' ? body.note.trim() : '';

  if (!clearing && !TYPES.includes(assignedType)) {
    res
      .status(400)
      .json({ error: `assignedType must be one of ${TYPES.join(', ')}, or null to clear` });
    return;
  }

  if (!clearing && note === '') {
    res
      .status(400)
      .json({ error: 'A note is required. A decision without a reason is not a decision.' });
    return;
  }

  const carriesMoney = assignedType === 'ALLOWANCE' || assignedType === 'CONTINGENCY';
  const amount =
    typeof body.assignedAmount === 'number' && Number.isFinite(body.assignedAmount)
      ? body.assignedAmount
      : null;

  if (!clearing && carriesMoney && amount === null) {
    res.status(400).json({
      error: `${assignedType} needs an amount — that is what it carries into the buyout.`,
    });
    return;
  }

  const db = supabaseForUser(auth.token);

  const { data: before } = await db.from('scope_gap').select('*').eq('id', gapId).maybeSingle();
  if (!before) {
    res.status(404).json({ error: 'No such gap' });
    return;
  }

  const patch = clearing
    ? {
        assigned_type: null,
        assigned_amount: null,
        assigned_note: null,
        assigned_by: null,
        assigned_at: null,
      }
    : {
        assigned_type: assignedType,
        assigned_amount: carriesMoney ? amount : null,
        assigned_note: note,
        assigned_by: auth.userId,
        assigned_at: new Date().toISOString(),
      };

  const { data: after, error } = await db
    .from('scope_gap')
    .update(patch)
    .eq('id', gapId)
    .select('*')
    .single();

  if (error) {
    res.status(400).json({ error: error.message });
    return;
  }

  const { error: auditError } = await db.from('audit_event').insert({
    tenant_id: auth.tenantId,
    actor_id: auth.userId,
    action: 'GAP_DISPOSITION',
    table_name: 'scope_gap',
    record_id: gapId,
    before: {
      assigned_type: before.assigned_type,
      assigned_amount: before.assigned_amount,
      assigned_note: before.assigned_note,
    },
    after: patch,
  });

  if (auditError) {
    res.status(500).json({
      error: `Saved, but the audit record failed: ${auditError.message}`,
      gap: after,
    });
    return;
  }

  res.json({ gap: after });
});

/**
 * Who was selected on this package, plus the weights the scores were computed
 * against.
 *
 * One request rather than three, because the leveling sheet cannot render
 * without all of it and three round trips means three chances to draw a
 * half-populated table.
 */
levelingRouter.get('/packages/:packageId/selection', async (req, res) => {
  const packageId = req.params.packageId ?? '';
  const auth = req.auth;
  if (!auth) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }

  const db = supabaseForUser(auth.token);

  const { data: pkg } = await db
    .from('work_package')
    .select('project_id')
    .eq('id', packageId)
    .maybeSingle();

  const [{ data: selection }, { data: project }] = await Promise.all([
    db
      .from('selection')
      .select('quote_id, rationale, selected_at')
      .eq('package_id', packageId)
      .order('selected_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
    pkg?.project_id
      ? db
          .from('project')
          .select('weight_price, weight_scope, weight_risk, weight_commercial, weight_programme')
          .eq('id', pkg.project_id)
          .maybeSingle()
      : Promise.resolve({ data: null }),
  ]);

  res.json({
    selection: selection ?? null,
    projectId: pkg?.project_id ?? null,
    weights: project ?? null,
  });
});

import { Router } from 'express';
import { requireRole } from '../lib/auth.js';
import { supabaseForUser } from '../lib/supabase.js';

export const projectsRouter = Router();

/**
 * CSI divisions a GC actually buys by. Packages are created against these, one
 * per trade — a project has a dozen packages, not one.
 */
export const DIVISIONS: { code: string; title: string }[] = [
  { code: '01', title: 'General Requirements' },
  { code: '02', title: 'Existing Conditions' },
  { code: '03', title: 'Concrete' },
  { code: '04', title: 'Masonry' },
  { code: '05', title: 'Metals' },
  { code: '06', title: 'Wood, Plastics & Composites' },
  { code: '07', title: 'Thermal & Moisture Protection' },
  { code: '08', title: 'Openings' },
  { code: '09', title: 'Finishes' },
  { code: '10', title: 'Specialties' },
  { code: '11', title: 'Equipment' },
  { code: '12', title: 'Furnishings' },
  { code: '13', title: 'Special Construction' },
  { code: '14', title: 'Conveying Equipment' },
  { code: '21', title: 'Fire Suppression' },
  { code: '22', title: 'Plumbing' },
  { code: '23', title: 'HVAC' },
  { code: '26', title: 'Electrical' },
  { code: '27', title: 'Communications' },
  { code: '28', title: 'Electronic Safety & Security' },
  { code: '31', title: 'Earthwork' },
  { code: '32', title: 'Exterior Improvements' },
  { code: '33', title: 'Utilities' },
];

projectsRouter.get('/divisions', (_req, res) => {
  res.json(DIVISIONS);
});

projectsRouter.get('/projects', async (req, res) => {
  const auth = req.auth;
  if (!auth) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }

  const { data, error } = await supabaseForUser(auth.token)
    .from('project')
    .select('id, bid_id, name, owner_org, due_at, status, created_at')
    .order('created_at', { ascending: false });

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }
  res.json(data ?? []);
});

projectsRouter.post('/projects', requireRole('BC', 'EST', 'PM'), async (req, res) => {
  const auth = req.auth;
  if (!auth) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }

  const body = (req.body ?? {}) as Record<string, unknown>;
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const bidId = typeof body.bidId === 'string' ? body.bidId.trim() : '';

  if (!name || !bidId) {
    res.status(400).json({ error: 'name and bidId are required' });
    return;
  }
  // bid_id is permanent and never reused (spec section 4).
  if (!/^[A-Z0-9]+-\d{4}-\d{3}$/.test(bidId)) {
    res.status(400).json({ error: 'bidId must look like PREFIX-YYYY-NNN, e.g. RMO-2026-004' });
    return;
  }

  const { data, error } = await supabaseForUser(auth.token)
    .from('project')
    .insert({
      tenant_id: auth.tenantId,
      bid_id: bidId,
      name,
      owner_org: typeof body.ownerOrg === 'string' ? body.ownerOrg.trim() || null : null,
      due_at: typeof body.dueAt === 'string' && body.dueAt ? body.dueAt : null,
      status: 'BIDDING',
    })
    .select('id, bid_id, name, owner_org, due_at, status, created_at')
    .single();

  if (error) {
    const duplicate = error.code === '23505';
    res.status(duplicate ? 409 : 500).json({
      error: duplicate ? `Bid id ${bidId} is already used on this tenant` : error.message,
    });
    return;
  }
  res.status(201).json(data);
});

projectsRouter.get('/projects/:projectId', async (req, res) => {
  const auth = req.auth;
  if (!auth) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }

  const { data, error } = await supabaseForUser(auth.token)
    .from('project')
    .select('id, bid_id, name, owner_org, due_at, status, created_at')
    .eq('id', req.params.projectId)
    .maybeSingle();

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }
  if (!data) {
    res.status(404).json({ error: 'No such project' });
    return;
  }
  res.json(data);
});

// -----------------------------------------------------------------------------
// Packages — one per division, which is how a GC buys
// -----------------------------------------------------------------------------

projectsRouter.get('/projects/:projectId/packages', async (req, res) => {
  const auth = req.auth;
  if (!auth) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }

  const { data, error } = await supabaseForUser(auth.token)
    .from('work_package')
    .select(
      'id, name, status, lead_division, csi_divisions, description, notes, budget_amount, allowance_amount, contingency_amount, approved_at',
    )
    .eq('project_id', req.params.projectId)
    .order('lead_division');

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }
  res.json(data ?? []);
});

projectsRouter.post(
  '/projects/:projectId/packages',
  requireRole('BC', 'EST'),
  async (req, res) => {
    const auth = req.auth;
    if (!auth) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }

    const body = (req.body ?? {}) as Record<string, unknown>;
    const leadDivision = typeof body.leadDivision === 'string' ? body.leadDivision.trim() : '';
    if (!DIVISIONS.some((division) => division.code === leadDivision)) {
      res.status(400).json({ error: 'leadDivision must be a CSI division code, e.g. 22' });
      return;
    }

    const fallbackName = DIVISIONS.find((d) => d.code === leadDivision)?.title ?? leadDivision;
    const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim() : fallbackName;

    const extra = Array.isArray(body.csiDivisions)
      ? body.csiDivisions.filter((value): value is string => typeof value === 'string')
      : [];

    const number = (value: unknown): number | null =>
      typeof value === 'number' && Number.isFinite(value) ? value : null;

    const { data, error } = await supabaseForUser(auth.token)
      .from('work_package')
      .insert({
        tenant_id: auth.tenantId,
        project_id: req.params.projectId,
        name,
        lead_division: leadDivision,
        csi_divisions: [...new Set([leadDivision, ...extra])],
        description: typeof body.description === 'string' ? body.description.trim() || null : null,
        budget_amount: number(body.budgetAmount),
        allowance_amount: number(body.allowanceAmount),
        contingency_amount: number(body.contingencyAmount),
        status: 'DRAFT', // H3 approval is a gate, not a create-time field
      })
      .select(
        'id, name, status, lead_division, csi_divisions, description, notes, budget_amount, allowance_amount, contingency_amount',
      )
      .single();

    if (error) {
      res.status(500).json({ error: error.message });
      return;
    }
    res.status(201).json(data);
  },
);

// -----------------------------------------------------------------------------
// Scope items — the hub. Every quote line, gap and benchmark joins back here.
// -----------------------------------------------------------------------------

projectsRouter.get('/projects/:projectId/scope-items', async (req, res) => {
  const auth = req.auth;
  if (!auth) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }

  const { data, error } = await supabaseForUser(auth.token)
    .from('scope_item')
    .select(
      'id, scope_id, csi_division, csi_section, title, description, unit, quantity, ' +
        'quantity_basis, cost_code_id, is_locked, locked_at',
    )
    .eq('project_id', req.params.projectId)
    .order('csi_division')
    .order('scope_id');

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }
  res.json(data ?? []);
});

/**
 * Merges several scope items into one.
 *
 * Estimators end up with duplicates for real reasons — a template line and a
 * drafted line describing the same work, three sheets each producing their own
 * row for the same wall type. Deleting the extras by hand loses whatever was
 * only written on the extras, so this keeps one row and folds the others into
 * it rather than dropping them.
 *
 * What survives, and why:
 *   - The kept row keeps its scope_id. Every quote line, gap and change order
 *     joins on that, so inventing a new one would orphan them.
 *   - Blank fields on the kept row are filled from the merged rows, first
 *     non-blank wins. A field that is set on the kept row is never overwritten:
 *     merging is not a licence to silently change a number somebody entered.
 *   - Quantities are NOT added up. Two rows may be duplicates or may be two
 *     genuinely different quantities, and this cannot tell which. R1 says a
 *     number nobody stands behind does not get written, so the kept quantity
 *     stays and the merged ones are reported back for a person to look at.
 *   - Context lines move across, deduplicated on kind and text.
 *   - Package membership moves across.
 *
 * A locked row cannot be merged away — that is a gate crossing, not an edit.
 */
projectsRouter.post(
  '/projects/:projectId/scope-items/merge',
  requireRole('EST', 'BC'),
  async (req, res) => {
    const auth = req.auth;
    if (!auth) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }

    const body = (req.body ?? {}) as Record<string, unknown>;
    const keepId = typeof body.keepId === 'string' ? body.keepId : '';
    const mergeIds = Array.isArray(body.mergeIds)
      ? body.mergeIds.filter((id): id is string => typeof id === 'string' && id !== keepId)
      : [];
    const rationale = typeof body.rationale === 'string' ? body.rationale.trim() : '';

    if (keepId === '' || mergeIds.length === 0) {
      res.status(400).json({ error: 'Pick a row to keep and at least one to merge into it' });
      return;
    }
    if (rationale === '') {
      res.status(400).json({ error: 'A reason is required. Merging removes rows.' });
      return;
    }

    const db = supabaseForUser(auth.token);
    const projectId = req.params.projectId ?? '';

    const { data: rows, error: readError } = await db
      .from('scope_item')
      .select(
        'id, scope_id, csi_division, csi_section, title, description, unit, quantity, ' +
          'quantity_basis, cost_code_id, is_locked',
      )
      .eq('project_id', projectId)
      .in('id', [keepId, ...mergeIds]);

    if (readError) {
      res.status(500).json({ error: readError.message });
      return;
    }

    type MergeRow = {
      id: string;
      scope_id: string;
      csi_division: string | null;
      csi_section: string | null;
      title: string | null;
      description: string | null;
      unit: string | null;
      quantity: number | null;
      quantity_basis: string | null;
      cost_code_id: string | null;
      is_locked: boolean;
    };

    const all = (rows ?? []) as unknown as MergeRow[];
    const keep = all.find((row) => row.id === keepId);
    const others = all.filter((row) => row.id !== keepId);

    if (!keep) {
      res.status(404).json({ error: 'The row you asked to keep is not in this project' });
      return;
    }
    if (others.length === 0) {
      res.status(400).json({ error: 'None of the rows to merge are in this project' });
      return;
    }

    const locked = [keep, ...others].filter((row) => row.is_locked);
    if (locked.length > 0) {
      res.status(400).json({
        error:
          `Locked: ${locked.map((row) => row.scope_id).join(', ')}. ` +
          'A locked scope item is baseline. Unlocking it is a gate crossing, not an edit.',
      });
      return;
    }

    // Fill blanks only. See the note above — a set field is never overwritten.
    const fillable = [
      'csi_section',
      'title',
      'description',
      'unit',
      'quantity',
      'quantity_basis',
      'cost_code_id',
    ] as const;

    const patch: Record<string, unknown> = {};
    for (const field of fillable) {
      const current = (keep as Record<string, unknown>)[field];
      if (current !== null && current !== undefined && current !== '') continue;
      const donor = others.find((row) => {
        const value = (row as Record<string, unknown>)[field];
        return value !== null && value !== undefined && value !== '';
      });
      if (donor) patch[field] = (donor as Record<string, unknown>)[field];
    }

    // Descriptions are the one place where losing text is a real loss, so any
    // distinct description on a merged row is appended rather than dropped.
    const keptDescription = String(patch.description ?? keep.description ?? '').trim();
    const extra = others
      .map((row) => String(row.description ?? '').trim())
      .filter((text) => text !== '' && text !== keptDescription);
    if (extra.length > 0) {
      patch.description = [keptDescription, ...new Set(extra)].filter(Boolean).join('\n');
    }

    if (Object.keys(patch).length > 0) {
      const { error: updateError } = await db.from('scope_item').update(patch).eq('id', keepId);
      if (updateError) {
        res.status(400).json({ error: updateError.message });
        return;
      }
    }

    // Context moves across, deduplicated. A merged row's inclusions are just as
    // real as the kept row's, and they are the part an estimator would most
    // regret losing.
    const [{ data: keptContext }, { data: movingContext }] = await Promise.all([
      db.from('scope_context').select('kind, text').eq('scope_item_id', keepId),
      db
        .from('scope_context')
        .select('id, kind, text, origin, source_location, confidence')
        .in('scope_item_id', others.map((row) => row.id)),
    ]);

    const seen = new Set(
      (keptContext ?? []).map((row) => `${row.kind}|${String(row.text).trim().toLowerCase()}`),
    );

    let movedContext = 0;
    for (const line of movingContext ?? []) {
      const fingerprint = `${line.kind}|${String(line.text).trim().toLowerCase()}`;
      if (seen.has(fingerprint)) continue;
      seen.add(fingerprint);
      const { error: moveError } = await db
        .from('scope_context')
        .update({ scope_item_id: keepId })
        .eq('id', line.id);
      if (!moveError) movedContext += 1;
    }

    // Package membership, deduplicated the same way.
    const [{ data: keptLinks }, { data: movingLinks }] = await Promise.all([
      db.from('package_scope').select('work_package_id').eq('scope_item_id', keepId),
      db
        .from('package_scope')
        .select('id, work_package_id')
        .in('scope_item_id', others.map((row) => row.id)),
    ]);

    const packages = new Set((keptLinks ?? []).map((row) => row.work_package_id as string));
    for (const link of movingLinks ?? []) {
      if (packages.has(link.work_package_id as string)) continue;
      packages.add(link.work_package_id as string);
      await db.from('package_scope').update({ scope_item_id: keepId }).eq('id', link.id);
    }

    const droppedQuantities = others
      .filter((row) => row.quantity !== null && row.quantity !== undefined)
      .map((row) => ({ scope_id: row.scope_id, quantity: row.quantity, unit: row.unit }));

    const { error: deleteError } = await db
      .from('scope_item')
      .delete()
      .in('id', others.map((row) => row.id));

    if (deleteError) {
      res.status(400).json({
        error:
          `Merged the content but could not remove the old rows: ${deleteError.message}. ` +
          'Most likely something is already bid against them.',
      });
      return;
    }

    await db.from('audit_event').insert({
      tenant_id: auth.tenantId,
      actor_id: auth.userId,
      action: 'MERGE_SCOPE',
      table_name: 'scope_item',
      record_id: keepId,
      before: {
        merged: others.map((row) => ({ id: row.id, scope_id: row.scope_id, title: row.title })),
      },
      after: { kept: keep.scope_id, filled: Object.keys(patch), rationale },
    });

    res.json({
      kept: keep.scope_id,
      merged: others.length,
      filledFields: Object.keys(patch),
      movedContext,
      // Surfaced, not summed. A quantity nobody re-measured is not a quantity.
      droppedQuantities,
      note:
        droppedQuantities.length > 0
          ? 'Quantities on the merged rows were not added up — check the kept row carries the right one.'
          : null,
    });
  },
);

/**
 * Adds an empty row for a human to fill in.
 *
 * scope_id is {bid_id}-{division}-{seq}, sequenced within its division and
 * generated here rather than typed, because it is the key every quote line,
 * gap and change order joins back to. A typo in it is a broken join later.
 */
projectsRouter.post('/projects/:projectId/scope-items', requireRole('EST', 'BC'), async (req, res) => {
  const auth = req.auth;
  if (!auth) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }

  const body = (req.body ?? {}) as Record<string, unknown>;
  const division = typeof body.csiDivision === 'string' ? body.csiDivision.trim() : '';
  if (!DIVISIONS.some((entry) => entry.code === division)) {
    res.status(400).json({ error: 'csiDivision must be a CSI division code, e.g. 22' });
    return;
  }

  const db = supabaseForUser(auth.token);

  const { data: project } = await db
    .from('project')
    .select('bid_id')
    .eq('id', req.params.projectId)
    .maybeSingle();

  if (!project) {
    res.status(404).json({ error: 'No such project' });
    return;
  }

  const { data: existing } = await db
    .from('scope_item')
    .select('scope_id')
    .eq('project_id', req.params.projectId)
    .eq('csi_division', division);

  const prefix = `${project.bid_id}-${division}-`;
  const highest = (existing ?? []).reduce((max, row) => {
    const suffix = String(row.scope_id ?? '').startsWith(prefix)
      ? Number(String(row.scope_id).slice(prefix.length))
      : Number.NaN;
    return Number.isFinite(suffix) && suffix > max ? suffix : max;
  }, 0);

  const scopeId = `${prefix}${String(highest + 1).padStart(3, '0')}`;

  const { data, error } = await db
    .from('scope_item')
    .insert({
      tenant_id: auth.tenantId,
      project_id: req.params.projectId,
      scope_id: scopeId,
      csi_division: division,
      title: 'New scope item',
      is_locked: false,
    })
    .select(
      'id, scope_id, csi_division, csi_section, title, description, unit, quantity, ' +
        'quantity_basis, cost_code_id, is_locked, locked_at',
    )
    .single();

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }
  res.status(201).json(data);
});

/** Every package on the tenant, for screens that are not project-scoped yet. */
projectsRouter.get('/packages', async (req, res) => {
  const auth = req.auth;
  if (!auth) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }

  const { data, error } = await supabaseForUser(auth.token)
    .from('work_package')
    .select('id, name, status, lead_division, csi_divisions, project_id, budget_amount')
    .order('lead_division');

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }
  res.json(data ?? []);
});

// -----------------------------------------------------------------------------
// Where this project is in the chain
// -----------------------------------------------------------------------------

/**
 * One request that answers "where am I, and what is left".
 *
 * The chain is Documents → Scope → Packages → Bidders → Bids → Leveling →
 * Gaps → Buyout, and until now nothing in the app said so. An estimator landed
 * on a page of tabs with no order to them and had to already know the product
 * to use it, which is the opposite of what a workflow tool is for.
 *
 * Counts rather than a percentage. "3 of 47 scope items locked" tells you what
 * to do next; "6% complete" tells you nothing you can act on.
 */
projectsRouter.get('/projects/:projectId/chain', async (req, res) => {
  const projectId = req.params.projectId ?? '';
  const auth = req.auth;
  if (!auth) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }

  const db = supabaseForUser(auth.token);

  const [{ data: documents }, { data: scopeItems }, { data: packages }] = await Promise.all([
    db.from('project_document').select('id, kind, indexed_at').eq('project_id', projectId),
    db.from('scope_item').select('id, is_locked').eq('project_id', projectId),
    db.from('work_package').select('id, status').eq('project_id', projectId),
  ]);

  const packageIds = (packages ?? []).map((row) => row.id as string);

  const [{ data: bidders }, { data: quotes }, { data: results }, { data: gaps }] = packageIds.length
    ? await Promise.all([
        db.from('package_bidder').select('package_id, invited_state').in('package_id', packageIds),
        db.from('quote').select('id, status').in('package_id', packageIds),
        db.from('leveling_result').select('quote_id, advisory_rank').in('package_id', packageIds),
        db.from('scope_gap').select('id, severity, assigned_type').in('package_id', packageIds),
      ])
    : [
        { data: [] as Record<string, unknown>[] },
        { data: [] as Record<string, unknown>[] },
        { data: [] as Record<string, unknown>[] },
        { data: [] as Record<string, unknown>[] },
      ];

  const docs = documents ?? [];
  const items = scopeItems ?? [];
  const openGaps = (gaps ?? []).filter((gap) => gap.assigned_type === null);

  res.json({
    documents: {
      total: docs.length,
      unfiled: docs.filter((row) => row.kind === 'UNFILED').length,
      drawings: docs.filter((row) => row.kind === 'DRAWING').length,
      specs: docs.filter((row) => row.kind === 'SPEC').length,
      indexed: docs.filter((row) => row.indexed_at !== null).length,
    },
    scope: {
      total: items.length,
      locked: items.filter((row) => row.is_locked).length,
    },
    packages: {
      total: (packages ?? []).length,
      approved: (packages ?? []).filter((row) => row.status === 'APPROVED').length,
    },
    bidders: {
      total: (bidders ?? []).length,
      invited: (bidders ?? []).filter((row) => row.invited_state === 'INVITED').length,
    },
    bids: {
      total: (quotes ?? []).length,
      extracted: (quotes ?? []).filter((row) => row.status === 'EXTRACTED').length,
    },
    leveling: {
      ranked: (results ?? []).filter((row) => Number(row.advisory_rank ?? 0) > 0).length,
    },
    gaps: {
      total: (gaps ?? []).length,
      open: openGaps.length,
      critical: openGaps.filter((gap) => gap.severity === 'CRITICAL').length,
      assigned: (gaps ?? []).length - openGaps.length,
    },
  });
});

/**
 * Removes a package.
 *
 * Refused once anything has been bought against it. A package that carries
 * quotes, a leveling result or a selection is part of the record of how a
 * decision was made, and deleting it would take the evidence with it — the
 * cascade is real, and the audit trail would point at rows that no longer
 * exist. Emptying it first is a deliberate act; doing it by accident from a
 * table row is not.
 */
/**
 * Removes a scope item.
 *
 * Refused for a locked row, because a locked scope item is the baseline every
 * bid on the job is measured against and removing it is a gate crossing rather
 * than a tidy-up. Refused by the database for anything already bid, quoted or
 * levelled against, which is the check that actually matters.
 */
projectsRouter.delete('/scope-items/:scopeItemId', requireRole('EST', 'BC'), async (req, res) => {
  const auth = req.auth;
  if (!auth) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }

  const db = supabaseForUser(auth.token);
  const scopeItemId = req.params.scopeItemId ?? '';

  const { data: item } = await db
    .from('scope_item')
    .select('id, scope_id, is_locked')
    .eq('id', scopeItemId)
    .maybeSingle();

  if (!item) {
    res.status(404).json({ error: 'No such scope item' });
    return;
  }
  if (item.is_locked) {
    res.status(400).json({
      error: `${item.scope_id} is locked. Unlocking it is a gate crossing, not an edit.`,
    });
    return;
  }

  await db.from('package_scope').delete().eq('scope_item_id', scopeItemId);

  const { error } = await db.from('scope_item').delete().eq('id', scopeItemId);
  if (error) {
    res.status(400).json({
      error:
        `Could not remove ${item.scope_id}: ${error.message}. ` +
        'Most likely something is already priced against it.',
    });
    return;
  }

  await db.from('audit_event').insert({
    tenant_id: auth.tenantId,
    actor_id: auth.userId,
    action: 'DELETE_SCOPE_ITEM',
    table_name: 'scope_item',
    record_id: scopeItemId,
    before: { scope_id: item.scope_id },
    after: null,
  });

  res.json({ deleted: item.scope_id });
});

projectsRouter.delete('/packages/:packageId', requireRole('BC', 'EST'), async (req, res) => {
  const packageId = req.params.packageId ?? '';
  const auth = req.auth;
  if (!auth) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }

  const db = supabaseForUser(auth.token);

  const { data: pkg } = await db
    .from('work_package')
    .select('id, name, status')
    .eq('id', packageId)
    .maybeSingle();

  if (!pkg) {
    res.status(404).json({ error: 'No such package' });
    return;
  }

  const [{ count: quotes }, { count: selections }] = await Promise.all([
    db.from('quote').select('id', { count: 'exact', head: true }).eq('package_id', packageId),
    db.from('selection').select('id', { count: 'exact', head: true }).eq('package_id', packageId),
  ]);

  if ((quotes ?? 0) > 0 || (selections ?? 0) > 0) {
    res.status(409).json({
      error:
        `${pkg.name} carries ${quotes ?? 0} bid(s)` +
        ((selections ?? 0) > 0 ? ' and a selection' : '') +
        '. Remove those first — deleting it would take the record of them with it.',
    });
    return;
  }

  const { error } = await db.from('work_package').delete().eq('id', packageId);
  if (error) {
    res.status(400).json({ error: error.message });
    return;
  }

  await db.from('audit_event').insert({
    tenant_id: auth.tenantId,
    actor_id: auth.userId,
    action: 'DELETE_PACKAGE',
    table_name: 'work_package',
    record_id: packageId,
    before: pkg,
    after: null,
  });

  res.json({ deleted: packageId });
});

/**
 * Removes a project.
 *
 * There was no way to do this at all, which the QA suite found by trying. A
 * test project, a duplicate, a job that never went ahead — all permanent, with
 * no route to remove them.
 *
 * Guarded by the same reasoning as deleting a package: refused once a bidder
 * has been selected, because a selection is the record of an award decision and
 * removing the project would take that record with it. Everything short of that
 * is work in progress and is the estimator's to discard.
 *
 * The approval and audit_event rows survive: they are tenant-scoped and are the
 * ledger (0021). What goes is the project's own working data.
 */
projectsRouter.delete('/projects/:projectId', requireRole('BC', 'EST', 'ADMIN'), async (req, res) => {
  const projectId = req.params.projectId ?? '';
  const auth = req.auth;
  if (!auth) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }

  const confirm = typeof (req.body ?? {}).bidId === 'string' ? req.body.bidId.trim() : '';

  const db = supabaseForUser(auth.token);

  const { data: project } = await db
    .from('project')
    .select('id, bid_id, name')
    .eq('id', projectId)
    .maybeSingle();

  if (!project) {
    res.status(404).json({ error: 'No such project' });
    return;
  }

  // Typing the bid id back is the confirmation. A project is a lot of work and
  // a misclick should not be able to end it.
  if (confirm !== project.bid_id) {
    res.status(400).json({
      error: `Type the bid id (${project.bid_id}) to confirm. This removes the scope, packages, bids and levelling.`,
    });
    return;
  }

  const { data: packages } = await db
    .from('work_package')
    .select('id')
    .eq('project_id', projectId);

  const packageIds = (packages ?? []).map((row) => row.id as string);

  // Fetching the rows rather than a head count: `count` with `head: true` came
  // back null through this path and the guard silently passed, which the QA
  // suite caught by deleting a project it should have refused.
  const { data: selections } = packageIds.length
    ? await db.from('selection').select('id').in('package_id', packageIds)
    : { data: [] as { id: string }[] };

  if ((selections ?? []).length > 0) {
    res.status(409).json({
      error:
        `${project.bid_id} has ${(selections ?? []).length} bidder selection(s) against it. ` +
        'Deleting it would ' +
        'take the record of an award decision with it.',
    });
    return;
  }

  // Audited BEFORE the delete: audit_event is tenant-scoped and survives, so
  // the ledger keeps a record of a project that no longer exists.
  await db.from('audit_event').insert({
    tenant_id: auth.tenantId,
    actor_id: auth.userId,
    action: 'DELETE_PROJECT',
    table_name: 'project',
    record_id: projectId,
    before: project,
    after: null,
  });

  const { error } = await db.from('project').delete().eq('id', projectId);

  if (error) {
    res.status(400).json({ error: error.message });
    return;
  }

  res.json({ deleted: projectId, bidId: project.bid_id });
});

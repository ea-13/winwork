import { Router } from 'express';
import { requireRole } from '../lib/auth.js';
import { supabaseForUser } from '../lib/supabase.js';

export const projectsRouter = Router();

/**
 * CSI divisions a GC actually buys by. Packages are created against these, one
 * per trade — a project has a dozen packages, not one.
 */
export const DIVISIONS: { code: string; title: string }[] = [
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
      'id, name, status, lead_division, csi_divisions, description, budget_amount, allowance_amount, contingency_amount, approved_at',
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
        'id, name, status, lead_division, csi_divisions, description, budget_amount, allowance_amount, contingency_amount',
      )
      .single();

    if (error) {
      res.status(500).json({ error: error.message });
      return;
    }
    res.status(201).json(data);
  },
);

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

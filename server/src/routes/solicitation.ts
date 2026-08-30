import { Router } from 'express';
import { DRAFT_SCOPE_PROMPT_VERSION } from '../agents/draft-scope.js';
import { INDEX_SHEETS_PROMPT_VERSION } from '../agents/index-sheets.js';
import { MODEL } from '../lib/anthropic.js';
import { requireRole } from '../lib/auth.js';
import { supabaseForUser } from '../lib/supabase.js';

export const solicitationRouter = Router();

// -----------------------------------------------------------------------------
// P16 · Package builder
// -----------------------------------------------------------------------------

/** Adds or removes scope items on a package. */
solicitationRouter.post('/packages/:packageId/scope', requireRole('BC', 'EST'), async (req, res) => {
  const packageId = req.params.packageId ?? '';
  const auth = req.auth;
  if (!auth) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }

  const body = (req.body ?? {}) as { add?: string[]; remove?: string[] };
  const db = supabaseForUser(auth.token);

  if (Array.isArray(body.remove) && body.remove.length > 0) {
    await db
      .from('package_scope')
      .delete()
      .eq('package_id', packageId)
      .in('scope_item_id', body.remove);
  }

  if (Array.isArray(body.add) && body.add.length > 0) {
    const { error } = await db.from('package_scope').upsert(
      body.add.map((scopeItemId) => ({
        tenant_id: auth.tenantId,
        package_id: packageId,
        scope_item_id: scopeItemId,
      })),
      { onConflict: 'package_id,scope_item_id', ignoreDuplicates: true },
    );
    if (error) {
      res.status(500).json({ error: error.message });
      return;
    }
  }

  const { data } = await db
    .from('package_scope')
    .select('scope_item_id')
    .eq('package_id', packageId);

  res.json({ scopeItemIds: (data ?? []).map((row) => row.scope_item_id) });
});

/**
 * Candidate bidders for a package, ranked.
 *
 * ADVISORY ONLY. The ranking is arithmetic on facts an estimator already knows
 * — trade match, prequal status, EMR, bonding capacity — and it exists to save
 * scrolling, not to choose. H4 approval of the list is a human act.
 */
solicitationRouter.get('/packages/:packageId/candidates', async (req, res) => {
  const packageId = req.params.packageId ?? '';
  const auth = req.auth;
  if (!auth) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }

  const db = supabaseForUser(auth.token);

  const { data: pkg } = await db
    .from('work_package')
    .select('csi_divisions, lead_division')
    .eq('id', packageId)
    .maybeSingle();

  if (!pkg) {
    res.status(404).json({ error: 'No such package' });
    return;
  }

  const wanted = new Set(
    ((pkg.csi_divisions ?? []) as string[]).concat(pkg.lead_division ? [pkg.lead_division] : []),
  );

  const [{ data: subs }, { data: invited }] = await Promise.all([
    db
      .from('subcontractor')
      .select('id, name, trade_csi, prequal_status, emr, bonding_capacity, license_class, contact_email, union_status'),
    db.from('package_bidder').select('subcontractor_id, invited_state').eq('package_id', packageId),
  ]);

  const onList = new Set((invited ?? []).map((row) => row.subcontractor_id as string));

  const scored = (subs ?? [])
    .map((sub) => {
      const trades = (sub.trade_csi ?? []) as string[];
      const overlap = trades.filter((trade) => wanted.has(trade));

      // Trade match dominates: a superb electrician is not a candidate for a
      // plumbing package. Everything else adjusts within that.
      let score = overlap.length * 40;
      if (sub.prequal_status === 'APPROVED') score += 20;
      if (sub.prequal_status === 'CONDITIONAL') score += 5;
      if (typeof sub.emr === 'number' && sub.emr < 1) score += Math.round((1 - sub.emr) * 20);
      if (typeof sub.bonding_capacity === 'number' && sub.bonding_capacity > 0) score += 5;

      const reasons = [
        overlap.length > 0 ? `trades ${overlap.join(', ')}` : 'no trade match',
        sub.prequal_status ? `prequal ${String(sub.prequal_status).toLowerCase()}` : null,
        typeof sub.emr === 'number' ? `EMR ${sub.emr}` : null,
      ].filter(Boolean);

      return { ...sub, score, matched: overlap, onList: onList.has(sub.id as string), reasons };
    })
    .filter((sub) => sub.matched.length > 0 || sub.onList)
    .sort((a, b) => b.score - a.score);

  res.json({ candidates: scored, divisions: [...wanted] });
});

/** Adds bidders to the package list. H4 approval is a separate gate. */
solicitationRouter.post('/packages/:packageId/bidders', requireRole('BC'), async (req, res) => {
  const packageId = req.params.packageId ?? '';
  const auth = req.auth;
  if (!auth) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }

  const body = (req.body ?? {}) as { add?: string[]; remove?: string[] };
  const db = supabaseForUser(auth.token);

  if (Array.isArray(body.remove) && body.remove.length > 0) {
    await db
      .from('package_bidder')
      .delete()
      .eq('package_id', packageId)
      .in('subcontractor_id', body.remove);
  }

  if (Array.isArray(body.add) && body.add.length > 0) {
    const { error } = await db.from('package_bidder').insert(
      body.add.map((subcontractorId) => ({
        tenant_id: auth.tenantId,
        package_id: packageId,
        subcontractor_id: subcontractorId,
        // Nothing here implies an invitation went out. There is no send (R3).
        invited_state: 'CANDIDATE',
      })),
    );
    if (error) {
      res.status(500).json({ error: error.message });
      return;
    }
  }

  const { data } = await db
    .from('package_bidder')
    .select('subcontractor_id, invited_state, list_approved_at')
    .eq('package_id', packageId);

  res.json({ bidders: data ?? [] });
});

/**
 * Drafts the solicitation text for a package.
 *
 * Writes to solicitation_draft and nowhere else. THERE IS NO SEND. The absence
 * is the feature: a GC owner who has had software contact his subs without
 * asking reads this as the reason to trust it.
 */
solicitationRouter.post('/packages/:packageId/solicitation', requireRole('BC', 'EST'), async (req, res) => {
  const packageId = req.params.packageId ?? '';
  const auth = req.auth;
  if (!auth) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }

  const db = supabaseForUser(auth.token);

  const { data: pkg } = await db
    .from('work_package')
    .select('id, name, lead_division, project_id, description')
    .eq('id', packageId)
    .maybeSingle();

  if (!pkg) {
    res.status(404).json({ error: 'No such package' });
    return;
  }

  const [{ data: project }, { data: packageScope }] = await Promise.all([
    db.from('project').select('bid_id, name, owner_org, due_at').eq('id', pkg.project_id).maybeSingle(),
    db.from('package_scope').select('scope_item_id').eq('package_id', packageId),
  ]);

  const scopeIds = (packageScope ?? []).map((row) => row.scope_item_id as string);
  const { data: items } = scopeIds.length
    ? await db
        .from('scope_item')
        .select('scope_id, csi_section, title, unit, quantity')
        .in('id', scopeIds)
        .order('scope_id')
    : { data: [] as { scope_id: string; csi_section: string; title: string; unit: string; quantity: number }[] };

  const due = project?.due_at ? new Date(project.due_at).toLocaleDateString() : 'to be confirmed';

  const subject = `${project?.bid_id ?? ''} — ${pkg.name} — bid request`;

  const body = [
    `Project: ${project?.name ?? ''} (${project?.bid_id ?? ''})`,
    project?.owner_org ? `Owner: ${project.owner_org}` : null,
    `Package: ${pkg.name}${pkg.lead_division ? ` (CSI division ${pkg.lead_division})` : ''}`,
    `Bids due: ${due}`,
    '',
    pkg.description ?? null,
    '',
    'SCOPE OF WORK — price every line below, and state clearly anything you exclude.',
    '',
    ...(items ?? []).map(
      (item) =>
        `  ${item.scope_id}  ${item.csi_section ?? ''}  ${item.title}` +
        (item.quantity ? `  —  ${item.quantity} ${item.unit ?? ''}` : ''),
    ),
    '',
    'Please state exclusions, qualifications and assumptions explicitly. Anything not',
    'priced and not excluded will be read as included.',
  ]
    .filter((line) => line !== null)
    .join('\n');

  const { data: draft, error } = await db
    .from('solicitation_draft')
    .insert({ tenant_id: auth.tenantId, package_id: packageId, subject, body })
    .select('id, subject, body')
    .single();

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }

  res.status(201).json({
    ...draft,
    // Said plainly, because the UI shows it and it is the point.
    notice: 'Drafted. WinProjects does not send email — copy this into your own system.',
  });
});

solicitationRouter.get('/packages/:packageId/solicitation', async (req, res) => {
  const auth = req.auth;
  if (!auth) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }

  const { data } = await supabaseForUser(auth.token)
    .from('solicitation_draft')
    .select('id, subject, body, approved_at')
    .eq('package_id', req.params.packageId ?? '')
    .order('id', { ascending: false });

  res.json(data ?? []);
});

// -----------------------------------------------------------------------------
// P18 · Scope of Work drafter, and the sheet index it reads drawings through
// -----------------------------------------------------------------------------

/**
 * Indexes one drawing set: what sheets it contains, and on which page.
 *
 * Separate from drafting because it is worth doing once per document and
 * reusing for every division afterwards, and because an estimator wants to see
 * the sheet list before anything is drafted from it.
 */
solicitationRouter.post(
  '/projects/:projectId/documents/:documentId/index-sheets',
  requireRole('EST', 'BC'),
  async (req, res) => {
    const { projectId = '', documentId = '' } = req.params;
    const auth = req.auth;
    if (!auth) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }

    const db = supabaseForUser(auth.token);

    const { data: document } = await db
      .from('project_document')
      .select('id, filename, storage_path, kind')
      .eq('id', documentId)
      .maybeSingle();

    if (!document) {
      res.status(404).json({ error: 'No such document' });
      return;
    }

    const { data: run, error: runError } = await db
      .from('agent_run')
      .insert({
        tenant_id: auth.tenantId,
        agent_type: 'index_sheets',
        project_id: projectId,
        status: 'QUEUED',
        input_ref: document.filename,
        model: MODEL,
        prompt_version: INDEX_SHEETS_PROMPT_VERSION,
      })
      .select('id')
      .single();

    if (runError || !run) {
      res.status(500).json({ error: runError?.message ?? 'Could not create the agent run' });
      return;
    }

    const { error: jobError } = await db.from('job').insert({
      tenant_id: auth.tenantId,
      job_type: 'index_sheets',
      agent_run_id: run.id,
      payload: {
        projectId,
        documentId: document.id,
        storagePath: document.storage_path,
        filename: document.filename,
      },
    });

    if (jobError) {
      res.status(500).json({ error: jobError.message });
      return;
    }

    res.status(202).json({ runId: run.id });
  },
);

/** The sheet list for a drawing set, in page order. */
solicitationRouter.get('/documents/:documentId/sheets', async (req, res) => {
  const auth = req.auth;
  if (!auth) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }

  const { data, error } = await supabaseForUser(auth.token)
    .from('document_sheet')
    .select('id, page_number, sheet_number, sheet_title, discipline, confidence')
    .eq('document_id', req.params.documentId)
    .order('page_number');

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }
  res.json(data ?? []);
});

/**
 * Drafts scope from the bid set.
 *
 * Takes a list of documents rather than one, because scope does not live in a
 * single file — it lives in the specification AND the drawings, and an item
 * that appears in both is better evidenced than one that appears in either.
 * Drafting them together is also what makes it possible to notice they
 * disagree.
 *
 * Drawings carry their sheet index into the payload so the agent can pick
 * sheets by discipline and cite them by number.
 */
solicitationRouter.post(
  '/projects/:projectId/draft-scope',
  requireRole('EST', 'BC'),
  async (req, res) => {
    const projectId = req.params.projectId ?? '';
    const auth = req.auth;
    if (!auth) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }

    const body = (req.body ?? {}) as {
      documentId?: string;
      documentIds?: string[];
      divisions?: string[];
    };

    // documentId stays accepted so an older client keeps working.
    const requested = [
      ...(Array.isArray(body.documentIds) ? body.documentIds : []),
      ...(typeof body.documentId === 'string' ? [body.documentId] : []),
    ].filter((id, index, all) => typeof id === 'string' && all.indexOf(id) === index);

    if (requested.length === 0) {
      res.status(400).json({
        error: 'documentIds is required — which drawings and specs to read',
      });
      return;
    }

    const db = supabaseForUser(auth.token);

    const { data: documents } = await db
      .from('project_document')
      .select('id, filename, storage_path, kind, indexed_at')
      .eq('project_id', projectId)
      .in('id', requested);

    if (!documents || documents.length === 0) {
      res.status(404).json({ error: 'None of those documents are on this project' });
      return;
    }

    const drawingIds = documents
      .filter((document) => document.kind === 'DRAWING')
      .map((document) => document.id as string);

    const { data: sheets } = drawingIds.length
      ? await db
          .from('document_sheet')
          .select('document_id, page_number, sheet_number, sheet_title, discipline')
          .in('document_id', drawingIds)
          .order('page_number')
      : { data: [] as Record<string, unknown>[] };

    const sheetsByDocument = new Map<string, Record<string, unknown>[]>();
    for (const sheet of sheets ?? []) {
      const key = sheet.document_id as string;
      sheetsByDocument.set(key, [...(sheetsByDocument.get(key) ?? []), sheet]);
    }

    const { data: project } = await db
      .from('project')
      .select('bid_id')
      .eq('id', projectId)
      .maybeSingle();

    const { data: run, error: runError } = await db
      .from('agent_run')
      .insert({
        tenant_id: auth.tenantId,
        agent_type: 'draft_scope',
        project_id: projectId,
        status: 'QUEUED',
        input_ref: documents.map((document) => document.filename).join(', ').slice(0, 500),
        model: MODEL,
        prompt_version: DRAFT_SCOPE_PROMPT_VERSION,
      })
      .select('id')
      .single();

    if (runError || !run) {
      res.status(500).json({ error: runError?.message ?? 'Could not create the agent run' });
      return;
    }

    const { error: jobError } = await db.from('job').insert({
      tenant_id: auth.tenantId,
      job_type: 'draft_scope',
      agent_run_id: run.id,
      payload: {
        projectId,
        bidId: project?.bid_id ?? '',
        divisions: body.divisions ?? [],
        documents: documents.map((document) => ({
          id: document.id,
          storagePath: document.storage_path,
          filename: document.filename,
          kind: document.kind,
          sheets: (sheetsByDocument.get(document.id as string) ?? []).map((sheet) => ({
            pageNumber: sheet.page_number,
            sheetNumber: sheet.sheet_number,
            sheetTitle: sheet.sheet_title,
            discipline: sheet.discipline,
          })),
        })),
      },
    });

    if (jobError) {
      res.status(500).json({ error: jobError.message });
      return;
    }

    const unindexed = documents.filter(
      (document) => document.kind === 'DRAWING' && document.indexed_at === null,
    );

    res.status(202).json({
      runId: run.id,
      documents: documents.length,
      note:
        unindexed.length > 0
          ? `${unindexed.length} drawing set(s) are not indexed yet — they will be read by page, ` +
            'and cited by page rather than by sheet.'
          : null,
    });
  },
);

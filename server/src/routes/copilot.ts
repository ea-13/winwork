import { Router } from 'express';
import { MODEL } from '../lib/anthropic.js';
import { AUDIT_COVERAGE_PROMPT_VERSION } from '../agents/audit-coverage.js';
import { COMPARE_BIDS_PROMPT_VERSION } from '../agents/compare-bids.js';
import { MAP_COST_CODES_PROMPT_VERSION } from '../agents/map-cost-codes.js';
import { requireRole } from '../lib/auth.js';
import { suggestFor } from '../lib/suggestions.js';
import { supabaseForUser } from '../lib/supabase.js';

export const copilotRouter = Router();

/**
 * What is worth doing next on this project.
 *
 * See lib/suggestions.ts for why this is rules over state rather than a model
 * deciding: a suggestion engine that is sometimes confidently wrong gets
 * ignored within a week, and then the agents behind it go unused too.
 */
copilotRouter.get('/projects/:projectId/suggestions', async (req, res) => {
  const auth = req.auth;
  if (!auth) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }

  try {
    res.json(await suggestFor(supabaseForUser(auth.token), req.params.projectId ?? ''));
  } catch (caught) {
    res.status(500).json({ error: caught instanceof Error ? caught.message : String(caught) });
  }
});

/** Queues a job and returns its run id, without repeating the boilerplate. */
async function enqueue(
  db: ReturnType<typeof supabaseForUser>,
  options: {
    tenantId: string;
    agentType: string;
    projectId: string | null;
    inputRef: string;
    promptVersion: string;
    payload: Record<string, unknown>;
  },
): Promise<{ runId: string } | { error: string }> {
  const { data: run, error } = await db
    .from('agent_run')
    .insert({
      tenant_id: options.tenantId,
      agent_type: options.agentType,
      project_id: options.projectId,
      status: 'QUEUED',
      input_ref: options.inputRef.slice(0, 500),
      model: MODEL,
      prompt_version: options.promptVersion,
    })
    .select('id')
    .single();

  if (error || !run) return { error: error?.message ?? 'Could not create the agent run' };

  const { error: jobError } = await db.from('job').insert({
    tenant_id: options.tenantId,
    job_type: options.agentType,
    agent_run_id: run.id,
    payload: options.payload,
  });

  if (jobError) return { error: jobError.message };
  return { runId: run.id as string };
}

/**
 * A10 · Audit the scope against the documents.
 *
 * The whole baseline is sent with every request, so the auditor knows what
 * exists before it reports what does not.
 */
copilotRouter.post(
  '/projects/:projectId/audit-coverage',
  requireRole('EST', 'BC'),
  async (req, res) => {
    const projectId = req.params.projectId ?? '';
    const auth = req.auth;
    if (!auth) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }

    const db = supabaseForUser(auth.token);
    const body = (req.body ?? {}) as { documentIds?: string[] };

    let query = db
      .from('project_document')
      .select('id, filename, storage_path, kind')
      .eq('project_id', projectId)
      .in('kind', ['DRAWING', 'SPEC', 'ADDENDUM']);

    if (Array.isArray(body.documentIds) && body.documentIds.length > 0) {
      query = query.in('id', body.documentIds);
    }

    const [{ data: documents }, { data: scope }] = await Promise.all([
      query,
      db
        .from('scope_item')
        .select('id, scope_id, csi_division, title')
        .eq('project_id', projectId)
        .order('csi_division'),
    ]);

    if (!documents || documents.length === 0) {
      res.status(400).json({ error: 'No drawings or specs to audit against' });
      return;
    }
    if (!scope || scope.length === 0) {
      res.status(400).json({
        error:
          'There is no scope to audit yet. Draft the scope of work first — an audit against ' +
          'nothing would just be a second draft.',
      });
      return;
    }

    const drawingIds = documents.filter((d) => d.kind === 'DRAWING').map((d) => d.id as string);
    const { data: sheets } = drawingIds.length
      ? await db
          .from('document_sheet')
          .select('document_id, page_number, sheet_number, sheet_title')
          .in('document_id', drawingIds)
          .order('page_number')
      : { data: [] as Record<string, unknown>[] };

    const result = await enqueue(db, {
      tenantId: auth.tenantId,
      agentType: 'audit_coverage',
      projectId,
      inputRef: `${scope.length} scope items vs ${documents.length} document(s)`,
      promptVersion: AUDIT_COVERAGE_PROMPT_VERSION,
      payload: {
        projectId,
        scope: scope.map((item) => ({
          scopeId: item.scope_id,
          division: item.csi_division,
          title: item.title,
        })),
        documents: documents.map((document) => ({
          id: document.id,
          storagePath: document.storage_path,
          filename: document.filename,
          kind: document.kind,
          sheets: (sheets ?? [])
            .filter((sheet) => sheet.document_id === document.id)
            .map((sheet) => ({
              pageNumber: sheet.page_number,
              sheetNumber: sheet.sheet_number,
              sheetTitle: sheet.sheet_title,
            })),
        })),
      },
    });

    if ('error' in result) {
      res.status(500).json(result);
      return;
    }
    res.status(202).json(result);
  },
);

/** A11 · Why these bids are not comparable. */
copilotRouter.post('/packages/:packageId/compare-bids', requireRole('EST', 'BC'), async (req, res) => {
  const packageId = req.params.packageId ?? '';
  const auth = req.auth;
  if (!auth) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }

  const db = supabaseForUser(auth.token);

  const { data: pkg } = await db
    .from('work_package')
    .select('id, name, project_id')
    .eq('id', packageId)
    .maybeSingle();

  if (!pkg) {
    res.status(404).json({ error: 'No such package' });
    return;
  }

  const [{ data: quotes }, { data: subs }, { data: packageScope }] = await Promise.all([
    db
      .from('quote')
      .select('id, subcontractor_id, quoted_total, source_filename, status')
      .eq('package_id', packageId)
      .in('status', ['EXTRACTED', 'MANUAL']),
    db.from('subcontractor').select('id, name'),
    db.from('package_scope').select('scope_item_id').eq('package_id', packageId),
  ]);

  if (!quotes || quotes.length < 2) {
    res.status(400).json({
      error: 'Comparing bids needs at least two of them on the same package.',
    });
    return;
  }

  const quoteIds = quotes.map((quote) => quote.id as string);
  const scopeIds = (packageScope ?? []).map((row) => row.scope_item_id as string);

  const [{ data: lines }, { data: exclusions }, { data: terms }, { data: scopeItems }] =
    await Promise.all([
      db.from('quote_line').select('quote_id, scope_item_id, line_total').in('quote_id', quoteIds),
      db.from('quote_exclusion').select('quote_id, excerpt').in('quote_id', quoteIds),
      db.from('quote_term').select('quote_id, term_key, term_value').in('quote_id', quoteIds),
      scopeIds.length
        ? db.from('scope_item').select('id, title').in('id', scopeIds)
        : Promise.resolve({ data: [] as Record<string, unknown>[] }),
    ]);

  const subName = new Map((subs ?? []).map((row) => [row.id as string, row.name as string]));
  const scopeTitle = new Map((scopeItems ?? []).map((row) => [row.id as string, row.title as string]));

  const bids = quotes.map((quote) => {
    const id = quote.id as string;
    const priced = new Set(
      (lines ?? [])
        .filter((line) => line.quote_id === id && typeof line.line_total === 'number')
        .map((line) => line.scope_item_id as string)
        .filter(Boolean),
    );

    return {
      bidder:
        (quote.subcontractor_id ? subName.get(quote.subcontractor_id as string) : null) ??
        (quote.source_filename as string | null) ??
        'Unidentified bidder',
      quotedTotal: quote.quoted_total,
      exclusions: (exclusions ?? [])
        .filter((row) => row.quote_id === id)
        .map((row) => String(row.excerpt ?? ''))
        .filter(Boolean)
        .slice(0, 40),
      terms: (terms ?? [])
        .filter((row) => row.quote_id === id)
        .map((row) => ({ key: String(row.term_key ?? ''), value: String(row.term_value ?? '') })),
      pricedScope: [...priced].map((sid) => scopeTitle.get(sid) ?? sid).slice(0, 40),
      unpricedScope: scopeIds
        .filter((sid) => !priced.has(sid))
        .map((sid) => scopeTitle.get(sid) ?? sid)
        .slice(0, 40),
    };
  });

  const result = await enqueue(db, {
    tenantId: auth.tenantId,
    agentType: 'compare_bids',
    projectId: (pkg.project_id as string) ?? null,
    inputRef: `${bids.length} bids on ${pkg.name}`,
    promptVersion: COMPARE_BIDS_PROMPT_VERSION,
    payload: { packageId, packageName: pkg.name, bids },
  });

  if ('error' in result) {
    res.status(500).json(result);
    return;
  }
  res.status(202).json(result);
});

/** A12 · Map scope onto the tenant's own cost codes. */
copilotRouter.post(
  '/projects/:projectId/map-cost-codes',
  requireRole('EST', 'BC'),
  async (req, res) => {
    const projectId = req.params.projectId ?? '';
    const auth = req.auth;
    if (!auth) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }

    const db = supabaseForUser(auth.token);

    const [{ data: codes }, { data: items }] = await Promise.all([
      db
        .from('cost_code')
        .select('id, code, description, csi_division')
        .eq('is_active', true)
        .order('code'),
      db
        .from('scope_item')
        .select('id, scope_id, csi_division, title, description')
        .eq('project_id', projectId)
        .is('cost_code_id', null),
    ]);

    if (!codes || codes.length === 0) {
      res.status(400).json({
        error:
          'No cost codes are set up yet. Import your structure from a template or a past bid first.',
      });
      return;
    }
    if (!items || items.length === 0) {
      res.status(400).json({ error: 'Every scope item already has a cost code.' });
      return;
    }

    const result = await enqueue(db, {
      tenantId: auth.tenantId,
      agentType: 'map_cost_codes',
      projectId,
      inputRef: `${items.length} unmapped scope items`,
      promptVersion: MAP_COST_CODES_PROMPT_VERSION,
      payload: {
        projectId,
        codes: codes.map((code) => ({
          id: code.id,
          code: code.code,
          description: code.description,
          division: code.csi_division,
        })),
        items: items.map((item) => ({
          id: item.id,
          scopeId: item.scope_id,
          division: item.csi_division,
          title: item.title,
          description: item.description,
        })),
      },
    });

    if ('error' in result) {
      res.status(500).json(result);
      return;
    }
    res.status(202).json(result);
  },
);

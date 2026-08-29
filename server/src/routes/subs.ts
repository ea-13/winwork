import { Router, type NextFunction, type Request, type Response } from 'express';
import multer from 'multer';
import { CONSULT_PROMPT_VERSION } from '../agents/division-consult.js';
import { MODEL } from '../lib/anthropic.js';
import { requireRole } from '../lib/auth.js';
import { parseSubWorkbook, type ParsedSub } from '../lib/sub-import.js';
import { supabaseForUser } from '../lib/supabase.js';

export const subsRouter = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024, files: 1 },
});

function handleUpload(req: Request, res: Response, next: NextFunction): void {
  upload.single('file')(req, res, (error: unknown) => {
    if (error instanceof multer.MulterError) {
      res.status(error.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ error: error.message });
      return;
    }
    if (error instanceof Error) {
      res.status(400).json({ error: error.message });
      return;
    }
    next();
  });
}

/**
 * P15 · Preview an import without writing anything.
 *
 * Every GC's sub list is a different mess, and 2,700 rows landing unreviewed is
 * not an import, it is a spill. So this parses, classifies what it can, and
 * hands back what it would do — including what it would skip and why.
 */
subsRouter.post('/subcontractors/import/preview', requireRole('BC', 'EST', 'ADMIN'), handleUpload, (req, res) => {
  const file = req.file;
  if (!file) {
    res.status(400).json({ error: 'No file was sent' });
    return;
  }

  try {
    const parsed = parseSubWorkbook(file.buffer);
    const importable = parsed.rows.filter((row) => !row.skipReason);

    res.json({
      filename: file.originalname,
      sourceKind: parsed.sourceKind,
      sheetNames: parsed.sheetNames,
      rowCount: parsed.rowCount,
      importable: importable.length,
      skipped: parsed.rows.length - importable.length,
      classified: importable.filter((row) => row.divisions.length > 0).length,
      unmatchedScopes: parsed.unmatchedScopes,
      // Enough to review without shipping thousands of rows to the browser.
      rows: parsed.rows.slice(0, 500),
      truncated: parsed.rows.length > 500,
    });
  } catch (caught) {
    res.status(400).json({
      error: `Could not read that workbook: ${caught instanceof Error ? caught.message : String(caught)}`,
    });
  }
});

/**
 * Commits a reviewed import.
 *
 * The client sends back the rows it wants, with any trade assignments a human
 * made. Unclassified rows are imported with an empty trade list rather than a
 * guessed one — an empty list means "nobody has said yet", and that is a
 * different thing from "no trades" (R1).
 */
subsRouter.post('/subcontractors/import/commit', requireRole('BC', 'EST', 'ADMIN'), async (req, res) => {
  const auth = req.auth;
  if (!auth) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }

  const body = (req.body ?? {}) as { rows?: ParsedSub[]; filename?: string; sourceKind?: string };
  const rows = Array.isArray(body.rows) ? body.rows : [];
  if (rows.length === 0) {
    res.status(400).json({ error: 'No rows to import' });
    return;
  }

  const db = supabaseForUser(auth.token);

  const { data: batch, error: batchError } = await db
    .from('import_batch')
    .insert({
      tenant_id: auth.tenantId,
      source_kind:
        body.sourceKind === 'SUB_DIRECTORY' || body.sourceKind === 'VENDOR_MASTER'
          ? body.sourceKind
          : 'OTHER',
      filename: body.filename ?? null,
      row_count: rows.length,
      imported_by: auth.userId,
    })
    .select('id')
    .single();

  if (batchError || !batch) {
    res.status(500).json({ error: batchError?.message ?? 'Could not open an import batch' });
    return;
  }

  const records = rows
    .filter((row) => typeof row.name === 'string' && row.name.trim() !== '')
    .map((row) => ({
      tenant_id: auth.tenantId,
      name: row.name.trim(),
      trade_csi: row.divisions ?? [],
      contact_name: row.contactName ?? null,
      contact_email: row.contactEmail ?? null,
      contact_phone: row.contactPhone ?? null,
      address_line: row.addressLine ?? null,
      city: row.city ?? null,
      state: row.state ?? null,
      postal_code: row.postalCode ?? null,
      union_status: row.unionStatus ?? 'UNKNOWN',
      vendor_code: row.vendorCode ?? null,
      source: body.sourceKind ?? 'IMPORT',
      imported_at: new Date().toISOString(),
      import_batch: batch.id,
      raw_row: row.raw ?? {},
    }));

  // Re-importing the same list updates rather than duplicates; the unique index
  // on (tenant_id, lower(name)) is what makes that safe.
  const { data: written, error } = await db
    .from('subcontractor')
    .upsert(records, { onConflict: 'tenant_id,name', ignoreDuplicates: false })
    .select('id');

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }

  const imported = written?.length ?? 0;

  await db
    .from('import_batch')
    .update({ imported_count: imported, skipped_count: rows.length - imported })
    .eq('id', batch.id);

  await db.from('audit_event').insert({
    tenant_id: auth.tenantId,
    actor_id: auth.userId,
    action: 'IMPORT_SUBCONTRACTORS',
    table_name: 'subcontractor',
    record_id: batch.id,
    before: null,
    after: { filename: body.filename, imported, offered: rows.length },
  });

  res.status(201).json({ batchId: batch.id, imported, offered: rows.length });
});

/** The sub list, with coverage by division so gaps in the list are visible. */
subsRouter.get('/subcontractors', async (req, res) => {
  const auth = req.auth;
  if (!auth) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }

  const { data, error } = await supabaseForUser(auth.token)
    .from('subcontractor')
    .select('id, name, trade_csi, contact_name, contact_email, contact_phone, license_class, emr, bonding_capacity, prequal_status, union_status, city, state')
    .order('name');

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }

  const rows = data ?? [];
  const coverage: Record<string, number> = {};
  for (const row of rows) {
    for (const division of (row.trade_csi ?? []) as string[]) {
      coverage[division] = (coverage[division] ?? 0) + 1;
    }
  }

  res.json({
    rows,
    coverage,
    unclassified: rows.filter((row) => ((row.trade_csi ?? []) as string[]).length === 0).length,
  });
});

/** P13 · Runs the Division Expert consult over a package's locked scope. */
subsRouter.post('/packages/:packageId/consult', requireRole('EST', 'BC'), async (req, res) => {
  const packageId = req.params.packageId ?? '';
  const auth = req.auth;
  if (!auth) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }

  const db = supabaseForUser(auth.token);

  const { data: pkg } = await db
    .from('work_package')
    .select('id, csi_divisions, lead_division')
    .eq('id', packageId)
    .maybeSingle();

  if (!pkg) {
    res.status(404).json({ error: 'No such package' });
    return;
  }

  const divisions = ((pkg.csi_divisions ?? []) as string[]).concat(
    pkg.lead_division ? [pkg.lead_division] : [],
  );

  const { data: experts } = await db
    .from('division_expert')
    .select('id, csi_division')
    .in('csi_division', [...new Set(divisions)]);

  const expertIds = (experts ?? []).map((row) => row.id as string);
  const divisionByExpert = new Map(
    (experts ?? []).map((row) => [row.id as string, row.csi_division as string]),
  );

  const { data: patterns } = expertIds.length
    ? await db
        .from('gap_pattern')
        .select('id, division_expert_id, pattern_text, typical_csi_section, is_frequent_change_order')
        .in('division_expert_id', expertIds)
    : { data: [] as Record<string, unknown>[] };

  const { data: packageScope } = await db
    .from('package_scope')
    .select('scope_item_id')
    .eq('package_id', packageId);

  const scopeIds = (packageScope ?? []).map((row) => row.scope_item_id as string);
  const { data: scopeItems } = scopeIds.length
    ? await db
        .from('scope_item')
        .select('id, scope_id, csi_section, title, description')
        .in('id', scopeIds)
        .eq('is_locked', true)
    : { data: [] as unknown[] };

  const { data: run, error: runError } = await db
    .from('agent_run')
    .insert({
      tenant_id: auth.tenantId,
      agent_type: 'division_consult',
      status: 'QUEUED',
      input_ref: packageId,
      model: MODEL,
      prompt_version: CONSULT_PROMPT_VERSION,
    })
    .select('id')
    .single();

  if (runError || !run) {
    res.status(500).json({ error: runError?.message ?? 'Could not create the agent run' });
    return;
  }

  const { error: jobError } = await db.from('job').insert({
    tenant_id: auth.tenantId,
    job_type: 'division_consult',
    agent_run_id: run.id,
    payload: {
      packageId,
      scopeItems: scopeItems ?? [],
      patterns: (patterns ?? []).map((pattern) => ({
        ...pattern,
        division: divisionByExpert.get(pattern.division_expert_id as string) ?? null,
      })),
    },
  });

  if (jobError) {
    res.status(500).json({ error: jobError.message });
    return;
  }

  res.status(202).json({ runId: run.id });
});

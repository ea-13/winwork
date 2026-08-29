import { Router, type NextFunction, type Request, type Response } from 'express';
import multer from 'multer';
import * as XLSX from 'xlsx';
import { CO_ARCHAEOLOGY_PROMPT_VERSION } from '../agents/co-archaeologist.js';
import { MODEL } from '../lib/anthropic.js';
import { readRationale, requireRole } from '../lib/auth.js';
import { supabaseForUser } from '../lib/supabase.js';

export const archaeologyRouter = Router();

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

function handleUpload(req: Request, res: Response, next: NextFunction): void {
  upload.single('file')(req, res, (error: unknown) => {
    if (error instanceof Error) {
      res.status(400).json({ error: error.message });
      return;
    }
    next();
  });
}

const clean = (value: unknown): string => String(value ?? '').replace(/\s+/g, ' ').trim();

const money = (value: unknown): number | null => {
  const text = clean(value).replace(/[$,()]/g, '');
  if (text === '') return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
};

/** Past projects — the closed jobs archaeology runs against. */
archaeologyRouter.get('/past-projects', async (req, res) => {
  const auth = req.auth;
  if (!auth) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }

  const db = supabaseForUser(auth.token);
  const { data: projects } = await db
    .from('past_project')
    .select('id, name, gc_name, contract_value, completed_at, project_id, notes')
    .order('completed_at', { ascending: false, nullsFirst: false });

  const ids = (projects ?? []).map((row) => row.id as string);
  const { data: orders } = ids.length
    ? await db.from('change_order').select('id, past_project_id, amount').in('past_project_id', ids)
    : { data: [] as { id: string; past_project_id: string; amount: number }[] };

  const orderIds = (orders ?? []).map((row) => row.id as string);
  const { data: classifications } = orderIds.length
    ? await db
        .from('co_classification')
        .select('change_order_id, classification, human_verdict')
        .in('change_order_id', orderIds)
    : { data: [] as { change_order_id: string; classification: string; human_verdict: string }[] };

  const classByOrder = new Map(
    (classifications ?? []).map((row) => [row.change_order_id as string, row]),
  );

  res.json(
    (projects ?? []).map((project) => {
      const mine = (orders ?? []).filter((order) => order.past_project_id === project.id);
      const total = mine.reduce((sum, order) => sum + Number(order.amount ?? 0), 0);

      // Only VERIFIED preventable counts toward the headline. An unvetted
      // classification is a claim, and this number is the pitch.
      const verifiedPreventable = mine.filter((order) => {
        const c = classByOrder.get(order.id as string);
        return c?.human_verdict === 'PREVENTABLE_SCOPE_GAP';
      });

      return {
        ...project,
        changeOrderCount: mine.length,
        changeOrderTotal: total,
        classified: mine.filter((order) => classByOrder.has(order.id as string)).length,
        verified: mine.filter((order) => classByOrder.get(order.id as string)?.human_verdict).length,
        preventableCount: verifiedPreventable.length,
        preventableAmount: verifiedPreventable.reduce(
          (sum, order) => sum + Number(order.amount ?? 0),
          0,
        ),
      };
    }),
  );
});

archaeologyRouter.post('/past-projects', requireRole('EST', 'BC', 'PM'), async (req, res) => {
  const auth = req.auth;
  if (!auth) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }

  const body = (req.body ?? {}) as Record<string, unknown>;
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name) {
    res.status(400).json({ error: 'name is required' });
    return;
  }

  const { data, error } = await supabaseForUser(auth.token)
    .from('past_project')
    .insert({
      tenant_id: auth.tenantId,
      name,
      gc_name: typeof body.gcName === 'string' ? body.gcName.trim() || null : null,
      contract_value: typeof body.contractValue === 'number' ? body.contractValue : null,
      completed_at: typeof body.completedAt === 'string' && body.completedAt ? body.completedAt : null,
      project_id: typeof body.projectId === 'string' ? body.projectId : null,
    })
    .select('*')
    .single();

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }
  res.status(201).json(data);
});

/** Change orders with whatever the archaeologist proposed and a human decided. */
archaeologyRouter.get('/past-projects/:pastProjectId/change-orders', async (req, res) => {
  const auth = req.auth;
  if (!auth) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }

  const db = supabaseForUser(auth.token);
  const { data: orders } = await db
    .from('change_order')
    .select('id, co_number, amount, description, stated_reason, issued_at')
    .eq('past_project_id', req.params.pastProjectId ?? '')
    .order('co_number');

  const ids = (orders ?? []).map((row) => row.id as string);
  const { data: classifications } = ids.length
    ? await db
        .from('co_classification')
        .select('*')
        .in('change_order_id', ids)
    : { data: [] as Record<string, unknown>[] };

  const byOrder = new Map(
    (classifications ?? []).map((row) => [row.change_order_id as string, row]),
  );

  res.json(
    (orders ?? []).map((order) => ({
      ...order,
      classification: byOrder.get(order.id as string) ?? null,
    })),
  );
});

/**
 * Imports change orders from a spreadsheet.
 *
 * A change-order log is a spreadsheet in every office in the country, and it is
 * never the same spreadsheet twice, so columns are matched by meaning.
 */
archaeologyRouter.post(
  '/past-projects/:pastProjectId/change-orders/import',
  requireRole('EST', 'BC', 'PM'),
  handleUpload,
  async (req, res) => {
    const pastProjectId = req.params.pastProjectId ?? '';
    const auth = req.auth;
    if (!auth) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }
    if (!req.file) {
      res.status(400).json({ error: 'No file was sent' });
      return;
    }

    const workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
    const rows: Record<string, unknown>[] = [];

    for (const sheetName of workbook.SheetNames) {
      const grid = XLSX.utils.sheet_to_json<unknown[]>(workbook.Sheets[sheetName]!, {
        header: 1,
        blankrows: false,
        defval: '',
      });

      // Find the header row by content, same reason as the sub list importer.
      const labels = {
        number: /^(co|co ?#|change ?order( ?#| ?no\.?)?|number|ref)$/i,
        amount: /^(amount|value|cost|total|\$)$/i,
        description: /^(description|scope|detail|title|work)$/i,
        reason: /^(reason|stated ?reason|cause|justification)$/i,
        issued: /^(date|issued|issued ?at|approved)$/i,
      };

      let headerIndex = -1;
      let best = 0;
      for (let index = 0; index < Math.min(grid.length, 15); index += 1) {
        const score = (grid[index] ?? [])
          .map(clean)
          .filter((cell) => Object.values(labels).some((pattern) => pattern.test(cell))).length;
        if (score > best) {
          best = score;
          headerIndex = index;
        }
      }
      if (best < 2 || headerIndex === -1) continue;

      const columns: Record<string, number> = {};
      (grid[headerIndex] ?? []).forEach((cell, index) => {
        const label = clean(cell);
        for (const [field, pattern] of Object.entries(labels)) {
          if (columns[field] === undefined && pattern.test(label)) columns[field] = index;
        }
      });

      for (const row of grid.slice(headerIndex + 1)) {
        const at = (field: string) =>
          columns[field] === undefined ? '' : clean(row[columns[field]!]);

        const description = at('description');
        const amount = money(at('amount'));
        if (!description && amount === null) continue;

        const raw: Record<string, unknown> = { sheet: sheetName };
        (grid[headerIndex] ?? []).forEach((label, index) => {
          const key = clean(label);
          if (key) raw[key] = clean(row[index]);
        });

        const issued = at('issued');
        const issuedDate = issued ? new Date(issued) : null;

        rows.push({
          tenant_id: auth.tenantId,
          past_project_id: pastProjectId,
          co_number: at('number') || null,
          amount,
          description: description || null,
          stated_reason: at('reason') || null,
          issued_at:
            issuedDate && !Number.isNaN(issuedDate.getTime())
              ? issuedDate.toISOString().slice(0, 10)
              : null,
          imported_at: new Date().toISOString(),
          raw_row: raw,
        });
      }
    }

    if (rows.length === 0) {
      res.status(400).json({
        error:
          'No change orders found. The sheet needs at least two recognisable columns — ' +
          'a CO number or description, and an amount.',
      });
      return;
    }

    const { data, error } = await supabaseForUser(auth.token)
      .from('change_order')
      .insert(rows)
      .select('id');

    if (error) {
      res.status(500).json({ error: error.message });
      return;
    }
    res.status(201).json({ imported: data?.length ?? 0 });
  },
);

/** P14 · Runs the archaeologist over a past project's change orders. */
archaeologyRouter.post(
  '/past-projects/:pastProjectId/classify',
  requireRole('EST', 'BC', 'PM'),
  async (req, res) => {
    const pastProjectId = req.params.pastProjectId ?? '';
    const auth = req.auth;
    if (!auth) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }

    const db = supabaseForUser(auth.token);

    const { data: past } = await db
      .from('past_project')
      .select('id, name, project_id')
      .eq('id', pastProjectId)
      .maybeSingle();

    if (!past) {
      res.status(404).json({ error: 'No such past project' });
      return;
    }

    const [{ data: changeOrders }, { data: patterns }] = await Promise.all([
      db
        .from('change_order')
        .select('id, co_number, amount, description, stated_reason, issued_at')
        .eq('past_project_id', pastProjectId),
      db.from('gap_pattern').select('id, pattern_text, typical_csi_section'),
    ]);

    // The bid set is what makes "was it in the documents" answerable.
    const { data: documents } = past.project_id
      ? await db
          .from('project_document')
          .select('storage_path, filename, kind')
          .eq('project_id', past.project_id)
          .in('kind', ['DRAWING', 'SPEC'])
          .order('size_bytes', { ascending: true })
      : { data: [] as { storage_path: string; filename: string }[] };

    const { data: run, error: runError } = await db
      .from('agent_run')
      .insert({
        tenant_id: auth.tenantId,
        agent_type: 'co_archaeology',
        status: 'QUEUED',
        input_ref: past.name,
        model: MODEL,
        prompt_version: CO_ARCHAEOLOGY_PROMPT_VERSION,
      })
      .select('id')
      .single();

    if (runError || !run) {
      res.status(500).json({ error: runError?.message ?? 'Could not create the agent run' });
      return;
    }

    const { error: jobError } = await db.from('job').insert({
      tenant_id: auth.tenantId,
      job_type: 'co_archaeology',
      agent_run_id: run.id,
      payload: {
        pastProjectId,
        changeOrders: changeOrders ?? [],
        patterns: patterns ?? [],
        bidSetPaths: (documents ?? []).map((document) => ({
          path: document.storage_path,
          filename: document.filename,
        })),
      },
    });

    if (jobError) {
      res.status(500).json({ error: jobError.message });
      return;
    }

    res.status(202).json({
      runId: run.id,
      bidSetAttached: (documents ?? []).length > 0,
      note:
        (documents ?? []).length === 0
          ? 'No bid set is linked to this past project, so every classification will be ' +
            'UNDETERMINED. Link a project with drawings or specs first.'
          : undefined,
    });
  },
);

/**
 * The human verdict. This is the point of the whole feature.
 *
 * A classification the agent produced is a claim. Only a verdict makes it a
 * finding, and only findings are counted in what a prospect is shown.
 */
archaeologyRouter.post(
  '/change-orders/:changeOrderId/verdict',
  requireRole('EST', 'PM', 'BC'),
  async (req, res) => {
    const changeOrderId = req.params.changeOrderId ?? '';
    const auth = req.auth;
    if (!auth) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }

    const rationale = readRationale(req, res);
    if (rationale === null) return;

    const body = (req.body ?? {}) as Record<string, unknown>;
    const verdict = typeof body.verdict === 'string' ? body.verdict : '';
    const allowed = [
      'PREVENTABLE_SCOPE_GAP',
      'OWNER_DIRECTED',
      'UNFORESEEN_CONDITION',
      'DESIGN_ERROR',
      'UNDETERMINED',
    ];
    if (!allowed.includes(verdict)) {
      res.status(400).json({ error: `verdict must be one of: ${allowed.join(', ')}` });
      return;
    }

    const db = supabaseForUser(auth.token);

    const { data: existing } = await db
      .from('co_classification')
      .select('id')
      .eq('change_order_id', changeOrderId)
      .maybeSingle();

    const row = {
      tenant_id: auth.tenantId,
      change_order_id: changeOrderId,
      classification: verdict,
      human_verdict: verdict,
      verified_by: auth.userId,
      verified_at: new Date().toISOString(),
      verdict_rationale: rationale,
    };

    const { error } = existing
      ? await db.from('co_classification').update(row).eq('id', existing.id)
      : await db.from('co_classification').insert(row);

    if (error) {
      res.status(500).json({ error: error.message });
      return;
    }

    await db
      .from('change_order')
      .update({ is_preventable: verdict === 'PREVENTABLE_SCOPE_GAP' })
      .eq('id', changeOrderId);

    await db.from('audit_event').insert({
      tenant_id: auth.tenantId,
      actor_id: auth.userId,
      action: 'CO_VERDICT',
      table_name: 'change_order',
      record_id: changeOrderId,
      before: null,
      after: { verdict, rationale },
    });

    res.json({ verdict, rationale });
  },
);

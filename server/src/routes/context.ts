import { Router } from 'express';
import { MODEL } from '../lib/anthropic.js';
import { requireRole } from '../lib/auth.js';
import { SCOPE_CONTEXT_PROMPT_VERSION } from '../agents/scope-context.js';
import { SCOPE_TEMPLATE, templateFor } from '../lib/scope-template.js';
import { supabaseForUser } from '../lib/supabase.js';

export const contextRouter = Router();

const KINDS = [
  'INCLUSION',
  'EXCLUSION',
  'INTERFACE',
  'ASSUMPTION',
  'RISK',
  'BASIS_OF_DESIGN',
];

/**
 * The context on one scope item, with its track record.
 *
 * The track record is the point. A line that says "deflection track at head of
 * full-height partitions" is an opinion the first time somebody writes it and a
 * rule by the fourth project where leaving it out cost money. Showing the count
 * next to the line is what lets an estimator tell those two apart, and it is
 * the only honest way to present something an agent proposed.
 */
contextRouter.get('/scope-items/:scopeItemId/context', async (req, res) => {
  const scopeItemId = req.params.scopeItemId ?? '';
  const auth = req.auth;
  if (!auth) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }

  const db = supabaseForUser(auth.token);

  const [{ data: lines }, { data: outcomes }] = await Promise.all([
    db
      .from('scope_context')
      .select('*')
      .eq('scope_item_id', scopeItemId)
      .order('position')
      .order('created_at'),
    db
      .from('scope_context_outcome')
      .select('context_id, outcome, amount, note, recorded_at')
      .eq('scope_item_id', scopeItemId),
  ]);

  const patternIds = [
    ...new Set(
      (lines ?? []).map((line) => line.gap_pattern_id as string | null).filter(Boolean) as string[],
    ),
  ];

  const { data: patterns } = patternIds.length
    ? await db
        .from('gap_pattern')
        .select('id, text, division, csi_section, times_proposed, times_confirmed')
        .in('id', patternIds)
    : { data: [] as Record<string, unknown>[] };

  const patternById = new Map((patterns ?? []).map((row) => [row.id as string, row]));

  const scored = (lines ?? []).map((line) => {
    const mine = (outcomes ?? []).filter((row) => row.context_id === line.id);
    return {
      ...line,
      pattern: patternById.get(line.gap_pattern_id as string) ?? null,
      record: {
        caughtGap: mine.filter((row) => row.outcome === 'CAUGHT_GAP').length,
        pricedByAll: mine.filter((row) => row.outcome === 'PRICED_BY_ALL').length,
        excludedByBidder: mine.filter((row) => row.outcome === 'EXCLUDED_BY_BIDDER').length,
        changeOrders: mine.filter((row) => row.outcome === 'CHANGE_ORDER').length,
      },
    };
  });

  // Gaps that opened on this item with nothing written against them. This is
  // the list a human turns into new context, and it is the loop closing.
  const missed = (outcomes ?? []).filter((row) => row.outcome === 'MISSED_GAP');

  res.json({ lines: scored, missed });
});

/** An estimator writing their own context line. */
contextRouter.post(
  '/scope-items/:scopeItemId/context',
  requireRole('EST', 'BC', 'PM'),
  async (req, res) => {
    const scopeItemId = req.params.scopeItemId ?? '';
    const auth = req.auth;
    if (!auth) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }

    const body = (req.body ?? {}) as Record<string, unknown>;
    const kind = typeof body.kind === 'string' ? body.kind : '';
    const text = typeof body.text === 'string' ? body.text.trim() : '';

    if (!KINDS.includes(kind)) {
      res.status(400).json({ error: `kind must be one of ${KINDS.join(', ')}` });
      return;
    }
    if (text === '') {
      res.status(400).json({ error: 'text is required' });
      return;
    }

    const db = supabaseForUser(auth.token);

    const { data: existing } = await db
      .from('scope_context')
      .select('position')
      .eq('scope_item_id', scopeItemId)
      .order('position', { ascending: false })
      .limit(1)
      .maybeSingle();

    const { data: line, error } = await db
      .from('scope_context')
      .insert({
        tenant_id: auth.tenantId,
        scope_item_id: scopeItemId,
        kind,
        text,
        origin: 'HUMAN',
        source_location:
          typeof body.sourceLocation === 'string' ? body.sourceLocation.trim() || null : null,
        confidence: null,
        position: Number(existing?.position ?? 0) + 1,
        created_by: auth.userId,
      })
      .select('*')
      .single();

    if (error) {
      res.status(400).json({ error: error.message });
      return;
    }

    // An estimator writing context by hand is a labelled correction: it says
    // the drafter should have produced this and did not. That is the highest
    // quality training signal in the system, so it is recorded as one.
    await db.from('scope_context_outcome').insert({
      tenant_id: auth.tenantId,
      scope_item_id: scopeItemId,
      context_id: line.id,
      outcome: 'HUMAN_ADDED',
      evidence_table: 'scope_context',
      evidence_id: line.id,
      note: `${kind} written by hand`,
      recorded_by: auth.userId,
    });

    res.status(201).json(line);
  },
);

/**
 * Retires a context line rather than deleting it.
 *
 * The outcomes already recorded against it stay meaningful, and "we used to say
 * this and stopped" is itself worth knowing — a line retired on three projects
 * running is a pattern that should come out of the knowledge base.
 */
contextRouter.post(
  '/context/:contextId/retire',
  requireRole('EST', 'BC'),
  async (req, res) => {
    const contextId = req.params.contextId ?? '';
    const auth = req.auth;
    if (!auth) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }

    const reason =
      typeof (req.body ?? {}).reason === 'string' ? String(req.body.reason).trim() : '';
    if (reason === '') {
      res.status(400).json({ error: 'A reason is required to retire a context line.' });
      return;
    }

    const db = supabaseForUser(auth.token);

    const { data: line, error } = await db
      .from('scope_context')
      .update({ is_active: false, retired_reason: reason })
      .eq('id', contextId)
      .select('*')
      .single();

    if (error) {
      res.status(400).json({ error: error.message });
      return;
    }

    await db.from('scope_context_outcome').insert({
      tenant_id: auth.tenantId,
      scope_item_id: line.scope_item_id,
      context_id: line.id,
      outcome: 'HUMAN_REMOVED',
      evidence_table: 'scope_context',
      evidence_id: line.id,
      note: reason,
      recorded_by: auth.userId,
    });

    res.json(line);
  },
);

/**
 * Drafts context for a project's scope items.
 *
 * The route assembles the grounding — division patterns and past change orders
 * for the sections in play — rather than the agent going and fetching it, so
 * that what the model was given is recorded in the job payload and a bad
 * result can be traced back to what it actually saw.
 */
contextRouter.post(
  '/projects/:projectId/draft-context',
  requireRole('EST', 'BC'),
  async (req, res) => {
    const projectId = req.params.projectId ?? '';
    const auth = req.auth;
    if (!auth) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }

    const body = (req.body ?? {}) as { scopeItemIds?: string[] };
    const db = supabaseForUser(auth.token);

    let query = db
      .from('scope_item')
      .select('id, scope_id, csi_division, csi_section, title, description, quantity, unit')
      .eq('project_id', projectId);

    if (Array.isArray(body.scopeItemIds) && body.scopeItemIds.length > 0) {
      query = query.in('id', body.scopeItemIds);
    }

    const { data: items } = await query.order('csi_division').order('scope_id');

    if (!items || items.length === 0) {
      res.status(400).json({ error: 'No scope items to write context for' });
      return;
    }

    const divisions = [
      ...new Set(items.map((item) => item.csi_division as string | null).filter(Boolean)),
    ] as string[];
    const sections = [
      ...new Set(items.map((item) => item.csi_section as string | null).filter(Boolean)),
    ] as string[];

    const [{ data: patterns }, { data: changeOrders }] = await Promise.all([
      divisions.length
        ? db
            .from('gap_pattern')
            .select('id, division, csi_section, text, frequent_change_order, times_proposed, times_confirmed')
            .in('division', divisions)
        : Promise.resolve({ data: [] as Record<string, unknown>[] }),
      sections.length
        ? db
            .from('co_classification')
            .select(
              'classification, reasoning, change_order:change_order_id (description, stated_reason, csi_section)',
            )
            .limit(60)
        : Promise.resolve({ data: [] as Record<string, unknown>[] }),
    ]);

    const history = (changeOrders ?? [])
      .map((row) => {
        const order = row.change_order as Record<string, unknown> | null;
        return {
          section: (order?.csi_section as string | null) ?? null,
          description: (order?.description as string | null) ?? '',
          statedReason: (order?.stated_reason as string | null) ?? null,
          classification: (row.classification as string | null) ?? null,
        };
      })
      .filter((entry) => entry.description !== '' && (entry.section === null || sections.includes(entry.section)));

    const { data: run, error: runError } = await db
      .from('agent_run')
      .insert({
        tenant_id: auth.tenantId,
        agent_type: 'draft_scope_context',
        project_id: projectId,
        status: 'QUEUED',
        input_ref: `${items.length} scope items`,
        model: MODEL,
        prompt_version: SCOPE_CONTEXT_PROMPT_VERSION,
      })
      .select('id')
      .single();

    if (runError || !run) {
      res.status(500).json({ error: runError?.message ?? 'Could not create the agent run' });
      return;
    }

    const { error: jobError } = await db.from('job').insert({
      tenant_id: auth.tenantId,
      job_type: 'draft_scope_context',
      agent_run_id: run.id,
      payload: {
        projectId,
        scopeItems: items.map((item) => ({
          id: item.id,
          scopeId: item.scope_id,
          csiDivision: item.csi_division,
          csiSection: item.csi_section,
          title: item.title,
          description: item.description,
          quantity: item.quantity,
          unit: item.unit,
        })),
        patterns: (patterns ?? []).map((pattern) => ({
          id: pattern.id,
          division: pattern.division,
          section: pattern.csi_section,
          text: pattern.text,
          frequentChangeOrder: pattern.frequent_change_order ?? false,
          timesProposed: pattern.times_proposed ?? 0,
          timesConfirmed: pattern.times_confirmed ?? 0,
        })),
        history,
      },
    });

    if (jobError) {
      res.status(500).json({ error: jobError.message });
      return;
    }

    // Proposing a pattern is what makes its confirmation rate meaningful later.
    for (const pattern of patterns ?? []) {
      await db
        .from('gap_pattern')
        .update({ times_proposed: Number(pattern.times_proposed ?? 0) + 1 })
        .eq('id', pattern.id);
    }

    res.status(202).json({
      runId: run.id,
      scopeItems: items.length,
      patterns: (patterns ?? []).length,
      history: history.length,
    });
  },
);

/**
 * What the system has learned, across every project in the tenant.
 *
 * The missed gaps are the useful half. Each one is a seam nobody wrote down
 * before it cost money, and turning them into gap patterns is the manual step
 * that makes the next project's draft better — deliberately manual, because a
 * system that promotes its own failures into rules unsupervised gets worse in
 * a way nobody notices until it is expensive.
 */
contextRouter.get('/context/learning', async (req, res) => {
  const auth = req.auth;
  if (!auth) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }

  const db = supabaseForUser(auth.token);

  const { data: outcomes } = await db
    .from('scope_context_outcome')
    .select('id, scope_item_id, context_id, outcome, amount, note, recorded_at')
    .order('recorded_at', { ascending: false })
    .limit(500);

  const scopeIds = [...new Set((outcomes ?? []).map((row) => row.scope_item_id as string))];

  const { data: items } = scopeIds.length
    ? await db
        .from('scope_item')
        .select('id, scope_id, csi_division, csi_section, title')
        .in('id', scopeIds)
    : { data: [] as Record<string, unknown>[] };

  const itemById = new Map((items ?? []).map((row) => [row.id as string, row]));

  const counted = (outcome: string) =>
    (outcomes ?? []).filter((row) => row.outcome === outcome).length;

  res.json({
    summary: {
      caughtGap: counted('CAUGHT_GAP'),
      missedGap: counted('MISSED_GAP'),
      pricedByAll: counted('PRICED_BY_ALL'),
      humanAdded: counted('HUMAN_ADDED'),
      humanRemoved: counted('HUMAN_REMOVED'),
    },
    missed: (outcomes ?? [])
      .filter((row) => row.outcome === 'MISSED_GAP')
      .map((row) => ({ ...row, scope: itemById.get(row.scope_item_id as string) ?? null })),
  });
});

// -----------------------------------------------------------------------------
// Starting from the standard containers
// -----------------------------------------------------------------------------

/** What the template offers, so the client can show it before committing to it. */
contextRouter.get('/scope-template', (_req, res) => {
  res.json(
    SCOPE_TEMPLATE.map((division) => ({
      code: division.code,
      packageName: division.packageName,
      items: division.items.length,
      titles: division.items.map((item) => item.title),
    })),
  );
});

/**
 * Creates the standard scope containers for the divisions asked for.
 *
 * A human act, not an agent one — nothing here is proposed, reviewed or
 * promoted, because a template is a starting structure somebody chose rather
 * than a claim about this project. That is also why it carries no quantities:
 * the shape of a plumbing package is knowledge, how much pipe is on THIS job
 * is a measurement, and only one of those can be shipped in a template (R1).
 *
 * Idempotent on title within a division, so running it twice does not double
 * the baseline and adding a division later leaves the others alone.
 */
contextRouter.post(
  '/projects/:projectId/scope-template',
  requireRole('EST', 'BC'),
  async (req, res) => {
    const projectId = req.params.projectId ?? '';
    const auth = req.auth;
    if (!auth) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }

    const body = (req.body ?? {}) as { divisions?: string[]; createPackages?: boolean };
    const wanted = Array.isArray(body.divisions) ? body.divisions : [];

    if (wanted.length === 0) {
      res.status(400).json({ error: 'Pick at least one division to start from' });
      return;
    }

    const db = supabaseForUser(auth.token);

    const { data: project } = await db
      .from('project')
      .select('bid_id')
      .eq('id', projectId)
      .maybeSingle();

    if (!project) {
      res.status(404).json({ error: 'No such project' });
      return;
    }

    const [{ data: existingItems }, { data: existingPackages }] = await Promise.all([
      db
        .from('scope_item')
        .select('id, scope_id, csi_division, title')
        .eq('project_id', projectId),
      db.from('work_package').select('id, lead_division, name').eq('project_id', projectId),
    ]);

    const already = new Set(
      (existingItems ?? []).map(
        (item) => `${item.csi_division}|${String(item.title).toLowerCase().trim()}`,
      ),
    );

    // Continue the existing numbering rather than restarting it, so scope ids
    // stay unique and stay meaningful.
    const nextSeq = new Map<string, number>();
    for (const item of existingItems ?? []) {
      const division = String(item.csi_division ?? '');
      const tail = Number(String(item.scope_id ?? '').split('-').pop());
      if (Number.isFinite(tail)) {
        nextSeq.set(division, Math.max(nextSeq.get(division) ?? 0, tail));
      }
    }

    const packageByDivision = new Map(
      (existingPackages ?? []).map((pkg) => [pkg.lead_division as string, pkg.id as string]),
    );

    let createdItems = 0;
    let createdPackages = 0;
    let createdContext = 0;
    let skipped = 0;

    for (const code of wanted) {
      const division = templateFor(code);
      if (!division) continue;

      let packageId = packageByDivision.get(code) ?? null;

      if (!packageId && body.createPackages !== false) {
        const { data: pkg } = await db
          .from('work_package')
          .insert({
            tenant_id: auth.tenantId,
            project_id: projectId,
            name: division.packageName,
            lead_division: code,
            csi_divisions: [code],
            status: 'DRAFT',
          })
          .select('id')
          .single();

        if (pkg) {
          packageId = pkg.id as string;
          packageByDivision.set(code, packageId);
          createdPackages += 1;
        }
      }

      for (const item of division.items) {
        if (already.has(`${code}|${item.title.toLowerCase().trim()}`)) {
          skipped += 1;
          continue;
        }

        const seq = (nextSeq.get(code) ?? 0) + 1;
        nextSeq.set(code, seq);

        const { data: created, error } = await db
          .from('scope_item')
          .insert({
            tenant_id: auth.tenantId,
            project_id: projectId,
            scope_id: `${project.bid_id}-${code}-${String(seq).padStart(3, '0')}`,
            csi_division: code,
            csi_section: item.section,
            title: item.title,
            description: item.description,
            unit: item.unit,
            // Never a quantity. See the note on SCOPE_TEMPLATE.
            quantity: null,
            quantity_basis: null,
          })
          .select('id')
          .single();

        if (error || !created) continue;
        createdItems += 1;

        if (packageId) {
          await db.from('package_scope').insert({
            tenant_id: auth.tenantId,
            package_id: packageId,
            scope_item_id: created.id,
          });
        }

        if (item.context.length > 0) {
          const { error: contextError } = await db.from('scope_context').insert(
            item.context.map((line, index) => ({
              tenant_id: auth.tenantId,
              scope_item_id: created.id,
              kind: line.kind,
              text: line.text,
              origin: 'PATTERN',
              source_location: 'standard scope template',
              position: index + 1,
              created_by: auth.userId,
            })),
          );
          if (!contextError) createdContext += item.context.length;
        }
      }
    }

    await db.from('audit_event').insert({
      tenant_id: auth.tenantId,
      actor_id: auth.userId,
      action: 'APPLY_SCOPE_TEMPLATE',
      table_name: 'scope_item',
      record_id: projectId,
      before: null,
      after: { divisions: wanted, createdItems, createdPackages, createdContext, skipped },
    });

    res.status(201).json({ createdItems, createdPackages, createdContext, skipped });
  },
);

/**
 * Turns something the system missed into something it will look for.
 *
 * MISSED_GAP rows are the corpus: each one is a seam nobody wrote down before it
 * cost money. Until now they accumulated and nothing could act on them, so the
 * learning loop ran exactly half — it recorded that it had been wrong and had no
 * way to become less wrong.
 *
 * Deliberately manual. A system that promoted its own failures into rules
 * unsupervised gets worse in a way nobody notices until it is expensive: one
 * mis-detected gap becomes a pattern, the pattern fires on every job, and the
 * warnings stop being read. A person decides what is a real pattern.
 */
contextRouter.post(
  '/context/outcomes/:outcomeId/promote',
  requireRole('EST', 'BC'),
  async (req, res) => {
    const outcomeId = req.params.outcomeId ?? '';
    const auth = req.auth;
    if (!auth) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }

    const body = (req.body ?? {}) as Record<string, unknown>;
    const text = typeof body.text === 'string' ? body.text.trim() : '';

    if (text === '') {
      res.status(400).json({
        error: 'Write the pattern in the words you would want to read on the next job.',
      });
      return;
    }

    const db = supabaseForUser(auth.token);

    const { data: outcome } = await db
      .from('scope_context_outcome')
      .select('id, scope_item_id, outcome, note')
      .eq('id', outcomeId)
      .maybeSingle();

    if (!outcome) {
      res.status(404).json({ error: 'No such outcome' });
      return;
    }

    if (outcome.outcome !== 'MISSED_GAP') {
      res.status(400).json({
        error: 'Only a missed gap becomes a pattern. The others are already covered by one.',
      });
      return;
    }

    const { data: item } = await db
      .from('scope_item')
      .select('csi_division, csi_section, title')
      .eq('id', outcome.scope_item_id)
      .maybeSingle();

    const division = (item?.csi_division as string | null) ?? null;
    if (!division) {
      res.status(400).json({
        error: 'That scope item has no CSI division, so there is nowhere to file the pattern.',
      });
      return;
    }

    // gap_pattern hangs off a division_expert, so the division needs one. It is
    // created as a stub if missing rather than refusing — a tenant should not
    // have to seed the knowledge base before recording something they learned.
    const { data: expert } = await db
      .from('division_expert')
      .select('id')
      .eq('csi_division', division)
      .maybeSingle();

    let expertId = expert?.id as string | undefined;

    if (!expertId) {
      const { data: made } = await db
        .from('division_expert')
        .insert({ csi_division: division, title: `Division ${division}`, status: 'SEED_STUB' })
        .select('id')
        .single();
      expertId = made?.id as string | undefined;
    }

    if (!expertId) {
      res.status(500).json({ error: 'Could not file the pattern against a division' });
      return;
    }

    const { data: pattern, error } = await db
      .from('gap_pattern')
      .insert({
        division_expert_id: expertId,
        pattern_text: text,
        typical_csi_section: (item?.csi_section as string | null) ?? division,
        is_frequent_change_order: body.frequentChangeOrder === true,
        detection_hint:
          typeof body.detectionHint === 'string' ? body.detectionHint.trim() || null : null,
        // Starts at one proposal and one confirmation: it came from something
        // that actually happened, which is more than any seeded pattern can say.
        times_proposed: 1,
        times_confirmed: 1,
        last_confirmed_at: new Date().toISOString(),
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
      action: 'PROMOTE_GAP_PATTERN',
      table_name: 'gap_pattern',
      record_id: pattern.id,
      before: { fromOutcome: outcomeId, note: outcome.note },
      after: { division, text },
    });

    res.status(201).json(pattern);
  },
);

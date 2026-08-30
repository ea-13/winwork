import { Router } from 'express';
import * as XLSX from 'xlsx';
import { requireRole } from '../lib/auth.js';
import { supabaseForUser } from '../lib/supabase.js';

export const hindsightRouter = Router();

/**
 * P14 · Hindsight — would we have caught it?
 *
 * Not a change-order tracker. A BACKTEST:
 *
 *   Take a job that is already finished. Load its bid set and its bids as if it
 *   were precon. Run gap detection. Then put the real change-order list next to
 *   the gaps we flagged.
 *
 * "Of your 31 change orders, 19 were scope gaps, and we would have flagged 14 of
 * them worth $340k before you bought the job" is a different conversation from
 * "here is a tool". It is also the only honest way to calibrate: gap_pattern has
 * carried times_proposed and times_confirmed since 0012 and nothing has ever
 * confirmed one against reality.
 *
 * The verdicts are HUMAN. A model may propose which scope item a change order
 * landed on, and a human confirms it — because "we would have caught this" is a
 * claim made in a room to somebody who ran that job, and a claim resting on a
 * model's guess is one that falls apart the first time it is questioned.
 *
 * Once buyout is complete this tool is finished. Tracking change orders during
 * construction is a different product living somewhere else.
 */

// Importing change orders is NOT here. `archaeology.ts` already owns
// POST /past-projects/:id/change-orders/import and takes a real spreadsheet,
// which is the form a CO list actually arrives in. A second JSON-shaped import
// on the same path was silently shadowed by it — the kind of duplicate that
// looks like it works until somebody uses the wrong one.

/**
 * The comparison itself.
 *
 * Reads the change orders against the gaps detected on the linked precon
 * project, and reports what would have been caught, what was missed, and what
 * was never ours to catch.
 *
 * Nothing here is computed from a model. It is a join over what a human has
 * already verdicted, because the number that goes in front of a GC has to be
 * one somebody stood behind.
 */
hindsightRouter.get('/past-projects/:pastProjectId/hindsight', async (req, res) => {
  const pastProjectId = req.params.pastProjectId ?? '';
  const auth = req.auth;
  if (!auth) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }

  const db = supabaseForUser(auth.token);

  const { data: past } = await db
    .from('past_project')
    .select('id, name, gc_name, contract_value, completed_at, project_id, notes')
    .eq('id', pastProjectId)
    .maybeSingle();

  if (!past) {
    res.status(404).json({ error: 'No such past project' });
    return;
  }

  const { data: changeOrders } = await db
    .from('change_order')
    .select('id, co_number, amount, description, stated_reason, scope_item_id, matched_gap_id, hindsight, hindsight_note')
    .eq('past_project_id', pastProjectId)
    .order('co_number');

  const orders = changeOrders ?? [];

  // The gaps we would have flagged, if this past project has been reconstructed
  // as a real precon project.
  const { data: packages } = past.project_id
    ? await db.from('work_package').select('id').eq('project_id', past.project_id)
    : { data: [] as Record<string, unknown>[] };

  const packageIds = (packages ?? []).map((row) => row.id as string);

  const { data: gaps } = packageIds.length
    ? await db
        .from('scope_gap')
        .select('id, scope_item_id, gap_type, severity, exposure_amount, package_id')
        .in('package_id', packageIds)
    : { data: [] as Record<string, unknown>[] };

  // The two halves of the answer this screen exists to give.
  //
  //   What the scope of work includes — the baseline reconstructed from the
  //   drawings and specs of a job that is already finished.
  //   What the bidders missed — the scope in that baseline nobody priced.
  //
  // Both are read from the linked project, because "load its bid set as if it
  // were precon" is not a metaphor: it is a real project in this system, run
  // through the same chain as a live one. If nothing is linked, both are empty
  // and the screen says so rather than showing zeroes as though they were
  // findings.
  const { data: allScope } = past.project_id
    ? await db
        .from('scope_item')
        .select('id, scope_id, csi_division, title, is_locked')
        .eq('project_id', past.project_id)
    : { data: [] as Record<string, unknown>[] };

  const scopeRows = (allScope ?? []) as {
    id: string;
    scope_id: string;
    csi_division: string | null;
    title: string;
    is_locked: boolean;
  }[];

  const byDivision = new Map<string, { division: string; items: number; gaps: number }>();
  for (const item of scopeRows) {
    const division = item.csi_division ?? '—';
    const entry = byDivision.get(division) ?? { division, items: 0, gaps: 0 };
    entry.items += 1;
    byDivision.set(division, entry);
  }

  const scopeIndex = new Map(scopeRows.map((item) => [item.id, item]));

  // A gap a change order landed on is the whole argument: it was missed at bid
  // time, and it came back as money. Anything else is a gap that was caught in
  // precon or never mattered, and conflating the two would inflate the claim.
  const gapsWithCO = new Set(
    orders.map((order) => order.matched_gap_id as string | null).filter(Boolean) as string[],
  );

  const missedScope = (gaps ?? []).map((gap) => {
    const item = scopeIndex.get(gap.scope_item_id as string);
    if (item) {
      const entry = byDivision.get(item.csi_division ?? '—');
      if (entry) entry.gaps += 1;
    }
    return {
      id: gap.id as string,
      severity: (gap.severity as string | null) ?? null,
      gapType: (gap.gap_type as string | null) ?? null,
      exposure: gap.exposure_amount === null ? null : Number(gap.exposure_amount),
      scopeId: item?.scope_id ?? null,
      division: item?.csi_division ?? null,
      title: item?.title ?? null,
      // Did this one actually come back as a change order?
      becameChangeOrder: gapsWithCO.has(gap.id as string),
    };
  });

  const scopeIds = [
    ...new Set(orders.map((order) => order.scope_item_id as string | null).filter(Boolean)),
  ] as string[];

  const { data: scopeItems } = scopeIds.length
    ? await db.from('scope_item').select('id, scope_id, csi_division, title').in('id', scopeIds)
    : { data: [] as Record<string, unknown>[] };

  const scopeById = new Map((scopeItems ?? []).map((row) => [row.id as string, row]));

  const money = (rows: typeof orders) =>
    rows.reduce((sum, row) => sum + Number(row.amount ?? 0), 0);

  const predicted = orders.filter((order) => order.hindsight === 'PREDICTED');
  const missed = orders.filter((order) => order.hindsight === 'MISSED');
  const notOurs = orders.filter((order) => order.hindsight === 'NOT_PREVENTABLE');
  const unreviewed = orders.filter((order) => order.hindsight === 'UNREVIEWED');

  // Preventable is what the product claims to address: the ones that were scope
  // gaps, whether or not we flagged them.
  const preventable = predicted.length + missed.length;
  const preventableValue = money(predicted) + money(missed);

  res.json({
    pastProject: past,
    detectedGaps: (gaps ?? []).length,
    /** What the scope of work includes, reconstructed from the bid set. */
    scope: {
      total: scopeRows.length,
      locked: scopeRows.filter((item) => item.is_locked).length,
      byDivision: [...byDivision.values()].sort((a, b) => a.division.localeCompare(b.division)),
    },
    /** What the bidders missed — scope in that baseline nobody priced. */
    missedScope: missedScope.sort((a, b) => {
      const rank = (severity: string | null) =>
        severity === 'CRITICAL' ? 0 : severity === 'HIGH' ? 1 : severity === 'MEDIUM' ? 2 : 3;
      return (
        Number(b.becameChangeOrder) - Number(a.becameChangeOrder) ||
        rank(a.severity) - rank(b.severity) ||
        (b.exposure ?? 0) - (a.exposure ?? 0)
      );
    }),
    totals: {
      changeOrders: orders.length,
      value: money(orders),
      preventable,
      preventableValue,
      predicted: predicted.length,
      predictedValue: money(predicted),
      missed: missed.length,
      missedValue: money(missed),
      notPreventable: notOurs.length,
      unreviewed: unreviewed.length,
      // The headline, and deliberately null until enough is reviewed to mean
      // anything. A hit rate over three reviewed change orders is not a hit
      // rate, and quoting one would be the fastest way to lose the room.
      catchRate:
        preventable >= 5 ? Math.round((predicted.length / preventable) * 100) : null,
    },
    changeOrders: orders.map((order) => ({
      ...order,
      scope: scopeById.get(order.scope_item_id as string) ?? null,
    })),
  });
});

/**
 * One human verdict on one change order.
 *
 * PREDICTED requires a gap to point at. Claiming we caught something without
 * naming the row that caught it is the claim that cannot survive being asked
 * "which one?".
 */
hindsightRouter.post(
  '/change-orders/:changeOrderId/hindsight',
  requireRole('EST', 'BC', 'PM'),
  async (req, res) => {
    const changeOrderId = req.params.changeOrderId ?? '';
    const auth = req.auth;
    if (!auth) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }

    const body = (req.body ?? {}) as Record<string, unknown>;
    const VERDICTS = ['UNREVIEWED', 'PREDICTED', 'MISSED', 'NOT_PREVENTABLE'];
    const verdict = typeof body.hindsight === 'string' ? body.hindsight : '';

    if (!VERDICTS.includes(verdict)) {
      res.status(400).json({ error: `hindsight must be one of ${VERDICTS.join(', ')}` });
      return;
    }

    const matchedGapId = typeof body.matchedGapId === 'string' ? body.matchedGapId : null;

    if (verdict === 'PREDICTED' && !matchedGapId) {
      res.status(400).json({
        error:
          'PREDICTED needs the gap that predicted it. "We would have caught this" without naming ' +
          'the row is a claim that cannot survive being asked which one.',
      });
      return;
    }

    const db = supabaseForUser(auth.token);

    const { data, error } = await db
      .from('change_order')
      .update({
        hindsight: verdict,
        matched_gap_id: verdict === 'PREDICTED' ? matchedGapId : null,
        scope_item_id: typeof body.scopeItemId === 'string' ? body.scopeItemId : null,
        hindsight_note: typeof body.note === 'string' ? body.note.trim() || null : null,
        reviewed_by: auth.userId,
        reviewed_at: new Date().toISOString(),
      })
      .eq('id', changeOrderId)
      .select('*')
      .single();

    if (error) {
      res.status(400).json({ error: error.message });
      return;
    }

    // A confirmed catch is the only thing in the system that has ever confirmed
    // a gap pattern against reality. This is where times_confirmed earns its
    // meaning (0012).
    if (verdict === 'PREDICTED' && matchedGapId) {
      const { data: gap } = await db
        .from('scope_gap')
        .select('division_pattern_id')
        .eq('id', matchedGapId)
        .maybeSingle();

      if (gap?.division_pattern_id) {
        const { data: pattern } = await db
          .from('gap_pattern')
          .select('times_confirmed')
          .eq('id', gap.division_pattern_id)
          .maybeSingle();

        if (pattern) {
          await db
            .from('gap_pattern')
            .update({
              times_confirmed: Number(pattern.times_confirmed ?? 0) + 1,
              last_confirmed_at: new Date().toISOString(),
            })
            .eq('id', gap.division_pattern_id);
        }
      }
    }

    await db.from('audit_event').insert({
      tenant_id: auth.tenantId,
      actor_id: auth.userId,
      action: 'HINDSIGHT_VERDICT',
      table_name: 'change_order',
      record_id: changeOrderId,
      before: null,
      after: { hindsight: verdict, matchedGapId },
    });

    res.json(data);
  },
);

/**
 * The artefact a prospect asks for a copy of.
 *
 * Only reviewed change orders appear. An unreviewed one is a row nobody has
 * looked at, and including it would let the export imply a verdict that does
 * not exist.
 */
hindsightRouter.get('/past-projects/:pastProjectId/hindsight.xlsx', async (req, res) => {
  const pastProjectId = req.params.pastProjectId ?? '';
  const auth = req.auth;
  if (!auth) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }

  const db = supabaseForUser(auth.token);

  const [{ data: past }, { data: orders }] = await Promise.all([
    db.from('past_project').select('name, gc_name, contract_value, completed_at').eq('id', pastProjectId).maybeSingle(),
    db
      .from('change_order')
      .select('co_number, amount, description, stated_reason, hindsight, hindsight_note')
      .eq('past_project_id', pastProjectId)
      .neq('hindsight', 'UNREVIEWED'),
  ]);

  if (!past) {
    res.status(404).json({ error: 'No such past project' });
    return;
  }

  const rows = orders ?? [];
  const value = (verdict: string) =>
    rows.filter((row) => row.hindsight === verdict).reduce((sum, row) => sum + Number(row.amount ?? 0), 0);

  const predicted = rows.filter((row) => row.hindsight === 'PREDICTED').length;
  const missed = rows.filter((row) => row.hindsight === 'MISSED').length;

  const summary = [
    ['WinProjects — Hindsight review'],
    [],
    ['Project', past.name],
    ['General contractor', past.gc_name ?? ''],
    ['Completed', past.completed_at ?? ''],
    ['Reviewed', new Date().toISOString().slice(0, 10)],
    [],
    ['Change orders reviewed', rows.length],
    ['Scope gaps we would have flagged', predicted],
    ['Value we would have flagged', value('PREDICTED')],
    ['Scope gaps we would have missed', missed],
    ['Value missed', value('MISSED')],
    ['Not preventable at precon', rows.filter((row) => row.hindsight === 'NOT_PREVENTABLE').length],
    [],
    [
      'Note',
      'Every verdict in this file was made by a person reviewing the change order against the ' +
        'scope gaps detected at precon. None was assigned by software.',
    ],
  ];

  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(summary), 'Summary');
  XLSX.utils.book_append_sheet(
    book,
    XLSX.utils.json_to_sheet(
      rows.map((row) => ({
        'CO number': row.co_number ?? '',
        Amount: row.amount ?? '',
        Description: row.description ?? '',
        'Reason given': row.stated_reason ?? '',
        Verdict: row.hindsight,
        'Reviewer note': row.hindsight_note ?? '',
      })),
    ),
    'Change orders',
  );

  const buffer = XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }) as Buffer;

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="hindsight-${past.name}.xlsx"`);
  res.send(buffer);
});

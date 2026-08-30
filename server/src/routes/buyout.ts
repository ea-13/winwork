import { Router } from 'express';
import * as XLSX from 'xlsx';
import { supabaseForUser } from '../lib/supabase.js';

export const buyoutRouter = Router();

type Package = {
  id: string;
  name: string;
  lead_division: string | null;
  csi_divisions: string[] | null;
  status: string;
  notes: string | null;
  budget_amount: number | null;
  allowance_amount: number | null;
  contingency_amount: number | null;
};

/**
 * P27 · The buyout log.
 *
 * What an estimator actually lives in: what each package was budgeted at, what
 * it is being bought for, and what is still open against it.
 *
 * Variance is measured against the ADJUSTED value, not the quoted one. A
 * package bought at $503k that carries $81k of uncosted exclusions has not come
 * in under budget, and a buyout log that says otherwise is the spreadsheet this
 * product exists to replace.
 *
 * It is a report, not a worksheet. Every gap nobody priced comes back with it,
 * because the number at the bottom of a buyout log is only defensible if the
 * things nobody carried are sitting underneath it — either priced as an
 * allowance, held as contingency, or accepted in writing.
 */
buyoutRouter.get('/projects/:projectId/buyout', async (req, res) => {
  const projectId = req.params.projectId ?? '';
  const auth = req.auth;
  if (!auth) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }

  const db = supabaseForUser(auth.token);

  const { data: packages } = await db
    .from('work_package')
    .select(
      'id, name, lead_division, csi_divisions, status, notes, budget_amount, allowance_amount, contingency_amount',
    )
    .eq('project_id', projectId)
    .order('lead_division');

  const packageIds = (packages ?? []).map((row) => row.id as string);
  if (packageIds.length === 0) {
    res.json({ rows: [], totals: null });
    return;
  }

  const [{ data: leveling }, { data: gaps }, { data: selections }, { data: quotes }, { data: subs }] =
    await Promise.all([
      db.from('leveling_result').select('*').in('package_id', packageIds),
      db.from('scope_gap').select('*').in('package_id', packageIds),
      db.from('selection').select('package_id, quote_id, selected_at').in('package_id', packageIds),
      db
        .from('quote')
        .select('id, package_id, subcontractor_id, quoted_total')
        .in('package_id', packageIds),
      db.from('subcontractor').select('id, name'),
    ]);

  const scopeIds = [...new Set((gaps ?? []).map((gap) => gap.scope_item_id as string))];
  const { data: scopeItems } = scopeIds.length
    ? await db
        .from('scope_item')
        .select('id, scope_id, csi_division, csi_section, title, unit, quantity')
        .in('id', scopeIds)
    : { data: [] as Record<string, unknown>[] };

  const subName = new Map((subs ?? []).map((row) => [row.id as string, row.name as string]));
  const quoteById = new Map((quotes ?? []).map((row) => [row.id as string, row]));
  const scopeById = new Map((scopeItems ?? []).map((row) => [row.id as string, row]));

  const severityOrder = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 } as Record<string, number>;

  const rows = (packages ?? []).map((pkg: Package) => {
    const selection = (selections ?? []).find((row) => row.package_id === pkg.id);
    const results = (leveling ?? []).filter((row) => row.package_id === pkg.id);

    // The selected bidder if one has been chosen (H6), otherwise the leading
    // one — clearly labelled as advisory, because nothing is awarded here.
    const chosen = selection
      ? results.find((row) => row.quote_id === selection.quote_id)
      : results.find((row) => row.advisory_rank === 1);

    const packageGaps = (gaps ?? [])
      .filter((row) => row.package_id === pkg.id)
      .map((gap) => {
        const scope = scopeById.get(gap.scope_item_id as string);
        return {
          id: gap.id as string,
          gapType: gap.gap_type as string | null,
          severity: gap.severity as string | null,
          exposureAmount: gap.exposure_amount as number | null,
          exposureBasis: gap.exposure_basis as string | null,
          detectedByRule: gap.detected_by_rule as string | null,
          affectedCount: Array.isArray(gap.affected_quote_ids)
            ? (gap.affected_quote_ids as unknown[]).length
            : 0,
          assignedType: gap.assigned_type as string | null,
          assignedAmount: gap.assigned_amount as number | null,
          assignedNote: gap.assigned_note as string | null,
          assignedAt: gap.assigned_at as string | null,
          scopeId: (scope?.scope_id as string | null) ?? null,
          scopeTitle: (scope?.title as string | null) ?? null,
          csiSection: (scope?.csi_section as string | null) ?? null,
        };
      })
      .sort(
        (a, b) =>
          (severityOrder[a.severity ?? ''] ?? 9) - (severityOrder[b.severity ?? ''] ?? 9) ||
          Number(b.exposureAmount ?? 0) - Number(a.exposureAmount ?? 0),
      );

    const sumWhere = (type: string): number =>
      packageGaps
        .filter((gap) => gap.assignedType === type)
        .reduce((total, gap) => total + Number(gap.assignedAmount ?? 0), 0);

    // Only gaps nobody has decided about are still open. An accepted gap has
    // been looked at and deliberately not carried — that is a decision, not an
    // outstanding question, and counting it as open makes the number lie.
    const open = packageGaps.filter((gap) => gap.assignedType === null);

    const gapAllowance = sumWhere('ALLOWANCE');
    const gapContingency = sumWhere('CONTINGENCY');

    const quote = chosen ? quoteById.get(chosen.quote_id as string) : undefined;
    const budget = pkg.budget_amount ?? null;
    const adjusted = chosen ? Number(chosen.adjusted_total ?? 0) || null : null;

    // What this package really costs: the adjusted bid plus everything carried
    // against the scope nobody priced.
    const committed =
      adjusted === null && gapAllowance === 0 && gapContingency === 0
        ? null
        : Number(adjusted ?? 0) +
          Number(pkg.allowance_amount ?? 0) +
          Number(pkg.contingency_amount ?? 0) +
          gapAllowance +
          gapContingency;

    return {
      packageId: pkg.id,
      division: pkg.lead_division,
      divisions: pkg.csi_divisions ?? [],
      name: pkg.name,
      status: pkg.status,
      notes: pkg.notes ?? null,
      budget,
      allowance: pkg.allowance_amount ?? null,
      contingency: pkg.contingency_amount ?? null,
      bidder: quote?.subcontractor_id ? (subName.get(quote.subcontractor_id) ?? null) : null,
      selected: Boolean(selection),
      quotedTotal: chosen ? Number(chosen.quoted_total ?? 0) || null : null,
      addbackTotal: chosen ? Number(chosen.addback_total ?? 0) : null,
      adjustedTotal: adjusted,
      gapAllowance: gapAllowance || null,
      gapContingency: gapContingency || null,
      committed,
      // Positive is over budget. Measured on what is actually carried, which
      // includes the gap dispositions — anything else flatters the number.
      variance: budget !== null && committed !== null ? committed - budget : null,
      bidderCount: results.length,
      gaps: packageGaps,
      openGaps: open.length,
      criticalGaps: open.filter((gap) => gap.severity === 'CRITICAL').length,
      openExposure: open.reduce((total, gap) => total + Number(gap.exposureAmount ?? 0), 0) || null,
    };
  });

  const sum = (pick: (row: (typeof rows)[number]) => number | null): number =>
    rows.reduce((total, row) => total + (pick(row) ?? 0), 0);

  res.json({
    rows,
    totals: {
      budget: sum((row) => row.budget),
      allowance: sum((row) => row.allowance),
      contingency: sum((row) => row.contingency),
      adjusted: sum((row) => row.adjustedTotal),
      gapAllowance: sum((row) => row.gapAllowance),
      gapContingency: sum((row) => row.gapContingency),
      committed: sum((row) => row.committed),
      variance: sum((row) => row.variance),
      openExposure: sum((row) => row.openExposure),
      openGaps: rows.reduce((total, row) => total + row.openGaps, 0),
      criticalGaps: rows.reduce((total, row) => total + row.criticalGaps, 0),
    },
  });
});

/**
 * P12 · The risk log export.
 *
 * The artefact a prospect asks for a copy of, so it has to stand alone: what
 * project, when, a summary line, then the detail.
 *
 * R5 is enforced here rather than trusted: any exposure resting on an
 * uncalibrated benchmark is suppressed from the client-facing export. An
 * uncalibrated range is a calibration tool. It appears in the internal UI
 * clearly labelled, and it never leaves the building as a number.
 */
buyoutRouter.get('/projects/:projectId/risk-log.xlsx', async (req, res) => {
  const projectId = req.params.projectId ?? '';
  const auth = req.auth;
  if (!auth) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }

  const db = supabaseForUser(auth.token);

  const { data: project } = await db
    .from('project')
    .select('bid_id, name, owner_org')
    .eq('id', projectId)
    .maybeSingle();

  if (!project) {
    res.status(404).json({ error: 'No such project' });
    return;
  }

  const { data: packages } = await db
    .from('work_package')
    .select('id, name, lead_division')
    .eq('project_id', projectId);

  const packageIds = (packages ?? []).map((row) => row.id as string);
  const { data: gaps } = packageIds.length
    ? await db.from('scope_gap').select('*').in('package_id', packageIds)
    : { data: [] as Record<string, unknown>[] };

  const scopeIds = [...new Set((gaps ?? []).map((gap) => gap.scope_item_id as string))];
  const { data: items } = scopeIds.length
    ? await db.from('scope_item').select('id, scope_id, csi_section, title').in('id', scopeIds)
    : { data: [] as { id: string; scope_id: string; csi_section: string; title: string }[] };

  const itemById = new Map((items ?? []).map((row) => [row.id as string, row]));
  const packageById = new Map((packages ?? []).map((row) => [row.id as string, row]));

  // Which sections rest on an uncalibrated benchmark.
  const { data: benchmarks } = await db
    .from('benchmark_range')
    .select('csi_section, is_calibrated');
  const uncalibrated = new Set(
    (benchmarks ?? []).filter((row) => !row.is_calibrated).map((row) => row.csi_section as string),
  );

  const severityOrder = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 } as Record<string, number>;
  let suppressed = 0;

  const detail = (gaps ?? [])
    .map((gap) => {
      const scope = itemById.get(gap.scope_item_id as string);
      const basedOnUncalibrated =
        String(gap.exposure_basis ?? '').toUpperCase().includes('BENCHMARK') &&
        scope?.csi_section !== undefined &&
        uncalibrated.has(scope.csi_section);

      if (basedOnUncalibrated) suppressed += 1;

      return {
        Severity: gap.severity,
        Type: gap.gap_type,
        Package: packageById.get(gap.package_id as string)?.name ?? '',
        'CSI Section': scope?.csi_section ?? '',
        'Scope ID': scope?.scope_id ?? '',
        'Scope Item': scope?.title ?? '',
        // R5: no uncalibrated number leaves the building.
        Exposure: basedOnUncalibrated ? 'TBC' : (gap.exposure_amount ?? 'TBC'),
        Basis: basedOnUncalibrated ? 'Requires clarification' : (gap.exposure_basis ?? ''),
        'Bidders affected': Array.isArray(gap.affected_quote_ids)
          ? (gap.affected_quote_ids as unknown[]).length
          : 0,
        'Detected by': gap.detected_by_rule ?? '',
      };
    })
    .sort(
      (a, b) =>
        (severityOrder[String(a.Severity)] ?? 9) - (severityOrder[String(b.Severity)] ?? 9),
    );

  const quantified = detail.filter((row) => typeof row.Exposure === 'number');
  const totalExposure = quantified.reduce((sum, row) => sum + Number(row.Exposure), 0);
  const critical = detail.filter((row) => row.Severity === 'CRITICAL').length;

  const summary = [
    ['WinProjects — Scope Gap Risk Log'],
    [],
    ['Project', project.name],
    ['Bid ID', project.bid_id],
    ['Owner', project.owner_org ?? ''],
    ['Generated', new Date().toISOString().slice(0, 10)],
    [],
    [
      'Summary',
      `${detail.length} gaps, ${totalExposure.toLocaleString('en-US', {
        style: 'currency',
        currency: 'USD',
        maximumFractionDigits: 0,
      })} quantified exposure, ${critical} critical`,
    ],
    ...(suppressed > 0
      ? [['Note', `${suppressed} gap(s) shown as TBC pending clarification`]]
      : []),
  ];

  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(summary), 'Summary');
  XLSX.utils.book_append_sheet(book, XLSX.utils.json_to_sheet(detail), 'Scope Gaps');

  const buffer = XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }) as Buffer;

  res.setHeader(
    'Content-Type',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  );
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${project.bid_id}-risk-log.xlsx"`,
  );
  res.send(buffer);
});

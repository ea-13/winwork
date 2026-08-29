import { Router } from 'express';
import * as XLSX from 'xlsx';
import { supabaseForUser } from '../lib/supabase.js';

export const buyoutRouter = Router();

type Package = {
  id: string;
  name: string;
  lead_division: string | null;
  status: string;
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
    .select('id, name, lead_division, status, budget_amount, allowance_amount, contingency_amount')
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
      db.from('scope_gap').select('package_id, severity, exposure_amount').in('package_id', packageIds),
      db.from('selection').select('package_id, quote_id, selected_at').in('package_id', packageIds),
      db.from('quote').select('id, package_id, subcontractor_id, quoted_total').in('package_id', packageIds),
      db.from('subcontractor').select('id, name'),
    ]);

  const subName = new Map((subs ?? []).map((row) => [row.id as string, row.name as string]));
  const quoteById = new Map((quotes ?? []).map((row) => [row.id as string, row]));

  const rows = (packages ?? []).map((pkg: Package) => {
    const selection = (selections ?? []).find((row) => row.package_id === pkg.id);
    const results = (leveling ?? []).filter((row) => row.package_id === pkg.id);

    // The selected bidder if one has been chosen (H6), otherwise the leading
    // one — clearly labelled as advisory, because nothing is awarded here.
    const chosen = selection
      ? results.find((row) => row.quote_id === selection.quote_id)
      : results.find((row) => row.advisory_rank === 1);

    const packageGaps = (gaps ?? []).filter((row) => row.package_id === pkg.id);
    const openExposure = packageGaps.reduce(
      (sum, gap) => sum + Number(gap.exposure_amount ?? 0),
      0,
    );

    const quote = chosen ? quoteById.get(chosen.quote_id as string) : undefined;
    const budget = pkg.budget_amount ?? null;
    const adjusted = chosen ? Number(chosen.adjusted_total ?? 0) || null : null;

    return {
      packageId: pkg.id,
      division: pkg.lead_division,
      name: pkg.name,
      status: pkg.status,
      budget,
      allowance: pkg.allowance_amount ?? null,
      contingency: pkg.contingency_amount ?? null,
      bidder:
        quote?.subcontractor_id ? (subName.get(quote.subcontractor_id) ?? null) : null,
      selected: Boolean(selection),
      quotedTotal: chosen ? Number(chosen.quoted_total ?? 0) || null : null,
      addbackTotal: chosen ? Number(chosen.addback_total ?? 0) : null,
      adjustedTotal: adjusted,
      // Positive is over budget. Measured on adjusted, never on quoted.
      variance: budget !== null && adjusted !== null ? adjusted - budget : null,
      bidderCount: results.length,
      openGaps: packageGaps.length,
      criticalGaps: packageGaps.filter((gap) => gap.severity === 'CRITICAL').length,
      openExposure: openExposure || null,
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
      variance: sum((row) => row.variance),
      openExposure: sum((row) => row.openExposure),
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

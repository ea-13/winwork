import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * The analytical heart: add-backs, scope gaps, and the adjusted comparison.
 *
 * Deliberately deterministic. No model is involved in any arithmetic here —
 * a set difference against the locked baseline is a fact, and an average of
 * three comparable bids is a calculation. Model judgement belongs upstream in
 * normalisation, where the question is genuinely "does this line mean that
 * scope item"; by the time we are adding numbers, the answer must be
 * reproducible and explainable to a GC line by line.
 *
 *   adjusted_total = quoted_total + Σ add-backs + risk_allowance
 *
 * Rank on adjusted_total. Never on quoted_total. That is the product.
 */

export type AddBackBasis = 'COMPARABLE_BIDS' | 'BENCHMARK' | 'TBC';

type ScopeItem = {
  id: string;
  scope_id: string;
  csi_section: string | null;
  title: string;
  quantity: number | null;
  unit: string | null;
};

type Line = {
  id: string;
  quote_id: string;
  scope_item_id: string | null;
  line_total: number | null;
  match_confidence: number | null;
  match_basis: string | null;
};

type Exclusion = {
  id: string;
  quote_id: string;
  scope_item_id: string | null;
  excerpt: string | null;
};

type Quote = { id: string; quoted_total: number | null; subcontractor_id: string | null };

const average = (values: number[]): number | null =>
  values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;

async function loadPackage(db: SupabaseClient, packageId: string) {
  const { data: packageScope } = await db
    .from('package_scope')
    .select('scope_item_id')
    .eq('package_id', packageId);

  const scopeIds = (packageScope ?? []).map((row) => row.scope_item_id as string);

  const [{ data: scopeItems }, { data: quotes }] = await Promise.all([
    scopeIds.length
      ? db
          .from('scope_item')
          .select('id, scope_id, csi_section, title, quantity, unit')
          .in('id', scopeIds)
      : Promise.resolve({ data: [] as ScopeItem[] }),
    db
      .from('quote')
      .select('id, quoted_total, subcontractor_id')
      .eq('package_id', packageId)
      .eq('status', 'EXTRACTED'),
  ]);

  const quoteIds = (quotes ?? []).map((quote) => quote.id as string);

  const [{ data: lines }, { data: exclusions }] = await Promise.all([
    quoteIds.length
      ? db
          .from('quote_line')
          .select('id, quote_id, scope_item_id, line_total, match_confidence, match_basis')
          .in('quote_id', quoteIds)
      : Promise.resolve({ data: [] as Line[] }),
    quoteIds.length
      ? db
          .from('quote_exclusion')
          .select('id, quote_id, scope_item_id, excerpt')
          .in('quote_id', quoteIds)
      : Promise.resolve({ data: [] as Exclusion[] }),
  ]);

  return {
    scopeItems: (scopeItems ?? []) as ScopeItem[],
    quotes: (quotes ?? []) as Quote[],
    lines: (lines ?? []) as Line[],
    exclusions: (exclusions ?? []) as Exclusion[],
  };
}

/**
 * What the other bidders priced for a scope item — the preferred add-back basis
 * because it is this project, these drawings, these bidders. A benchmark is a
 * fallback, and no basis at all means TBC rather than a number.
 */
function comparablePrice(lines: Line[], scopeItemId: string, excludeQuoteId: string): number | null {
  const priced = lines
    .filter(
      (line) =>
        line.scope_item_id === scopeItemId &&
        line.quote_id !== excludeQuoteId &&
        typeof line.line_total === 'number',
    )
    .map((line) => line.line_total as number);

  return average(priced);
}

export type AddBackSummary = {
  priced: number;
  fromComparables: number;
  fromBenchmark: number;
  tbc: number;
};

/**
 * P9 · Costs every exclusion back in, in strict priority order.
 *
 * Be conservative. A wrong add-back is worse than an honest TBC: the first
 * produces a defensible-looking number that falls apart under questioning, the
 * second produces a clarification request, which is what an estimator would
 * have done anyway.
 */
export async function computeAddBacks(
  db: SupabaseClient,
  options: { tenantId: string; packageId: string },
): Promise<AddBackSummary> {
  const { scopeItems, lines, exclusions } = await loadPackage(db, options.packageId);
  const byId = new Map(scopeItems.map((item) => [item.id, item]));

  // Uncalibrated ranges are a calibration tool, never a client-facing number
  // (R5). They are still usable here because the leveling matrix is internal;
  // the export in P12 is what must suppress them.
  const sections = scopeItems.map((item) => item.csi_section).filter(Boolean) as string[];
  const { data: benchmarks } = sections.length
    ? await db
        .from('benchmark_range')
        .select('csi_section, low, high, is_calibrated')
        .in('csi_section', sections)
    : { data: [] as { csi_section: string; low: number; high: number; is_calibrated: boolean }[] };

  const summary: AddBackSummary = { priced: 0, fromComparables: 0, fromBenchmark: 0, tbc: 0 };

  for (const exclusion of exclusions) {
    let amount: number | null = null;
    let basis: AddBackBasis = 'TBC';
    let confidence: number | null = null;

    if (exclusion.scope_item_id) {
      const comparable = comparablePrice(lines, exclusion.scope_item_id, exclusion.quote_id);

      if (comparable !== null) {
        amount = Math.round(comparable);
        basis = 'COMPARABLE_BIDS';
        confidence = 0.8;
        summary.fromComparables += 1;
      } else {
        const item = byId.get(exclusion.scope_item_id);
        const range = benchmarks?.find((entry) => entry.csi_section === item?.csi_section);

        if (range && item?.quantity) {
          amount = Math.round(((range.low + range.high) / 2) * item.quantity);
          basis = 'BENCHMARK';
          confidence = range.is_calibrated ? 0.6 : 0.3;
          summary.fromBenchmark += 1;
        }
      }
    }

    if (basis === 'TBC') summary.tbc += 1;
    else summary.priced += 1;

    await db
      .from('quote_exclusion')
      .update({
        addback_amount: amount,
        addback_basis: basis,
        addback_confidence: confidence,
      })
      .eq('id', exclusion.id);
  }

  return summary;
}

export type GapSummary = {
  uncovered: number;
  partial: number;
  unpriceable: number;
  ambiguous: number;
  exposure: number;
};

/** Severity is derived, never authored. Nobody hand-tunes a risk score. */
function severityFor(exposure: number | null, confidence: number): string {
  if (exposure === null) return confidence > 0.6 ? 'MEDIUM' : 'LOW';
  const weighted = exposure * confidence;
  if (weighted >= 50_000) return 'CRITICAL';
  if (weighted >= 15_000) return 'HIGH';
  if (weighted >= 3_000) return 'MEDIUM';
  return 'LOW';
}

/**
 * P10 · Scope gaps.
 *
 * UNCOVERED is the dangerous one: in the scope, priced by nobody, and it
 * silently becomes the GC's cost. It is found by set difference against the
 * locked baseline — no model, no judgement, no confidence score.
 */
export async function detectGaps(
  db: SupabaseClient,
  options: { tenantId: string; packageId: string },
): Promise<GapSummary> {
  const { scopeItems, quotes, lines, exclusions } = await loadPackage(db, options.packageId);

  // Recomputing replaces the previous picture rather than layering on it.
  await db.from('scope_gap').delete().eq('package_id', options.packageId);

  const summary: GapSummary = { uncovered: 0, partial: 0, unpriceable: 0, ambiguous: 0, exposure: 0 };
  const rows: Record<string, unknown>[] = [];

  for (const item of scopeItems) {
    const pricedBy = new Set(
      lines
        .filter((line) => line.scope_item_id === item.id && typeof line.line_total === 'number')
        .map((line) => line.quote_id),
    );
    const excludedBy = new Set(
      exclusions.filter((entry) => entry.scope_item_id === item.id).map((entry) => entry.quote_id),
    );
    const ambiguousOn = lines.filter(
      (line) => line.scope_item_id === item.id && (line.match_basis ?? '').startsWith('AMBIGUOUS'),
    );

    const comparable = average(
      lines
        .filter((line) => line.scope_item_id === item.id && typeof line.line_total === 'number')
        .map((line) => line.line_total as number),
    );

    let gapType: string | null = null;
    let confidence = 0.9;

    if (pricedBy.size === 0 && quotes.length > 0) {
      gapType = 'UNCOVERED';
      summary.uncovered += 1;
    } else if (excludedBy.size > 0 && pricedBy.size > 0 && pricedBy.size < quotes.length) {
      gapType = 'PARTIAL';
      summary.partial += 1;
    } else if (excludedBy.size > 0 && comparable === null) {
      gapType = 'UNPRICEABLE';
      confidence = 0.5;
      summary.unpriceable += 1;
    } else if (ambiguousOn.length > 0) {
      gapType = 'AMBIGUOUS';
      confidence = 0.4;
      summary.ambiguous += 1;
    }

    if (!gapType) continue;

    // Exposure is what it would cost to buy this scope elsewhere. With no
    // comparable and no benchmark there is no number, and TBC is the answer.
    const exposure = comparable === null ? null : Math.round(comparable);
    if (exposure) summary.exposure += exposure;

    rows.push({
      tenant_id: options.tenantId,
      package_id: options.packageId,
      scope_item_id: item.id,
      gap_type: gapType,
      affected_quote_ids: quotes
        .filter((quote) => !pricedBy.has(quote.id))
        .map((quote) => quote.id),
      exposure_amount: exposure,
      exposure_basis:
        exposure === null ? 'TBC — no comparable bid priced this scope' : 'Average of comparable bids',
      confidence,
      severity: severityFor(exposure, confidence),
      detected_by_rule:
        gapType === 'UNCOVERED'
          ? 'set difference against locked baseline: no bidder priced this item'
          : gapType === 'PARTIAL'
            ? 'priced by some bidders, excluded by others'
            : gapType === 'UNPRICEABLE'
              ? 'excluded, and no comparable bid exists to cost it from'
              : 'normalisation could not confidently map a line to this item',
      detected_at: new Date().toISOString(),
    });
  }

  if (rows.length > 0) {
    const { error } = await db.from('scope_gap').insert(rows);
    if (error) throw new Error(`Could not write scope gaps: ${error.message}`);
  }

  return summary;
}

export type LevelingRow = {
  quoteId: string;
  quotedTotal: number | null;
  addbackTotal: number;
  riskAllowance: number;
  adjustedTotal: number | null;
  advisoryRank: number;
};

/**
 * P11 · The adjusted comparison.
 *
 * Ranks on adjusted_total, which is the whole argument: a bidder who excluded
 * $81k of scope was never the low bidder, they were the least complete.
 */
export async function computeLeveling(
  db: SupabaseClient,
  options: { tenantId: string; packageId: string },
): Promise<LevelingRow[]> {
  const { quotes, exclusions } = await loadPackage(db, options.packageId);

  const { data: existing } = await db
    .from('leveling_result')
    .select('quote_id, risk_allowance')
    .eq('package_id', options.packageId);

  const riskByQuote = new Map(
    (existing ?? []).map((row) => [row.quote_id as string, Number(row.risk_allowance ?? 0)]),
  );

  const { data: priced } = await db
    .from('quote_exclusion')
    .select('quote_id, addback_amount')
    .in('quote_id', quotes.map((quote) => quote.id));

  const addbackByQuote = new Map<string, number>();
  for (const row of priced ?? []) {
    if (typeof row.addback_amount !== 'number') continue;
    addbackByQuote.set(
      row.quote_id as string,
      (addbackByQuote.get(row.quote_id as string) ?? 0) + row.addback_amount,
    );
  }

  const computed = quotes.map((quote) => {
    const addbackTotal = addbackByQuote.get(quote.id) ?? 0;
    const riskAllowance = riskByQuote.get(quote.id) ?? 0;
    const adjustedTotal =
      quote.quoted_total === null ? null : quote.quoted_total + addbackTotal + riskAllowance;
    return { quoteId: quote.id, quotedTotal: quote.quoted_total, addbackTotal, riskAllowance, adjustedTotal };
  });

  // A quote with no stated total cannot be ranked. It sorts last and keeps a
  // null adjusted total rather than being treated as zero (R1).
  const ranked = [...computed].sort((a, b) => {
    if (a.adjustedTotal === null) return 1;
    if (b.adjustedTotal === null) return -1;
    return a.adjustedTotal - b.adjustedTotal;
  });

  const rows: LevelingRow[] = ranked.map((row, index) => ({
    ...row,
    advisoryRank: row.adjustedTotal === null ? 0 : index + 1,
  }));

  await db.from('leveling_result').delete().eq('package_id', options.packageId);

  if (rows.length > 0) {
    const { error } = await db.from('leveling_result').insert(
      rows.map((row) => ({
        tenant_id: options.tenantId,
        package_id: options.packageId,
        quote_id: row.quoteId,
        quoted_total: row.quotedTotal,
        addback_total: row.addbackTotal,
        risk_allowance: row.riskAllowance,
        adjusted_total: row.adjustedTotal,
        advisory_rank: row.advisoryRank,
        computed_at: new Date().toISOString(),
      })),
    );
    if (error) throw new Error(`Could not write leveling results: ${error.message}`);
  }

  return rows;
}

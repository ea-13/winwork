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

// -----------------------------------------------------------------------------
// The leveled number per scope item, per sub
// -----------------------------------------------------------------------------

export type ScopeLevelCell = {
  scopeItemId: string;
  quoteId: string;
  rolledTotal: number | null;
  lineCount: number;
  isExcluded: boolean;
  isCarried: boolean;
  matchBasis: string | null;
  overrideTotal: number | null;
  note: string | null;
};

/**
 * The bid tab sheet: one row per scope item, one column per bidder.
 *
 * `leveling_result` answers "what is this bid worth in total". This answers the
 * question an estimator actually asks out loud — "what did each of them carry
 * for metal stud framing" — which no per-quote row can.
 *
 * Two rules make it safe to run repeatedly:
 *
 *   - rolled_total is derived, always, and is replaced wholesale on each run.
 *   - override_total and note are the estimator's, and are carried across
 *     untouched. Recomputing must never quietly delete a human's judgement,
 *     which is the failure mode that makes people stop trusting a recompute
 *     button and start keeping the real numbers in a spreadsheet.
 *
 * A cell is written for every scope item and every quote, including the empty
 * ones. An absent cell and a cell where a sub carried nothing look identical in
 * a grid, and only one of them means "they did not price this".
 */
export async function computeScopeLeveling(
  db: SupabaseClient,
  options: { tenantId: string; packageId: string },
): Promise<ScopeLevelCell[]> {
  const { scopeItems, quotes, lines, exclusions } = await loadPackage(db, options.packageId);

  const { data: existing } = await db
    .from('scope_leveling')
    .select('scope_item_id, quote_id, override_total, note, noted_by, noted_at')
    .eq('package_id', options.packageId);

  const key = (scopeItemId: string, quoteId: string) => `${scopeItemId}|${quoteId}`;

  const human = new Map(
    (existing ?? []).map((row) => [
      key(row.scope_item_id as string, row.quote_id as string),
      row,
    ]),
  );

  const cells: ScopeLevelCell[] = [];
  const rows: Record<string, unknown>[] = [];

  for (const item of scopeItems) {
    for (const quote of quotes) {
      const matched = lines.filter(
        (line) => line.scope_item_id === item.id && line.quote_id === quote.id,
      );
      const priced = matched.filter((line) => typeof line.line_total === 'number');

      // No priced line is not zero. R1: blank stays blank.
      const rolledTotal =
        priced.length === 0
          ? null
          : Math.round(priced.reduce((sum, line) => sum + (line.line_total as number), 0));

      const isExcluded = exclusions.some(
        (entry) => entry.scope_item_id === item.id && entry.quote_id === quote.id,
      );

      const carried = human.get(key(item.id, quote.id));

      cells.push({
        scopeItemId: item.id,
        quoteId: quote.id,
        rolledTotal,
        lineCount: matched.length,
        isExcluded,
        isCarried: priced.length > 0,
        matchBasis: matched[0]?.match_basis ?? null,
        overrideTotal:
          typeof carried?.override_total === 'number' ? carried.override_total : null,
        note: (carried?.note as string | null) ?? null,
      });

      rows.push({
        tenant_id: options.tenantId,
        package_id: options.packageId,
        scope_item_id: item.id,
        quote_id: quote.id,
        rolled_total: rolledTotal,
        line_count: matched.length,
        is_excluded: isExcluded,
        is_carried: priced.length > 0,
        match_basis: matched[0]?.match_basis ?? null,
        override_total: carried?.override_total ?? null,
        note: carried?.note ?? null,
        noted_by: carried?.noted_by ?? null,
        noted_at: carried?.noted_at ?? null,
        computed_at: new Date().toISOString(),
      });
    }
  }

  // A cell that no longer computes but carries a human value is kept.
  //
  // The cross product only covers quotes that have been extracted, so a bid
  // still waiting on extraction contributes no cells — and without this, the
  // delete below would take an estimator's override and note with it and the
  // insert would not put them back. Recompute silently eating typed-in numbers
  // is the single behaviour that would make somebody stop trusting the button.
  const computed = new Set(rows.map((row) => key(row.scope_item_id as string, row.quote_id as string)));

  for (const row of existing ?? []) {
    const id = key(row.scope_item_id as string, row.quote_id as string);
    if (computed.has(id)) continue;

    const hasJudgement = row.override_total !== null || (row.note ?? '') !== '';
    if (!hasJudgement) continue;

    rows.push({
      tenant_id: options.tenantId,
      package_id: options.packageId,
      scope_item_id: row.scope_item_id,
      quote_id: row.quote_id,
      // Nothing was derived this time round, and saying so is more honest than
      // carrying a stale rolled total next to a fresh override.
      rolled_total: null,
      line_count: 0,
      is_excluded: false,
      is_carried: false,
      match_basis: null,
      override_total: row.override_total,
      note: row.note,
      noted_by: row.noted_by,
      noted_at: row.noted_at,
      computed_at: new Date().toISOString(),
    });

    cells.push({
      scopeItemId: row.scope_item_id as string,
      quoteId: row.quote_id as string,
      rolledTotal: null,
      lineCount: 0,
      isExcluded: false,
      isCarried: false,
      matchBasis: null,
      overrideTotal: typeof row.override_total === 'number' ? row.override_total : null,
      note: (row.note as string | null) ?? null,
    });
  }

  await db.from('scope_leveling').delete().eq('package_id', options.packageId);

  if (rows.length > 0) {
    const { error } = await db.from('scope_leveling').insert(rows);
    if (error) throw new Error(`Could not write scope leveling: ${error.message}`);
  }

  return cells;
}

// -----------------------------------------------------------------------------
// The feedback loop: did the context we wrote turn out to matter?
// -----------------------------------------------------------------------------

export type OutcomeSummary = {
  caught: number;
  missed: number;
  held: number;
  patternsConfirmed: number;
};

/**
 * Scores every scope item's context against what the bids actually did.
 *
 * This is the half that makes the product improve rather than just run. Three
 * verdicts, recorded per context line:
 *
 *   CAUGHT_GAP  — a gap opened here AND somebody had written down that it
 *                 might. The context earned its place.
 *   MISSED_GAP  — a gap opened here and nothing warned. This is the valuable
 *                 one: it names a seam the system does not yet know about, and
 *                 it is the row a human turns into a new gap_pattern.
 *   PRICED_BY_ALL — every bidder carried it and nothing came loose. Weak
 *                 evidence, but it is what stops a pattern that fires on every
 *                 job and predicts nothing from looking valuable.
 *
 * Outcomes are append-only and de-duplicated on the evidence they rest on, so
 * pressing Recompute five times does not give a context line a track record of
 * five. That would be the easiest possible way to make these numbers lie.
 */
export async function recordContextOutcomes(
  db: SupabaseClient,
  options: { tenantId: string; packageId: string },
): Promise<OutcomeSummary> {
  const { data: packageScope } = await db
    .from('package_scope')
    .select('scope_item_id')
    .eq('package_id', options.packageId);

  const scopeIds = (packageScope ?? []).map((row) => row.scope_item_id as string);
  const summary: OutcomeSummary = { caught: 0, missed: 0, held: 0, patternsConfirmed: 0 };

  if (scopeIds.length === 0) return summary;

  const [{ data: gaps }, { data: context }, { data: already }] = await Promise.all([
    db
      .from('scope_gap')
      .select('id, scope_item_id, gap_type, exposure_amount, severity')
      .eq('package_id', options.packageId),
    db
      .from('scope_context')
      .select('id, scope_item_id, kind, gap_pattern_id')
      .in('scope_item_id', scopeIds)
      .eq('is_active', true),
    db
      .from('scope_context_outcome')
      .select('scope_item_id, context_id, outcome, evidence_id')
      .in('scope_item_id', scopeIds),
  ]);

  // What has already been learned. Recompute must not inflate a track record:
  // pressing the button five times cannot turn one finding into five, or the
  // confirmation counts become meaningless the first day somebody iterates.
  const recorded = new Set(
    (already ?? []).map(
      (row) => `${row.scope_item_id}|${row.context_id ?? ''}|${row.outcome}|${row.evidence_id ?? ''}`,
    ),
  );

  const seen = (row: Record<string, unknown>): boolean =>
    recorded.has(
      `${row.scope_item_id}|${row.context_id ?? ''}|${row.outcome}|${row.evidence_id ?? ''}`,
    );

  const contextByItem = new Map<string, Record<string, unknown>[]>();
  for (const line of context ?? []) {
    const key = line.scope_item_id as string;
    contextByItem.set(key, [...(contextByItem.get(key) ?? []), line]);
  }

  const gapByItem = new Map((gaps ?? []).map((gap) => [gap.scope_item_id as string, gap]));
  const rows: Record<string, unknown>[] = [];
  const confirmedPatterns = new Set<string>();

  for (const scopeItemId of scopeIds) {
    const gap = gapByItem.get(scopeItemId);
    const lines = contextByItem.get(scopeItemId) ?? [];

    if (gap) {
      if (lines.length === 0) {
        // Nothing was written down and a gap opened anyway. context_id is null
        // on purpose: the finding is the ABSENCE, and attaching it to a line
        // that does not exist would lose exactly that.
        const row = {
          tenant_id: options.tenantId,
          scope_item_id: scopeItemId,
          context_id: null,
          outcome: 'MISSED_GAP',
          evidence_table: 'scope_gap',
          evidence_id: gap.id,
          amount: gap.exposure_amount,
          note: `${gap.gap_type} gap with no context written against this item`,
        };
        if (!seen(row)) {
          summary.missed += 1;
          rows.push(row);
        }
        continue;
      }

      for (const line of lines) {
        const row = {
          tenant_id: options.tenantId,
          scope_item_id: scopeItemId,
          context_id: line.id as string,
          outcome: 'CAUGHT_GAP',
          evidence_table: 'scope_gap',
          evidence_id: gap.id,
          amount: gap.exposure_amount,
          note: `${gap.gap_type} gap opened on an item this ${String(line.kind).toLowerCase()} was written against`,
        };
        if (seen(row)) continue;
        summary.caught += 1;
        rows.push(row);
        if (line.gap_pattern_id) confirmedPatterns.add(line.gap_pattern_id as string);
      }
      continue;
    }

    for (const line of lines) {
      const row = {
        tenant_id: options.tenantId,
        scope_item_id: scopeItemId,
        context_id: line.id as string,
        outcome: 'PRICED_BY_ALL',
        evidence_table: 'work_package',
        evidence_id: options.packageId,
        amount: null,
        note: 'no gap opened on this item in this package',
      };
      if (seen(row)) continue;
      summary.held += 1;
      rows.push(row);
    }
  }

  if (rows.length > 0) {
    const { error } = await db.from('scope_context_outcome').insert(rows);

    // The unique index is the backstop for two recomputes racing each other.
    // Losing that race means the outcome is already recorded, which is the
    // result we wanted anyway.
    if (error && !/duplicate|unique/i.test(error.message)) {
      throw new Error(`Could not record context outcomes: ${error.message}`);
    }
  }

  // A pattern that keeps preceding real findings is one the drafter should
  // weight more heavily next time. This is the only place that number moves.
  for (const patternId of confirmedPatterns) {
    const { data: pattern } = await db
      .from('gap_pattern')
      .select('times_confirmed')
      .eq('id', patternId)
      .maybeSingle();

    if (!pattern) continue;

    await db
      .from('gap_pattern')
      .update({
        times_confirmed: Number(pattern.times_confirmed ?? 0) + 1,
        last_confirmed_at: new Date().toISOString(),
      })
      .eq('id', patternId);

    summary.patternsConfirmed += 1;
  }

  return summary;
}

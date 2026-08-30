import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * What is worth doing next, and why.
 *
 * The difference between a tool that has agents and a tool that is AI-native is
 * not the number of agents. It is whether you have to already know which button
 * to press. Seven agents existed before this file and every one of them was a
 * click on a screen you had to think to visit — which means the product only
 * worked for somebody who had already been taught it.
 *
 * DELIBERATELY DETERMINISTIC. Not one line of this asks a model what you should
 * do next. It reads actual state and applies rules, because a model guessing at
 * your workflow is strictly worse than arithmetic over what is really there —
 * it would be confidently wrong sometimes, and a suggestion engine that is
 * sometimes confidently wrong gets ignored within a week. The models do the
 * work; the rules decide when the work is worth doing.
 *
 * Every suggestion carries its WHY in the estimator's own terms. "Run the
 * extractor" is an instruction. "Three bids are sitting unread, so the
 * comparison below is missing two of them" is a reason, and a reason is what
 * lets somebody disagree with it.
 */

export type Suggestion = {
  /** Stable across reads, so dismissing one can stick. */
  id: string;
  kind: 'AGENT' | 'HUMAN';
  title: string;
  why: string;
  urgency: 'BLOCKING' | 'HIGH' | 'NORMAL';
  /** Where the user should be to act on it. */
  step: 'documents' | 'scope' | 'bids' | 'leveling' | 'buyout';
  packageId?: string;
  packageName?: string;
  /** What to POST to do it. Absent when the act is typing, not a request. */
  action?: { path: string; body?: Record<string, unknown> };
  /** Roughly what it will cost in model calls. Null when nothing is billed. */
  estimate?: string;
};

type Counts = {
  documents: Record<string, unknown>[];
  scopeItems: Record<string, unknown>[];
  packages: Record<string, unknown>[];
  packageScope: Record<string, unknown>[];
  quotes: Record<string, unknown>[];
  leveling: Record<string, unknown>[];
  gaps: Record<string, unknown>[];
  context: Record<string, unknown>[];
  selections: Record<string, unknown>[];
  costCodes: Record<string, unknown>[];
};

async function loadState(db: SupabaseClient, projectId: string): Promise<Counts> {
  const [{ data: documents }, { data: scopeItems }, { data: packages }] = await Promise.all([
    db
      .from('project_document')
      .select('id, kind, filename, indexed_at, routed_quote_id')
      .eq('project_id', projectId),
    db.from('scope_item').select('id, is_locked, cost_code_id').eq('project_id', projectId),
    db.from('work_package').select('id, name, lead_division, status').eq('project_id', projectId),
  ]);

  const packageIds = (packages ?? []).map((row) => row.id as string);
  const scopeIds = (scopeItems ?? []).map((row) => row.id as string);

  const [
    { data: packageScope },
    { data: quotes },
    { data: leveling },
    { data: gaps },
    { data: selections },
  ] = packageIds.length
    ? await Promise.all([
        db.from('package_scope').select('package_id, scope_item_id').in('package_id', packageIds),
        db
          .from('quote')
          .select('id, package_id, status, quoted_total, source_filename')
          .in('package_id', packageIds),
        db
          .from('leveling_result')
          .select('package_id, quote_id, advisory_rank')
          .in('package_id', packageIds),
        db
          .from('scope_gap')
          .select('id, package_id, gap_type, severity, assigned_type, exposure_amount')
          .in('package_id', packageIds),
        db.from('selection').select('package_id, quote_id').in('package_id', packageIds),
      ])
    : [{ data: [] }, { data: [] }, { data: [] }, { data: [] }, { data: [] }];

  const [{ data: context }, { data: costCodes }] = await Promise.all([
    scopeIds.length
      ? db.from('scope_context').select('scope_item_id').in('scope_item_id', scopeIds)
      : Promise.resolve({ data: [] as Record<string, unknown>[] }),
    db.from('cost_code').select('id').limit(1),
  ]);

  return {
    documents: documents ?? [],
    scopeItems: scopeItems ?? [],
    packages: packages ?? [],
    packageScope: packageScope ?? [],
    quotes: quotes ?? [],
    leveling: leveling ?? [],
    gaps: gaps ?? [],
    context: context ?? [],
    selections: selections ?? [],
    costCodes: costCodes ?? [],
  };
}

/**
 * The rules, in the order an estimator would hit them.
 *
 * Ordering matters more than completeness: a list of fourteen equally-weighted
 * suggestions is a list nobody reads. BLOCKING means the next step genuinely
 * cannot happen, HIGH means the numbers on screen are currently wrong or
 * incomplete, NORMAL means it would be better if you did it.
 */
export async function suggestFor(
  db: SupabaseClient,
  projectId: string,
): Promise<Suggestion[]> {
  const state = await loadState(db, projectId);
  const out: Suggestion[] = [];

  const readable = state.documents.filter((doc) =>
    ['DRAWING', 'SPEC', 'ADDENDUM'].includes(String(doc.kind)),
  );

  // ---- Documents ----------------------------------------------------------

  const unfiled = state.documents.filter((doc) => doc.kind === 'UNFILED');
  if (unfiled.length > 0) {
    out.push({
      id: 'label-documents',
      kind: 'HUMAN',
      title: `Label ${unfiled.length} file${unfiled.length === 1 ? '' : 's'}`,
      why:
        'Drawings and specs are read differently — one is indexed by sheet, the other by page. ' +
        'Nothing can be drafted from a file until you say which it is.',
      urgency: 'BLOCKING',
      step: 'documents',
    });
  }

  const unindexed = state.documents.filter(
    (doc) => doc.kind === 'DRAWING' && doc.indexed_at === null,
  );
  for (const drawing of unindexed) {
    out.push({
      id: `index-${drawing.id}`,
      kind: 'AGENT',
      title: `Index ${String(drawing.filename)}`,
      why:
        'Reads every title block so scope drafted from this set cites sheet numbers a sub can ' +
        'act on, rather than page numbers nobody can find.',
      urgency: 'HIGH',
      step: 'documents',
      action: { path: `/projects/${projectId}/documents/${drawing.id}/index-sheets` },
      estimate: 'about a minute per 20 sheets',
    });
  }

  const unroutedQuotes = state.documents.filter(
    (doc) => doc.kind === 'QUOTE' && doc.routed_quote_id === null,
  );
  if (unroutedQuotes.length > 0) {
    out.push({
      id: 'route-quotes',
      kind: 'HUMAN',
      title: `File ${unroutedQuotes.length} quote${unroutedQuotes.length === 1 ? '' : 's'} under a package`,
      why: 'They came in with the bid set and are not against a package yet, so nothing levels them.',
      urgency: 'HIGH',
      step: 'documents',
    });
  }

  // ---- Scope --------------------------------------------------------------

  if (state.scopeItems.length === 0 && readable.length > 0) {
    out.push({
      id: 'draft-scope',
      kind: 'AGENT',
      title: `Draft scope from ${readable.length} document${readable.length === 1 ? '' : 's'}`,
      why:
        'The scope of work is the baseline every bid is measured against. Nothing downstream — ' +
        'gaps, levelling, buyout — means anything until it exists.',
      urgency: 'BLOCKING',
      step: 'documents',
      action: {
        path: `/projects/${projectId}/draft-scope`,
        body: { documentIds: readable.map((doc) => doc.id) },
      },
      estimate: 'a few minutes per document',
    });
  }

  if (state.scopeItems.length === 0 && readable.length === 0) {
    out.push({
      id: 'start-scope',
      kind: 'HUMAN',
      title: 'Start the scope of work',
      why:
        'Drop the bid set and draft from it, or start from the standard containers for the ' +
        'trades on this job and fill them in.',
      urgency: 'BLOCKING',
      step: 'scope',
    });
  }

  if (state.scopeItems.length > 0) {
    const withContext = new Set(state.context.map((row) => row.scope_item_id as string));
    const bare = state.scopeItems.filter((item) => !withContext.has(item.id as string));

    if (bare.length > 0) {
      out.push({
        id: 'draft-context',
        kind: 'AGENT',
        title: `Write context for ${bare.length} scope item${bare.length === 1 ? '' : 's'}`,
        why:
          'A line that says "metal stud framing" is enough to check somebody priced framing. It ' +
          'is not enough to check anybody priced the head-of-wall detail — and that is the change ' +
          'order. Scope leaks at the seam, not the line.',
        urgency: bare.length === state.scopeItems.length ? 'HIGH' : 'NORMAL',
        step: 'scope',
        action: { path: `/projects/${projectId}/draft-context` },
        estimate: 'under a minute per dozen items',
      });
    }

    if (readable.length > 0) {
      out.push({
        id: 'audit-coverage',
        kind: 'AGENT',
        title: 'Check the scope against the documents',
        why:
          'Reads the bid set back against what you have drafted and reports what is in the ' +
          'documents that no scope item covers. Drafting finds what is there; this finds what ' +
          'is missing.',
        urgency: 'NORMAL',
        step: 'scope',
        action: {
          path: `/projects/${projectId}/audit-coverage`,
          body: { documentIds: readable.map((doc) => doc.id) },
        },
        estimate: 'a few minutes',
      });
    }

    if (state.costCodes.length > 0) {
      const unmapped = state.scopeItems.filter((item) => item.cost_code_id === null);
      if (unmapped.length > 0) {
        out.push({
          id: 'map-cost-codes',
          kind: 'AGENT',
          title: `Map ${unmapped.length} scope item${unmapped.length === 1 ? '' : 's'} to your cost codes`,
          why:
            'Your cost structure is imported but nothing is filed against it yet, so none of this ' +
            'reconciles with how you actually estimate.',
          urgency: 'NORMAL',
          step: 'scope',
          action: { path: `/projects/${projectId}/map-cost-codes` },
          estimate: 'under a minute',
        });
      }
    }
  }

  // ---- Packages -----------------------------------------------------------

  if (state.scopeItems.length > 0 && state.packages.length === 0) {
    out.push({
      id: 'add-packages',
      kind: 'HUMAN',
      title: 'Put the scope into packages',
      why: 'A GC buys by trade. Nothing can be bid until the scope sits in a package somebody quotes.',
      urgency: 'BLOCKING',
      step: 'scope',
    });
  }

  const assigned = new Set(state.packageScope.map((row) => row.scope_item_id as string));
  const unassigned = state.scopeItems.filter((item) => !assigned.has(item.id as string));

  if (unassigned.length > 0 && state.packages.length > 0) {
    out.push({
      id: 'assign-scope',
      kind: 'HUMAN',
      title: `${unassigned.length} scope item${unassigned.length === 1 ? '' : 's'} in no package`,
      why:
        'Nothing here can be bid, and nothing here can be found missing from a bid either — ' +
        'gap detection only looks at scope that is in a package.',
      urgency: 'HIGH',
      step: 'scope',
    });
  }

  // ---- Per package --------------------------------------------------------

  for (const pkg of state.packages) {
    const id = pkg.id as string;
    const name = String(pkg.name);
    const quotes = state.quotes.filter((quote) => quote.package_id === id);
    const levelled = state.leveling.filter((row) => row.package_id === id);
    const packageGaps = state.gaps.filter((row) => row.package_id === id);
    const selected = state.selections.some((row) => row.package_id === id);
    const scopeCount = state.packageScope.filter((row) => row.package_id === id).length;

    const unread = quotes.filter((quote) => quote.status === 'PENDING_EXTRACTION');
    if (unread.length > 0) {
      out.push({
        id: `extract-${id}`,
        kind: 'AGENT',
        title: `Read ${unread.length} bid${unread.length === 1 ? '' : 's'} on ${name}`,
        why:
          'An unread bid is not in the comparison. The exclusions are the valuable part and they ' +
          'are what nobody reads to the end of.',
        urgency: 'HIGH',
        step: 'bids',
        packageId: id,
        packageName: name,
        estimate: 'about a minute per bid',
      });
    }

    if (quotes.length >= 2 && scopeCount > 0) {
      out.push({
        id: `compare-${id}`,
        kind: 'AGENT',
        title: `Explain why the ${name} bids are not comparable`,
        why:
          'Reads them side by side and writes down what differs underneath the totals — the ' +
          'assumptions, the exclusions, the things one carries and another does not. This is the ' +
          'argument you take to the meeting.',
        urgency: 'NORMAL',
        step: 'leveling',
        packageId: id,
        packageName: name,
        action: { path: `/packages/${id}/compare-bids` },
        estimate: 'under a minute',
      });
    }

    if (quotes.length > 0 && levelled.length === 0) {
      out.push({
        id: `level-${id}`,
        kind: 'AGENT',
        title: `Level ${name}`,
        why:
          'Costs every exclusion back in and ranks on the adjusted total. No model touches the ' +
          'arithmetic — it is a set difference and an average, and it is reproducible.',
        urgency: 'HIGH',
        step: 'leveling',
        packageId: id,
        packageName: name,
        action: { path: `/packages/${id}/level` },
      });
    }

    const openGaps = packageGaps.filter((gap) => gap.assigned_type === null);
    if (openGaps.length > 0) {
      const exposure = openGaps.reduce((sum, gap) => sum + Number(gap.exposure_amount ?? 0), 0);
      out.push({
        id: `gaps-${id}`,
        kind: 'HUMAN',
        title: `Decide ${openGaps.length} open gap${openGaps.length === 1 ? '' : 's'} on ${name}`,
        why:
          exposure > 0
            ? `${exposure.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })} of exposure is not in the carried total until each one is an allowance, a contingency, or accepted in writing.`
            : 'Until each is disposed of, the buyout total is optimistic.',
        urgency: openGaps.some((gap) => gap.severity === 'CRITICAL') ? 'HIGH' : 'NORMAL',
        step: 'buyout',
        packageId: id,
        packageName: name,
      });
    }

    if (levelled.length > 0 && !selected && openGaps.length === 0) {
      out.push({
        id: `select-${id}`,
        kind: 'HUMAN',
        title: `Select the bidder for ${name}`,
        why: 'Levelled, and every gap decided. Nothing is sent to anyone — a selection is a record.',
        urgency: 'NORMAL',
        step: 'leveling',
        packageId: id,
        packageName: name,
      });
    }
  }

  const order = { BLOCKING: 0, HIGH: 1, NORMAL: 2 };
  return out.sort((a, b) => order[a.urgency] - order[b.urgency]);
}

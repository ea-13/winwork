import type Anthropic from '@anthropic-ai/sdk';
import type { SupabaseClient } from '@supabase/supabase-js';
import { suggestFor } from './suggestions.js';

/**
 * What the assistant can actually do.
 *
 * The Ask panel could only talk. This is the difference between a chat bolted
 * onto a product and a product you can talk to: the assistant reads the real
 * project and runs the real operations, so "what is still open on plumbing"
 * gets an answer from the database rather than from a summary somebody pasted
 * into a prompt.
 *
 * THE RULE LINE IS THE SAME LINE AS EVERYWHERE ELSE. Every tool here is either
 *
 *   - a READ, or
 *   - a run of something that produces DRAFTS or DETERMINISTIC arithmetic
 *
 * and nothing else. There is no tool that writes a scope item, accepts an
 * extraction, disposes of a gap or selects a bidder. Those are gate crossings
 * and they belong to a human with a written rationale (R2, R4) — an assistant
 * that could cross one on your behalf would make the audit trail a record of
 * what a model decided, which is precisely what this product sells against.
 *
 * So the assistant can say "I have levelled it and here is what changed" and it
 * can say "there are four undecided gaps and here is what I would carry", but
 * the second one ends with you clicking something.
 */

export const CHAT_TOOLS: Anthropic.Tool[] = [
  {
    name: 'get_project_state',
    description:
      'The whole picture for the current project: documents, scope items, packages, bids, ' +
      'leveling results and open gaps, with counts and totals. Start here for almost any question.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_suggestions',
    description:
      'What the system thinks is worth doing next on this project and why, ordered by urgency. ' +
      'Use when asked what to do next, or what is blocking.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_scope',
    description:
      'Scope items on the project, with their division, quantity, package and lock state. ' +
      'Optionally filtered to one CSI division.',
    input_schema: {
      type: 'object',
      properties: {
        division: { type: 'string', description: 'Two-digit CSI division, e.g. "22".' },
      },
      required: [],
    },
  },
  {
    name: 'get_scope_context',
    description:
      'The context lines on one scope item — what it includes, excludes, interfaces with and ' +
      'assumes — with the track record of each.',
    input_schema: {
      type: 'object',
      properties: { scopeItemId: { type: 'string' } },
      required: ['scopeItemId'],
    },
  },
  {
    name: 'get_package_detail',
    description:
      'One package in full: its scope, every bid on it, the leveling comparison with adjusted ' +
      'totals and ranks, and its scope gaps with their disposition.',
    input_schema: {
      type: 'object',
      properties: { packageId: { type: 'string' } },
      required: ['packageId'],
    },
  },
  {
    name: 'get_bid_detail',
    description:
      'One bid in full: its lines, everything it excluded, and its terms. The exclusions are ' +
      'usually the answer to "why is this one cheaper".',
    input_schema: {
      type: 'object',
      properties: { quoteId: { type: 'string' } },
      required: ['quoteId'],
    },
  },
  {
    name: 'get_buyout',
    description:
      'The buyout log: every package with budget, allowance, contingency, what is carried, the ' +
      'variance, and the gaps still undecided.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'run_leveling',
    description:
      'Recomputes add-backs, gap detection and the adjusted comparison for a package. Pure ' +
      'arithmetic, no model, reproducible — safe to run whenever bids or scope have changed.',
    input_schema: {
      type: 'object',
      properties: { packageId: { type: 'string' } },
      required: ['packageId'],
    },
  },
  {
    name: 'run_agent',
    description:
      'Queues one of the drafting agents. They propose; nothing they produce becomes project ' +
      'state until a human accepts it. Returns a run id, not a result — say that it is running.',
    input_schema: {
      type: 'object',
      properties: {
        agent: {
          type: 'string',
          enum: ['draft_scope_context', 'audit_coverage', 'compare_bids', 'map_cost_codes'],
          description:
            'draft_scope_context writes what scope items mean; audit_coverage finds what the ' +
            'documents require that the scope misses; compare_bids explains why bids are not ' +
            'comparable; map_cost_codes files scope under the tenant cost structure.',
        },
        packageId: { type: 'string', description: 'Required for compare_bids.' },
      },
      required: ['agent'],
    },
  },
];

export type ToolResult = { ok: true; data: unknown } | { ok: false; error: string };

/**
 * Runs one tool call against the caller's own database client.
 *
 * Everything goes through the user's token, so RLS applies to the assistant
 * exactly as it applies to them. An assistant that ran as service_role would be
 * a way to read another tenant by asking nicely.
 */
export async function runTool(
  db: SupabaseClient,
  context: { projectId: string; tenantId: string; userId: string; queue: QueueFn },
  name: string,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  try {
    switch (name) {
      case 'get_project_state':
        return { ok: true, data: await projectState(db, context.projectId) };

      case 'get_suggestions':
        return { ok: true, data: await suggestFor(db, context.projectId) };

      case 'get_scope': {
        let query = db
          .from('scope_item')
          .select('id, scope_id, csi_division, csi_section, title, unit, quantity, is_locked')
          .eq('project_id', context.projectId);
        if (typeof input.division === 'string' && input.division) {
          query = query.eq('csi_division', input.division);
        }
        const { data } = await query.order('csi_division').order('scope_id');
        return { ok: true, data };
      }

      case 'get_scope_context': {
        const { data: lines } = await db
          .from('scope_context')
          .select('kind, text, origin, is_active, source_location')
          .eq('scope_item_id', String(input.scopeItemId))
          .eq('is_active', true);
        return { ok: true, data: lines };
      }

      case 'get_package_detail':
        return { ok: true, data: await packageDetail(db, String(input.packageId)) };

      case 'get_bid_detail': {
        const quoteId = String(input.quoteId);
        const [{ data: quote }, { data: lines }, { data: exclusions }, { data: terms }] =
          await Promise.all([
            db.from('quote').select('id, quoted_total, status').eq('id', quoteId).maybeSingle(),
            db.from('quote_line').select('description, qty, unit, line_total').eq('quote_id', quoteId),
            db.from('quote_exclusion').select('excerpt, addback_amount, addback_basis').eq('quote_id', quoteId),
            db.from('quote_term').select('term_key, term_value, deviates').eq('quote_id', quoteId),
          ]);
        return { ok: true, data: { quote, lines, exclusions, terms } };
      }

      case 'get_buyout':
        return { ok: true, data: await buyoutRows(db, context.projectId) };

      case 'run_leveling':
        return context.queue('level', { packageId: String(input.packageId) });

      case 'run_agent':
        return context.queue('agent', {
          agent: String(input.agent),
          packageId: typeof input.packageId === 'string' ? input.packageId : undefined,
        });

      default:
        return { ok: false, error: `No such tool: ${name}` };
    }
  } catch (caught) {
    return { ok: false, error: caught instanceof Error ? caught.message : String(caught) };
  }
}

export type QueueFn = (
  kind: 'level' | 'agent',
  args: { packageId?: string; agent?: string },
) => Promise<ToolResult>;

async function projectState(db: SupabaseClient, projectId: string) {
  const [{ data: project }, { data: documents }, { data: scope }, { data: packages }] =
    await Promise.all([
      db.from('project').select('id, bid_id, name, owner_org, due_at').eq('id', projectId).maybeSingle(),
      db.from('project_document').select('id, filename, kind, indexed_at').eq('project_id', projectId),
      db.from('scope_item').select('id, csi_division, is_locked').eq('project_id', projectId),
      db
        .from('work_package')
        .select('id, name, lead_division, status, budget_amount')
        .eq('project_id', projectId),
    ]);

  const packageIds = (packages ?? []).map((row) => row.id as string);

  const [{ data: quotes }, { data: gaps }] = packageIds.length
    ? await Promise.all([
        db
          .from('quote')
          .select('id, package_id, status, quoted_total, subcontractor_id')
          .in('package_id', packageIds),
        db
          .from('scope_gap')
          .select('package_id, gap_type, severity, assigned_type, exposure_amount')
          .in('package_id', packageIds),
      ])
    : [{ data: [] }, { data: [] }];

  return {
    project,
    documents: {
      total: (documents ?? []).length,
      byKind: countBy(documents ?? [], 'kind'),
      unindexedDrawings: (documents ?? []).filter(
        (d) => d.kind === 'DRAWING' && d.indexed_at === null,
      ).length,
    },
    scope: {
      total: (scope ?? []).length,
      locked: (scope ?? []).filter((s) => s.is_locked).length,
      byDivision: countBy(scope ?? [], 'csi_division'),
    },
    packages: (packages ?? []).map((pkg) => ({
      id: pkg.id,
      name: pkg.name,
      division: pkg.lead_division,
      budget: pkg.budget_amount,
      bids: (quotes ?? []).filter((q) => q.package_id === pkg.id).length,
      openGaps: (gaps ?? []).filter(
        (g) => g.package_id === pkg.id && g.assigned_type === null,
      ).length,
    })),
  };
}

async function packageDetail(db: SupabaseClient, packageId: string) {
  const [{ data: pkg }, { data: leveling }, { data: gaps }, { data: packageScope }] =
    await Promise.all([
      db
        .from('work_package')
        .select('id, name, lead_division, budget_amount, allowance_amount, contingency_amount, notes')
        .eq('id', packageId)
        .maybeSingle(),
      db.from('leveling_result').select('*').eq('package_id', packageId).order('advisory_rank'),
      db.from('scope_gap').select('*').eq('package_id', packageId),
      db.from('package_scope').select('scope_item_id').eq('package_id', packageId),
    ]);

  const scopeIds = (packageScope ?? []).map((row) => row.scope_item_id as string);
  const resultQuoteIds = [...new Set((leveling ?? []).map((row) => row.quote_id as string))];

  const [{ data: scopeItems }, { data: quotes }, { data: subs }] = await Promise.all([
    scopeIds.length
      ? db.from('scope_item').select('id, scope_id, title, quantity, unit').in('id', scopeIds)
      : Promise.resolve({ data: [] as Record<string, unknown>[] }),
    resultQuoteIds.length
      ? db
          .from('quote')
          .select('id, subcontractor_id, source_filename, status')
          .in('id', resultQuoteIds)
      : Promise.resolve({ data: [] as Record<string, unknown>[] }),
    db.from('subcontractor').select('id, name'),
  ]);

  const subName = new Map((subs ?? []).map((row) => [row.id as string, row.name as string]));
  const quoteById = new Map((quotes ?? []).map((row) => [row.id as string, row]));

  return {
    package: pkg,
    scope: scopeItems,
    leveling: (leveling ?? []).map((row) => {
      const quote = quoteById.get(row.quote_id as string);
      return {
        quoteId: row.quote_id,
        bidder:
          (quote?.subcontractor_id ? subName.get(quote.subcontractor_id as string) : null) ??
          quote?.source_filename ??
          'Unidentified',
        quotedTotal: row.quoted_total,
        addbackTotal: row.addback_total,
        adjustedTotal: row.adjusted_total,
        advisoryRank: row.advisory_rank,
        weightedScore: row.weighted_score,
      };
    }),
    gaps: gaps ?? [],
  };
}

async function buyoutRows(db: SupabaseClient, projectId: string) {
  const { data: packages } = await db
    .from('work_package')
    .select('id, name, lead_division, budget_amount, allowance_amount, contingency_amount')
    .eq('project_id', projectId);

  const packageIds = (packages ?? []).map((row) => row.id as string);
  if (packageIds.length === 0) return [];

  const [{ data: leveling }, { data: gaps }] = await Promise.all([
    db.from('leveling_result').select('package_id, adjusted_total, advisory_rank').in('package_id', packageIds),
    db.from('scope_gap').select('package_id, assigned_type, assigned_amount, exposure_amount').in('package_id', packageIds),
  ]);

  return (packages ?? []).map((pkg) => {
    const leading = (leveling ?? []).find(
      (row) => row.package_id === pkg.id && row.advisory_rank === 1,
    );
    const packageGaps = (gaps ?? []).filter((row) => row.package_id === pkg.id);

    return {
      package: pkg.name,
      division: pkg.lead_division,
      budget: pkg.budget_amount,
      adjusted: leading?.adjusted_total ?? null,
      openGaps: packageGaps.filter((gap) => gap.assigned_type === null).length,
      openExposure: packageGaps
        .filter((gap) => gap.assigned_type === null)
        .reduce((sum, gap) => sum + Number(gap.exposure_amount ?? 0), 0),
    };
  });
}

function countBy(rows: Record<string, unknown>[], key: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const row of rows) {
    const value = String(row[key] ?? 'unknown');
    out[value] = (out[value] ?? 0) + 1;
  }
  return out;
}

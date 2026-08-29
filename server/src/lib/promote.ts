import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Promoting drafts to canonical state.
 *
 * An agent proposes; a human accepts. This is the seam between the two, and it
 * is the only way an agent's output ever becomes a row anyone acts on (R2).
 *
 * It runs through the caller's own client, so RLS applies, and it writes an
 * audit_event naming the person who accepted the work. The drafts themselves
 * are untouched — they are immutable, and they remain the evidence for what was
 * proposed even after a human changes it.
 */

type Draft = {
  id: string;
  target_table: string;
  target_id: string | null;
  field: string;
  proposed_value: unknown;
  source_file_id: string | null;
  source_location: string | null;
  confidence: number | null;
};

export type PromotionResult = {
  quoteLines: number;
  exclusions: number;
  terms: number;
  quoteFields: string[];
};

type LineValue = {
  description?: string;
  qty?: number | null;
  unit?: string | null;
  rate?: number | null;
  line_total?: number | null;
  source_location?: string;
  is_lumped?: boolean;
};

type ExclusionValue = {
  excerpt?: string;
  source_location?: string;
  what_is_excluded?: string;
  confidence?: number;
};

type TermValue = { term_key?: string; term_value?: string; source_location?: string };

/**
 * Materialises one extraction run's drafts onto a quote.
 *
 * Idempotent by replacement: promoting twice replaces the previously promoted
 * lines rather than doubling them. Extraction is commonly re-run after a prompt
 * change, and an estimator should not have to clean up after that.
 */
export async function promoteExtraction(
  db: SupabaseClient,
  options: { tenantId: string; actorId: string; quoteId: string; runId: string },
): Promise<PromotionResult> {
  const { data: drafts, error } = await db
    .from('draft')
    .select('id, target_table, target_id, field, proposed_value, source_file_id, source_location, confidence')
    .eq('agent_run_id', options.runId)
    .order('id');

  if (error) throw new Error(`Could not read the drafts: ${error.message}`);
  const rows = (drafts ?? []) as Draft[];
  if (rows.length === 0) throw new Error('That run produced no drafts to promote');

  // Replace rather than append — see the note above.
  await db.from('quote_line').delete().eq('quote_id', options.quoteId);
  await db.from('quote_exclusion').delete().eq('quote_id', options.quoteId);
  await db.from('quote_term').delete().eq('quote_id', options.quoteId);

  const base = { tenant_id: options.tenantId, quote_id: options.quoteId };

  const lines = rows
    .filter((row) => row.target_table === 'quote_line')
    .map((row) => {
      const value = (row.proposed_value ?? {}) as LineValue;
      return {
        ...base,
        original_text: value.description ?? null,
        description: value.description ?? null,
        qty: value.qty ?? null,
        unit: value.unit ?? null,
        rate: value.rate ?? null,
        line_total: value.line_total ?? null,
        is_lumped: value.is_lumped ?? false,
        extraction_source: row.source_location ?? value.source_location ?? null,
      };
    });

  const exclusions = rows
    .filter((row) => row.target_table === 'quote_exclusion')
    .map((row) => {
      const value = (row.proposed_value ?? {}) as ExclusionValue;
      return {
        ...base,
        excerpt: value.excerpt ?? null,
        source_location: row.source_location ?? value.source_location ?? null,
        // No add-back yet. R1: it stays blank until P9 finds a basis for it.
        addback_amount: null,
        addback_basis: null,
        addback_confidence: value.confidence ?? row.confidence ?? null,
      };
    });

  const terms = rows
    .filter((row) => row.target_table === 'quote_term')
    .map((row) => {
      const value = (row.proposed_value ?? {}) as TermValue;
      return {
        ...base,
        term_key: value.term_key ?? row.field,
        term_value: value.term_value ?? null,
        standard_position: null,
        deviates: null,
      };
    });

  // quote_line has no extraction_source column; drop it before insert.
  const insertable = lines.map(({ extraction_source: _ignored, ...rest }) => rest);

  if (insertable.length > 0) {
    const { error: lineError } = await db.from('quote_line').insert(insertable);
    if (lineError) throw new Error(`Could not write quote lines: ${lineError.message}`);
  }
  if (exclusions.length > 0) {
    const { error: exclusionError } = await db.from('quote_exclusion').insert(exclusions);
    if (exclusionError) throw new Error(`Could not write exclusions: ${exclusionError.message}`);
  }
  if (terms.length > 0) {
    const { error: termError } = await db.from('quote_term').insert(terms);
    if (termError) throw new Error(`Could not write terms: ${termError.message}`);
  }

  // Quote-level scalars.
  const quotePatch: Record<string, unknown> = {};
  const accepted: string[] = [];
  for (const row of rows.filter((entry) => entry.target_table === 'quote')) {
    const column = row.field === 'subcontractor_name' ? null : row.field;
    if (!column) continue; // the bidder is matched to a subcontractor by a human
    quotePatch[column] = row.proposed_value;
    accepted.push(column);
  }

  if (Object.keys(quotePatch).length > 0) {
    const { error: quoteError } = await db
      .from('quote')
      .update(quotePatch)
      .eq('id', options.quoteId);
    if (quoteError) throw new Error(`Could not update the quote: ${quoteError.message}`);
  }

  await db.from('audit_event').insert({
    tenant_id: options.tenantId,
    actor_id: options.actorId,
    action: 'PROMOTE_EXTRACTION',
    table_name: 'quote',
    record_id: options.quoteId,
    before: null,
    after: {
      agent_run_id: options.runId,
      quote_lines: insertable.length,
      exclusions: exclusions.length,
      terms: terms.length,
      quote_fields: accepted,
    },
  });

  return {
    quoteLines: insertable.length,
    exclusions: exclusions.length,
    terms: terms.length,
    quoteFields: accepted,
  };
}

/**
 * Applies a normalisation run's proposed mappings to the quote's lines.
 *
 * Ambiguous matches arrive with a null scope_item_id and an AMBIGUOUS basis, so
 * accepting them does not quietly accept a guess — it records that the agent
 * could not decide, which is what the gap detector then reports.
 */
export async function promoteNormalisation(
  db: SupabaseClient,
  options: { tenantId: string; actorId: string; quoteId: string; runId: string },
): Promise<{ lines: number; exclusions: number }> {
  const { data: drafts, error } = await db
    .from('draft')
    .select('target_table, target_id, field, proposed_value')
    .eq('agent_run_id', options.runId);

  if (error) throw new Error(`Could not read the drafts: ${error.message}`);

  let lines = 0;
  let exclusions = 0;

  for (const draft of drafts ?? []) {
    if (!draft.target_id) continue;
    const value = (draft.proposed_value ?? {}) as Record<string, unknown>;

    if (draft.target_table === 'quote_line' && draft.field === 'scope_item_id') {
      await db
        .from('quote_line')
        .update({
          scope_item_id: (value.scope_item_id as string | null) ?? null,
          match_confidence: (value.match_confidence as number | null) ?? null,
          match_basis: (value.match_basis as string | null) ?? null,
          is_lumped: Boolean(value.is_lumped),
        })
        .eq('id', draft.target_id);
      lines += 1;
    }

    if (draft.target_table === 'quote_exclusion' && draft.field === 'scope_item_id') {
      await db
        .from('quote_exclusion')
        .update({ scope_item_id: (value.scope_item_id as string | null) ?? null })
        .eq('id', draft.target_id);
      exclusions += 1;
    }
  }

  await db.from('audit_event').insert({
    tenant_id: options.tenantId,
    actor_id: options.actorId,
    action: 'PROMOTE_NORMALISATION',
    table_name: 'quote',
    record_id: options.quoteId,
    before: null,
    after: { agent_run_id: options.runId, lines, exclusions },
  });

  return { lines, exclusions };
}

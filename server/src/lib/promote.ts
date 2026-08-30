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

// -----------------------------------------------------------------------------
// Drafts that create rows rather than fill them in
// -----------------------------------------------------------------------------

type ScopeItemValue = {
  scope_id?: string | null;
  csi_division?: string | null;
  csi_section?: string | null;
  title?: string;
  description?: string | null;
  unit?: string | null;
  quantity?: number | null;
  quantity_basis?: string | null;
};

type ScopeContextValue = {
  scope_item_id?: string;
  kind?: string;
  text?: string;
  origin?: string;
  gap_pattern_id?: string | null;
};

/**
 * Turns a scope-drafting run into real scope items.
 *
 * Idempotent on scope_id: promoting the same run twice updates the items it
 * already created rather than doubling the baseline. Re-running the drafter
 * after fixing a document label is normal, and an estimator should not have to
 * clean up forty duplicate line items afterwards.
 *
 * A locked item is never touched. Locking is H2, and a re-draft quietly
 * rewriting a baseline somebody has already levelled bids against would make
 * every comparison built on it wrong.
 */
/**
 * A person's edits to what was proposed, keyed by draft id.
 *
 * Drafts are immutable, so an estimator who fixes a title before accepting is
 * not editing the evidence — the draft still says what the agent said. The
 * correction rides in here, lands on the scope item, and is recorded in the
 * audit event as a field the human changed. That is exactly the shape R2 wants:
 * the agent's claim and the human's decision are both legible afterwards, and
 * they are not the same record.
 */
export type ScopeOverrides = Record<string, Partial<ScopeItemValue>>;

export async function promoteScopeDrafts(
  db: SupabaseClient,
  options: {
    tenantId: string;
    actorId: string;
    projectId: string;
    runId: string;
    /** Human edits made in the table before accepting, keyed by draft id. */
    overrides?: ScopeOverrides;
    /** Draft ids the human rejected outright. Never written. */
    drop?: string[];
  },
): Promise<{ created: number; updated: number; skippedLocked: number; dropped: number; edited: number }> {
  const { data: drafts, error } = await db
    .from('draft')
    .select('id, target_table, target_id, field, proposed_value, source_location, confidence')
    .eq('agent_run_id', options.runId)
    .eq('target_table', 'scope_item')
    .order('id');

  if (error) throw new Error(`Could not read the drafts: ${error.message}`);
  const rows = (drafts ?? []) as Draft[];
  if (rows.length === 0) throw new Error('That run produced no scope items to promote');

  const { data: existing } = await db
    .from('scope_item')
    .select('id, scope_id, is_locked')
    .eq('project_id', options.projectId);

  const byScopeId = new Map(
    (existing ?? []).map((item) => [item.scope_id as string, item]),
  );

  let created = 0;
  let updated = 0;
  let skippedLocked = 0;
  let dropped = 0;
  let edited = 0;

  const dropSet = new Set(options.drop ?? []);
  const overrides = options.overrides ?? {};

  for (const draft of rows) {
    if (dropSet.has(draft.id)) {
      dropped += 1;
      continue;
    }

    const override = overrides[draft.id];
    const value = { ...((draft.proposed_value ?? {}) as ScopeItemValue), ...(override ?? {}) };
    if (override && Object.keys(override).length > 0) edited += 1;
    if (!value.title || !value.scope_id) continue;

    const match = byScopeId.get(value.scope_id);

    if (match?.is_locked) {
      skippedLocked += 1;
      continue;
    }

    const fields = {
      csi_division: value.csi_division ?? null,
      csi_section: value.csi_section ?? null,
      title: value.title,
      description: value.description ?? null,
      unit: value.unit ?? null,
      // R1: an unstated quantity stays null. It is never defaulted to zero.
      quantity: value.quantity ?? null,
      quantity_basis: value.quantity_basis ?? null,
    };

    if (match) {
      const { error: updateError } = await db
        .from('scope_item')
        .update(fields)
        .eq('id', match.id);
      if (updateError) throw new Error(`Could not update ${value.scope_id}: ${updateError.message}`);
      updated += 1;
      continue;
    }

    const { error: insertError } = await db.from('scope_item').insert({
      tenant_id: options.tenantId,
      project_id: options.projectId,
      scope_id: value.scope_id,
      ...fields,
    });

    if (insertError) throw new Error(`Could not create ${value.scope_id}: ${insertError.message}`);
    created += 1;
  }

  await db.from('audit_event').insert({
    tenant_id: options.tenantId,
    actor_id: options.actorId,
    action: 'PROMOTE_SCOPE',
    table_name: 'scope_item',
    record_id: options.projectId,
    before: null,
    after: {
      agent_run_id: options.runId,
      created,
      updated,
      skippedLocked,
      dropped,
      edited,
      // Which fields a person changed before accepting, so "accept with
      // changes" is answerable later without diffing against the drafts.
      changed_fields: [
        ...new Set(Object.values(overrides).flatMap((patch) => Object.keys(patch))),
      ],
      dropped_draft_ids: [...dropSet],
    },
  });

  return { created, updated, skippedLocked, dropped, edited };
}

/**
 * Turns a context-drafting run into real context lines.
 *
 * Deduplicated on (scope item, kind, text) so re-running the drafter does not
 * stack four copies of the same inclusion onto an item. A line that already
 * exists is left exactly as it is — including any edit a human has made to its
 * wording, which is the whole reason not to replace-and-reinsert here.
 */
export async function promoteContextDrafts(
  db: SupabaseClient,
  options: { tenantId: string; actorId: string; runId: string },
): Promise<{ created: number; alreadyPresent: number }> {
  const { data: drafts, error } = await db
    .from('draft')
    .select('id, target_table, target_id, field, proposed_value, source_location, confidence')
    .eq('agent_run_id', options.runId)
    .eq('target_table', 'scope_context')
    .order('id');

  if (error) throw new Error(`Could not read the drafts: ${error.message}`);
  const rows = (drafts ?? []) as Draft[];
  if (rows.length === 0) throw new Error('That run produced no context lines to promote');

  const scopeItemIds = [
    ...new Set(
      rows
        .map((draft) => (draft.proposed_value as ScopeContextValue)?.scope_item_id)
        .filter(Boolean) as string[],
    ),
  ];

  const { data: existing } = scopeItemIds.length
    ? await db
        .from('scope_context')
        .select('scope_item_id, kind, text')
        .in('scope_item_id', scopeItemIds)
    : { data: [] as Record<string, unknown>[] };

  const normalise = (text: string) => text.toLowerCase().replace(/\s+/g, ' ').trim();

  const present = new Set(
    (existing ?? []).map(
      (line) => `${line.scope_item_id}|${line.kind}|${normalise(String(line.text))}`,
    ),
  );

  const position = new Map<string, number>();
  for (const line of existing ?? []) {
    const key = line.scope_item_id as string;
    position.set(key, (position.get(key) ?? 0) + 1);
  }

  let created = 0;
  let alreadyPresent = 0;

  for (const draft of rows) {
    const value = (draft.proposed_value ?? {}) as ScopeContextValue;
    if (!value.scope_item_id || !value.kind || !value.text) continue;

    const key = `${value.scope_item_id}|${value.kind}|${normalise(value.text)}`;
    if (present.has(key)) {
      alreadyPresent += 1;
      continue;
    }

    const next = (position.get(value.scope_item_id) ?? 0) + 1;
    position.set(value.scope_item_id, next);

    const { error: insertError } = await db.from('scope_context').insert({
      tenant_id: options.tenantId,
      scope_item_id: value.scope_item_id,
      kind: value.kind,
      text: value.text,
      origin: value.origin ?? 'PATTERN',
      source_location: draft.source_location,
      gap_pattern_id: value.gap_pattern_id ?? null,
      confidence: draft.confidence,
      position: next,
      created_by: options.actorId,
    });

    if (insertError) throw new Error(`Could not create a context line: ${insertError.message}`);
    present.add(key);
    created += 1;
  }

  await db.from('audit_event').insert({
    tenant_id: options.tenantId,
    actor_id: options.actorId,
    action: 'PROMOTE_CONTEXT',
    table_name: 'scope_context',
    record_id: options.runId,
    before: null,
    after: { agent_run_id: options.runId, created, alreadyPresent },
  });

  return { created, alreadyPresent };
}

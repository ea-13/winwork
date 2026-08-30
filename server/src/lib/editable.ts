/**
 * Human editing of canonical state.
 *
 * The product is a workspace, not a read-only view of agent output. An
 * estimator types over anything, at any time — that is the point, and it is
 * also what R2 already says: agents write evidence, humans write state. This
 * module is the "humans write state" half made general.
 *
 * Every edit writes an audit_event carrying the before and after values, the
 * actor and the timestamp. That ledger is append-only, so the record cannot be
 * quietly revised — and it doubles as the training corpus: an agent's draft
 * followed by what a human actually chose is a labelled correction. See
 * docs/05-TECH-DEBT.md, "Training corpus".
 */

/**
 * What a human may type over, per table.
 *
 * Three kinds of column are deliberately absent:
 *
 *   - identity and tenancy (`id`, `tenant_id`, `created_at`) — not data, and
 *     editing them would move a row between tenants
 *   - gate-controlled state (`is_locked`, `approved_by`, `approved_at`,
 *     `status` on work_package) — those change by crossing a gate with a
 *     rationale, not by typing. R4: no path may bypass a gate
 *   - agent bookkeeping (`extraction_run_id`, `normalisation_run_id`) — the
 *     provenance of a value, not the value
 */
export const EDITABLE: Record<string, readonly string[]> = {
  project: ['name', 'owner_org', 'due_at', 'status',
    // P11 weights. They move the advisory weighted score and never the
    // adjusted ranking, which is why they are safe to type over.
    'weight_price', 'weight_scope', 'weight_risk', 'weight_commercial', 'weight_programme'],

  work_package: ['name', 'description', 'lead_division', 'csi_divisions',
    'budget_amount', 'allowance_amount', 'contingency_amount', 'notes', 'cost_code_id'],

  scope_item: ['scope_id', 'csi_division', 'csi_section', 'title', 'description',
    'unit', 'quantity', 'quantity_basis', 'cost_code_id'],

  subcontractor: ['name', 'trade_csi', 'contact_name', 'contact_email', 'contact_phone',
    'license_no', 'license_class', 'bonding_capacity', 'emr', 'prequal_status',
    'address_line', 'city', 'state', 'postal_code', 'union_status', 'vendor_code'],

  package_bidder: ['invited_state'],

  quote: ['subcontractor_id', 'quoted_total', 'currency', 'quote_date', 'revision',
    'pricing_basis', 'status', 'extraction_confidence'],

  quote_line: ['scope_item_id', 'description', 'qty', 'unit', 'rate', 'line_total',
    'match_basis', 'is_lumped', 'match_confidence'],

  quote_exclusion: ['scope_item_id', 'excerpt', 'source_location', 'addback_amount',
    'addback_basis', 'addback_confidence'],

  quote_term: ['term_key', 'term_value', 'standard_position', 'deviates'],

  scope_gap: ['gap_type', 'exposure_amount', 'exposure_basis', 'confidence', 'severity'],

  // rolled_total is derived and recomputed; typing over it would be erased by
  // the next level run. The estimator's number goes in override_total.
  scope_leveling: ['override_total', 'note'],

  document_sheet: ['sheet_number', 'sheet_title', 'discipline'],

  cost_code: ['code', 'description', 'csi_division', 'csi_section', 'sort_order', 'is_active'],

  quote_allocation: ['amount', 'cost_code_id', 'note'],

  // is_active and retired_reason move through the retire endpoint, which
  // records why — a line that vanished with no reason teaches nothing.
  scope_context: ['kind', 'text', 'source_location', 'position'],

  leveling_result: ['risk_allowance', 'score_price', 'score_scope', 'score_programme',
    'score_commercial', 'score_risk'],

  benchmark_range: ['csi_section', 'description', 'unit', 'low', 'high', 'is_calibrated'],

  // project_id links a finished job to the project its bid set was
  // reconstructed in. That link is the whole backtest — without it there is
  // no baseline to have missed anything against — and setting it is an
  // ordinary human edit, not a gate crossing.
  past_project: ['name', 'gc_name', 'contract_value', 'completed_at', 'project_id'],

  change_order: ['co_number', 'amount', 'description', 'stated_reason', 'issued_at',
    // The hindsight verdict itself moves through its own endpoint, which
    // enforces that PREDICTED names the gap that predicted it.
    'scope_item_id'],

  co_classification: ['classification', 'human_verdict', 'reasoning'],

  project_document: ['kind', 'filename', 'discipline', 'revision'],
};

export type EditError = { status: number; error: string };

/** Rejects unknown tables and columns before anything reaches the database. */
export function validatePatch(
  table: string,
  patch: Record<string, unknown>,
): EditError | null {
  const allowed = EDITABLE[table];
  if (!allowed) {
    return { status: 404, error: `${table} is not editable` };
  }

  const fields = Object.keys(patch);
  if (fields.length === 0) {
    return { status: 400, error: 'No fields to update' };
  }

  const refused = fields.filter((field) => !allowed.includes(field));
  if (refused.length > 0) {
    return {
      status: 403,
      error:
        `Not editable on ${table}: ${refused.join(', ')}. ` +
        'Gate-controlled and identity columns change through their gate, not by typing.',
    };
  }
  return null;
}

/** Only the fields that actually changed, so the audit trail stays meaningful. */
export function diff(
  before: Record<string, unknown>,
  patch: Record<string, unknown>,
): { before: Record<string, unknown>; after: Record<string, unknown> } {
  const changedBefore: Record<string, unknown> = {};
  const changedAfter: Record<string, unknown> = {};

  for (const [field, next] of Object.entries(patch)) {
    const previous = before[field] ?? null;
    const normalisedNext = next ?? null;
    if (JSON.stringify(previous) !== JSON.stringify(normalisedNext)) {
      changedBefore[field] = previous;
      changedAfter[field] = normalisedNext;
    }
  }
  return { before: changedBefore, after: changedAfter };
}

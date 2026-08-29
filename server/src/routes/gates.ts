import { Router, type Request, type Response } from 'express';
import type { Gate, GateResponse, Role } from 'shared';
import { readRationale, requireRole } from '../lib/auth.js';
import { supabaseForUser } from '../lib/supabase.js';

/**
 * The five human gates. No agent crosses one, ever — not on a confidence score,
 * not after a retry, not under autopilot (R4). Each crossing is attributed and
 * justified, and lands one append-only approval row.
 *
 * Each gate is a single Postgres function (migration 0008), so the approval and
 * the state change it authorises are one transaction. They used to be two
 * statements, which meant a failure between them could leave an approval for
 * something that did not happen. The ledger is the product's integrity claim to
 * a GC; it does not get an asterisk.
 *
 * The functions are SECURITY INVOKER, so RLS still decides which rows the
 * caller may touch. A gate is not a way around tenancy.
 */
export const gatesRouter = Router();

type Params = Record<string, unknown>;

function gate(
  path: string,
  name: Gate,
  roles: Role[],
  fn: string,
  buildArgs: (body: Params, rationale: string, actorRole: string) => Params | { error: string },
) {
  gatesRouter.post(path, requireRole(...roles), async (req: Request, res: Response) => {
    const auth = req.auth;
    if (!auth) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }

    const rationale = readRationale(req, res);
    if (rationale === null) return;

    // The role that actually authorised this crossing, for the ledger.
    const actorRole = roles.find((role) => auth.roles.includes(role)) ?? auth.roles[0] ?? '';

    const args = buildArgs((req.body ?? {}) as Params, rationale, actorRole);
    if ('error' in args && typeof args.error === 'string') {
      res.status(400).json({ error: args.error });
      return;
    }

    const { data, error } = await supabaseForUser(auth.token).rpc(fn, args);

    if (error) {
      // 22023 is the rationale check inside the function.
      res.status(error.code === '22023' ? 400 : 500).json({ error: error.message });
      return;
    }

    const result = data as { approvalId: string; affected: number };
    const body: GateResponse = {
      gate: name,
      approvalId: result.approvalId,
      affected: result.affected,
    };
    res.json(body);
  });
}

const ids = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];

// H2 · Scope of Work locked — EST
gate('/h2/scope-lock', 'H2', ['EST'], 'gate_h2_scope_lock', (body, rationale, actorRole) => {
  const scopeItems = ids(body.scopeItemIds);
  if (scopeItems.length === 0) return { error: 'scopeItemIds must be a non-empty array' };
  return { p_actor_role: actorRole, p_rationale: rationale, p_scope_items: scopeItems };
});

// H3 · Work package approved — BC
gate('/h3/package-approve', 'H3', ['BC'], 'gate_h3_package_approve', (body, rationale, actorRole) => {
  if (typeof body.packageId !== 'string') return { error: 'packageId is required' };
  return { p_actor_role: actorRole, p_rationale: rationale, p_package: body.packageId };
});

// H4 · Bidder list approved — BC
gate('/h4/bidder-list-approve', 'H4', ['BC'], 'gate_h4_bidder_list_approve', (body, rationale, actorRole) => {
  if (typeof body.packageId !== 'string') return { error: 'packageId is required' };
  return { p_actor_role: actorRole, p_rationale: rationale, p_package: body.packageId };
});

// H5 · Clarifications released — EST. Drafted only: there is no send (R3).
gate('/h5/clarifications', 'H5', ['EST'], 'gate_h5_clarifications', (body, rationale, actorRole) => {
  if (typeof body.packageId !== 'string') return { error: 'packageId is required' };
  return { p_actor_role: actorRole, p_rationale: rationale, p_package: body.packageId };
});

// H6 · Bidder selected — EST. Nothing is notified; a selection is a record.
gate('/h6/selection', 'H6', ['EST'], 'gate_h6_selection', (body, rationale, actorRole) => {
  if (typeof body.packageId !== 'string' || typeof body.quoteId !== 'string') {
    return { error: 'packageId and quoteId are required' };
  }
  return {
    p_actor_role: actorRole,
    p_rationale: rationale,
    p_package: body.packageId,
    p_quote: body.quoteId,
  };
});

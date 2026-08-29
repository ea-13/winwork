import { Router, type Request, type Response } from 'express';
import type { Gate, GateResponse, Role } from 'shared';
import { readRationale, requireRole } from '../lib/auth.js';
import { supabaseForUser } from '../lib/supabase.js';

/**
 * The five human gates. No agent crosses one, ever — not on a confidence score,
 * not after a retry, not under autopilot (R4). Each crossing is attributed and
 * justified, and lands one append-only approval row.
 *
 * Known limitation: the approval row and the state change it authorises are two
 * statements, not one transaction, because supabase-js cannot span them. The
 * approval is written first, so the failure mode is an approval recording an
 * attempt that did not land — visible and honest — rather than a state change
 * nobody authorised. P19 (provenance and the approval ledger) should move each
 * gate into a single Postgres function and make it atomic.
 */
export const gatesRouter = Router();

type GateHandler = (
  db: ReturnType<typeof supabaseForUser>,
  req: Request,
  tenantId: string,
  userId: string,
) => Promise<{ affected: number } | { error: string; status?: number }>;

function gate(path: string, name: Gate, roles: Role[], handler: GateHandler) {
  gatesRouter.post(path, requireRole(...roles), async (req: Request, res: Response) => {
    const auth = req.auth;
    if (!auth) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }

    const rationale = readRationale(req, res);
    if (rationale === null) return;

    const db = supabaseForUser(auth.token);

    // The role that actually authorised this crossing, for the ledger.
    const actorRole = roles.find((role) => auth.roles.includes(role)) ?? auth.roles[0] ?? null;

    const { data: approval, error: approvalError } = await db
      .from('approval')
      .insert({
        tenant_id: auth.tenantId,
        gate: name,
        actor_id: auth.userId,
        actor_role: actorRole,
        rationale,
      })
      .select('id')
      .single();

    if (approvalError || !approval) {
      res.status(500).json({ error: approvalError?.message ?? 'Could not record the approval' });
      return;
    }

    const result = await handler(db, req, auth.tenantId, auth.userId);
    if ('error' in result) {
      res.status(result.status ?? 400).json({ error: result.error });
      return;
    }

    const body: GateResponse = { gate: name, approvalId: approval.id, affected: result.affected };
    res.json(body);
  });
}

const ids = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];

// H2 · Scope of Work locked — EST
gate('/h2/scope-lock', 'H2', ['EST'], async (db, req, _tenantId, userId) => {
  const scopeItemIds = ids((req.body as Record<string, unknown>)?.scopeItemIds);
  if (scopeItemIds.length === 0) {
    return { error: 'scopeItemIds must be a non-empty array' };
  }

  const { data, error } = await db
    .from('scope_item')
    .update({ is_locked: true, locked_by: userId, locked_at: new Date().toISOString() })
    .in('id', scopeItemIds)
    .select('id');

  if (error) return { error: error.message, status: 500 };
  return { affected: data?.length ?? 0 };
});

// H3 · Work package approved — BC
gate('/h3/package-approve', 'H3', ['BC'], async (db, req, _tenantId, userId) => {
  const packageId = (req.body as Record<string, unknown>)?.packageId;
  if (typeof packageId !== 'string') return { error: 'packageId is required' };

  const { data, error } = await db
    .from('work_package')
    .update({ status: 'APPROVED', approved_by: userId, approved_at: new Date().toISOString() })
    .eq('id', packageId)
    .select('id');

  if (error) return { error: error.message, status: 500 };
  return { affected: data?.length ?? 0 };
});

// H4 · Bidder list approved — BC
gate('/h4/bidder-list-approve', 'H4', ['BC'], async (db, req, _tenantId, userId) => {
  const packageId = (req.body as Record<string, unknown>)?.packageId;
  if (typeof packageId !== 'string') return { error: 'packageId is required' };

  const { data, error } = await db
    .from('package_bidder')
    .update({ list_approved_by: userId, list_approved_at: new Date().toISOString() })
    .eq('package_id', packageId)
    .select('id');

  if (error) return { error: error.message, status: 500 };
  return { affected: data?.length ?? 0 };
});

// H5 · Clarifications released — EST. Drafted only: there is no send (R3).
gate('/h5/clarifications', 'H5', ['EST'], async (db, req, _tenantId, userId) => {
  const packageId = (req.body as Record<string, unknown>)?.packageId;
  if (typeof packageId !== 'string') return { error: 'packageId is required' };

  const { data, error } = await db
    .from('solicitation_draft')
    .update({ approved_by: userId, approved_at: new Date().toISOString() })
    .eq('package_id', packageId)
    .select('id');

  if (error) return { error: error.message, status: 500 };
  return { affected: data?.length ?? 0 };
});

// H6 · Bidder selected — EST. Nothing is notified; a selection is a record.
gate('/h6/selection', 'H6', ['EST'], async (db, req, tenantId, userId) => {
  const body = (req.body as Record<string, unknown>) ?? {};
  const { packageId, quoteId, rationale } = body;
  if (typeof packageId !== 'string' || typeof quoteId !== 'string') {
    return { error: 'packageId and quoteId are required' };
  }

  const { data, error } = await db
    .from('selection')
    .insert({
      tenant_id: tenantId,
      package_id: packageId,
      quote_id: quoteId,
      selected_by: userId,
      rationale: String(rationale).trim(),
    })
    .select('id');

  if (error) return { error: error.message, status: 500 };
  return { affected: data?.length ?? 0 };
});

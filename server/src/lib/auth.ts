import type { NextFunction, Request, Response } from 'express';
import type { Role } from 'shared';
import { supabaseAdmin } from './supabase.js';

export type AuthContext = {
  /** auth.users.id, which is also app_user.id — the seed keeps them aligned. */
  userId: string;
  tenantId: string;
  email: string;
  roles: Role[];
  /** Passed through to supabaseForUser so queries run under the caller's RLS. */
  token: string;
};

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: AuthContext;
    }
  }
}

/**
 * Verifies the bearer token with Supabase and attaches the caller's tenant and
 * roles, which arrive as app_metadata claims — writable only by service_role,
 * so a user cannot grant themselves a role or move themselves between tenants.
 */
export async function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const header = req.header('authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';

  if (!token) {
    res.status(401).json({ error: 'Missing bearer token' });
    return;
  }

  const { data, error } = await supabaseAdmin.auth.getUser(token);
  if (error || !data.user) {
    res.status(401).json({ error: 'Invalid or expired session' });
    return;
  }

  const claims = data.user.app_metadata as { tenant_id?: string; roles?: Role[] };
  if (!claims.tenant_id) {
    res.status(403).json({ error: 'This account carries no tenant claim' });
    return;
  }

  req.auth = {
    userId: data.user.id,
    tenantId: claims.tenant_id,
    email: data.user.email ?? '',
    roles: claims.roles ?? [],
    token,
  };
  next();
}

/**
 * Passes if the caller holds ANY of the listed roles. Roles are grants, not an
 * enum — one person routinely holds several, and a small GC gives one estimator
 * both BC and EST.
 */
export function requireRole(...roles: Role[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const held = req.auth?.roles ?? [];
    if (!roles.some((role) => held.includes(role))) {
      res.status(403).json({
        error: `Requires one of: ${roles.join(', ')}. This account holds: ${held.join(', ') || 'none'}`,
      });
      return;
    }
    next();
  };
}

/**
 * R3. There is no outbound send path in this product — not disabled behind a
 * flag, absent. Anything that smells like one is refused at creation.
 *
 * This is the API half of the guard; the other half is a check constraint on
 * job.job_type, so the rule survives a code path that forgets to call this.
 */
const SEND_PATTERN = /send|invite|remind|award|submit|email|sms|message/i;

export function refuseSendPaths(req: Request, res: Response, next: NextFunction): void {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const candidates = [body.job_type, body.jobType, body.agent_type, body.agentType]
    .filter((value): value is string => typeof value === 'string');

  if (candidates.some((value) => SEND_PATTERN.test(value))) {
    res.status(403).json({ error: 'No outbound send path exists in this system.' });
    return;
  }
  next();
}

/**
 * Every gate crossing is attributed and justified. A blank rationale is not a
 * rationale, so this rejects whitespace as firmly as it rejects absence — the
 * same check the database makes on approval.rationale.
 */
export function readRationale(req: Request, res: Response): string | null {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const rationale = typeof body.rationale === 'string' ? body.rationale.trim() : '';

  if (!rationale) {
    res.status(400).json({ error: 'A non-empty rationale is required to cross a gate' });
    return null;
  }
  return rationale;
}

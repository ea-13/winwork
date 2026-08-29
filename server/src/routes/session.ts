import { Router } from 'express';
import type { SessionUser } from 'shared';

export const sessionRouter = Router();

/**
 * Who the caller is, according to their verified token. The client uses this to
 * decide which gates to offer — but the decision that matters is made again on
 * the server, and again by RLS. This endpoint is convenience, not authority.
 */
sessionRouter.get('/me', (req, res) => {
  const auth = req.auth;
  if (!auth) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }

  const body: SessionUser = {
    appUserId: auth.userId,
    tenantId: auth.tenantId,
    email: auth.email,
    roles: auth.roles,
  };
  res.json(body);
});

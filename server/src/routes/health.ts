import { Router } from 'express';
import type { HealthResponse } from 'shared';
import { supabaseAdmin } from '../lib/supabase.js';

/**
 * A real round-trip to Postgres, not a ping.
 *
 * It counts rows in `tenant` — a table that exists, that every other table
 * hangs off, and that is cheap to ask about. Getting an answer proves the whole
 * path: URL reachable, key accepted, PostgREST up, Postgres answering, schema
 * cache current.
 *
 * It used to query `_health_probe`, a table that has never existed, and treat
 * "undefined table" as success. That was correct before P2 created the schema
 * and quietly wrong for every day after — it would have gone on reporting
 * `connected` with the schema dropped, which is the one moment a health check
 * exists for. Replit's deployment gate reads this endpoint.
 */
export const healthRouter = Router();

healthRouter.get('/health', async (_req, res) => {
  const { error } = await supabaseAdmin
    .from('tenant')
    .select('id', { count: 'exact', head: true });

  if (!error) {
    const body: HealthResponse = { ok: true, db: 'connected' };
    res.json(body);
    return;
  }

  const body: HealthResponse = { ok: false, db: 'error', error: error.message };
  res.status(503).json(body);
});

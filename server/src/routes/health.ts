import { Router } from 'express';
import type { HealthResponse } from 'shared';
import { supabaseAdmin } from '../lib/supabase.js';

/**
 * A real round-trip to Postgres, not a ping.
 *
 * There is no schema yet — P2 creates it — so this queries a table that does
 * not exist and treats "undefined table" as success. PostgREST only reaches
 * that error after authenticating and asking Postgres, which is exactly what we
 * want to prove: URL reachable, key accepted, database answering.
 *
 * TODO(P2): repoint at `tenants` and drop the tolerated-codes set.
 */
const NO_SCHEMA_YET = new Set([
  '42P01', // postgres: undefined_table
  'PGRST205', // postgrest: table not found in schema cache
]);

export const healthRouter = Router();

healthRouter.get('/health', async (_req, res) => {
  const { error } = await supabaseAdmin.from('_health_probe').select('*').limit(1);

  if (!error || NO_SCHEMA_YET.has(error.code ?? '')) {
    const body: HealthResponse = { ok: true, db: 'connected' };
    res.json(body);
    return;
  }

  const body: HealthResponse = { ok: false, db: 'error', error: error.message };
  res.status(503).json(body);
});

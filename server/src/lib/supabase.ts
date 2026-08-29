import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { env } from '../env.js';

/**
 * Service-role client. It bypasses Row Level Security completely and can read
 * and write every tenant's rows.
 *
 * This module must never be imported from /client, and its key must never reach
 * the browser. Use it only where there is legitimately no user: the seed, the
 * job worker, and agent runs.
 */
export const supabaseAdmin = createClient(
  env.supabaseUrl,
  env.supabaseServiceRoleKey,
  { auth: { persistSession: false, autoRefreshToken: false } },
);

/**
 * A client carrying the caller's access token, so every query runs under their
 * RLS policies rather than around them.
 *
 * Request handlers should prefer this over supabaseAdmin. The API's role checks
 * and the database's tenant policies then have to agree before anything is read
 * or written, which means a bug in one is caught by the other.
 */
export function supabaseForUser(accessToken: string): SupabaseClient {
  return createClient(env.supabaseUrl, env.supabaseAnonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
}

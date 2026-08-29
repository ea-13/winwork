import { createClient } from '@supabase/supabase-js';
import { env } from '../env.js';

/**
 * Service-role client. It bypasses Row Level Security completely and can read
 * and write every tenant's rows.
 *
 * This module must never be imported from /client, and its key must never reach
 * the browser. Once P4 lands, per-request work runs through a tenant-scoped
 * client carrying the caller's JWT; this one is for jobs that legitimately have
 * no user, such as agent runs.
 */
export const supabaseAdmin = createClient(
  env.supabaseUrl,
  env.supabaseServiceRoleKey,
  { auth: { persistSession: false, autoRefreshToken: false } },
);

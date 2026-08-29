import { createClient } from '@supabase/supabase-js';

/**
 * Browser client. Uses the anon/publishable key, so every read and write is
 * subject to Row Level Security — that is the whole point of it.
 *
 * The service-role key must never appear anywhere under /client.
 */
const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!url || !anonKey) {
  throw new Error(
    'Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY. Check .env at the repo root.',
  );
}

export const supabase = createClient(url, anonKey);

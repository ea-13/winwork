import { config } from 'dotenv';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// server/src (dev) or server/dist (built) -> repo root
const here = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(here, '../../.env') });

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing ${name}. Copy .env.example to .env at the repo root and fill it in.`,
    );
  }
  return value;
}

function optional(name: string): string | undefined {
  return process.env[name] || undefined;
}

export const env = {
  supabaseUrl: required('SUPABASE_URL'),
  supabaseAnonKey: required('SUPABASE_ANON_KEY'),
  /** Bypasses RLS. Server-side only. */
  supabaseServiceRoleKey: required('SUPABASE_SERVICE_ROLE_KEY'),
  /** Not needed until P6 (agent runtime), so absence is not fatal. */
  anthropicApiKey: optional('ANTHROPIC_API_KEY'),
  /** Week 1 has one seeded login and no signup flow. Used only by the seed. */
  demoUserEmail: process.env.DEMO_USER_EMAIL ?? 'demo@winprojects.ai',
  demoUserPassword: optional('DEMO_USER_PASSWORD'),
  port: Number(process.env.PORT ?? 3001),
  isProduction: process.env.NODE_ENV === 'production',
} as const;

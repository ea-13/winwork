#!/usr/bin/env node
/**
 * Fails the build if a server-only secret reached the client bundle.
 *
 * The service-role key bypasses Row Level Security entirely. One careless
 * import — a shared module that pulls in the server's Supabase client, an
 * environment variable renamed to a VITE_ prefix — and every tenant's data is
 * readable by anyone who opens devtools.
 *
 * This is cheap to run and catastrophic to skip, so it runs on every build
 * rather than being someone's responsibility to remember.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'client', 'dist');

let env = {};
try {
  env = Object.fromEntries(
    readFileSync(join(root, '.env'), 'utf8')
      .split(/\r?\n/)
      .map((line) => line.match(/^([A-Z_]+)=(.*?)\s*$/))
      .filter(Boolean)
      .map((m) => [m[1], m[2].trim()]),
  );
} catch {
  // No .env (CI, a fresh clone). The literal patterns below still apply.
}

/**
 * Things that must never appear in anything served to a browser.
 *
 * Exact secret values first — those are unambiguous. The pattern rules require
 * a plausible key BODY, not just a prefix: supabase-js legitimately contains
 * the string "sb_secret_" in its own key-format detection, and a check that
 * trips on a library mentioning a prefix is a check people learn to ignore.
 */
const exact = [
  ['service-role key', env.SUPABASE_SERVICE_ROLE_KEY],
  ['Anthropic API key', env.ANTHROPIC_API_KEY],
  ['database password', env.SUPABASE_DB_PASSWORD],
  ['demo password', env.DEMO_USER_PASSWORD],
  ['database connection string', env.DATABASE_URL],
].filter(([, value]) => typeof value === 'string' && value.length >= 12);

const patterns = [
  ['an Anthropic API key', /sk-ant-[A-Za-z0-9_-]{24,}/],
  ['a Supabase secret key', /sb_secret_[A-Za-z0-9_-]{16,}/],
  ['a postgres connection string with credentials', /postgres(ql)?:\/\/[^\s:@'"`]+:[^\s@'"`]+@/],
];

function walk(directory) {
  const found = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) found.push(...walk(path));
    else found.push(path);
  }
  return found;
}

let files;
try {
  files = walk(dist);
} catch {
  console.error('  check-bundle: no client/dist — run the client build first');
  process.exit(1);
}

const violations = [];

for (const file of files) {
  if (!/\.(js|css|html|map|json)$/.test(file)) continue;
  const contents = readFileSync(file, 'utf8');

  for (const [label, value] of exact) {
    if (contents.includes(value)) {
      violations.push(`${file.replace(root, '.')} contains the ${label}`);
    }
  }
  for (const [label, pattern] of patterns) {
    if (pattern.test(contents)) {
      violations.push(`${file.replace(root, '.')} contains what looks like ${label}`);
    }
  }
}

if (violations.length > 0) {
  console.error('\nBUILD FAILED — a server-only secret reached the client bundle:\n');
  for (const violation of violations) console.error(`  ${violation}`);
  console.error(
    '\nThe service-role key bypasses RLS. Nothing that reads it may be imported\n' +
      'from anything under client/. Check for a shared module pulling in\n' +
      'server/src/lib/supabase.ts, or a secret renamed with a VITE_ prefix.\n',
  );
  process.exit(1);
}

console.log(`  check-bundle: ${files.length} files clean — no server secret in the client bundle`);

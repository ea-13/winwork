#!/usr/bin/env node
/**
 * `npm run resume` — everything needed to pick the build back up, in one command.
 *
 * Written because the last session lost the better part of an hour to
 * environment state rather than to the product: orphaned Node processes from
 * hot-reloads still holding port 3001, a tsx compile cache serving code that no
 * longer existed in the repo, and a demo login whose password had drifted from
 * .env. None of those are interesting problems and all of them look like bugs
 * in the app when you meet them cold.
 *
 * So this does the boring things first, in order, and says what it found:
 *
 *   1. kills anything still holding the dev ports, and the tsx cache with it
 *   2. applies pending migrations
 *   3. reseeds, which also resets the demo password to whatever .env says
 *   4. typechecks
 *   5. prints where the build actually is, read from the database rather than
 *      from memory or from a doc that may be stale
 *
 * It deliberately does NOT start the dev server. Starting it is one command and
 * you may want it in your own terminal.
 */
import { execSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir, userInfo } from 'node:os';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const say = (mark, text) => console.log(`  ${mark} ${text}`);
const run = (command) => {
  const result = spawnSync(command, { cwd: root, shell: true, stdio: 'pipe', encoding: 'utf8' });
  return { ok: result.status === 0, out: `${result.stdout ?? ''}${result.stderr ?? ''}` };
};

console.log('\nWinProjects — resuming\n');

// -- 1 · a clean slate ------------------------------------------------------
//
// Orphaned children survive Ctrl-C on Windows, and each one runs its own job
// worker. Two workers on the same queue means a job can be claimed by whichever
// process has the older code, which is a genuinely confusing way to lose a day.
console.log('Environment');

const ports = [3001, 5173];
let killed = 0;

for (const port of ports) {
  const { out } = run(`netstat -ano | findstr :${port}`);
  const pids = new Set(
    out
      .split(/\r?\n/)
      .map((line) => line.trim().split(/\s+/).pop())
      .filter((pid) => pid && /^\d+$/.test(pid) && pid !== '0'),
  );
  for (const pid of pids) {
    if (run(`taskkill /PID ${pid} /F`).ok) killed += 1;
  }
}

say(killed > 0 ? '·' : '=', killed > 0 ? `freed ports ${ports.join(', ')} (${killed} process)` : 'ports already free');

// tsx caches compiled output per user. A stale entry serves code that is not in
// the repo, and every symptom of it points at the wrong place.
const cache = join(tmpdir(), `tsx-${userInfo().username}`);
if (existsSync(cache)) {
  try {
    rmSync(cache, { recursive: true, force: true });
    say('·', 'cleared the tsx compile cache');
  } catch {
    say('!', 'could not clear the tsx cache — close any running dev server and retry');
  }
} else {
  say('=', 'tsx cache already clear');
}

// -- 2 · schema and data ----------------------------------------------------
console.log('\nDatabase');

const migrate = run('npm run migrate');
const applied = (migrate.out.match(/^\s*\+ /gm) ?? []).length;
say(migrate.ok ? '·' : '!', migrate.ok ? `migrations up to date${applied ? ` (${applied} applied)` : ''}` : 'MIGRATION FAILED');
if (!migrate.ok) console.log(migrate.out.split('\n').slice(-12).join('\n'));

const seed = run('npm run seed');
say(seed.ok ? '·' : '!', seed.ok ? 'demo tenant seeded, login password reset from .env' : 'SEED FAILED');
if (!seed.ok) console.log(seed.out.split('\n').slice(-12).join('\n'));

// -- 3 · does it compile ----------------------------------------------------
console.log('\nBuild');
const types = run('npx tsc -b');
say(types.ok ? '·' : '!', types.ok ? 'typecheck clean' : 'TYPE ERRORS');
if (!types.ok) console.log(types.out.split('\n').slice(0, 15).join('\n'));

// -- 4 · where the build actually is ----------------------------------------
//
// Read from the database, not from a document. A status doc is a claim about
// last week; the row counts are what is true now.
console.log('\nWhere things stand');

const env = Object.fromEntries(
  readFileSync(join(root, '.env'), 'utf8')
    .split('\n')
    .map((line) => line.match(/^([A-Z_]+)=(.*?)\s*$/))
    .filter(Boolean)
    .map((m) => [m[1], m[2].trim()]),
);

const count = async (table, query = '') => {
  const response = await fetch(
    `${env.SUPABASE_URL}/rest/v1/${table}?select=id${query}`,
    {
      headers: {
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
        Prefer: 'count=exact',
        Range: '0-0',
      },
    },
  );
  return Number((response.headers.get('content-range') ?? '/0').split('/')[1] ?? 0);
};

try {
  const [projects, scope, context, outcomes, packages, quotes, gaps, sheets] = await Promise.all([
    count('project'),
    count('scope_item'),
    count('scope_context'),
    count('scope_context_outcome'),
    count('work_package'),
    count('quote'),
    count('scope_gap'),
    count('document_sheet'),
  ]);

  say('·', `${projects} projects · ${packages} packages · ${scope} scope items · ${quotes} quotes`);
  say('·', `${context} context lines · ${outcomes} recorded outcomes · ${gaps} scope gaps`);
  say('·', `${sheets} drawing sheets indexed`);
} catch (caught) {
  say('!', `could not read the database: ${caught instanceof Error ? caught.message : caught}`);
}

console.log(`
Next
  npm run dev            API on :3001, client on :5173
  login                  ${env.DEMO_USER_EMAIL} / DEMO_USER_PASSWORD from .env

  Open docs/02-EXECUTION.md — the "What is left" section at the end is the
  running list, and it is the file to update as things land.
`);

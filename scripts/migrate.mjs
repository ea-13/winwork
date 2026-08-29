#!/usr/bin/env node
/**
 * Applies supabase/migrations/*.sql in filename order, once each, inside a
 * transaction. Tracks what ran in public.schema_migrations and refuses to
 * re-run a file whose contents changed after it was applied — an applied
 * migration is history, and history is edited by adding to it.
 *
 * Reads DATABASE_URL from .env (gitignored). Never used by the app at runtime.
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const env = Object.fromEntries(
  readFileSync(join(root, '.env'), 'utf8')
    .split('\n')
    .map((line) => line.match(/^([A-Z_]+)=(.*?)\s*$/))
    .filter(Boolean)
    .map((m) => [m[1], m[2].trim()]),
);

if (!env.DATABASE_URL) {
  console.error('DATABASE_URL is missing from .env');
  process.exit(1);
}

const dir = join(root, 'supabase', 'migrations');
const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();

const client = new pg.Client({
  connectionString: env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 20000,
});
await client.connect();

await client.query(`
  create table if not exists public.schema_migrations (
    filename   text primary key,
    checksum   text not null,
    applied_at timestamptz not null default now()
  )`);

const { rows } = await client.query('select filename, checksum from public.schema_migrations');
const applied = new Map(rows.map((r) => [r.filename, r.checksum]));

let count = 0;
for (const file of files) {
  const sql = readFileSync(join(dir, file), 'utf8');
  const checksum = createHash('sha256').update(sql).digest('hex').slice(0, 16);
  const previous = applied.get(file);

  if (previous === checksum) {
    console.log(`  = ${file}`);
    continue;
  }
  if (previous) {
    console.error(`  ! ${file} was modified after being applied. Add a new migration instead.`);
    await client.end();
    process.exit(1);
  }

  process.stdout.write(`  + ${file} ... `);
  try {
    await client.query('begin');
    await client.query(sql);
    await client.query('insert into public.schema_migrations (filename, checksum) values ($1, $2)', [
      file,
      checksum,
    ]);
    await client.query('commit');
    console.log('ok');
    count += 1;
  } catch (error) {
    await client.query('rollback');
    console.log('FAILED');
    console.error(`\n  ${error.message}`);
    if (error.position) {
      const upto = sql.slice(0, Number(error.position));
      const line = upto.split('\n').length;
      console.error(`  at line ${line}: ${sql.split('\n')[line - 1]?.trim()}`);
    }
    await client.end();
    process.exit(1);
  }
}

console.log(count ? `\napplied ${count} migration(s)` : '\nnothing to apply');
await client.end();

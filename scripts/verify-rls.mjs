#!/usr/bin/env node
/**
 * Verifies the invariants P2 exists to establish. Re-runnable after any
 * migration; it creates and removes its own fixtures.
 *
 * Structural checks are necessary but not sufficient — RLS that is enabled but
 * permissive looks identical to RLS that works. So the last section actually
 * impersonates an authenticated user of one tenant and confirms another
 * tenant's rows are invisible and unwritable.
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const env = Object.fromEntries(
  readFileSync(join(root, '.env'), 'utf8')
    .split(/\r?\n/)
    .map((line) => line.match(/^([A-Z_]+)=(.*?)\s*$/))
    .filter(Boolean)
    .map((m) => [m[1], m[2].trim()]),
);

const client = new pg.Client({
  connectionString: env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 20000,
});
await client.connect();

let failures = 0;
const check = (ok, label, detail = '') => {
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
};

const q = (sql, params) => client.query(sql, params).then((r) => r.rows);

// ---------------------------------------------------------------- structural
console.log('\nSchema');

const tables = await q(`
  select c.relname, c.relrowsecurity,
         (select count(*) from pg_policy p where p.polrelid = c.oid)::int as policies
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind = 'r' and c.relname <> 'schema_migrations'
  order by c.relname`);

// A floor, not an equality: later migrations legitimately add tables, and a
// hardcoded count turns every addition into a false alarm. Losing one is still
// caught.
check(tables.length >= 29, 'table count at or above the P2 baseline', `${tables.length} tables`);

const noRls = tables.filter((t) => !t.relrowsecurity).map((t) => t.relname);
check(noRls.length === 0, 'RLS enabled on every table', noRls.join(', ') || `all ${tables.length}`);

const noPolicy = tables.filter((t) => t.policies === 0).map((t) => t.relname);
check(noPolicy.length === 0, 'every table has a policy', noPolicy.join(', ') || `all ${tables.length}`);

const missingTenant = await q(`
  select c.relname from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname='public' and c.relkind='r'
    and c.relname not in ('schema_migrations','tenant','division_expert','gap_pattern','lead_time')
    and not exists (
      select 1 from pg_attribute a
      where a.attrelid=c.oid and a.attname='tenant_id' and a.attnum>0 and not a.attisdropped)`);
check(missingTenant.length === 0, 'tenant_id on every tenant-scoped table',
  missingTenant.map((r) => r.relname).join(', ') || `${tables.length - 4} tables`);

const unindexedFk = await q(`
  select con.conname, cl.relname
  from pg_constraint con
  join pg_class cl on cl.oid = con.conrelid
  join pg_namespace n on n.oid = cl.relnamespace
  where con.contype='f' and n.nspname='public'
    and not exists (
      select 1 from pg_index i
      where i.indrelid = con.conrelid
        and (i.indkey::smallint[])[0:array_length(con.conkey,1)-1] @> con.conkey[1:1])`);
check(unindexedFk.length === 0, 'every foreign key is indexed',
  unindexedFk.map((r) => r.conname).join(', ') || 'all indexed');

const fn = await q(`select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                    where n.nspname='public' and p.proname='current_tenant_id'`);
check(fn.length === 1, 'current_tenant_id() exists');

// --------------------------------------------------------------- append-only
console.log('\nAppend-only (R2)');

// UPDATE triggers are statement-level, so they raise even against an empty
// table — which is exactly what P2's acceptance test does.
for (const table of ['draft', 'approval', 'audit_event']) {
  try {
    await q('begin');
    await q(`update public.${table} set tenant_id = tenant_id`);
    await q('rollback');
    check(false, `${table}: UPDATE rejected`, 'it succeeded');
  } catch (error) {
    await q('rollback');
    check(error.code === '42501', `${table}: UPDATE rejected`, error.code);
  }
}

// DELETE triggers are row-level (migration 0002), so proving them needs a real
// row. The whole fixture rolls back, including the row the trigger refused to
// delete.
const seedOneRow = {
  draft: `
    with t as (insert into public.tenant (name) values ('rls probe') returning id),
         r as (insert into public.agent_run (tenant_id, agent_type)
               select id, 'probe' from t returning id, tenant_id)
    insert into public.draft (tenant_id, agent_run_id, target_table)
    select tenant_id, id, 'probe' from r`,
  approval: `
    with t as (insert into public.tenant (name) values ('rls probe') returning id)
    insert into public.approval (tenant_id, gate, rationale)
    select id, 'H2', 'probe' from t`,
  audit_event: `
    with t as (insert into public.tenant (name) values ('rls probe') returning id)
    insert into public.audit_event (tenant_id, action) select id, 'probe' from t`,
};

for (const [table, seed] of Object.entries(seedOneRow)) {
  try {
    await q('begin');
    await q(seed);
    await q(`delete from public.${table}`);
    await q('rollback');
    check(false, `${table}: DELETE of an existing row rejected`, 'it succeeded');
  } catch (error) {
    await q('rollback');
    check(error.code === '42501', `${table}: DELETE of an existing row rejected`, error.code);
  }
}

// Regression test for migration 0002: statement-level DELETE triggers made this
// impossible, because the cascade fired them even with nothing to delete.
try {
  await q('begin');
  const [{ id }] = await q("insert into public.tenant (name) values ('rls probe') returning id");
  await q('delete from public.tenant where id = $1', [id]);
  await q('rollback');
  check(true, 'a tenant holding no evidence rows can still be deleted');
} catch (error) {
  await q('rollback');
  check(false, 'a tenant holding no evidence rows can still be deleted', error.message);
}

// ----------------------------------------------------------------- isolation
console.log('\nTenant isolation (live, as an authenticated user)');

const [{ id: tenantA }] = await q(
  "insert into public.tenant (name) values ('RLS probe A') returning id");
const [{ id: tenantB }] = await q(
  "insert into public.tenant (name) values ('RLS probe B') returning id");
await q(`insert into public.project (tenant_id, bid_id, name) values
         ($1,'PROBE-A-001','A project'), ($2,'PROBE-B-001','B project')`, [tenantA, tenantB]);

const asTenant = async (tenantId, sql, params) => {
  await q('begin');
  await q("select set_config('role','authenticated',true)");
  await q("select set_config('request.jwt.claims', $1, true)",
    [JSON.stringify({ sub: '00000000-0000-0000-0000-000000000000', app_metadata: { tenant_id: tenantId } })]);
  try {
    const rows = await q(sql, params);
    await q('rollback');
    return { rows };
  } catch (error) {
    await q('rollback');
    return { error };
  }
};

const seen = await asTenant(tenantA, "select bid_id from public.project where bid_id like 'PROBE-%'");
const visible = (seen.rows ?? []).map((r) => r.bid_id).sort();
check(
  visible.length === 1 && visible[0] === 'PROBE-A-001',
  "tenant A sees only tenant A's projects",
  seen.error ? seen.error.message : `saw [${visible.join(', ')}]`,
);

const crossWrite = await asTenant(
  tenantA,
  "insert into public.project (tenant_id, bid_id, name) values ($1,'PROBE-X-001','smuggled')",
  [tenantB],
);
check(
  Boolean(crossWrite.error) && crossWrite.error.code === '42501',
  'tenant A cannot write a row owned by tenant B',
  crossWrite.error ? crossWrite.error.code : 'the insert SUCCEEDED',
);

const anon = await asTenant(null, "select bid_id from public.project where bid_id like 'PROBE-%'");
check(
  (anon.rows ?? []).length === 0,
  'a caller with no tenant claim sees nothing',
  anon.error ? anon.error.message : `saw ${(anon.rows ?? []).length} rows`,
);

const removed = await client.query("delete from public.tenant where name like 'RLS probe %'");
const leftover = await q("select count(*)::int n from public.project where bid_id like 'PROBE-%'");
check(leftover[0].n === 0, 'fixtures cleaned up', `removed ${removed.rowCount} tenant(s)`);

console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks passed');
await client.end();
process.exit(failures ? 1 : 0);

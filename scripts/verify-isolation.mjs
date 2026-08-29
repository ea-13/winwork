#!/usr/bin/env node
/**
 * P20 · The test that prevents a company-ending demo.
 *
 * Creates a second tenant with real data, authenticates as the first tenant's
 * user, and asserts that every endpoint returns zero rows belonging to the
 * other. RLS is checked directly by verify-rls; this checks the API on top of
 * it, because a route using the service-role client by mistake would pass every
 * database-level test and still leak.
 *
 * Also asserts the negative controls: an agent cannot cross a gate, a
 * send-shaped job is refused, and the evidence tables reject mutation.
 *
 *   node scripts/verify-isolation.mjs [baseUrl]
 */
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const env = Object.fromEntries(
  readFileSync(join(root, '.env'), 'utf8')
    .split(/\r?\n/)
    .map((line) => line.match(/^([A-Z_]+)=(.*?)\s*$/))
    .filter(Boolean)
    .map((m) => [m[1], m[2].trim()]),
);

const base = process.argv[2] ?? `http://localhost:${env.PORT ?? 3001}`;

let failures = 0;
const check = (ok, label, detail = '') => {
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
};

const admin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

// ---------------------------------------------------------- the other tenant
console.log('\nP20 · Cross-tenant isolation');

const { data: other } = await admin
  .from('tenant')
  .insert({ name: 'Isolation probe tenant' })
  .select('id')
  .single();

const { data: otherProject } = await admin
  .from('project')
  .insert({
    tenant_id: other.id,
    bid_id: 'ISO-2026-001',
    name: 'Isolation probe project',
    status: 'BIDDING',
  })
  .select('id')
  .single();

const { data: otherScope } = await admin
  .from('scope_item')
  .insert({
    tenant_id: other.id,
    project_id: otherProject.id,
    scope_id: 'ISO-2026-001-22-001',
    csi_division: '22',
    title: 'Isolation probe scope item',
  })
  .select('id')
  .single();

const { data: otherPackage } = await admin
  .from('work_package')
  .insert({
    tenant_id: other.id,
    project_id: otherProject.id,
    name: 'Isolation probe package',
    lead_division: '22',
  })
  .select('id')
  .single();

const { data: otherSub } = await admin
  .from('subcontractor')
  .insert({ tenant_id: other.id, name: 'Isolation Probe Plumbing Co' })
  .select('id')
  .single();

// ----------------------------------------------------------------- sign in
const anon = createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
  auth: { persistSession: false },
});
const { data: signIn, error: signInError } = await anon.auth.signInWithPassword({
  email: env.DEMO_USER_EMAIL,
  password: env.DEMO_USER_PASSWORD,
});
if (signInError) {
  console.log(`  FAIL  sign in — ${signInError.message}`);
  process.exit(1);
}
const token = signIn.session.access_token;
const authed = (path, init = {}) =>
  fetch(`${base}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
  });

const json = async (path) => {
  const response = await authed(path);
  if (!response.ok) return null;
  return response.json().catch(() => null);
};

// --------------------------------------------------------- the endpoint sweep
const forbidden = [other.id, otherProject.id, otherScope.id, otherPackage.id, otherSub.id];

const endpoints = [
  '/api/projects',
  '/api/packages',
  '/api/subcontractors',
  '/api/agent-runs',
  '/api/review-queue',
  '/api/corpus/stats',
  `/api/projects/${otherProject.id}`,
  `/api/projects/${otherProject.id}/packages`,
  `/api/projects/${otherProject.id}/scope-items`,
  `/api/projects/${otherProject.id}/documents`,
  `/api/projects/${otherProject.id}/buyout`,
  `/api/packages/${otherPackage.id}/documents`,
  `/api/packages/${otherPackage.id}/leveling`,
  `/api/packages/${otherPackage.id}/gaps`,
  `/api/packages/${otherPackage.id}/candidates`,
  `/api/packages/${otherPackage.id}/solicitation`,
];

let leaked = [];
for (const endpoint of endpoints) {
  const body = await json(endpoint);
  const text = body === null ? '' : JSON.stringify(body);
  const hit = forbidden.filter((id) => text.includes(id));
  if (hit.length > 0) leaked.push(`${endpoint} exposed ${hit.length} foreign id(s)`);
}

check(leaked.length === 0, `${endpoints.length} endpoints return no other tenant's rows`, leaked.join('; '));

// Writing into the other tenant must fail too, not just reading.
const forge = await authed(`/api/records/scope_item/${otherScope.id}`, {
  method: 'PATCH',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ title: 'owned' }),
});
check(forge.status === 404, "editing another tenant's row is not found", `HTTP ${forge.status}`);

const { data: untouched } = await admin
  .from('scope_item')
  .select('title')
  .eq('id', otherScope.id)
  .single();
check(untouched.title === 'Isolation probe scope item', 'the foreign row is unchanged');

// ------------------------------------------------------- negative controls
console.log('\nP20 · Negative controls');

const noRationale = await authed('/api/gates/h3/package-approve', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ packageId: otherPackage.id }),
});
check(noRationale.status === 400, 'a gate with no rationale is refused', `HTTP ${noRationale.status}`);

const sendJob = await admin
  .from('job')
  .insert({ tenant_id: other.id, job_type: 'send_award_notice' });
check(
  Boolean(sendJob.error) && sendJob.error.code === '23514',
  'a send-shaped job is refused even to service_role',
  sendJob.error?.code ?? 'it was accepted',
);

for (const table of ['draft', 'approval', 'audit_event']) {
  const update = await admin.from(table).update({ tenant_id: other.id }).eq('tenant_id', other.id);
  check(
    Boolean(update.error) && update.error.code === '42501',
    `${table} rejects UPDATE from service_role`,
    update.error?.code ?? 'it was accepted',
  );
}

// ----------------------------------------------------------------- cleanup
await admin.from('scope_item').delete().eq('tenant_id', other.id);
await admin.from('work_package').delete().eq('tenant_id', other.id);
await admin.from('subcontractor').delete().eq('tenant_id', other.id);
await admin.from('project').delete().eq('tenant_id', other.id);
const removed = await admin.from('tenant').delete().eq('id', other.id);
check(!removed.error, 'probe tenant cleaned up', removed.error?.message ?? '');

console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks passed');
process.exit(failures ? 1 : 0);

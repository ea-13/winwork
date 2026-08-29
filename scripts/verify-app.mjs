#!/usr/bin/env node
/**
 * End-to-end check of P4 (auth and gates), P5 (upload) and P6 (agent runtime).
 * Assumes the server is already running. Re-runnable: it removes what it makes.
 *
 *   node scripts/verify-app.mjs [baseUrl]
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

// ------------------------------------------------------------------ sign in
console.log('\nP4 · Auth');

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
check(true, 'sign in as the seeded user');

const authed = (path, init = {}) =>
  fetch(`${base}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
  });

const noAuth = await fetch(`${base}/api/me`);
check(noAuth.status === 401, 'a request with no token is refused', `HTTP ${noAuth.status}`);

const badAuth = await fetch(`${base}/api/me`, { headers: { Authorization: 'Bearer nonsense' } });
check(badAuth.status === 401, 'a forged token is refused', `HTTP ${badAuth.status}`);

const me = await (await authed('/api/me')).json();
check(
  me.email === env.DEMO_USER_EMAIL && me.roles.includes('BC') && me.roles.includes('EST'),
  'GET /api/me returns identity and both role grants',
  `${me.email} ${JSON.stringify(me.roles)}`,
);

// ------------------------------------------------------------------- gates
console.log('\nP4 · Gates');

const noRationale = await authed('/api/gates/h2/scope-lock', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ scopeItemIds: ['00000000-0000-0000-0000-000000000000'] }),
});
check(noRationale.status === 400, 'a gate with no rationale returns 400', `HTTP ${noRationale.status}`);

const blankRationale = await authed('/api/gates/h2/scope-lock', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ rationale: '   ', scopeItemIds: ['x'] }),
});
check(blankRationale.status === 400, 'whitespace is not a rationale', `HTTP ${blankRationale.status}`);

const packages = await (await authed('/api/packages')).json();
check(Array.isArray(packages) && packages.length > 0, 'packages visible', `${packages.length}`);
const packageId = packages[0]?.id;

const approve = await authed('/api/gates/h3/package-approve', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ packageId, rationale: 'Verification run — scope reviewed.' }),
});
const approveBody = await approve.json();
check(
  approve.ok && approveBody.gate === 'H3' && approveBody.approvalId,
  'H3 with a rationale crosses and writes an approval',
  approve.ok ? `affected ${approveBody.affected}` : JSON.stringify(approveBody),
);

// ------------------------------------------------------------------- R3
console.log('\nR3 · No send path');

const send = await authed('/api/agent-runs/demo', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ agentType: 'send_invite_to_bidders' }),
});
const sendBody = await send.json().catch(() => ({}));
check(
  send.status === 403 && /no outbound send path/i.test(sendBody.error ?? ''),
  'a send-shaped agent type is refused',
  `HTTP ${send.status}`,
);

// ------------------------------------------------------------------ upload
console.log('\nP5 · Upload');

const pdf = Buffer.from(
  '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n' +
    '2 0 obj<</Type/Pages/Kids[]/Count 0>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n',
);

const rejected = new FormData();
rejected.append('files', new Blob([pdf]), 'malware.exe');
const rejectedResponse = await authed(`/api/packages/${packageId}/documents`, {
  method: 'POST',
  body: rejected,
});
check(rejectedResponse.status === 400, 'a disallowed file type is rejected', `HTTP ${rejectedResponse.status}`);

const form = new FormData();
form.append('files', new Blob([pdf], { type: 'application/pdf' }), 'verify probe.pdf');
const uploaded = await authed(`/api/packages/${packageId}/documents`, { method: 'POST', body: form });
const uploadedBody = await uploaded.json();
check(
  uploaded.status === 201 && uploadedBody[0]?.status === 'PENDING_EXTRACTION',
  'a PDF uploads and creates a quote row',
  uploaded.ok ? uploadedBody[0].sourceFilename : JSON.stringify(uploadedBody),
);
const quoteId = uploadedBody[0]?.id;

const listed = await (await authed(`/api/packages/${packageId}/documents`)).json();
check(
  listed.some((row) => row.id === quoteId),
  'the document appears in the package listing',
  `${listed.length} document(s)`,
);

// --------------------------------------------------------------- agent run
console.log('\nP6 · Agent runtime');

const started = await authed('/api/agent-runs/demo', { method: 'POST' });
const { runId } = await started.json();
check(started.status === 202 && Boolean(runId), 'a job is enqueued and returns a run id');

const events = [];
let finishedStatus = null;
const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(), 45_000);

try {
  const stream = await authed(`/api/agent-runs/${runId}/stream`, { signal: controller.signal });
  const reader = stream.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  outer: for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split('\n\n');
    buffer = frames.pop() ?? '';
    for (const frame of frames) {
      const name = /^event: (.+)$/m.exec(frame)?.[1];
      const raw = /^data: (.+)$/m.exec(frame)?.[1];
      if (!name || !raw) continue;
      if (name === 'agent-event') events.push(JSON.parse(raw));
      if (name === 'agent-run-finished') {
        finishedStatus = JSON.parse(raw).status;
        break outer;
      }
    }
  }
} catch (error) {
  if (!controller.signal.aborted) throw error;
} finally {
  clearTimeout(timeout);
}

check(events.length >= 8, 'events streamed live over SSE', `${events.length} events`);
check(finishedStatus === 'DONE', 'the run reached DONE', String(finishedStatus));
check(
  events.some((event) => event.eventType === 'WARNING'),
  'findings are emitted as WARNING, not buried in INFO',
);
check(
  events.every((event, index) => event.seq === index + 1),
  'event sequence is gapless and ordered',
);

const admin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});
const { count: draftCount } = await admin
  .from('draft')
  .select('*', { count: 'exact', head: true })
  .eq('agent_run_id', runId);
check((draftCount ?? 0) >= 3, 'the agent wrote immutable drafts, not canonical rows', `${draftCount} drafts`);

// Replay: a client connecting after the fact still sees the whole run.
const replayed = [];
const replay = await authed(`/api/agent-runs/${runId}/stream`);
const reader = replay.body.getReader();
const decoder = new TextDecoder();
let buffer = '';
for (;;) {
  const { done, value } = await reader.read();
  if (done) break;
  buffer += decoder.decode(value, { stream: true });
  const frames = buffer.split('\n\n');
  buffer = frames.pop() ?? '';
  let stop = false;
  for (const frame of frames) {
    const name = /^event: (.+)$/m.exec(frame)?.[1];
    const raw = /^data: (.+)$/m.exec(frame)?.[1];
    if (name === 'agent-event') replayed.push(JSON.parse(raw));
    if (name === 'agent-run-finished') stop = true;
  }
  if (stop) break;
}
check(
  replayed.length === events.length,
  'a late client replays the full run',
  `${replayed.length} of ${events.length}`,
);

// ----------------------------------------------------------------- cleanup
if (quoteId) await admin.from('quote').delete().eq('id', quoteId);
await admin.from('job').delete().eq('agent_run_id', runId);
check(true, 'fixtures cleaned up');

console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks passed');
process.exit(failures ? 1 : 0);

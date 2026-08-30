/**
 * Wires the real plumbing quote into the ADU project so Bids and Leveling have
 * something to show.
 *
 * Uses samples/ADU two story.pdf, which is an Oro Pro Plumbing estimate, not a
 * drawing set — it was mislabelled DRAWING on upload and the sheet indexer
 * caught it by refusing to invent sheet numbers for it.
 */
import { readFileSync } from 'node:fs';

const env = Object.fromEntries(
  readFileSync(new URL('../.env', import.meta.url), 'utf8')
    .split('\n').map((l) => l.match(/^([A-Z_]+)=(.*?)\s*$/)).filter(Boolean)
    .map((m) => [m[1], m[2].trim()]),
);

const auth = await fetch(`${env.SUPABASE_URL}/auth/v1/token?grant_type=password`, {
  method: 'POST',
  headers: { apikey: env.SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: env.DEMO_USER_EMAIL, password: env.DEMO_USER_PASSWORD }),
});
if (!auth.ok) { console.error('login failed', auth.status); process.exit(1); }
const { access_token } = await auth.json();

const api = async (path, method = 'GET', body) => {
  const r = await fetch(`http://localhost:3001/api${path}`, {
    method,
    headers: { Authorization: `Bearer ${access_token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const t = await r.text();
  try { return { status: r.status, body: JSON.parse(t) }; } catch { return { status: r.status, body: t.slice(0, 200) }; }
};
const rest = (p) => fetch(`${env.SUPABASE_URL}/rest/v1/${p}`, {
  headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` },
}).then((r) => r.json());
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const follow = async (runId, timeout = 900000) => {
  const t0 = Date.now(); let last = 0;
  for (;;) {
    const ev = await rest(`agent_event?select=seq,event_type,message&agent_run_id=eq.${runId}&order=seq.asc`);
    for (const e of Array.isArray(ev) ? ev : []) {
      if (e.seq <= last) continue; last = e.seq;
      console.log(`   ${e.event_type === 'WARNING' ? '!' : ' '} ${e.message}`);
    }
    const [run] = await rest(`agent_run?select=status&id=eq.${runId}`);
    if (run?.status === 'DONE' || run?.status === 'FAILED') return run.status;
    if (Date.now() - t0 > timeout) return 'TIMEOUT';
    await wait(4000);
  }
};

const projects = (await api('/projects')).body;
const project = projects.find((p) => p.bid_id === 'ADU-2026-251') ?? projects[0];
console.log(`project: ${project.bid_id} — ${project.name}`);

// 1 · Standard plumbing scope, so there is a baseline to level against.
const tpl = await api(`/projects/${project.id}/scope-template`, 'POST', { divisions: ['22'] });
console.log('template:', tpl.status, JSON.stringify(tpl.body));

const packages = (await api(`/projects/${project.id}/packages`)).body;
const plumbing = packages.find((p) => p.lead_division === '22');
if (!plumbing) { console.error('no plumbing package'); process.exit(1); }
console.log(`package: ${plumbing.name}`);

// 2 · Lock the baseline. Normalisation only compares against locked items.
const scope = (await api(`/projects/${project.id}/scope-items`)).body;
const div22 = scope.filter((s) => s.csi_division === '22' && !s.is_locked);
if (div22.length > 0) {
  const lock = await api('/gates/h2/scope-lock', 'POST', {
    scopeItemIds: div22.map((s) => s.id),
    rationale: 'Demo preload — standard plumbing containers accepted as the baseline.',
  });
  console.log('H2 lock:', lock.status, JSON.stringify(lock.body).slice(0, 120));
}

// 3 · The quote is a quote, not a drawing.
const docs = (await api(`/projects/${project.id}/documents`)).body;
const quoteDoc = docs.find((d) => d.filename.toLowerCase().includes('adu_two_story'));
if (!quoteDoc) { console.error('sample quote not found'); process.exit(1); }

if (quoteDoc.kind !== 'QUOTE') {
  await api(`/records/project_document/${quoteDoc.id}`, 'PATCH', { kind: 'QUOTE' });
  console.log('relabelled as QUOTE');
}

if (!quoteDoc.routed_quote_id) {
  const routed = await api(`/projects/${project.id}/documents/${quoteDoc.id}/route-to-package`, 'POST', { packageId: plumbing.id });
  console.log('routed:', routed.status, JSON.stringify(routed.body).slice(0, 140));
}

// 4 · Extract, accept, normalise, accept, level.
const quotes = (await api(`/packages/${plumbing.id}/documents`)).body;
const quote = quotes[0];
if (!quote) { console.error('no quote on the package'); process.exit(1); }
console.log(`quote: ${quote.sourceFilename} (${quote.status})`);

if (quote.status !== 'EXTRACTED') {
  const ex = await api(`/quotes/${quote.id}/extract`, 'POST');
  console.log('extract queued:', ex.status);
  console.log('extract:', await follow(ex.body.runId));
}

// Accept it regardless of how it got to EXTRACTED. A quote can sit extracted
// with nothing promoted, and normalisation has no lines to work from until a
// human accepts — which is the whole point of the gate, not a bug.
const p1 = await api(`/quotes/${quote.id}/promote`, 'POST', { rationale: 'Demo preload — extraction accepted.' });
console.log('accept extraction:', p1.status, JSON.stringify(p1.body).slice(0, 200));

const nz = await api(`/quotes/${quote.id}/normalise`, 'POST');
console.log('normalise queued:', nz.status);
if (nz.status === 202) {
  console.log('normalise:', await follow(nz.body.runId));
  const p2 = await api(`/quotes/${quote.id}/promote-normalisation`, 'POST', { rationale: 'Demo preload — mapping accepted.' });
  console.log('accept mapping:', p2.status, JSON.stringify(p2.body).slice(0, 140));
}

const lvl = await api(`/packages/${plumbing.id}/level`, 'POST');
console.log('level:', lvl.status, JSON.stringify(lvl.body).slice(0, 300));

const tab = (await api(`/packages/${plumbing.id}/scope-leveling`)).body;
console.log(`\nBID TAB: ${tab.scopeItems.length} scope rows x ${tab.bidders.length} bidder(s), ${tab.cells.length} cells`);
for (const b of tab.bidders) console.log(`   ${b.name} — quoted ${b.quotedTotal} adjusted ${b.adjustedTotal} rank ${b.advisoryRank}`);
console.log(`\nOpen: http://localhost:5173/packages/${plumbing.id}?step=leveling`);

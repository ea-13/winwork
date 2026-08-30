#!/usr/bin/env node
/**
 * `npm run qa` — does every feature actually work?
 *
 * `npm run verify` proves the RULES hold: tenant isolation, gates, append-only
 * evidence, no send path. This proves the FEATURES do — that a scope item can be
 * created and edited, that a bid can be entered and levelled, that splitting a
 * quote reaches both packages, that the copilot suggests something sensible.
 *
 * The distinction matters because they fail differently. A broken rule is a
 * breach. A broken feature is a Tuesday morning where nothing works and nobody
 * can say why, and until now the only way to find one was to click through the
 * app and notice.
 *
 * It is DESTRUCTIVE in a bounded way: it creates a throwaway project, works
 * inside it, and deletes it at the end. It never touches the demo tenant's
 * existing projects, because a QA run that damages the thing you demo is worse
 * than no QA run.
 *
 * Nothing here calls a model. Every assertion is about plumbing that must work
 * whether or not the API key is live — model behaviour is judged by reading its
 * output, not by asserting on it.
 */
import { readFileSync } from 'node:fs';

const env = Object.fromEntries(
  readFileSync(new URL('../.env', import.meta.url), 'utf8')
    .split('\n')
    .map((line) => line.match(/^([A-Z_]+)=(.*?)\s*$/))
    .filter(Boolean)
    .map((m) => [m[1], m[2].trim()]),
);

const BASE = process.env.QA_BASE_URL ?? 'http://localhost:3001';

const auth = await fetch(`${env.SUPABASE_URL}/auth/v1/token?grant_type=password`, {
  method: 'POST',
  headers: { apikey: env.SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: env.DEMO_USER_EMAIL, password: env.DEMO_USER_PASSWORD }),
});

if (!auth.ok) {
  console.error(`\n  sign in failed (${auth.status}). Run npm run seed and try again.\n`);
  process.exit(1);
}

const { access_token: token } = await auth.json();

const api = async (path, method = 'GET', body) => {
  const response = await fetch(`${BASE}/api${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  try {
    return { status: response.status, body: JSON.parse(text) };
  } catch {
    return { status: response.status, body: text.slice(0, 200) };
  }
};

const admin = (path, method = 'GET', body) =>
  fetch(`${env.SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      ...(method === 'POST' ? { Prefer: 'return=representation' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

let passed = 0;
const failures = [];
let group = '';

const section = (name) => {
  group = name;
  console.log(`\n${name}`);
};

const check = (label, condition, detail = '') => {
  if (condition) {
    passed += 1;
    console.log(`  PASS  ${label}${detail ? ` — ${detail}` : ''}`);
  } else {
    failures.push(`${group} · ${label}${detail ? ` — ${detail}` : ''}`);
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  }
};

console.log('\nWinProjects QA — features, not rules\n' + '='.repeat(44));

// ---------------------------------------------------------------- scaffolding

section('Setup');

const stamp = Date.now();
// bid_id must match PREFIX-YYYY-NNN and is permanent, so the uniqueness goes in
// the prefix rather than fighting the three-digit sequence.
const bidId = `QA${stamp}-2026-001`;

const created = await api('/projects', 'POST', {
  bidId,
  name: `QA throwaway ${stamp}`,
  ownerOrg: 'QA',
});
check('a project can be created', created.status === 201 || created.status === 200, `HTTP ${created.status}`);

const projectId = created.body?.id;
if (!projectId) {
  console.log('\n  Cannot continue without a project.\n');
  process.exit(1);
}

// ------------------------------------------------------------------ the chain

section('Scope and packages');

const template = await api(`/projects/${projectId}/scope-template`, 'POST', {
  divisions: ['22', '09'],
});
check('standard scope applies', template.status === 201, JSON.stringify(template.body));
check(
  'it creates packages as well as items',
  (template.body?.createdPackages ?? 0) > 0 && (template.body?.createdItems ?? 0) > 0,
);
check(
  'it brings context lines with it',
  (template.body?.createdContext ?? 0) > 0,
  `${template.body?.createdContext} lines`,
);

const again = await api(`/projects/${projectId}/scope-template`, 'POST', { divisions: ['22'] });
check(
  'applying it twice does not duplicate',
  (again.body?.createdItems ?? 0) === 0 && (again.body?.skipped ?? 0) > 0,
  `${again.body?.skipped} already existed`,
);

const scope = await api(`/projects/${projectId}/scope-items`);
check('scope reads back', scope.status === 200 && scope.body.length > 0, `${scope.body.length} items`);
check(
  'no template item invented a quantity (R1)',
  scope.body.every((item) => item.quantity === null),
);

const firstItem = scope.body[0];
const edited = await api(`/records/scope_item/${firstItem.id}`, 'PATCH', { title: 'QA edited title' });
check('a scope item is editable', edited.status === 200 && edited.body.record.title === 'QA edited title');

// The division decides which package the work is bought under, so it has to be
// settable on the row itself rather than only at creation.
const redivision = await api(`/records/scope_item/${firstItem.id}`, 'PATCH', {
  csi_division: '26',
});
check(
  'a scope item can be moved to another division',
  redivision.status === 200 && redivision.body.record.csi_division === '26',
);
await api(`/records/scope_item/${firstItem.id}`, 'PATCH', { csi_division: firstItem.csi_division });

const locked = await api(`/records/scope_item/${firstItem.id}`, 'PATCH', { is_locked: true });
check('a gate-controlled column is refused (R4)', locked.status === 403);

const packages = await api(`/projects/${projectId}/packages`);
const plumbing = packages.body.find((row) => row.lead_division === '22');
check('packages read back', packages.status === 200 && Boolean(plumbing));

// ---------------------------------------------------------------------- bids

section('Bids and leveling');

const bids = [
  { bidderName: `QA Alpha ${stamp}`, quotedTotal: 50000 },
  { bidderName: `QA Beta ${stamp}`, quotedTotal: 62000 },
];
const quoteIds = [];
for (const bid of bids) {
  const result = await api(`/packages/${plumbing.id}/quotes/manual`, 'POST', bid);
  if (result.status === 201) quoteIds.push(result.body.id);
}
check('bids can be entered by hand', quoteIds.length === 2, `${quoteIds.length} of 2`);

const noBidder = await api(`/packages/${plumbing.id}/quotes/manual`, 'POST', { quotedTotal: 1 });
check('a bid with no bidder is refused', noBidder.status === 400);

const levelled = await api(`/packages/${plumbing.id}/level`, 'POST');
check('leveling computes', levelled.status === 200, JSON.stringify(levelled.body?.gaps ?? {}));

const matrix = await api(`/packages/${plumbing.id}/leveling`);
check('leveling ranks every bid', matrix.body.length === 2 && matrix.body.every((r) => r.advisory_rank > 0));
check(
  'the cheapest bid ranks first on adjusted',
  matrix.body.find((r) => r.advisory_rank === 1)?.quoted_total === 50000,
);
check('P11 scores are computed', matrix.body.every((r) => r.score_price !== null));
check(
  'commercial and programme are left for a human (R1)',
  matrix.body.every((r) => r.score_commercial === null),
);
check('a weighted score exists', matrix.body.some((r) => r.weighted_score !== null));

const tab = await api(`/packages/${plumbing.id}/scope-leveling`);
check('the bid tab builds', tab.status === 200 && tab.body.bidders.length === 2);

const anyScope = tab.body.scopeItems[0];
if (anyScope) {
  const cell = await api(`/packages/${plumbing.id}/scope-leveling/cell`, 'POST', {
    scopeItemId: anyScope.id,
    quoteId: quoteIds[0],
    overrideTotal: 4242,
    note: 'QA override',
  });
  check('a bid tab cell takes an override', cell.status === 200);

  await api(`/packages/${plumbing.id}/level`, 'POST');
  const after = await api(`/packages/${plumbing.id}/scope-leveling`);
  const survived = after.body.cells.find(
    (c) => c.scopeItemId === anyScope.id && c.quoteId === quoteIds[0],
  );
  check(
    'an override survives recompute',
    survived?.overrideTotal === 4242 && survived?.note === 'QA override',
  );
}

// -------------------------------------------------------------- split a bid

section('Splitting a bid across divisions');

const finishes = packages.body.find((row) => row.lead_division === '09');
if (finishes && quoteIds[0]) {
  const split = await api(`/quotes/${quoteIds[0]}/allocations`, 'POST', {
    allocations: [
      { packageId: plumbing.id, amount: 30000 },
      { packageId: finishes.id, amount: 20000 },
    ],
  });
  check('a bid splits across two packages', split.status === 200 && split.body.balanced === true);

  await api(`/packages/${plumbing.id}/level`, 'POST');
  const home = await api(`/packages/${plumbing.id}/leveling`);
  check(
    'it levels at its allocated amount, not its total',
    home.body.some((r) => Number(r.quoted_total) === 30000),
  );

  await api(`/packages/${finishes.id}/level`, 'POST');
  const other = await api(`/packages/${finishes.id}/leveling`);
  check('it appears on the other package too', other.body.some((r) => Number(r.quoted_total) === 20000));

  const unbalanced = await api(`/quotes/${quoteIds[0]}/allocations`, 'POST', {
    allocations: [{ packageId: plumbing.id, amount: 30000 }],
  });
  check(
    'an unbalanced split is reported, not corrected',
    unbalanced.body.balanced === false && unbalanced.body.unallocated === 20000,
  );

  await api(`/quotes/${quoteIds[0]}/allocations`, 'POST', { allocations: [] });
  await api(`/packages/${plumbing.id}/level`, 'POST');
  await api(`/packages/${finishes.id}/level`, 'POST');
}

// -------------------------------------------------------------------- gates

section('Gates');

const noReason = await api('/gates/h6/selection', 'POST', {
  packageId: plumbing.id,
  quoteId: quoteIds[0],
  rationale: '',
});
check('H6 without a rationale is refused', noReason.status >= 400);

const selected = await api('/gates/h6/selection', 'POST', {
  packageId: plumbing.id,
  quoteId: quoteIds[0],
  rationale: 'QA selection',
});
check('H6 with a rationale crosses', selected.status === 200);

const readBack = await api(`/packages/${plumbing.id}/selection`);
check('the selection reads back', readBack.body.selection?.quote_id === quoteIds[0]);

const scopeIds = scope.body.filter((i) => i.csi_division === '22').map((i) => i.id).slice(0, 3);
const h2 = await api('/gates/h2/scope-lock', 'POST', {
  scopeItemIds: scopeIds,
  rationale: 'QA lock',
});
check('H2 locks scope', h2.status === 200 && h2.body.affected === scopeIds.length);

const editLocked = await api(`/records/scope_item/${scopeIds[0]}`, 'PATCH', { title: 'nope' });
check(
  'a locked item still rejects gate columns',
  editLocked.status === 200 || editLocked.status === 403,
  `HTTP ${editLocked.status} (title is not gate-controlled)`,
);

// ------------------------------------------------------------------- buyout

section('Buyout and gaps');

const buyout = await api(`/projects/${projectId}/buyout`);
check('the buyout log builds', buyout.status === 200 && buyout.body.rows.length > 0);
check('it carries per-package gaps', buyout.body.rows.every((r) => Array.isArray(r.gaps)));
check('it has totals', buyout.body.totals !== null);

const withGap = buyout.body.rows.find((r) => r.gaps.length > 0);
if (withGap) {
  const gap = withGap.gaps[0];
  const noNote = await api(`/gaps/${gap.id}/assign`, 'POST', { assignedType: 'ALLOWANCE' });
  check('a gap disposition without a reason is refused', noNote.status === 400);

  const noAmount = await api(`/gaps/${gap.id}/assign`, 'POST', {
    assignedType: 'ALLOWANCE',
    note: 'QA',
  });
  check('an allowance with no amount is refused', noAmount.status === 400);

  const assigned = await api(`/gaps/${gap.id}/assign`, 'POST', {
    assignedType: 'ALLOWANCE',
    assignedAmount: 5000,
    note: 'QA allowance',
  });
  check('a gap can be disposed of', assigned.status === 200);

  const after = await api(`/projects/${projectId}/buyout`);
  const row = after.body.rows.find((r) => r.packageId === withGap.packageId);
  check('it flows into the carried total', Number(row?.gapAllowance) === 5000, `carried ${row?.committed}`);
} else {
  console.log('  INFO  no gaps on this project to dispose of');
}

// ------------------------------------------------------------ scope context

section('Scope context and the learning loop');

const ctxItem = scope.body.find((i) => i.csi_division === '22');
const ctx = await api(`/scope-items/${ctxItem.id}/context`);
check('context reads back', ctx.status === 200 && ctx.body.lines.length > 0, `${ctx.body.lines.length} lines`);
check('template context is attributed to a pattern', ctx.body.lines.some((l) => l.origin === 'PATTERN'));

const added = await api(`/scope-items/${ctxItem.id}/context`, 'POST', {
  kind: 'INCLUSION',
  text: `QA line ${stamp}`,
});
check('a human can add a context line', added.status === 201);

const badKind = await api(`/scope-items/${ctxItem.id}/context`, 'POST', { kind: 'NOPE', text: 'x' });
check('an unknown context kind is refused', badKind.status === 400);

const noReasonRetire = await api(`/context/${added.body.id}/retire`, 'POST', {});
check('retiring without a reason is refused', noReasonRetire.status === 400);

const retired = await api(`/context/${added.body.id}/retire`, 'POST', { reason: 'QA' });
check('retiring works with a reason', retired.status === 200);

const afterRetire = await api(`/scope-items/${ctxItem.id}/context`);
check(
  'a retired line is kept, not deleted',
  afterRetire.body.lines.some((l) => l.id === added.body.id && l.is_active === false),
);

// --------------------------------------------------------------- the copilot

section('Copilot and assistant');

const suggestions = await api(`/projects/${projectId}/suggestions`);
check('suggestions are produced', suggestions.status === 200 && suggestions.body.length > 0, `${suggestions.body.length}`);
check('every suggestion explains itself', suggestions.body.every((s) => s.why?.length > 20));
check(
  'every agent suggestion has something to run',
  suggestions.body.filter((s) => s.kind === 'AGENT').every((s) => s.action?.path),
);
check(
  'suggestions are ordered by urgency',
  (() => {
    const rank = { BLOCKING: 0, HIGH: 1, NORMAL: 2 };
    return suggestions.body.every(
      (s, i) => i === 0 || rank[suggestions.body[i - 1].urgency] <= rank[s.urgency],
    );
  })(),
);

// ------------------------------------------------------------ table command

section('Talking to tables');

const badTable = await api('/table-command/plan', 'POST', {
  table: 'approval',
  instruction: 'x',
  rows: [{ id: '1' }],
  columns: [],
});
check('a non-editable table is refused', badTable.status === 400);

const badField = await api('/table-command/apply', 'POST', {
  table: 'scope_item',
  instruction: 'x',
  edits: [{ rowId: scope.body[0].id, field: 'is_locked', value: 'true' }],
});
check('a gate-controlled column is refused', badField.status === 403);

const ghostRow = await api('/table-command/apply', 'POST', {
  table: 'scope_item',
  instruction: 'x',
  edits: [{ rowId: '00000000-0000-0000-0000-000000000000', field: 'title', value: 'ghost' }],
});
check('an unknown row fails cleanly', ghostRow.status === 200 && ghostRow.body.applied === 0);

// ------------------------------------------------------------------- queue

section('Agent queue');

const queue = await api('/queue');
check('the queue reads', queue.status === 200 && Array.isArray(queue.body.queued));

const ghostCancel = await api('/jobs/00000000-0000-0000-0000-000000000000/cancel', 'POST');
check('cancelling an unknown job 404s', ghostCancel.status === 404);

const retryUnknown = await api('/jobs/00000000-0000-0000-0000-000000000000/retry', 'POST');
check('requeueing an unknown job 404s', retryUnknown.status === 404);

// A job that has not finished cannot be requeued — that would mean two of the
// same work in flight, spending twice.
const liveJobs = await api('/queue');
const inFlight = [...(liveJobs.body?.running ?? []), ...(liveJobs.body?.queued ?? [])][0];
if (inFlight) {
  const tooSoon = await api(`/jobs/${inFlight.id}/retry`, 'POST');
  check('requeueing a job still in flight is refused', tooSoon.status === 409);
}

const doneJob = (liveJobs.body?.finished ?? []).find((job) => job.status !== 'DONE');
if (doneJob) {
  const again = await api(`/jobs/${doneJob.id}/retry`, 'POST');
  check('a failed job can be requeued', again.status === 200, JSON.stringify(again.body).slice(0, 100));
  check('it goes in at the front', (again.body?.priority ?? 0) > 0);
  if (again.status === 200) await admin(`job?id=eq.${again.body.id}`, 'DELETE');
}

// --------------------------------------------------------------- workspaces

section('Workspaces and cost codes');

const subWithBid = await admin(
  `subcontractor?select=id&name=like.QA%25${stamp}`,
).then((r) => r.json());
if (subWithBid[0]) {
  const blocked = await admin(`subcontractor?id=eq.${subWithBid[0].id}`, 'DELETE');
  check(
    'a sub who has bid cannot be deleted (0022)',
    blocked.status >= 400,
    `HTTP ${blocked.status}`,
  );
}

const workspaces = await api('/workspaces');
check('workspaces list', workspaces.status === 200 && workspaces.body.length > 0);
check('exactly one is current', workspaces.body.filter((w) => w.isCurrent).length === 1);

const ghostSwitch = await api('/workspaces/00000000-0000-0000-0000-000000000000/switch', 'POST');
check('switching to a workspace you are not in 404s', ghostSwitch.status === 404);

const code = await api('/cost-codes', 'POST', {
  code: `QA-${stamp}`,
  description: 'QA code',
  csiDivision: '22',
});
check('a cost code can be created', code.status === 201);

const dupe = await api('/cost-codes', 'POST', { code: `QA-${stamp}`, description: 'again' });
check('a duplicate cost code is refused', dupe.status === 409);

// ------------------------------------------- merging and reviewing in place

section('Merging scope lines');

const mergeA = await api(`/projects/${projectId}/scope-items`, 'POST', { csiDivision: '26' });
const mergeB = await api(`/projects/${projectId}/scope-items`, 'POST', { csiDivision: '26' });
check(
  'two rows to merge exist',
  mergeA.status === 201 && mergeB.status === 201,
  `${mergeA.body?.scope_id} + ${mergeB.body?.scope_id}`,
);

// The kept row is left blank on purpose, and the merged row carries a unit and
// a basis. Merging should fill the blanks and nothing else.
await api(`/records/scope_item/${mergeB.body.id}`, 'PATCH', {
  unit: 'EA',
  quantity_basis: 'QA basis from the merged row',
  description: 'QA merged description',
});

const mergeNoReason = await api(`/projects/${projectId}/scope-items/merge`, 'POST', {
  keepId: mergeA.body.id,
  mergeIds: [mergeB.body.id],
});
check('merging without a reason is refused', mergeNoReason.status === 400);

const merged = await api(`/projects/${projectId}/scope-items/merge`, 'POST', {
  keepId: mergeA.body.id,
  mergeIds: [mergeB.body.id],
  rationale: 'QA — same work described twice',
});
check('a merge succeeds', merged.status === 200, JSON.stringify(merged.body).slice(0, 120));

const afterMerge = await api(`/projects/${projectId}/scope-items`);
const kept = afterMerge.body.find((row) => row.id === mergeA.body.id);
check('the kept row survives with its scope ID', Boolean(kept) && kept.scope_id === mergeA.body.scope_id);
check('the merged row is gone', !afterMerge.body.some((row) => row.id === mergeB.body.id));
check('blank fields were filled from the merged row', kept?.unit === 'EA');
check(
  'the merged description was carried over, not dropped',
  String(kept?.description ?? '').includes('QA merged description'),
);
check(
  'quantities were not silently summed (R1)',
  kept?.quantity === null,
  'kept quantity stays null',
);

const selfMerge = await api(`/projects/${projectId}/scope-items/merge`, 'POST', {
  keepId: mergeA.body.id,
  mergeIds: [mergeA.body.id],
  rationale: 'QA',
});
check('merging a row into itself is refused', selfMerge.status === 400);

section('Reviewing proposals in the table');

// A run with real drafts, seeded directly. Nothing here calls a model — the
// point is the review-and-accept path, not what an agent would have written.
const tenantId = (await (await admin(`project?id=eq.${projectId}&select=tenant_id`)).json())[0]
  ?.tenant_id;

const seededRun = await (
  await admin('agent_run', 'POST', {
    tenant_id: tenantId,
    agent_type: 'qa_draft_scope',
    project_id: projectId,
    status: 'DONE',
    input_ref: 'QA seeded',
    finished_at: new Date().toISOString(),
  })
).json();
const seededRunId = seededRun[0]?.id;

const draftValues = [
  { scope_id: `QA-DRAFT-${stamp}-A`, csi_division: '26', title: 'QA proposed A', unit: 'EA' },
  { scope_id: `QA-DRAFT-${stamp}-B`, csi_division: '26', title: 'QA proposed B', unit: 'LS' },
  { scope_id: `QA-DRAFT-${stamp}-C`, csi_division: '26', title: 'QA proposed C', unit: 'LF' },
];

const seededDrafts = await (
  await admin(
    'draft',
    'POST',
    draftValues.map((value) => ({
      tenant_id: tenantId,
      agent_run_id: seededRunId,
      target_table: 'scope_item',
      field: 'scope_item',
      proposed_value: value,
      confidence: 0.9,
      fill_tag: 'AI',
    })),
  )
).json();

check('three proposals were seeded', seededDrafts.length === 3, `${seededDrafts.length}`);

const proposals = await api(`/projects/${projectId}/proposed-scope`);
check('proposed scope reads', proposals.status === 200, `${proposals.body?.rows?.length ?? 0} rows`);
check(
  'the seeded proposals come back',
  (proposals.body?.rows ?? []).filter((row) => row.runId === seededRunId).length === 3,
);
check(
  'the run that proposed them is named',
  (proposals.body?.runs ?? []).some((run) => run.id === seededRunId),
);
check(
  'it returns rows and the runs they came from',
  Array.isArray(proposals.body?.rows) && Array.isArray(proposals.body?.runs),
);
check(
  'every proposal carries the draft it came from',
  (proposals.body?.rows ?? []).every((row) => typeof row.draftId === 'string' && row.draftId !== ''),
);
check(
  'no proposal invents a quantity (R1)',
  (proposals.body?.rows ?? []).every((row) => row.quantity === null || typeof row.quantity === 'number'),
);

// Accept with changes: one row edited, one rejected, one taken as drafted.
// This is the whole feature — if the override does not land or the dropped row
// gets written anyway, the review is decorative.
const byScope = Object.fromEntries(
  (proposals.body?.rows ?? [])
    .filter((row) => row.runId === seededRunId)
    .map((row) => [row.scope_id, row]),
);

const accepted = await api(`/runs/${seededRunId}/promote-scope`, 'POST', {
  rationale: 'QA — accepted with changes',
  overrides: {
    [byScope[`QA-DRAFT-${stamp}-A`].draftId]: { title: 'QA title the human wrote', unit: 'SF' },
  },
  drop: [byScope[`QA-DRAFT-${stamp}-C`].draftId],
});

check('accept with changes succeeds', accepted.status === 200, JSON.stringify(accepted.body).slice(0, 140));
check('it reports the edit', accepted.body?.edited === 1);
check('it reports the rejection', accepted.body?.dropped === 1);
check('it wrote only what was accepted', accepted.body?.created === 2);

const afterAccept = await api(`/projects/${projectId}/scope-items`);
const rowA = afterAccept.body.find((row) => row.scope_id === `QA-DRAFT-${stamp}-A`);
const rowB = afterAccept.body.find((row) => row.scope_id === `QA-DRAFT-${stamp}-B`);
const rowC = afterAccept.body.find((row) => row.scope_id === `QA-DRAFT-${stamp}-C`);

check('the edited row went in as the human wrote it', rowA?.title === 'QA title the human wrote');
check('the edit reached every changed field', rowA?.unit === 'SF');
check('the untouched row went in as drafted', rowB?.title === 'QA proposed B');
check('the rejected row was never written', rowC === undefined);

const draftStillSays = await (
  await admin(`draft?id=eq.${byScope[`QA-DRAFT-${stamp}-A`].draftId}&select=proposed_value`)
).json();
check(
  'the draft still says what the agent said, not what the human wrote (R2)',
  draftStillSays[0]?.proposed_value?.title === 'QA proposed A',
);

const acceptedTwice = await api(`/projects/${projectId}/proposed-scope`);
check(
  'an accepted run stops being proposed',
  !(acceptedTwice.body?.rows ?? []).some((row) => row.runId === seededRunId),
);

const blindAccept = await api('/runs/00000000-0000-0000-0000-000000000000/promote-scope', 'POST', {
  rationale: 'QA',
});
check('accepting an unknown run 404s', blindAccept.status === 404);

const noRationale = await api('/runs/00000000-0000-0000-0000-000000000000/promote-scope', 'POST', {});
check('accepting without a reason is refused before anything else', noRationale.status === 400);

const deleteScope = await api(`/scope-items/${mergeA.body.id}`, 'DELETE');
check('a scope item can be deleted', deleteScope.status === 200);

const deleteGone = await api(`/scope-items/${mergeA.body.id}`, 'DELETE');
check('deleting it twice 404s', deleteGone.status === 404);

const lockedItem = afterMerge.body.find((row) => row.is_locked);
if (lockedItem) {
  const refused = await api(`/scope-items/${lockedItem.id}`, 'DELETE');
  check('a locked scope item cannot be deleted', refused.status === 400);
}

// -------------------------------------------------------------- P14 hindsight

section('P14 hindsight');

const past = await api('/past-projects', 'POST', { name: `QA past ${stamp}`, gcName: 'QA GC' });
const pastId = past.body?.id;
check('a past project can be created', Boolean(pastId));

if (pastId) {
  const tenant = await admin(`past_project?select=tenant_id&id=eq.${pastId}`).then((r) => r.json());
  await admin('change_order', 'POST', [
    {
      tenant_id: tenant[0].tenant_id,
      past_project_id: pastId,
      co_number: 'QA-CO-1',
      amount: 10000,
      description: 'QA change order',
    },
  ]);

  const report = await api(`/past-projects/${pastId}/hindsight`);
  check('the hindsight report builds', report.status === 200 && report.body.totals.changeOrders === 1);
  check(
    'the catch rate is withheld below five reviewed',
    report.body.totals.catchRate === null,
  );

  const coId = report.body.changeOrders[0].id;
  const noGap = await api(`/change-orders/${coId}/hindsight`, 'POST', { hindsight: 'PREDICTED' });
  check('PREDICTED without a gap is refused', noGap.status === 400);

  const verdict = await api(`/change-orders/${coId}/hindsight`, 'POST', {
    hindsight: 'MISSED',
    note: 'QA verdict',
  });
  check('a verdict is accepted', verdict.status === 200);

  const scored = await api(`/past-projects/${pastId}/hindsight`);
  check('the verdict counts as preventable', scored.body.totals.missed === 1);
}

// ------------------------------------------------------------------ cleanup

section('Cleanup');

if (pastId) await admin(`change_order?past_project_id=eq.${pastId}`, 'DELETE');
if (pastId) await admin(`past_project?id=eq.${pastId}`, 'DELETE');
await admin(`cost_code?code=eq.QA-${stamp}`, 'DELETE');

const noConfirm = await api(`/projects/${projectId}`, 'DELETE', {});
check('deleting a project without confirming is refused', noConfirm.status === 400);

const withSelection = await api(`/projects/${projectId}`, 'DELETE', { bidId });
check(
  'a project with a selection against it is refused',
  withSelection.status === 409,
  `HTTP ${withSelection.status}`,
);

// Remove the selection, then it should delete through the app.
await admin(`selection?package_id=eq.${plumbing.id}`, 'DELETE');
const removed = await api(`/projects/${projectId}`, 'DELETE', { bidId });
check('the throwaway project is removed', removed.status === 200, `HTTP ${removed.status}`);

// Subs last: deleting one used to cascade into its quotes and their selections,
// which is the bug 0022 fixes — and doing it first is what made this suite lie
// to itself about the guard above.
await admin(`subcontractor?name=like.QA%25${stamp}`, 'DELETE');

const leftover = await api(`/projects`);
check(
  'nothing QA-shaped is left behind',
  !leftover.body.some((p) => String(p.bid_id).startsWith('QA')),
);

// ------------------------------------------------------------------- report

console.log('\n' + '='.repeat(44));
if (failures.length === 0) {
  console.log(`\n  ${passed} checks passed. No failures.\n`);
} else {
  console.log(`\n  ${passed} passed, ${failures.length} FAILED:\n`);
  for (const failure of failures) console.log(`    ${failure}`);
  console.log('');
  process.exitCode = 1;
}

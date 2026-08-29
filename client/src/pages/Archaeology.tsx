import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { ActivityStream } from '../components/ActivityStream';
import { ErrorBanner, Layout, money } from '../components/Layout';
import { apiGet, apiPost } from '../lib/api';
import { supabase } from '../lib/supabase';

type PastProject = {
  id: string;
  name: string;
  gc_name: string | null;
  contract_value: number | null;
  completed_at: string | null;
  project_id: string | null;
  changeOrderCount: number;
  changeOrderTotal: number;
  classified: number;
  verified: number;
  preventableCount: number;
  preventableAmount: number;
};

type ChangeOrder = {
  id: string;
  co_number: string | null;
  amount: number | null;
  description: string | null;
  stated_reason: string | null;
  issued_at: string | null;
  classification: {
    classification: string | null;
    human_verdict: string | null;
    reasoning: string | null;
    source_location: string | null;
    confidence: number | null;
  } | null;
};

type Project = { id: string; name: string; bid_id: string };

const VERDICTS = [
  ['PREVENTABLE_SCOPE_GAP', 'Preventable', 'bg-red-100 text-red-800'],
  ['OWNER_DIRECTED', 'Owner directed', 'bg-slate-100 text-slate-700'],
  ['UNFORESEEN_CONDITION', 'Unforeseen', 'bg-slate-100 text-slate-700'],
  ['DESIGN_ERROR', 'Design error', 'bg-amber-100 text-amber-800'],
  ['UNDETERMINED', 'Undetermined', 'bg-slate-100 text-slate-500'],
] as const;

/**
 * P14 · Change-order archaeology.
 *
 * Feed it a closed job and it asks of each change order: was this scope in the
 * bid documents on day one? The headline it produces — *of $X in change orders,
 * $Y were preventable* — is the most persuasive thing this product can say,
 * which is exactly why only VERIFIED classifications count toward it.
 *
 * An unvetted classification is a claim. A wrong "preventable" claim in front of
 * the person who ran that job ends the meeting.
 */
export function ArchaeologyPage() {
  const [pastProjects, setPastProjects] = useState<PastProject[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [orders, setOrders] = useState<ChangeOrder[]>([]);
  const [runId, setRunId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ name: '', gcName: '', projectId: '' });
  const [verdictFor, setVerdictFor] = useState<string | null>(null);
  const [verdict, setVerdict] = useState('');
  const [rationale, setRationale] = useState('');
  const picker = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    const [past, live] = await Promise.all([
      apiGet<PastProject[]>('/past-projects'),
      apiGet<Project[]>('/projects'),
    ]);
    setPastProjects(past);
    setProjects(live);
  }, []);

  useEffect(() => {
    load().catch((caught: Error) => setError(caught.message));
  }, [load]);

  const loadOrders = useCallback(async (id: string) => {
    setOrders(await apiGet<ChangeOrder[]>(`/past-projects/${id}/change-orders`));
  }, []);

  useEffect(() => {
    if (selected) loadOrders(selected).catch((caught: Error) => setError(caught.message));
  }, [selected, loadOrders]);

  const guard = async (work: () => Promise<void>) => {
    setError(null);
    try {
      await work();
      await load();
      if (selected) await loadOrders(selected);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  async function create(event: FormEvent) {
    event.preventDefault();
    await guard(async () => {
      const created = await apiPost<PastProject>('/past-projects', {
        name: form.name,
        gcName: form.gcName || undefined,
        projectId: form.projectId || undefined,
      });
      setSelected(created.id);
      setCreating(false);
      setForm({ name: '', gcName: '', projectId: '' });
    });
  }

  async function importOrders(file: File) {
    if (!selected) return;
    await guard(async () => {
      const body = new FormData();
      body.append('file', file);
      const { data } = await supabase.auth.getSession();
      const response = await fetch(`/api/past-projects/${selected}/change-orders/import`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${data.session?.access_token ?? ''}` },
        body,
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? 'Import failed');
      setError(`Imported ${result.imported} change orders.`);
    });
  }

  const current = pastProjects.find((row) => row.id === selected);

  return (
    <Layout breadcrumb={<span>Change-order archaeology</span>}>
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold text-slate-900">Change-order archaeology</h1>
          <p className="text-sm text-slate-500">
            Which change orders were in the bid documents all along.
          </p>
        </div>
        <button
          onClick={() => setCreating((value) => !value)}
          className="rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white"
        >
          {creating ? 'Cancel' : 'Add a closed job'}
        </button>
      </div>

      <ErrorBanner message={error} />

      {creating && (
        <form onSubmit={create} className="grid gap-3 rounded-lg border border-slate-200 bg-white p-4 sm:grid-cols-3">
          <label className="block">
            <span className="text-sm font-medium text-slate-700">Job name</span>
            <input
              required
              value={form.name}
              onChange={(event) => setForm({ ...form, name: event.target.value })}
              className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm outline-none focus:border-slate-900"
            />
          </label>
          <label className="block">
            <span className="text-sm font-medium text-slate-700">GC</span>
            <input
              value={form.gcName}
              onChange={(event) => setForm({ ...form, gcName: event.target.value })}
              className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm outline-none focus:border-slate-900"
            />
          </label>
          <label className="block">
            <span className="text-sm font-medium text-slate-700">Bid set from</span>
            <select
              value={form.projectId}
              onChange={(event) => setForm({ ...form, projectId: event.target.value })}
              className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
            >
              <option value="">none — classifications will be undetermined</option>
              {projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.bid_id} · {project.name}
                </option>
              ))}
            </select>
          </label>
          <div className="sm:col-span-3">
            <button className="rounded-md bg-slate-900 px-3 py-2 text-sm font-medium text-white">
              Add
            </button>
            <span className="ml-3 text-xs text-slate-500">
              Link a project with drawings or specs — without a bid set, nothing can be established
              as preventable.
            </span>
          </div>
        </form>
      )}

      <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
              <th className="px-4 py-2 font-medium">Closed job</th>
              <th className="px-4 py-2 text-right font-medium">COs</th>
              <th className="px-4 py-2 text-right font-medium">CO value</th>
              <th className="px-4 py-2 text-right font-medium">Verified preventable</th>
              <th className="px-4 py-2 font-medium">Progress</th>
            </tr>
          </thead>
          <tbody>
            {pastProjects.map((row) => (
              <tr
                key={row.id}
                onClick={() => setSelected(row.id)}
                className={`cursor-pointer border-b border-slate-100 last:border-0 ${
                  row.id === selected ? 'bg-slate-50' : ''
                }`}
              >
                <td className="px-4 py-2">
                  <div className="font-medium text-slate-900">{row.name}</div>
                  <div className="text-xs text-slate-400">{row.gc_name ?? '—'}</div>
                </td>
                <td className="px-4 py-2 text-right text-slate-600">{row.changeOrderCount}</td>
                <td className="px-4 py-2 text-right text-slate-600">
                  {money(row.changeOrderTotal)}
                </td>
                <td className="px-4 py-2 text-right">
                  {row.preventableCount > 0 ? (
                    <span className="font-semibold text-red-700">
                      {money(row.preventableAmount)}
                    </span>
                  ) : (
                    <span className="text-slate-400">—</span>
                  )}
                </td>
                <td className="px-4 py-2 text-xs text-slate-500">
                  {row.classified} classified · {row.verified} vetted
                </td>
              </tr>
            ))}
            {pastProjects.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-6 text-sm text-slate-400">
                  No closed jobs yet. Add one, link its bid set, and import the change-order log.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {current && (
        <section className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-sm font-medium text-slate-900">{current.name} — change orders</h2>
            <div className="flex gap-2">
              <button
                onClick={() => picker.current?.click()}
                className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700"
              >
                Import CO log (xlsx)
              </button>
              <input
                ref={picker}
                type="file"
                accept=".xlsx,.xls,.csv"
                className="hidden"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) void importOrders(file);
                  event.target.value = '';
                }}
              />
              <button
                onClick={() =>
                  void guard(async () => {
                    const result = await apiPost<{ runId: string; note?: string }>(
                      `/past-projects/${current.id}/classify`,
                    );
                    setRunId(result.runId);
                    if (result.note) setError(result.note);
                  })
                }
                disabled={current.changeOrderCount === 0}
                className="rounded-md bg-slate-900 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-40"
              >
                Run archaeologist
              </button>
            </div>
          </div>

          <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
                  <th className="px-3 py-2 font-medium">CO</th>
                  <th className="px-3 py-2 text-right font-medium">Amount</th>
                  <th className="px-3 py-2 font-medium">Description</th>
                  <th className="px-3 py-2 font-medium">Proposed</th>
                  <th className="px-3 py-2 font-medium">Your verdict</th>
                </tr>
              </thead>
              <tbody>
                {orders.map((order) => (
                  <tr key={order.id} className="border-b border-slate-100 last:border-0 align-top">
                    <td className="px-3 py-2 font-mono text-xs text-slate-500">
                      {order.co_number ?? '—'}
                    </td>
                    <td className="px-3 py-2 text-right text-slate-700">{money(order.amount)}</td>
                    <td className="max-w-sm px-3 py-2 text-slate-700">
                      {order.description ?? '—'}
                      {order.stated_reason && (
                        <div className="text-xs text-slate-400">
                          stated: {order.stated_reason}
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-2 text-xs">
                      {order.classification ? (
                        <>
                          <div className="text-slate-700">
                            {order.classification.classification}
                          </div>
                          {order.classification.source_location && (
                            <div className="text-slate-400">
                              {order.classification.source_location}
                            </div>
                          )}
                          {order.classification.reasoning && (
                            <div className="mt-0.5 max-w-xs text-slate-500">
                              {order.classification.reasoning.slice(0, 140)}
                            </div>
                          )}
                        </>
                      ) : (
                        <span className="text-slate-400">not classified</span>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      {order.classification?.human_verdict ? (
                        <span
                          className={`rounded px-1.5 py-0.5 text-xs font-medium ${
                            VERDICTS.find((v) => v[0] === order.classification?.human_verdict)?.[2] ??
                            'bg-slate-100 text-slate-600'
                          }`}
                        >
                          {VERDICTS.find((v) => v[0] === order.classification?.human_verdict)?.[1]}
                        </span>
                      ) : verdictFor === order.id ? (
                        <div className="space-y-1">
                          <select
                            value={verdict}
                            onChange={(event) => setVerdict(event.target.value)}
                            className="w-full rounded border border-slate-300 px-1 py-0.5 text-xs"
                          >
                            <option value="">choose…</option>
                            {VERDICTS.map(([value, label]) => (
                              <option key={value} value={value}>
                                {label}
                              </option>
                            ))}
                          </select>
                          <input
                            value={rationale}
                            onChange={(event) => setRationale(event.target.value)}
                            placeholder="Why?"
                            className="w-full rounded border border-slate-300 px-1 py-0.5 text-xs"
                          />
                          <div className="flex gap-1">
                            <button
                              disabled={!verdict || rationale.trim() === ''}
                              onClick={() =>
                                void guard(async () => {
                                  await apiPost(`/change-orders/${order.id}/verdict`, {
                                    verdict,
                                    rationale: rationale.trim(),
                                  });
                                  setVerdictFor(null);
                                  setVerdict('');
                                  setRationale('');
                                })
                              }
                              className="rounded bg-slate-900 px-2 py-0.5 text-xs text-white disabled:opacity-40"
                            >
                              Save
                            </button>
                            <button
                              onClick={() => setVerdictFor(null)}
                              className="px-1 text-xs text-slate-400"
                            >
                              cancel
                            </button>
                          </div>
                        </div>
                      ) : (
                        <button
                          onClick={() => {
                            setVerdictFor(order.id);
                            setVerdict(order.classification?.classification ?? '');
                            setRationale('');
                          }}
                          className="rounded-md border border-slate-300 px-2 py-1 text-xs text-slate-700"
                        >
                          Decide
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
                {orders.length === 0 && (
                  <tr>
                    <td colSpan={5} className="px-4 py-6 text-sm text-slate-400">
                      No change orders. Import the log.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          {runId && <ActivityStream runId={runId} />}

          <p className="text-xs text-slate-400">
            Only verdicts you have given count toward the preventable total. The agent proposes; a
            wrong &ldquo;preventable&rdquo; claim in front of the GC who ran that job ends the
            meeting.
          </p>
        </section>
      )}
    </Layout>
  );
}

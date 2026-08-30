import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ActivityStream } from '../components/ActivityStream';
import { ErrorBanner, Layout, money } from '../components/Layout';
import { apiGet, apiPatch, apiPost, apiUploadOne } from '../lib/api';

type ChangeOrder = {
  id: string;
  co_number: string | null;
  amount: number | null;
  description: string | null;
  stated_reason: string | null;
  hindsight: string;
  hindsight_note: string | null;
  matched_gap_id: string | null;
  scope: { scope_id: string; title: string } | null;
};

type MissedScope = {
  id: string;
  severity: string | null;
  gapType: string | null;
  exposure: number | null;
  scopeId: string | null;
  division: string | null;
  title: string | null;
  becameChangeOrder: boolean;
};

type Report = {
  pastProject: { id: string; name: string; gc_name: string | null; project_id: string | null };
  detectedGaps: number;
  scope: {
    total: number;
    locked: number;
    byDivision: { division: string; items: number; gaps: number }[];
  };
  missedScope: MissedScope[];
  totals: {
    changeOrders: number;
    value: number;
    preventable: number;
    preventableValue: number;
    predicted: number;
    predictedValue: number;
    missed: number;
    missedValue: number;
    notPreventable: number;
    unreviewed: number;
    catchRate: number | null;
  };
  changeOrders: ChangeOrder[];
};

type PastJob = { id: string; name: string; gc_name: string | null; project_id: string | null };
type Project = { id: string; name: string; bid_id: string };

const VERDICTS = [
  { value: 'PREDICTED', label: 'We flagged it', hint: 'A gap was raised on the scope this hit' },
  { value: 'MISSED', label: 'We missed it', hint: 'It was a scope gap and nothing warned' },
  { value: 'NOT_PREVENTABLE', label: 'Not ours', hint: 'Owner-directed, unforeseen, design error' },
] as const;

const SEVERITY: Record<string, string> = {
  CRITICAL: 'bg-red-100 text-red-800',
  HIGH: 'bg-orange-100 text-orange-800',
  MEDIUM: 'bg-flag-100 text-flag-700',
  LOW: 'bg-ink-100 text-ink-600',
};

/**
 * Hindsight — a backtest, in four steps.
 *
 * Not a change-order tracker. Take a job that is finished, load its bid set as
 * if it were precon, and put the real change-order list next to the scope gaps
 * that were flagged. "Of your 31 change orders, 19 were scope gaps, and we
 * would have flagged 14 of them worth $340k before you bought the job" is a
 * different conversation from "here is a tool".
 *
 * It used to be half a screen: a dropdown of past jobs, and an empty state that
 * pointed at an Archaeology page which is not in the navigation any more. So the
 * only path in was through a door that had been taken off the building. This is
 * the whole path, in the order somebody actually does it — name the job, point
 * at its documents, drop the change-order log, run it — with the two answers it
 * exists to produce sitting at the end: what the scope of work included, and
 * what the bidders missed.
 *
 * Every verdict is still a person's. A model can suggest which scope item a
 * change order landed on, but "we would have caught this" gets said in a room to
 * somebody who ran that job, and a claim resting on a model's guess does not
 * survive the first question.
 */
export function HindsightPage() {
  const [jobs, setJobs] = useState<PastJob[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [runId, setRunId] = useState<string | null>(null);

  const [newName, setNewName] = useState('');
  const [newGc, setNewGc] = useState('');
  const [newProjectId, setNewProjectId] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    const [past, live] = await Promise.all([
      apiGet<PastJob[]>('/past-projects'),
      apiGet<Project[]>('/projects').catch(() => [] as Project[]),
    ]);
    setJobs(past);
    setProjects(live);
  }, []);

  const loadReport = useCallback(async () => {
    if (!selected) {
      setReport(null);
      return;
    }
    try {
      setReport(await apiGet<Report>(`/past-projects/${selected}/hindsight`));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }, [selected]);

  useEffect(() => {
    load().catch((caught: Error) => setError(caught.message));
  }, [load]);

  useEffect(() => {
    void loadReport();
  }, [loadReport]);

  const job = jobs.find((row) => row.id === selected) ?? null;

  const guard = async (work: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
      await loadReport();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  const create = () =>
    guard(async () => {
      const created = await apiPost<PastJob>('/past-projects', {
        name: newName.trim(),
        gcName: newGc.trim() || undefined,
        projectId: newProjectId || undefined,
      });
      setNewName('');
      setNewGc('');
      setNewProjectId('');
      await load();
      setSelected(created.id);
    });

  /** The change-order log, as it exists in every office: a spreadsheet. */
  const importLog = (file: File) =>
    guard(async () => {
      const result = await apiUploadOne<{ imported?: number }>(
        `/past-projects/${selected}/change-orders/import`,
        file,
      );
      setError(`Read ${result.imported ?? 0} change orders from ${file.name}.`);
      if (fileInput.current) fileInput.current.value = '';
    });

  /** Points a past job at the project holding its bid set. */
  const linkProject = (projectId: string) =>
    guard(async () => {
      await apiPatch(`/records/past_project/${selected}`, { project_id: projectId });
      await load();
    });

  const runMatch = () =>
    guard(async () => {
      const result = await apiPost<{ runId: string; note?: string }>(
        `/past-projects/${selected}/classify`,
        {},
      );
      setRunId(result.runId);
      if (result.note) setError(result.note);
    });

  const verdict = async (co: ChangeOrder, value: string) =>
    guard(async () => {
      await apiPost(`/change-orders/${co.id}/hindsight`, {
        hindsight: value,
        note: note.trim() || undefined,
        matchedGapId: co.matched_gap_id ?? undefined,
      });
      setOpen(null);
      setNote('');
    });

  const totals = report?.totals;
  const step = !selected ? 1 : !job?.project_id ? 2 : (report?.totals.changeOrders ?? 0) === 0 ? 3 : 4;

  const stepHead = (n: number, title: string, hint: string) => (
    <div className="flex items-baseline gap-2.5">
      <span
        className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] font-medium ${
          step > n ? 'bg-ink-900 text-white' : step === n ? 'bg-flag-500 text-white' : 'bg-ink-100 text-ink-400'
        }`}
      >
        {step > n ? '✓' : n}
      </span>
      <span className="text-[13px] font-semibold text-ink-900">{title}</span>
      <span className="text-xs text-ink-400">{hint}</span>
    </div>
  );

  return (
    <Layout breadcrumb={<span>Hindsight</span>}>
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-ink-900">Hindsight</h1>
        <p className="max-w-3xl text-xs text-ink-400">
          Take a job that is already finished. Load its drawings and bids as if it were precon, drop
          in the change orders it actually ran, and see what the scope of work included and what the
          bidders missed. This is where the claim gets tested — and it is the only honest way to
          calibrate what the gap detector knows.
        </p>
      </div>

      <ErrorBanner message={error} />

      {/* 1 ─ the job */}
      <section className="space-y-2.5 rounded-xl border border-ink-200 bg-white px-4 py-3.5">
        {stepHead(1, 'The finished job', 'name it once; come back to it any time')}

        <div className="flex flex-wrap items-center gap-2 pl-8">
          {jobs.length > 0 && (
            <select
              value={selected ?? ''}
              onChange={(event) => setSelected(event.target.value || null)}
              className="rounded-md border border-ink-300 px-2 py-1.5 text-xs"
            >
              <option value="">Pick a job…</option>
              {jobs.map((row) => (
                <option key={row.id} value={row.id}>
                  {row.name}
                  {row.gc_name ? ` · ${row.gc_name}` : ''}
                </option>
              ))}
            </select>
          )}

          <span className="flex flex-wrap items-center gap-1.5">
            <input
              value={newName}
              onChange={(event) => setNewName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && newName.trim()) void create();
              }}
              placeholder={jobs.length > 0 ? 'or add another…' : 'Job name'}
              className="w-44 rounded-md border border-ink-300 px-2 py-1.5 text-xs outline-none focus:border-ink-800"
            />
            <input
              value={newGc}
              onChange={(event) => setNewGc(event.target.value)}
              placeholder="GC (optional)"
              className="w-36 rounded-md border border-ink-300 px-2 py-1.5 text-xs outline-none focus:border-ink-800"
            />
            <button
              disabled={busy || newName.trim() === ''}
              onClick={() => void create()}
              className="rounded-md bg-ink-900 px-2.5 py-1.5 text-xs font-medium text-white disabled:opacity-40"
            >
              Add
            </button>
          </span>
        </div>
      </section>

      {/* 2 ─ its documents */}
      {selected && (
        <section className="space-y-2.5 rounded-xl border border-ink-200 bg-white px-4 py-3.5">
          {stepHead(2, 'Its drawings, specs and bids', 'reconstructed as a normal project')}

          <div className="pl-8">
            {job?.project_id ? (
              <p className="text-xs text-ink-500">
                Linked to{' '}
                <Link
                  to={`/projects/${job.project_id}?step=documents`}
                  className="font-medium text-ink-900 underline"
                >
                  {projects.find((row) => row.id === job.project_id)?.name ?? 'its project'}
                </Link>
                . Upload, label and draft scope there — it is the same chain as a live job, which is
                the point: the gaps have to be found the way they would have been found at the time.
              </p>
            ) : (
              <div className="space-y-1.5">
                <p className="text-xs text-ink-500">
                  Point this at the project holding that job&apos;s bid set. If it is not in here
                  yet, create it, drop the drawings and bids in, and come back.
                </p>
                <div className="flex flex-wrap items-center gap-1.5">
                  <select
                    value={newProjectId}
                    onChange={(event) => setNewProjectId(event.target.value)}
                    className="rounded-md border border-ink-300 px-2 py-1.5 text-xs"
                  >
                    <option value="">Pick the project…</option>
                    {projects.map((row) => (
                      <option key={row.id} value={row.id}>
                        {row.bid_id} · {row.name}
                      </option>
                    ))}
                  </select>
                  <button
                    disabled={busy || newProjectId === ''}
                    onClick={() => void linkProject(newProjectId)}
                    className="rounded-md bg-ink-900 px-2.5 py-1.5 text-xs font-medium text-white disabled:opacity-40"
                  >
                    Link
                  </button>
                  <Link
                    to="/"
                    className="rounded-md border border-ink-300 px-2.5 py-1.5 text-xs font-medium text-ink-700"
                  >
                    or start a new one →
                  </Link>
                </div>
              </div>
            )}
          </div>
        </section>
      )}

      {/* 3 ─ the change orders */}
      {selected && (
        <section className="space-y-2.5 rounded-xl border border-ink-200 bg-white px-4 py-3.5">
          {stepHead(3, 'The change-order log', 'the spreadsheet, however it is laid out')}

          <div className="flex flex-wrap items-center gap-2 pl-8">
            <input
              ref={fileInput}
              type="file"
              accept=".xlsx,.xls,.csv"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void importLog(file);
              }}
              className="text-xs file:mr-2 file:rounded-md file:border file:border-ink-300 file:bg-white file:px-2.5 file:py-1.5 file:text-xs file:font-medium file:text-ink-700"
            />
            {(totals?.changeOrders ?? 0) > 0 && (
              <span className="text-xs text-ink-500">
                {totals?.changeOrders} imported · {money(totals?.value ?? 0)}
              </span>
            )}
            <button
              disabled={busy || (totals?.changeOrders ?? 0) === 0}
              onClick={() => void runMatch()}
              className="rounded-md bg-ink-900 px-2.5 py-1.5 text-xs font-medium text-white disabled:opacity-40"
              title="Matches each change order to the scope item it landed on"
            >
              {busy ? '…' : 'Match to scope'}
            </button>
            <span className="text-[11px] text-ink-400">
              Columns are matched by meaning, so any layout works.
            </span>
          </div>

          {runId && (
            <div className="pl-8">
              <ActivityStream runId={runId} />
            </div>
          )}
        </section>
      )}

      {/* 4 ─ the answer */}
      {report && totals && (
        <>
          <div className="grid gap-3 lg:grid-cols-2">
            {/* What the scope of work includes */}
            <section className="rounded-xl border border-ink-200 bg-white px-4 py-3.5">
              <div className="flex items-baseline justify-between gap-2">
                <h2 className="text-[13px] font-semibold text-ink-900">
                  What the scope of work includes
                </h2>
                <span className="text-xs tabular-nums text-ink-400">
                  {report.scope.total} item{report.scope.total === 1 ? '' : 's'}
                </span>
              </div>

              {report.scope.total === 0 ? (
                <p className="mt-1.5 text-xs text-ink-400">
                  Nothing yet. Link the project holding this job&apos;s bid set and draft its scope —
                  without a baseline there is nothing to have missed.
                </p>
              ) : (
                <ul className="mt-2 space-y-0.5">
                  {report.scope.byDivision.map((row) => (
                    <li
                      key={row.division}
                      className="flex items-baseline gap-2 border-b border-ink-50 py-1 text-xs last:border-0"
                    >
                      <span className="w-7 shrink-0 font-mono text-ink-400">{row.division}</span>
                      <span className="flex-1 tabular-nums text-ink-700">
                        {row.items} item{row.items === 1 ? '' : 's'}
                      </span>
                      {row.gaps > 0 && (
                        <span className="rounded bg-flag-100 px-1.5 py-0.5 text-[10px] font-medium text-flag-700">
                          {row.gaps} uncovered
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </section>

            {/* What the bidders missed */}
            <section className="rounded-xl border border-ink-200 bg-white px-4 py-3.5">
              <div className="flex items-baseline justify-between gap-2">
                <h2 className="text-[13px] font-semibold text-ink-900">What the bidders missed</h2>
                <span className="text-xs tabular-nums text-ink-400">
                  {report.missedScope.length}
                </span>
              </div>

              {report.missedScope.length === 0 ? (
                <p className="mt-1.5 text-xs text-ink-400">
                  No gaps detected on the reconstructed job. Either every bidder covered everything,
                  or the bids have not been read yet.
                </p>
              ) : (
                <ul className="mt-2 max-h-72 space-y-0.5 overflow-y-auto">
                  {report.missedScope.map((gap) => (
                    <li
                      key={gap.id}
                      className="flex items-baseline gap-2 border-b border-ink-50 py-1 text-xs last:border-0"
                    >
                      <span className="w-7 shrink-0 font-mono text-ink-400">
                        {gap.division ?? '—'}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-ink-800">
                        {gap.title ?? gap.gapType ?? 'Uncovered scope'}
                      </span>
                      {gap.becameChangeOrder && (
                        <span className="shrink-0 rounded bg-red-100 px-1.5 py-0.5 text-[10px] font-medium text-red-800">
                          became a CO
                        </span>
                      )}
                      {gap.severity && (
                        <span
                          className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium ${
                            SEVERITY[gap.severity] ?? 'bg-ink-100 text-ink-600'
                          }`}
                        >
                          {gap.severity.toLowerCase()}
                        </span>
                      )}
                      <span className="w-16 shrink-0 text-right tabular-nums text-ink-500">
                        {gap.exposure === null ? '' : money(gap.exposure)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>

          {/* The headline */}
          <div className="rounded-xl border border-ink-200 bg-white px-4 py-3.5">
            {totals.catchRate === null ? (
              <p className="text-xs text-ink-500">
                <b className="text-ink-900">No catch rate yet.</b> It is withheld until five change
                orders have been reviewed as scope gaps — {totals.preventable} so far. A hit rate
                over three is not a hit rate, and quoting one is the fastest way to lose the room.
              </p>
            ) : (
              <p className="text-sm text-ink-900">
                <b className="text-2xl tabular-nums">{totals.catchRate}%</b> of the scope gaps on
                this job would have been flagged at precon — {totals.predicted} of{' '}
                {totals.preventable}, worth {money(totals.predictedValue)}.
              </p>
            )}
            <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-xs text-ink-500">
              <span>
                {totals.changeOrders} change orders <b className="text-ink-900">{money(totals.value)}</b>
              </span>
              <span>
                scope gaps <b className="text-ink-900">{totals.preventable}</b>{' '}
                {money(totals.preventableValue)}
              </span>
              <span className="text-emerald-700">
                flagged <b>{totals.predicted}</b> {money(totals.predictedValue)}
              </span>
              <span className="text-red-700">
                missed <b>{totals.missed}</b> {money(totals.missedValue)}
              </span>
              {totals.unreviewed > 0 && (
                <span className="text-flag-700">
                  {totals.unreviewed} not reviewed — nothing counts until somebody has looked
                </span>
              )}
            </div>
          </div>

          {/* Change order by change order */}
          <div className="overflow-hidden rounded-xl border border-ink-200 bg-white">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-ink-200 text-left text-xs uppercase tracking-wide text-ink-500">
                  <th className="px-3 py-2 font-medium">CO</th>
                  <th className="px-3 py-2 text-right font-medium">Amount</th>
                  <th className="px-3 py-2 font-medium">What happened</th>
                  <th className="px-3 py-2 font-medium">Verdict</th>
                </tr>
              </thead>
              <tbody>
                {report.changeOrders.map((co) => (
                  <tr key={co.id} className="border-b border-ink-100 align-top last:border-0">
                    <td className="px-3 py-2 font-mono text-[11px] text-ink-500">
                      {co.co_number ?? '—'}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-ink-700">
                      {money(co.amount)}
                    </td>
                    <td className="px-3 py-2">
                      <p className="text-xs text-ink-800">{co.description ?? '—'}</p>
                      {co.stated_reason && (
                        <p className="text-[11px] text-ink-400">reason given: {co.stated_reason}</p>
                      )}
                      {co.scope && (
                        <p className="text-[11px] text-ink-500">
                          landed on {co.scope.scope_id} · {co.scope.title}
                        </p>
                      )}
                      {co.hindsight_note && (
                        <p className="mt-0.5 text-[11px] text-ink-500">&ldquo;{co.hindsight_note}&rdquo;</p>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      {open === co.id ? (
                        <div className="space-y-1.5">
                          <input
                            autoFocus
                            value={note}
                            onChange={(event) => setNote(event.target.value)}
                            placeholder="Why — this is what gets quoted"
                            className="w-full rounded border border-ink-300 px-2 py-1 text-[11px] outline-none focus:border-ink-800"
                          />
                          <div className="flex flex-wrap gap-1">
                            {VERDICTS.map((option) => (
                              <button
                                key={option.value}
                                disabled={busy}
                                onClick={() => void verdict(co, option.value)}
                                title={option.hint}
                                className="rounded border border-ink-300 px-1.5 py-0.5 text-[11px] text-ink-700 disabled:opacity-40"
                              >
                                {option.label}
                              </button>
                            ))}
                            <button
                              onClick={() => setOpen(null)}
                              className="px-1 text-[11px] text-ink-400"
                            >
                              cancel
                            </button>
                          </div>
                          {!co.matched_gap_id && (
                            <p className="text-[10px] text-ink-400">
                              &ldquo;We flagged it&rdquo; needs the gap that flagged it. Run the
                              match above first.
                            </p>
                          )}
                        </div>
                      ) : (
                        <button
                          onClick={() => {
                            setOpen(co.id);
                            setNote(co.hindsight_note ?? '');
                          }}
                          className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${
                            co.hindsight === 'PREDICTED'
                              ? 'bg-emerald-100 text-emerald-800'
                              : co.hindsight === 'MISSED'
                                ? 'bg-red-100 text-red-800'
                                : co.hindsight === 'NOT_PREVENTABLE'
                                  ? 'bg-ink-100 text-ink-600'
                                  : 'bg-flag-100 text-flag-700'
                          }`}
                        >
                          {co.hindsight === 'UNREVIEWED'
                            ? 'review'
                            : (VERDICTS.find((v) => v.value === co.hindsight)?.label ??
                              co.hindsight)}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
                {report.changeOrders.length === 0 && (
                  <tr>
                    <td colSpan={4} className="px-4 py-6 text-sm text-ink-400">
                      No change orders yet. Drop the log in step 3.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          <div className="flex items-center justify-between">
            <p className="text-[11px] text-ink-400">
              Every verdict here was made by a person. The agent only proposes which scope item a
              change order landed on.
            </p>
            <a
              href={`/api/past-projects/${selected}/hindsight.xlsx`}
              className="rounded-md border border-ink-300 px-3 py-1.5 text-xs font-medium text-ink-700"
            >
              Export
            </a>
          </div>
        </>
      )}
    </Layout>
  );
}

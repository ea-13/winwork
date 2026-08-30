import { useCallback, useEffect, useState } from 'react';
import { ErrorBanner, Layout, money } from '../components/Layout';
import { apiGet, apiPost } from '../lib/api';

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

type Report = {
  pastProject: { id: string; name: string; gc_name: string | null; project_id: string | null };
  detectedGaps: number;
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

type PastProject = { id: string; name: string; gc_name: string | null };

const VERDICTS = [
  { value: 'PREDICTED', label: 'We flagged it', hint: 'A gap was raised on the scope this hit' },
  { value: 'MISSED', label: 'We missed it', hint: 'It was a scope gap and nothing warned' },
  { value: 'NOT_PREVENTABLE', label: 'Not ours', hint: 'Owner-directed, unforeseen, design error' },
] as const;

/**
 * P14 · Hindsight.
 *
 * Not a change-order tracker. A backtest: take a job that is finished, load its
 * bid set as if it were precon, run gap detection, then put the real change-order
 * list next to what was flagged.
 *
 * "Of your 31 change orders, 19 were scope gaps, and we would have flagged 14 of
 * them worth $340k before you bought the job" is a different conversation from
 * "here is a tool".
 *
 * Every verdict is a person's. A model can suggest which scope item a change
 * order landed on, but the claim "we would have caught this" gets made in a room
 * to somebody who ran that job, and a claim resting on a model's guess does not
 * survive the first question.
 */
export function HindsightPage() {
  const [projects, setProjects] = useState<PastProject[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [note, setNote] = useState('');

  const loadProjects = useCallback(async () => {
    try {
      setProjects(await apiGet<PastProject[]>('/past-projects'));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }, []);

  const loadReport = useCallback(async () => {
    if (!selected) return;
    try {
      setReport(await apiGet<Report>(`/past-projects/${selected}/hindsight`));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }, [selected]);

  useEffect(() => {
    void loadProjects();
  }, [loadProjects]);

  useEffect(() => {
    void loadReport();
  }, [loadReport]);

  const verdict = async (co: ChangeOrder, value: string) => {
    setBusy(true);
    setError(null);
    try {
      await apiPost(`/change-orders/${co.id}/hindsight`, {
        hindsight: value,
        note: note.trim() || undefined,
        matchedGapId: co.matched_gap_id ?? undefined,
      });
      setOpen(null);
      setNote('');
      await loadReport();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  const totals = report?.totals;

  return (
    <Layout breadcrumb={<span>Hindsight</span>}>
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-ink-900">Hindsight</h1>
          <p className="max-w-2xl text-xs text-ink-400">
            Take a finished job, load its bid set as if it were precon, and put the real change
            orders next to the gaps that were flagged. This is where the claim gets tested.
          </p>
        </div>
        <select
          value={selected ?? ''}
          onChange={(event) => setSelected(event.target.value || null)}
          className="rounded-md border border-ink-300 px-2 py-1.5 text-xs"
        >
          <option value="">Pick a past job…</option>
          {projects.map((project) => (
            <option key={project.id} value={project.id}>
              {project.name}
              {project.gc_name ? ` · ${project.gc_name}` : ''}
            </option>
          ))}
        </select>
      </div>

      <ErrorBanner message={error} />

      {!selected && (
        <div className="rounded-xl border border-ink-200 bg-white px-4 py-8 text-center">
          <p className="text-sm text-ink-500">Pick a past job, or add one on the Archaeology page.</p>
          <p className="mx-auto mt-1 max-w-lg text-xs text-ink-400">
            You need its change-order list and, ideally, the project reconstructed here so gap
            detection has something to have flagged.
          </p>
        </div>
      )}

      {report && totals && (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {[
              { label: 'Change orders', value: String(totals.changeOrders), sub: money(totals.value) },
              {
                label: 'Scope gaps',
                value: String(totals.preventable),
                sub: `${money(totals.preventableValue)} preventable`,
              },
              {
                label: 'We flagged',
                value: String(totals.predicted),
                sub: money(totals.predictedValue),
                good: true,
              },
              {
                label: 'We missed',
                value: String(totals.missed),
                sub: money(totals.missedValue),
                bad: true,
              },
            ].map((tile) => (
              <div key={tile.label} className="rounded-xl border border-ink-200 bg-white px-4 py-3">
                <p className="text-[10px] uppercase tracking-wide text-ink-400">{tile.label}</p>
                <p
                  className={`text-2xl font-semibold tabular-nums ${
                    tile.good ? 'text-emerald-700' : tile.bad ? 'text-red-700' : 'text-ink-900'
                  }`}
                >
                  {tile.value}
                </p>
                <p className="text-[11px] text-ink-400">{tile.sub}</p>
              </div>
            ))}
          </div>

          <div className="rounded-xl border border-ink-200 bg-white px-4 py-3">
            {totals.catchRate === null ? (
              <p className="text-xs text-ink-500">
                <b>No catch rate yet.</b> It is withheld until five change orders have been
                reviewed as scope gaps — {totals.preventable} so far. A hit rate over three is not a
                hit rate, and quoting one is the fastest way to lose the room.
              </p>
            ) : (
              <p className="text-sm text-ink-900">
                <b className="text-2xl tabular-nums">{totals.catchRate}%</b> of the scope gaps on
                this job would have been flagged at precon — {totals.predicted} of{' '}
                {totals.preventable}, worth {money(totals.predictedValue)}.
              </p>
            )}
            {totals.unreviewed > 0 && (
              <p className="mt-1 text-[11px] text-flag-700">
                {totals.unreviewed} change order{totals.unreviewed === 1 ? '' : 's'} not reviewed
                yet. Nothing counts until somebody has looked at it.
              </p>
            )}
          </div>

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
                  <tr key={co.id} className="border-b border-ink-100 last:border-0 align-top">
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
                        <p className="mt-0.5 text-[11px] text-ink-500">“{co.hindsight_note}”</p>
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
                              “We flagged it” needs the gap that flagged it. Link it from the
                              project first.
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
                            : (VERDICTS.find((v) => v.value === co.hindsight)?.label ?? co.hindsight)}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
                {report.changeOrders.length === 0 && (
                  <tr>
                    <td colSpan={4} className="px-4 py-6 text-sm text-ink-400">
                      No change orders imported for this job yet. Import the list on the
                      Archaeology page.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          <div className="flex items-center justify-between">
            <p className="text-[11px] text-ink-400">
              {report.detectedGaps} gap{report.detectedGaps === 1 ? '' : 's'} were detected on the
              reconstructed project. Every verdict here was made by a person.
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

import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { apiGet, apiPost } from '../lib/api';
import { money } from './Layout';

type Row = {
  packageId: string;
  division: string | null;
  name: string;
  bidderCount: number;
  bidder: string | null;
  selected: boolean;
  adjustedTotal: number | null;
  budget: number | null;
  committed: number | null;
  variance: number | null;
  openGaps: number;
  criticalGaps: number;
};

/**
 * Bids and levelling across every package, at project level.
 *
 * These two steps used to require a package to be chosen first, and clicking
 * them without one bounced you back to the scope screen. That was wrong twice
 * over: it blocked a step for no reason, and it hid the only view that answers
 * "where is this whole job up to" — which is the question somebody actually has
 * when they open the app on a Tuesday morning.
 *
 * So the project level is the summary and the package level is the detail. You
 * click a division to go in, exactly as you would open a tab in a workbook.
 */
export function PackageOverview({
  projectId,
  mode,
  onError,
}: {
  projectId: string;
  mode: 'bids' | 'leveling';
  onError: (message: string | null) => void;
}) {
  const [rows, setRows] = useState<Row[]>([]);
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();

  const load = useCallback(async () => {
    const data = await apiGet<{ rows: Row[] }>(`/projects/${projectId}/buyout`);
    setRows(data.rows);
  }, [projectId]);

  useEffect(() => {
    load().catch((caught: Error) => onError(caught.message));
  }, [load, onError]);

  const levelAll = () =>
    void (async () => {
      setBusy(true);
      onError(null);
      try {
        // Every package with a bid on it. Cheap and deterministic — no model is
        // involved in the arithmetic, so there is no reason to make somebody do
        // this one package at a time.
        await Promise.all(
          rows
            .filter((row) => row.bidderCount > 0)
            .map((row) => apiPost(`/packages/${row.packageId}/level`)),
        );
        await load();
      } catch (caught) {
        onError(caught instanceof Error ? caught.message : String(caught));
      } finally {
        setBusy(false);
      }
    })();

  const withBids = rows.filter((row) => row.bidderCount > 0).length;

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-[13px] font-semibold text-ink-900">
            {mode === 'bids' ? 'Bids by package' : 'Levelling by package'}
          </h2>
          <p className="text-xs text-ink-400">
            {withBids} of {rows.length} package{rows.length === 1 ? '' : 's'} has a bid. Click a
            division to open it.
          </p>
        </div>
        {mode === 'leveling' && withBids > 0 && (
          <button
            onClick={levelAll}
            disabled={busy}
            className="rounded-md border border-ink-300 px-3 py-1.5 text-xs font-medium text-ink-700 disabled:opacity-50"
          >
            {busy ? 'Computing…' : 'Level everything'}
          </button>
        )}
      </div>

      <div className="overflow-x-auto rounded-xl border border-ink-200 bg-white">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-ink-200 text-left text-xs uppercase tracking-wide text-ink-500">
              <th className="px-3 py-2 font-medium">Package</th>
              <th className="px-3 py-2 text-center font-medium">Bids</th>
              <th className="px-3 py-2 font-medium">Leading</th>
              <th className="px-3 py-2 text-right font-medium">Adjusted</th>
              {mode === 'leveling' && (
                <>
                  <th className="px-3 py-2 text-right font-medium">Budget</th>
                  <th className="px-3 py-2 text-right font-medium">Variance</th>
                </>
              )}
              <th className="px-3 py-2 text-center font-medium">Gaps</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr
                key={row.packageId}
                onClick={() => navigate(`/packages/${row.packageId}?step=${mode}`)}
                className="cursor-pointer border-b border-ink-100 last:border-0 hover:bg-ink-50"
              >
                <td className="px-3 py-2">
                  <span className="font-mono text-[11px] text-ink-400">{row.division ?? '—'}</span>{' '}
                  <span className="font-medium text-ink-900">{row.name}</span>
                </td>
                <td className="px-3 py-2 text-center">
                  {row.bidderCount === 0 ? (
                    <span className="text-xs text-ink-300">none</span>
                  ) : (
                    <span className="rounded bg-ink-100 px-1.5 py-0.5 text-xs text-ink-700">
                      {row.bidderCount}
                    </span>
                  )}
                </td>
                <td className="px-3 py-2 text-ink-600">
                  {row.bidder ?? <span className="text-ink-300">—</span>}
                  {row.bidder && !row.selected && (
                    <span className="ml-1 text-[11px] text-ink-400">(leading)</span>
                  )}
                  {row.selected && (
                    <span className="ml-1.5 rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-medium text-emerald-800">
                      selected
                    </span>
                  )}
                </td>
                <td className="px-3 py-2 text-right text-ink-700">{money(row.adjustedTotal)}</td>

                {mode === 'leveling' && (
                  <>
                    <td className="px-3 py-2 text-right text-ink-600">{money(row.budget)}</td>
                    <td
                      className={`px-3 py-2 text-right font-medium ${
                        row.variance === null
                          ? 'text-ink-300'
                          : row.variance > 0
                            ? 'text-red-700'
                            : 'text-emerald-700'
                      }`}
                    >
                      {row.variance === null
                        ? '—'
                        : `${row.variance > 0 ? '+' : ''}${money(row.variance)}`}
                    </td>
                  </>
                )}

                <td className="px-3 py-2 text-center">
                  {row.openGaps > 0 ? (
                    <span
                      className={`rounded px-1.5 py-0.5 text-xs font-medium ${
                        row.criticalGaps > 0
                          ? 'bg-red-100 text-red-800'
                          : 'bg-flag-100 text-flag-700'
                      }`}
                    >
                      {row.openGaps}
                    </span>
                  ) : (
                    <span className="text-xs text-ink-300">—</span>
                  )}
                </td>
                <td className="px-3 py-2 text-right text-xs text-ink-300">open ›</td>
              </tr>
            ))}

            {rows.length === 0 && (
              <tr>
                <td colSpan={mode === 'leveling' ? 8 : 6} className="px-4 py-6 text-sm text-ink-400">
                  No packages yet. Put some scope into a package on the Scope step.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

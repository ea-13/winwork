import { useCallback, useEffect, useState } from 'react';
import { apiGet, apiPost } from '../lib/api';
import { money } from './Layout';

type Row = {
  quote_id: string;
  bidder: string;
  quoted_total: number | null;
  addback_total: number | null;
  risk_allowance: number | null;
  adjusted_total: number | null;
  advisory_rank: number;
};

/**
 * P11 · The adjusted comparison — the flip.
 *
 * Both rankings are shown side by side on purpose. The argument is not "here is
 * a number"; it is "the order you would have awarded in is not the right order",
 * and that only lands if the old order is visible next to the new one.
 */
export function LevelingMatrix({
  packageId,
  onError,
}: {
  packageId: string;
  onError: (message: string | null) => void;
}) {
  const [rows, setRows] = useState<Row[]>([]);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setRows(await apiGet<Row[]>(`/packages/${packageId}/leveling`));
  }, [packageId]);

  useEffect(() => {
    load().catch((caught: Error) => onError(caught.message));
  }, [load, onError]);

  async function recompute() {
    setBusy(true);
    onError(null);
    try {
      await apiPost(`/packages/${packageId}/level`);
      await load();
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  // What the spreadsheet would have said, before anything was costed back in.
  const quotedOrder = [...rows]
    .filter((row) => row.quoted_total !== null)
    .sort((a, b) => Number(a.quoted_total) - Number(b.quoted_total))
    .map((row) => row.quote_id);

  const flipped = rows.some(
    (row) => row.advisory_rank > 0 && quotedOrder.indexOf(row.quote_id) + 1 !== row.advisory_rank,
  );

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-medium text-slate-900">Adjusted comparison</h2>
          <p className="text-xs text-slate-500">
            Ranked on adjusted total, never on quoted.
          </p>
        </div>
        <button
          onClick={() => void recompute()}
          disabled={busy}
          className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 disabled:opacity-50"
        >
          {busy ? 'Computing…' : 'Recompute'}
        </button>
      </div>

      {flipped && (
        <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          The ranking changed once exclusions were costed back in. The apparent low bidder is not
          the low bidder.
        </p>
      )}

      <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
              <th className="px-4 py-2 font-medium">Bidder</th>
              <th className="px-4 py-2 text-right font-medium">Quoted</th>
              <th className="px-4 py-2 text-center font-medium">Was</th>
              <th className="px-4 py-2 text-right font-medium">Add-backs</th>
              <th className="px-4 py-2 text-right font-medium">Risk</th>
              <th className="px-4 py-2 text-right font-medium">Adjusted</th>
              <th className="px-4 py-2 text-center font-medium">Rank</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const wasRank = quotedOrder.indexOf(row.quote_id) + 1;
              const moved = wasRank > 0 && row.advisory_rank > 0 && wasRank !== row.advisory_rank;
              return (
                <tr key={row.quote_id} className="border-b border-slate-100 last:border-0">
                  <td className="px-4 py-2 font-medium text-slate-900">{row.bidder}</td>
                  <td className="px-4 py-2 text-right text-slate-600">{money(row.quoted_total)}</td>
                  <td className="px-4 py-2 text-center text-xs text-slate-400">
                    {wasRank > 0 ? `#${wasRank}` : '—'}
                  </td>
                  <td className="px-4 py-2 text-right text-amber-700">
                    {row.addback_total ? `+${money(row.addback_total)}` : '—'}
                  </td>
                  <td className="px-4 py-2 text-right text-slate-500">
                    {row.risk_allowance ? `+${money(row.risk_allowance)}` : '—'}
                  </td>
                  <td className="px-4 py-2 text-right font-semibold text-slate-900">
                    {row.adjusted_total === null ? 'no total stated' : money(row.adjusted_total)}
                  </td>
                  <td className="px-4 py-2 text-center">
                    {row.advisory_rank > 0 ? (
                      <span
                        className={`inline-block rounded px-1.5 py-0.5 text-xs font-medium ${
                          moved ? 'bg-amber-100 text-amber-800' : 'bg-slate-100 text-slate-600'
                        }`}
                      >
                        #{row.advisory_rank}
                        {moved && wasRank < row.advisory_rank && ' ▼'}
                        {moved && wasRank > row.advisory_rank && ' ▲'}
                      </span>
                    ) : (
                      <span className="text-xs text-slate-400">unranked</span>
                    )}
                  </td>
                </tr>
              );
            })}
            {rows.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-6 text-sm text-slate-400">
                  Nothing levelled yet. Extract and promote at least one quote, then recompute.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <p className="text-xs text-slate-400">
        Advisory only. Selection is a human act at H6 and requires a written rationale.
      </p>
    </section>
  );
}

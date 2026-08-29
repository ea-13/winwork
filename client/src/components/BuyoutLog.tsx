import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { apiGet, apiPatch } from '../lib/api';
import { money } from './Layout';

type Row = {
  packageId: string;
  division: string | null;
  name: string;
  status: string;
  budget: number | null;
  allowance: number | null;
  contingency: number | null;
  bidder: string | null;
  selected: boolean;
  quotedTotal: number | null;
  addbackTotal: number | null;
  adjustedTotal: number | null;
  variance: number | null;
  bidderCount: number;
  openGaps: number;
  criticalGaps: number;
  openExposure: number | null;
};

type Totals = {
  budget: number;
  allowance: number;
  contingency: number;
  adjusted: number;
  variance: number;
  openExposure: number;
  criticalGaps: number;
};

/**
 * P27 · The buyout log.
 *
 * Variance is measured against the ADJUSTED value. A package bought at $503k
 * carrying $81k of uncosted exclusions has not come in under budget, and a
 * buyout log that says otherwise is the spreadsheet this product replaces.
 *
 * Budget, allowance and contingency are editable in place: they are the
 * estimator's own numbers, not anything an agent produced.
 */
export function BuyoutLog({
  projectId,
  onError,
}: {
  projectId: string;
  onError: (message: string | null) => void;
}) {
  const [rows, setRows] = useState<Row[]>([]);
  const [totals, setTotals] = useState<Totals | null>(null);
  const [editing, setEditing] = useState<{ id: string; field: string; value: string } | null>(null);

  const load = useCallback(async () => {
    const data = await apiGet<{ rows: Row[]; totals: Totals | null }>(
      `/projects/${projectId}/buyout`,
    );
    setRows(data.rows);
    setTotals(data.totals);
  }, [projectId]);

  useEffect(() => {
    load().catch((caught: Error) => onError(caught.message));
  }, [load, onError]);

  async function save() {
    if (!editing) return;
    const parsed = editing.value.trim() === '' ? null : Number(editing.value.replace(/[$,\s]/g, ''));
    setEditing(null);
    try {
      await apiPatch(`/records/work_package/${editing.id}`, { [editing.field]: parsed });
      await load();
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  const cell = (row: Row, field: 'budget_amount' | 'allowance_amount' | 'contingency_amount', value: number | null) => {
    const active = editing?.id === row.packageId && editing.field === field;
    return (
      <td
        className="cursor-text px-3 py-2 text-right text-slate-700"
        onClick={() =>
          setEditing({ id: row.packageId, field, value: value === null ? '' : String(value) })
        }
      >
        {active ? (
          <input
            autoFocus
            value={editing.value}
            onChange={(event) => setEditing({ ...editing, value: event.target.value })}
            onBlur={() => void save()}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void save();
              if (event.key === 'Escape') setEditing(null);
            }}
            className="w-24 rounded border border-slate-900 px-1 text-right outline-none"
          />
        ) : (
          money(value)
        )}
      </td>
    );
  };

  return (
    <section className="space-y-3">
      <div>
        <h2 className="text-sm font-medium text-slate-900">Buyout log</h2>
        <p className="text-xs text-slate-500">
          Variance is measured on the adjusted value, with exclusions costed back in. Click a
          budget, allowance or contingency to edit it.
        </p>
      </div>

      <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
              <th className="px-3 py-2 font-medium">Div</th>
              <th className="px-3 py-2 font-medium">Package</th>
              <th className="px-3 py-2 font-medium">Bidder</th>
              <th className="px-3 py-2 text-right font-medium">Budget</th>
              <th className="px-3 py-2 text-right font-medium">Allowance</th>
              <th className="px-3 py-2 text-right font-medium">Contingency</th>
              <th className="px-3 py-2 text-right font-medium">Adjusted</th>
              <th className="px-3 py-2 text-right font-medium">Variance</th>
              <th className="px-3 py-2 text-center font-medium">Gaps</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.packageId} className="border-b border-slate-100 last:border-0">
                <td className="px-3 py-2 font-mono text-xs text-slate-500">{row.division ?? '—'}</td>
                <td className="px-3 py-2">
                  <Link to={`/packages/${row.packageId}`} className="font-medium text-slate-900 underline">
                    {row.name}
                  </Link>
                  <div className="text-xs text-slate-400">
                    {row.bidderCount} bid{row.bidderCount === 1 ? '' : 's'}
                  </div>
                </td>
                <td className="px-3 py-2 text-slate-600">
                  {row.bidder ?? <span className="text-slate-400">—</span>}
                  {row.bidder && !row.selected && (
                    <span className="ml-1 text-xs text-slate-400">(leading)</span>
                  )}
                </td>
                {cell(row, 'budget_amount', row.budget)}
                {cell(row, 'allowance_amount', row.allowance)}
                {cell(row, 'contingency_amount', row.contingency)}
                <td className="px-3 py-2 text-right font-semibold text-slate-900">
                  {money(row.adjustedTotal)}
                </td>
                <td
                  className={`px-3 py-2 text-right font-medium ${
                    row.variance === null
                      ? 'text-slate-400'
                      : row.variance > 0
                        ? 'text-red-700'
                        : 'text-emerald-700'
                  }`}
                >
                  {row.variance === null
                    ? '—'
                    : `${row.variance > 0 ? '+' : ''}${money(row.variance)}`}
                </td>
                <td className="px-3 py-2 text-center">
                  {row.openGaps > 0 ? (
                    <span
                      className={`rounded px-1.5 py-0.5 text-xs font-medium ${
                        row.criticalGaps > 0
                          ? 'bg-red-100 text-red-800'
                          : 'bg-slate-100 text-slate-600'
                      }`}
                    >
                      {row.openGaps}
                      {row.criticalGaps > 0 && ` · ${row.criticalGaps} critical`}
                    </span>
                  ) : (
                    <span className="text-xs text-slate-300">—</span>
                  )}
                </td>
              </tr>
            ))}

            {rows.length === 0 && (
              <tr>
                <td colSpan={9} className="px-4 py-6 text-sm text-slate-400">
                  No packages yet. Add one per division on the Packages tab.
                </td>
              </tr>
            )}
          </tbody>

          {totals && rows.length > 0 && (
            <tfoot>
              <tr className="border-t-2 border-slate-300 bg-slate-50 font-medium">
                <td className="px-3 py-2" colSpan={3}>
                  Project total
                </td>
                <td className="px-3 py-2 text-right">{money(totals.budget)}</td>
                <td className="px-3 py-2 text-right">{money(totals.allowance)}</td>
                <td className="px-3 py-2 text-right">{money(totals.contingency)}</td>
                <td className="px-3 py-2 text-right">{money(totals.adjusted)}</td>
                <td
                  className={`px-3 py-2 text-right ${
                    totals.variance > 0 ? 'text-red-700' : 'text-emerald-700'
                  }`}
                >
                  {totals.variance > 0 ? '+' : ''}
                  {money(totals.variance)}
                </td>
                <td className="px-3 py-2 text-center text-xs">
                  {totals.openExposure ? money(totals.openExposure) : '—'}
                </td>
              </tr>
            </tfoot>
          )}
        </table>
      </div>

      <p className="text-xs text-slate-400">
        A leading bidder is advisory. Nothing is awarded until an estimator selects at H6 with a
        written rationale — and this system has no way to tell anyone they won.
      </p>
    </section>
  );
}

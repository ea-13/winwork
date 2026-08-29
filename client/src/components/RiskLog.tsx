import { useCallback, useEffect, useState } from 'react';
import { apiGet } from '../lib/api';
import { money } from './Layout';

type Gap = {
  id: string;
  gap_type: string;
  severity: string;
  exposure_amount: number | null;
  exposure_basis: string | null;
  confidence: number | null;
  detected_by_rule: string | null;
  affected_quote_ids: string[] | null;
  scope: { scope_id: string; csi_section: string; title: string } | null;
};

const SEVERITY: Record<string, string> = {
  CRITICAL: 'bg-red-100 text-red-800',
  HIGH: 'bg-orange-100 text-orange-800',
  MEDIUM: 'bg-amber-100 text-amber-800',
  LOW: 'bg-slate-100 text-slate-600',
};

const TYPE_HELP: Record<string, string> = {
  UNCOVERED: 'In the scope, priced by nobody. This silently becomes your cost.',
  PARTIAL: 'Priced by some bidders, excluded by others.',
  UNPRICEABLE: 'Excluded, with no comparable bid to cost it from.',
  AMBIGUOUS: 'A line might map here. A human needs to decide.',
};

/** P12 · The risk log. The output a prospect asks for a copy of. */
export function RiskLog({
  packageId,
  projectId,
  onError,
}: {
  packageId: string;
  projectId: string | null;
  onError: (message: string | null) => void;
}) {
  const [gaps, setGaps] = useState<Gap[]>([]);
  const [filter, setFilter] = useState<string>('ALL');

  const load = useCallback(async () => {
    setGaps(await apiGet<Gap[]>(`/packages/${packageId}/gaps`));
  }, [packageId]);

  useEffect(() => {
    load().catch((caught: Error) => onError(caught.message));
  }, [load, onError]);

  const shown = filter === 'ALL' ? gaps : gaps.filter((gap) => gap.gap_type === filter);
  const quantified = gaps.filter((gap) => typeof gap.exposure_amount === 'number');
  const exposure = quantified.reduce((sum, gap) => sum + Number(gap.exposure_amount), 0);
  const critical = gaps.filter((gap) => gap.severity === 'CRITICAL').length;

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-medium text-slate-900">Scope gaps</h2>
          <p className="text-xs text-slate-500">
            {gaps.length} gap{gaps.length === 1 ? '' : 's'} · {money(exposure)} quantified exposure ·{' '}
            {critical} critical
            {gaps.length > quantified.length && (
              <> · {gaps.length - quantified.length} with no comparable, shown as TBC</>
            )}
          </p>
        </div>

        {projectId && (
          <a
            href={`/api/projects/${projectId}/risk-log.xlsx`}
            className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700"
          >
            Export risk log
          </a>
        )}
      </div>

      <div className="flex flex-wrap gap-1.5">
        {['ALL', 'UNCOVERED', 'PARTIAL', 'UNPRICEABLE', 'AMBIGUOUS'].map((option) => (
          <button
            key={option}
            onClick={() => setFilter(option)}
            title={TYPE_HELP[option]}
            className={`rounded-md border px-2.5 py-1 text-xs ${
              filter === option
                ? 'border-slate-900 bg-slate-900 text-white'
                : 'border-slate-300 text-slate-600'
            }`}
          >
            {option.toLowerCase()}
            {option !== 'ALL' && (
              <span className="ml-1 opacity-60">
                {gaps.filter((gap) => gap.gap_type === option).length}
              </span>
            )}
          </button>
        ))}
      </div>

      <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
              <th className="px-4 py-2 font-medium">Severity</th>
              <th className="px-4 py-2 font-medium">Type</th>
              <th className="px-4 py-2 font-medium">Scope item</th>
              <th className="px-4 py-2 text-right font-medium">Exposure</th>
              <th className="px-4 py-2 font-medium">Why it was flagged</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((gap) => (
              <tr key={gap.id} className="border-b border-slate-100 last:border-0 align-top">
                <td className="px-4 py-2">
                  <span
                    className={`rounded px-1.5 py-0.5 text-xs font-medium ${
                      SEVERITY[gap.severity] ?? SEVERITY.LOW
                    }`}
                  >
                    {gap.severity}
                  </span>
                </td>
                <td className="px-4 py-2 text-xs text-slate-600" title={TYPE_HELP[gap.gap_type]}>
                  {gap.gap_type}
                </td>
                <td className="px-4 py-2">
                  <div className="font-medium text-slate-900">{gap.scope?.title ?? '—'}</div>
                  <div className="font-mono text-xs text-slate-400">
                    {gap.scope?.csi_section} · {gap.scope?.scope_id}
                  </div>
                </td>
                <td className="px-4 py-2 text-right">
                  {gap.exposure_amount === null ? (
                    <span className="text-xs text-slate-500">TBC</span>
                  ) : (
                    <span className="font-medium text-slate-900">{money(gap.exposure_amount)}</span>
                  )}
                </td>
                <td className="px-4 py-2 text-xs text-slate-500">{gap.detected_by_rule}</td>
              </tr>
            ))}
            {shown.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-6 text-sm text-slate-400">
                  No gaps of this type. Recompute on the leveling tab after promoting quotes.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

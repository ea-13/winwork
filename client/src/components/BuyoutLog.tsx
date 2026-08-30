import { Fragment, useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { apiGet, apiPatch, apiPost } from '../lib/api';
import { money } from './Layout';

type Gap = {
  id: string;
  gapType: string | null;
  severity: string | null;
  exposureAmount: number | null;
  exposureBasis: string | null;
  detectedByRule: string | null;
  affectedCount: number;
  assignedType: string | null;
  assignedAmount: number | null;
  assignedNote: string | null;
  assignedAt: string | null;
  scopeId: string | null;
  scopeTitle: string | null;
  csiSection: string | null;
};

type Row = {
  packageId: string;
  division: string | null;
  divisions: string[];
  name: string;
  status: string;
  notes: string | null;
  budget: number | null;
  allowance: number | null;
  contingency: number | null;
  bidder: string | null;
  selected: boolean;
  quotedTotal: number | null;
  addbackTotal: number | null;
  adjustedTotal: number | null;
  gapAllowance: number | null;
  gapContingency: number | null;
  committed: number | null;
  variance: number | null;
  bidderCount: number;
  gaps: Gap[];
  openGaps: number;
  criticalGaps: number;
  openExposure: number | null;
};

type Totals = {
  budget: number;
  allowance: number;
  contingency: number;
  adjusted: number;
  gapAllowance: number;
  gapContingency: number;
  committed: number;
  variance: number;
  openExposure: number;
  openGaps: number;
  criticalGaps: number;
};

const DISPOSITIONS = [
  { value: 'ALLOWANCE', label: 'Allowance', money: true, hint: 'Carry a priced allowance for it' },
  { value: 'CONTINGENCY', label: 'Contingency', money: true, hint: 'Hold contingency against it' },
  { value: 'ACCEPTED', label: 'Accept', money: false, hint: 'Deliberately carry nothing' },
  { value: 'VOID', label: 'Not a gap', money: false, hint: 'It was never really missing' },
] as const;

const SEVERITY_STYLE: Record<string, string> = {
  CRITICAL: 'bg-red-100 text-red-800',
  HIGH: 'bg-orange-100 text-orange-800',
  MEDIUM: 'bg-flag-100 text-flag-700',
  LOW: 'bg-ink-100 text-ink-600',
};

/**
 * Colour by COVERAGE first, severity second.
 *
 * The question an estimator is scanning for is not "how bad is this" — it is
 * "did anybody price it". UNCOVERED means nobody did, and that becomes the
 * general contractor's cost silently, which is the single most expensive thing
 * on the page. It gets the loudest treatment on the screen and nothing else
 * competes with it.
 *
 * Once a gap has been disposed of it stops shouting. A decision that has been
 * made is not a warning any more, and leaving it red teaches people to ignore
 * red.
 */
function coverageStyle(gap: Gap): string {
  if (gap.assignedType) return 'bg-white';
  switch (gap.gapType) {
    case 'UNCOVERED':
      return 'bg-red-50/70 border-l-2 border-l-red-400';
    case 'PARTIAL':
      return 'bg-flag-50 border-l-2 border-l-flag-500';
    case 'UNPRICEABLE':
      return 'bg-orange-50/60 border-l-2 border-l-orange-300';
    default:
      return 'bg-ink-50 border-l-2 border-l-ink-300';
  }
}

const COVERAGE_LABEL: Record<string, string> = {
  UNCOVERED: 'nobody priced this',
  PARTIAL: 'some bidders excluded it',
  UNPRICEABLE: 'excluded, nothing to cost it from',
  AMBIGUOUS: 'could not be mapped confidently',
};

/** Disposing of one gap: what to do about it, how much, and why. */
function GapRow({
  gap,
  columns,
  onAssign,
}: {
  gap: Gap;
  columns: number;
  onAssign: (
    gapId: string,
    body: { assignedType: string | null; assignedAmount?: number | null; note?: string },
  ) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [type, setType] = useState<string>(gap.assignedType ?? 'ALLOWANCE');
  const [amount, setAmount] = useState(
    gap.assignedAmount === null ? String(gap.exposureAmount ?? '') : String(gap.assignedAmount),
  );
  const [note, setNote] = useState(gap.assignedNote ?? '');
  const [busy, setBusy] = useState(false);

  const chosen = DISPOSITIONS.find((option) => option.value === type);
  const needsAmount = chosen?.money ?? false;

  return (
    <>
      <tr className={`border-t border-ink-100 text-xs ${coverageStyle(gap)}`}>
        <td />
        <td className="py-1.5 pl-8 pr-3">
          <span className="font-mono text-[11px] text-slate-400">{gap.scopeId ?? '—'}</span>
          <span className="ml-2 text-slate-700">{gap.scopeTitle ?? 'Unnamed scope item'}</span>
          <span
            className={`ml-2 rounded px-1.5 py-0.5 text-[10px] font-medium ${
              SEVERITY_STYLE[gap.severity ?? ''] ?? SEVERITY_STYLE.LOW
            }`}
            title={COVERAGE_LABEL[gap.gapType ?? ''] ?? ''}
          >
            {(gap.gapType ?? 'gap').toLowerCase()}
          </span>
          {!gap.assignedType && gap.gapType === 'UNCOVERED' && (
            <span className="ml-1.5 text-[10px] font-medium text-red-700">
              no coverage
            </span>
          )}
        </td>
        <td className="px-3 py-1.5 text-slate-400">
          {gap.affectedCount > 0 ? `${gap.affectedCount} bidder(s) missed it` : ''}
        </td>
        <td className="px-3 py-1.5 text-right text-slate-500" title={gap.exposureBasis ?? ''}>
          {gap.exposureAmount === null ? 'TBC' : money(gap.exposureAmount)}
        </td>
        <td className="px-3 py-1.5 text-right">
          {gap.assignedType === 'ALLOWANCE' ? money(gap.assignedAmount) : ''}
        </td>
        <td className="px-3 py-1.5 text-right">
          {gap.assignedType === 'CONTINGENCY' ? money(gap.assignedAmount) : ''}
        </td>
        <td className="px-3 py-1.5" colSpan={columns}>
          <button
            onClick={() => setOpen((current) => !current)}
            className={`text-xs underline ${
              gap.assignedType ? 'text-slate-600' : 'text-amber-700 font-medium'
            }`}
          >
            {gap.assignedType
              ? `${gap.assignedType.toLowerCase()} — ${gap.assignedNote ?? 'no note'}`
              : 'undecided'}
          </button>
        </td>
      </tr>

      {open && (
        <tr className="border-t border-slate-100 bg-white text-xs">
          <td />
          <td colSpan={5 + columns} className="px-3 py-2 pl-8">
            <div className="flex flex-wrap items-center gap-2">
              {DISPOSITIONS.map((option) => (
                <button
                  key={option.value}
                  onClick={() => setType(option.value)}
                  title={option.hint}
                  className={`rounded-md border px-2 py-1 text-xs ${
                    type === option.value
                      ? 'border-slate-900 bg-slate-900 text-white'
                      : 'border-slate-300 text-slate-600'
                  }`}
                >
                  {option.label}
                </button>
              ))}

              {needsAmount && (
                <input
                  value={amount}
                  onChange={(event) => setAmount(event.target.value)}
                  placeholder="Amount"
                  className="w-28 rounded border border-slate-300 px-2 py-1 text-xs outline-none focus:border-slate-900"
                />
              )}

              <input
                value={note}
                onChange={(event) => setNote(event.target.value)}
                placeholder="Why — this is the part that has to survive a question"
                className="min-w-[16rem] flex-1 rounded border border-slate-300 px-2 py-1 text-xs outline-none focus:border-slate-900"
              />

              <button
                disabled={
                  busy || note.trim() === '' || (needsAmount && amount.replace(/[$,\s]/g, '') === '')
                }
                onClick={async () => {
                  setBusy(true);
                  const parsed = Number(amount.replace(/[$,\s]/g, ''));
                  await onAssign(gap.id, {
                    assignedType: type,
                    assignedAmount: needsAmount && Number.isFinite(parsed) ? parsed : null,
                    note: note.trim(),
                  });
                  setBusy(false);
                  setOpen(false);
                }}
                className="rounded-md bg-slate-900 px-2.5 py-1 text-xs font-medium text-white disabled:opacity-40"
              >
                {busy ? '…' : 'Assign'}
              </button>

              {gap.assignedType && (
                <button
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    await onAssign(gap.id, { assignedType: null });
                    setBusy(false);
                    setOpen(false);
                  }}
                  className="text-xs text-slate-400 underline"
                >
                  clear
                </button>
              )}
            </div>

            {gap.detectedByRule && (
              <p className="mt-1.5 text-[11px] text-slate-400">Found by: {gap.detectedByRule}</p>
            )}
          </td>
        </tr>
      )}
    </>
  );
}

/**
 * P27 · The buyout log, as a report.
 *
 * Variance is measured against what is actually CARRIED — the adjusted bid plus
 * every allowance and contingency held against scope nobody priced. A package
 * bought at $503k carrying $81k of uncosted exclusions has not come in under
 * budget, and neither has one carrying a $12k gap that no bidder touched.
 *
 * The gaps sit underneath the package they belong to rather than on a separate
 * screen, because the decision "nobody carried firestopping, so hold $12k" is
 * part of arriving at the number, not a footnote to it. Every disposition needs
 * a reason, and the reason is what the report is for.
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
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
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
    const cleaned = editing.value.replace(/[$,\s]/g, '');
    const parsed = cleaned === '' ? null : Number(cleaned);
    setEditing(null);
    if (cleaned !== '' && !Number.isFinite(parsed)) return;
    try {
      await apiPatch(`/records/work_package/${editing.id}`, { [editing.field]: parsed });
      await load();
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  const assign = async (
    gapId: string,
    body: { assignedType: string | null; assignedAmount?: number | null; note?: string },
  ) => {
    onError(null);
    try {
      await apiPost(`/gaps/${gapId}/assign`, body);
      await load();
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  const toggle = (id: string) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const cell = (
    row: Row,
    field: 'budget_amount' | 'allowance_amount' | 'contingency_amount',
    value: number | null,
  ) => {
    const active = editing?.id === row.packageId && editing.field === field;
    return (
      <td
        className="cursor-text px-3 py-2 text-right text-slate-700 hover:bg-slate-50"
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
          <span className={value === null ? 'text-slate-300' : ''}>{money(value)}</span>
        )}
      </td>
    );
  };

  const undecided = rows.reduce((sum, row) => sum + row.openGaps, 0);

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-medium text-slate-900">Buyout log</h2>
          <p className="text-xs text-slate-500">
            Variance is measured on what is carried, not what was quoted. Expand a package to
            dispose of the scope nobody priced.
          </p>
        </div>
        <a
          href={`/api/projects/${projectId}/risk-log.xlsx`}
          className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700"
        >
          Export risk log
        </a>
      </div>

      {undecided > 0 && (
        <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          {undecided} scope gap{undecided === 1 ? '' : 's'} nobody has decided about. Until each one
          is an allowance, a contingency, or accepted in writing, the total below is optimistic.
        </p>
      )}

      <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
              <th className="w-8 px-2 py-2" />
              <th className="px-3 py-2 font-medium">Package</th>
              <th className="px-3 py-2 font-medium">Bidder</th>
              <th className="px-3 py-2 text-right font-medium">Budget</th>
              <th className="px-3 py-2 text-right font-medium">Allowance</th>
              <th className="px-3 py-2 text-right font-medium">Contingency</th>
              <th className="px-3 py-2 text-right font-medium">Adjusted</th>
              <th className="px-3 py-2 text-right font-medium">Carried</th>
              <th className="px-3 py-2 text-right font-medium">Variance</th>
            </tr>
          </thead>

          <tbody>
            {rows.map((row) => (
              <Fragment key={row.packageId}>
                <tr className="border-b border-slate-100">
                  <td className="px-2 py-2">
                    {row.gaps.length > 0 && (
                      <button
                        onClick={() => toggle(row.packageId)}
                        aria-label="Show scope gaps"
                        className="w-4 text-slate-500"
                      >
                        {expanded.has(row.packageId) ? '▾' : '▸'}
                      </button>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <span className="font-mono text-[11px] text-slate-400">
                      {row.division ?? '—'}
                    </span>{' '}
                    <Link
                      to={`/packages/${row.packageId}`}
                      className="font-medium text-slate-900 hover:underline"
                    >
                      {row.name}
                    </Link>
                    <span className="block text-xs text-slate-400">
                      {row.bidderCount} bid{row.bidderCount === 1 ? '' : 's'}
                      {row.openGaps > 0 && (
                        <span className={row.criticalGaps > 0 ? 'text-red-600' : 'text-amber-600'}>
                          {' '}
                          · {row.openGaps} gap{row.openGaps === 1 ? '' : 's'} undecided
                        </span>
                      )}
                    </span>
                    {row.notes && (
                      <span className="mt-0.5 block max-w-md truncate text-[11px] text-slate-400">
                        {row.notes}
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-slate-600">
                    {row.bidder ?? <span className="text-slate-300">—</span>}
                    {row.bidder && !row.selected && (
                      <span className="ml-1 text-xs text-slate-400">(leading)</span>
                    )}
                  </td>
                  {cell(row, 'budget_amount', row.budget)}
                  {cell(row, 'allowance_amount', row.allowance)}
                  {cell(row, 'contingency_amount', row.contingency)}
                  <td className="px-3 py-2 text-right text-slate-600">
                    {money(row.adjustedTotal)}
                  </td>
                  <td className="px-3 py-2 text-right font-semibold text-slate-900">
                    {money(row.committed)}
                    {(row.gapAllowance || row.gapContingency) && (
                      <span className="block text-[11px] font-normal text-slate-400">
                        incl. {money((row.gapAllowance ?? 0) + (row.gapContingency ?? 0))} for gaps
                      </span>
                    )}
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
                </tr>

                {expanded.has(row.packageId) &&
                  row.gaps.map((gap) => (
                    <GapRow key={gap.id} gap={gap} columns={3} onAssign={assign} />
                  ))}
              </Fragment>
            ))}

            {rows.length === 0 && (
              <tr>
                <td colSpan={9} className="px-4 py-6 text-sm text-slate-400">
                  No packages yet. Add one per division on the Packages step.
                </td>
              </tr>
            )}
          </tbody>

          {totals && rows.length > 0 && (
            <tfoot>
              <tr className="border-t-2 border-slate-300 bg-slate-50 font-medium">
                <td />
                <td className="px-3 py-2" colSpan={2}>
                  Project total
                </td>
                <td className="px-3 py-2 text-right">{money(totals.budget)}</td>
                <td className="px-3 py-2 text-right">
                  {money(totals.allowance)}
                  {totals.gapAllowance > 0 && (
                    <span className="block text-[11px] font-normal text-slate-400">
                      +{money(totals.gapAllowance)} gaps
                    </span>
                  )}
                </td>
                <td className="px-3 py-2 text-right">
                  {money(totals.contingency)}
                  {totals.gapContingency > 0 && (
                    <span className="block text-[11px] font-normal text-slate-400">
                      +{money(totals.gapContingency)} gaps
                    </span>
                  )}
                </td>
                <td className="px-3 py-2 text-right">{money(totals.adjusted)}</td>
                <td className="px-3 py-2 text-right">{money(totals.committed)}</td>
                <td
                  className={`px-3 py-2 text-right ${
                    totals.variance > 0 ? 'text-red-700' : 'text-emerald-700'
                  }`}
                >
                  {totals.variance > 0 ? '+' : ''}
                  {money(totals.variance)}
                </td>
              </tr>

              {totals.openExposure > 0 && (
                <tr className="bg-slate-50 text-xs text-amber-700">
                  <td />
                  <td className="px-3 pb-2" colSpan={7}>
                    {money(totals.openExposure)} of exposure still sits in undecided gaps and is
                    NOT in the carried total above.
                  </td>
                  <td />
                </tr>
              )}
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

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Grid, type GridColumn, type GridRow } from './Grid';
import { BidTab } from './BidTab';
import { LevelingMatrix } from './LevelingMatrix';
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
  /**
   * The buyout log as a spreadsheet.
   *
   * Budget, allowance and contingency are the estimator's own numbers, so they
   * get the same surface as everywhere else — arrows, ranges, copy/paste
   * against Excel, and =SUM() down a column. The derived columns are read-only
   * because typing over an adjusted total would be typing over the arithmetic
   * the whole product rests on.
   */
  const columns = useMemo<GridColumn[]>(
    () => [
      { key: 'division', label: 'Div', width: 60, editable: false },
      { key: 'name', label: 'Package', width: 220, editable: false },
      { key: 'bidder', label: 'Bidder', width: 180, editable: false },
      { key: 'budget', label: 'Budget', width: 120, type: 'currency' },
      { key: 'allowance', label: 'Allowance', width: 120, type: 'currency' },
      { key: 'contingency', label: 'Contingency', width: 120, type: 'currency' },
      { key: 'gapCarry', label: 'Gap carry', width: 110, type: 'currency', editable: false },
      { key: 'adjustedTotal', label: 'Adjusted', width: 130, type: 'currency', editable: false },
      { key: 'committed', label: 'Carried', width: 130, type: 'currency', editable: false },
      { key: 'variance', label: 'Variance', width: 120, type: 'currency', editable: false },
      { key: 'openGaps', label: 'Open gaps', width: 90, type: 'number', editable: false },
    ],
    [],
  );

  const gridRows = useMemo<GridRow[]>(
    () =>
      rows.map((row) => ({
        id: row.packageId,
        division: row.division ?? '',
        name: row.name,
        bidder: row.bidder ?? '',
        budget: row.budget,
        allowance: row.allowance,
        contingency: row.contingency,
        gapCarry: (row.gapAllowance ?? 0) + (row.gapContingency ?? 0) || null,
        adjustedTotal: row.adjustedTotal,
        committed: row.committed,
        variance: row.variance,
        openGaps: row.openGaps || null,
      })) as unknown as GridRow[],
    [rows],
  );

  const commitPackage = useCallback(
    async (packageId: string, patch: Record<string, unknown>) => {
      const FIELD: Record<string, string> = {
        budget: 'budget_amount',
        allowance: 'allowance_amount',
        contingency: 'contingency_amount',
      };

      const mapped: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(patch)) {
        const column = FIELD[key];
        if (column) mapped[column] = value;
      }
      if (Object.keys(mapped).length === 0) return;

      await apiPatch(`/records/work_package/${packageId}`, mapped);
      await load();
    },
    [load],
  );

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

      <Grid
        columns={columns}
        rows={gridRows}
        onCommit={commitPackage}
        emptyMessage="No packages yet. Put some scope into a package on the Scope step."
      />

      {totals && rows.length > 0 && (
        <div className="flex flex-wrap items-center justify-end gap-x-6 gap-y-1 rounded-xl border border-ink-200 bg-white px-4 py-2.5 text-xs">
          <span className="mr-auto font-semibold text-ink-900">Project total</span>
          <span className="text-ink-500">budget <b className="text-ink-900">{money(totals.budget)}</b></span>
          <span className="text-ink-500">allowance <b className="text-ink-900">{money(totals.allowance + totals.gapAllowance)}</b></span>
          <span className="text-ink-500">contingency <b className="text-ink-900">{money(totals.contingency + totals.gapContingency)}</b></span>
          <span className="text-ink-500">carried <b className="text-ink-900">{money(totals.committed)}</b></span>
          <span className={totals.variance > 0 ? 'text-red-700' : 'text-emerald-700'}>
            variance <b>{totals.variance > 0 ? '+' : ''}{money(totals.variance)}</b>
          </span>
        </div>
      )}

      {totals && totals.openExposure > 0 && (
        <p className="rounded-lg border border-flag-100 bg-flag-50 px-3 py-2 text-xs text-flag-700">
          {money(totals.openExposure)} of exposure still sits in undecided gaps and is NOT in the
          carried total above.
        </p>
      )}

      {/* Each package opens into its own detail: the sub-by-sub comparison and
          the gaps against it.

          This is what merged Leveling into Buyout. They were two steps and one
          question — the buyout log is the summary sheet, and levelling is what
          you find when you open a line of it. Clicking the division header is
          the same gesture as opening a tab in a workbook, which is what an
          estimator is already doing in their head.

          Gaps stay OUTSIDE the grid rather than becoming rows in it: a gap is
          not a package, and giving it a row in the same cell model would break
          every range selection and every formula that counts packages. */}
      <div className="space-y-2">
        {rows.map((row) => (
            <div key={row.packageId} className="rounded-xl border border-ink-200 bg-white">
              <button
                onClick={() => toggle(row.packageId)}
                className="flex w-full items-center justify-between px-4 py-2 text-left"
              >
                <span className="text-xs">
                  <span className="font-mono text-ink-400">{row.division ?? '—'}</span>{' '}
                  <span className="font-medium text-ink-900">{row.name}</span>
                  <span className="ml-2 text-ink-400">
                    {row.bidderCount} bid{row.bidderCount === 1 ? '' : 's'}
                  </span>
                  {row.gaps.length > 0 && (
                    <span className="ml-2 text-ink-400">
                      · {row.gaps.length} gap{row.gaps.length === 1 ? '' : 's'}
                    </span>
                  )}
                  {row.openGaps > 0 && (
                    <span
                      className={`ml-2 font-medium ${
                        row.criticalGaps > 0 ? 'text-red-700' : 'text-flag-700'
                      }`}
                    >
                      {row.openGaps} undecided
                    </span>
                  )}
                  {row.selected && (
                    <span className="ml-2 rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-medium text-emerald-800">
                      awarded
                    </span>
                  )}
                </span>
                <span className="text-xs text-ink-400">
                  {expanded.has(row.packageId) ? 'hide' : 'open'}
                </span>
              </button>

              {expanded.has(row.packageId) && (
                <div className="space-y-4 border-t border-ink-100 p-4">
                  {row.bidderCount > 0 ? (
                    <>
                      <LevelingMatrix packageId={row.packageId} onError={onError} />
                      {/* The sub-by-sub sheet: one row per scope item, one
                          column per bidder. The comparison above says which bid
                          is lowest; this says where the difference comes from. */}
                      <BidTab packageId={row.packageId} onError={onError} />
                    </>
                  ) : (
                    <p className="text-xs text-ink-400">
                      No bids on this package yet. Drop them, or enter one by hand, on its Bids
                      step.
                    </p>
                  )}

                  {row.gaps.length > 0 && (
                    <div>
                      <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-ink-400">
                        Scope gaps · {row.gaps.length}
                      </p>
                      <table className="w-full text-sm">
                        <tbody>
                          {row.gaps.map((gap) => (
                            <GapRow key={gap.id} gap={gap} columns={3} onAssign={assign} />
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
      </div>

      <p className="text-xs text-slate-400">
        A leading bidder is advisory. Nothing is awarded until an estimator selects at H6 with a
        written rationale — and this system has no way to tell anyone they won.
      </p>
    </section>
  );
}

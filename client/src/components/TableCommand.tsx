import { useState } from 'react';
import { apiPost } from '../lib/api';
import type { GridColumn, GridRow } from './Grid';

type Edit = { rowId: string; field: string; value: string | null; reason: string };

type Plan = {
  summary: string;
  question: string | null;
  edits: Edit[];
  dropped: number;
  skipped: string[];
};

/**
 * Telling a table what to change, instead of clicking every cell.
 *
 * "Set every division 22 basis to 'per fixture schedule'" is one sentence and
 * forty clicks. An estimator with a bid due does the forty clicks in Excel
 * instead, and then the real numbers live in Excel — which is the failure this
 * whole product exists to prevent.
 *
 * The diff is always shown. Never "I did it" — always "here is what that means,
 * row by row, with why each one matched". That review step is the difference
 * between a faster keyboard and something that edits your project on its own,
 * and it is not optional even when the change is obviously right.
 *
 * Applying goes through the same audited PATCH as typing would, so an edit made
 * this way is indistinguishable in the ledger from one made by hand. Which is
 * what it is: a person said what they wanted.
 */
export function TableCommand({
  table,
  rows,
  columns,
  selectedRowIds,
  onApplied,
  onError,
  placeholder,
}: {
  table: string;
  rows: GridRow[];
  columns: GridColumn[];
  selectedRowIds?: string[];
  onApplied: () => void;
  onError: (message: string | null) => void;
  placeholder?: string;
}) {
  const [instruction, setInstruction] = useState('');
  const [plan, setPlan] = useState<Plan | null>(null);
  const [busy, setBusy] = useState(false);

  const scoped = selectedRowIds?.length ?? 0;

  const propose = async () => {
    if (instruction.trim() === '') return;
    setBusy(true);
    onError(null);
    try {
      setPlan(
        await apiPost<Plan>('/table-command/plan', {
          table,
          instruction: instruction.trim(),
          rows,
          columns: columns.map((column) => ({ key: column.key, label: column.label })),
          selectedRowIds,
        }),
      );
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  const apply = async () => {
    if (!plan) return;
    setBusy(true);
    onError(null);
    try {
      const result = await apiPost<{ applied: number; failures: string[] }>(
        '/table-command/apply',
        { table, instruction, edits: plan.edits },
      );
      setPlan(null);
      setInstruction('');
      onApplied();
      if (result.failures.length > 0) {
        onError(`${result.applied} applied. ${result.failures.length} failed: ${result.failures[0]}`);
      }
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  const label = (rowId: string) => {
    const row = rows.find((candidate) => String(candidate.id) === rowId);
    // Whatever identifies the row to a human. scope_id, then a name, then the
    // id — an estimator should recognise the row, not decode it.
    return String(row?.scope_id ?? row?.code ?? row?.name ?? row?.title ?? rowId).slice(0, 40);
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <input
          value={instruction}
          onChange={(event) => setInstruction(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !busy) void propose();
            if (event.key === 'Escape') setPlan(null);
          }}
          placeholder={
            placeholder ??
            (scoped > 0
              ? `Change the ${scoped} selected row${scoped === 1 ? '' : 's'}…`
              : 'Tell it what to change — "set every division 22 basis to per fixture schedule"')
          }
          className="flex-1 rounded-lg border border-ink-300 px-3 py-1.5 text-xs outline-none focus:border-ink-800"
        />
        <button
          onClick={() => void propose()}
          disabled={busy || instruction.trim() === ''}
          className="rounded-md bg-ink-900 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-40"
        >
          {busy ? '…' : 'Preview'}
        </button>
      </div>

      {plan?.question && (
        <div className="rounded-lg border border-flag-100 bg-flag-50 px-3 py-2">
          <p className="text-xs text-flag-700">{plan.question}</p>
          <p className="mt-0.5 text-[11px] text-flag-500">
            Nothing has changed. Answer that in the box above and try again.
          </p>
        </div>
      )}

      {plan && plan.edits.length > 0 && (
        <div className="rounded-lg border border-ink-300 bg-white">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-ink-100 px-3 py-2">
            <div className="min-w-0">
              <p className="text-xs font-medium text-ink-900">{plan.summary}</p>
              <p className="text-[11px] text-ink-400">
                {plan.edits.length} change{plan.edits.length === 1 ? '' : 's'} across{' '}
                {new Set(plan.edits.map((edit) => edit.rowId)).size} row
                {new Set(plan.edits.map((edit) => edit.rowId)).size === 1 ? '' : 's'}
                {plan.dropped > 0 && ` · ${plan.dropped} refused as out of bounds`}
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <button onClick={() => setPlan(null)} className="text-[11px] text-ink-400">
                discard
              </button>
              <button
                onClick={() => void apply()}
                disabled={busy}
                className="rounded-md bg-ink-900 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-40"
              >
                {busy ? '…' : `Apply ${plan.edits.length}`}
              </button>
            </div>
          </div>

          <div className="max-h-64 overflow-y-auto">
            <table className="w-full text-[11px]">
              <tbody>
                {plan.edits.map((edit, index) => {
                  const row = rows.find((candidate) => String(candidate.id) === edit.rowId);
                  const before = row?.[edit.field];

                  return (
                    <tr key={index} className="border-b border-ink-50 last:border-0">
                      <td className="w-40 px-3 py-1 font-mono text-ink-500">{label(edit.rowId)}</td>
                      <td className="w-28 px-2 py-1 text-ink-400">{edit.field}</td>
                      <td className="px-2 py-1">
                        <span className="text-ink-400 line-through">
                          {before === null || before === undefined || before === ''
                            ? '—'
                            : String(before).slice(0, 40)}
                        </span>
                        <span className="mx-1.5 text-ink-300">→</span>
                        <span className="font-medium text-ink-900">
                          {edit.value === null || edit.value === '' ? '—' : edit.value}
                        </span>
                      </td>
                      <td className="w-56 px-2 py-1 text-ink-400">{edit.reason}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {plan.skipped.length > 0 && (
            <p className="border-t border-ink-100 px-3 py-1.5 text-[10px] text-ink-400">
              Left alone: {plan.skipped.join(' · ')}
            </p>
          )}
        </div>
      )}

      {plan && plan.edits.length === 0 && !plan.question && (
        <p className="text-[11px] text-ink-400">
          Nothing matched that. {plan.summary}
        </p>
      )}
    </div>
  );
}

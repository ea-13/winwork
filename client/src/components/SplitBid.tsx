import { useCallback, useEffect, useState } from 'react';
import { apiGet, apiPost } from '../lib/api';
import { money } from './Layout';

type Allocation = { package_id: string; amount: number | null; note: string | null };

type State = {
  quotedTotal: number | null;
  homePackageId: string;
  allocations: Allocation[];
  allocated: number;
  unallocated: number | null;
};

type Pkg = { id: string; name: string; lead_division: string | null };

/**
 * Splitting one bid across packages.
 *
 * Plenty of subs price a scope rather than a trade — mechanical across 22 and
 * 23, a sitework sub across 31, 32 and 33. Before this the only way to represent
 * that was to invent two or three separate quotes, which loses the fact that it
 * was one bid, from one bidder, with one set of terms and one person to hold to
 * them.
 *
 * The remainder is shown and never corrected. A split that does not add up to
 * the quoted total is somebody's money, and rounding it away silently is how it
 * stops being anybody's problem until buyout.
 */
export function SplitBid({
  quoteId,
  projectId,
  onError,
  onChanged,
}: {
  quoteId: string;
  projectId: string;
  onError: (message: string | null) => void;
  onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<State | null>(null);
  const [packages, setPackages] = useState<Pkg[]>([]);
  const [rows, setRows] = useState<{ packageId: string; amount: string; note: string }[]>([]);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const [allocation, pkgs] = await Promise.all([
      apiGet<State>(`/quotes/${quoteId}/allocations`),
      apiGet<Pkg[]>(`/projects/${projectId}/packages`),
    ]);
    setState(allocation);
    setPackages(pkgs);
    setRows(
      allocation.allocations.length > 0
        ? allocation.allocations.map((row) => ({
            packageId: row.package_id,
            amount: row.amount === null ? '' : String(row.amount),
            note: row.note ?? '',
          }))
        : // Seed with the package it already belongs to, so the common case —
          // "actually this also covers HVAC" — is one row away.
          [{ packageId: allocation.homePackageId, amount: '', note: '' }],
    );
  }, [quoteId, projectId]);

  useEffect(() => {
    if (open) load().catch((caught: Error) => onError(caught.message));
  }, [open, load, onError]);

  const parsed = rows.map((row) => Number(row.amount.replace(/[$,\s]/g, '')) || 0);
  const allocated = parsed.reduce((sum, value) => sum + value, 0);
  const total = state?.quotedTotal ?? null;
  const remainder = total === null ? null : total - allocated;

  const save = () =>
    void (async () => {
      setBusy(true);
      onError(null);
      try {
        const result = await apiPost<{ balanced: boolean | null; unallocated: number | null }>(
          `/quotes/${quoteId}/allocations`,
          {
            allocations: rows
              .filter((row) => row.packageId)
              .map((row) => ({
                packageId: row.packageId,
                amount: row.amount.replace(/[$,\s]/g, '') === ''
                  ? null
                  : Number(row.amount.replace(/[$,\s]/g, '')),
                note: row.note || undefined,
              })),
          },
        );
        await load();
        onChanged();
        if (result.balanced === false) {
          onError(
            `Saved, but ${money(result.unallocated)} of this bid is not allocated to any package. ` +
              'It will not appear in any comparison until it is.',
          );
        }
      } catch (caught) {
        onError(caught instanceof Error ? caught.message : String(caught));
      } finally {
        setBusy(false);
      }
    })();

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="text-[11px] text-ink-400 underline hover:text-ink-700"
        title="For a sub who priced work across more than one division"
      >
        split across divisions
      </button>
    );
  }

  return (
    <div className="mt-2 rounded-lg border border-ink-200 bg-ink-50/50 p-3">
      <div className="mb-2 flex items-baseline justify-between">
        <p className="text-xs font-medium text-ink-900">
          Split this bid
          {total !== null && <span className="ml-2 font-normal text-ink-400">of {money(total)}</span>}
        </p>
        <button onClick={() => setOpen(false)} className="text-[11px] text-ink-400">
          close
        </button>
      </div>

      <div className="space-y-1.5">
        {rows.map((row, index) => (
          <div key={index} className="flex flex-wrap items-center gap-1.5">
            <select
              value={row.packageId}
              onChange={(event) =>
                setRows((current) =>
                  current.map((entry, at) =>
                    at === index ? { ...entry, packageId: event.target.value } : entry,
                  ),
                )
              }
              className="min-w-[10rem] flex-1 rounded border border-ink-300 px-1.5 py-1 text-xs"
            >
              <option value="">— pick a package —</option>
              {packages.map((pkg) => (
                <option key={pkg.id} value={pkg.id}>
                  {pkg.lead_division} {pkg.name}
                </option>
              ))}
            </select>

            <input
              value={row.amount}
              onChange={(event) =>
                setRows((current) =>
                  current.map((entry, at) =>
                    at === index ? { ...entry, amount: event.target.value } : entry,
                  ),
                )
              }
              placeholder="Amount"
              className="w-28 rounded border border-ink-300 px-2 py-1 text-right text-xs outline-none focus:border-ink-800"
            />

            <input
              value={row.note}
              onChange={(event) =>
                setRows((current) =>
                  current.map((entry, at) =>
                    at === index ? { ...entry, note: event.target.value } : entry,
                  ),
                )
              }
              placeholder="What this part covers"
              className="min-w-[10rem] flex-1 rounded border border-ink-300 px-2 py-1 text-xs outline-none focus:border-ink-800"
            />

            <button
              onClick={() => setRows((current) => current.filter((_, at) => at !== index))}
              className="px-1 text-[11px] text-ink-300 hover:text-red-600"
            >
              ×
            </button>
          </div>
        ))}
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-3">
        <button
          onClick={() => setRows((current) => [...current, { packageId: '', amount: '', note: '' }])}
          className="text-[11px] text-ink-500 underline"
        >
          + package
        </button>

        {remainder !== null && (
          <span
            className={`text-[11px] ${
              Math.abs(remainder) < 0.005 ? 'text-emerald-700' : 'text-flag-700'
            }`}
          >
            {Math.abs(remainder) < 0.005
              ? 'balances'
              : `${money(Math.abs(remainder))} ${remainder > 0 ? 'unallocated' : 'over-allocated'}`}
          </span>
        )}

        <button
          onClick={save}
          disabled={busy}
          className="ml-auto rounded-md bg-ink-900 px-2.5 py-1 text-xs font-medium text-white disabled:opacity-40"
        >
          {busy ? '…' : 'Save split'}
        </button>
      </div>

      <p className="mt-1.5 text-[10px] text-ink-400">
        Each package levels this bid at the amount allocated to it, against the other bids on that
        package. The bid stays one bid.
      </p>
    </div>
  );
}

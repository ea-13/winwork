import { useCallback, useEffect, useState } from 'react';
import { apiGet, apiPost } from '../lib/api';

type Sub = { id: string; name: string };

/**
 * Entering a bid by hand.
 *
 * The extraction chain is the interesting path and it is not the only one. A GC
 * with three quotes already on their desk wants the levelling, not the reading
 * — and a demo should not require thirteen model calls before anything appears
 * on screen.
 *
 * A quote entered here is status MANUAL, not EXTRACTED. It levels identically;
 * the difference is that it can never cite a page, and the record should say so
 * rather than let a typed number and a read number look alike.
 *
 * The bidder can just be named. Making somebody create a subcontractor, come
 * back, and start the bid again is the kind of friction that ends with the
 * numbers living in a spreadsheet.
 */
export function ManualBid({
  packageId,
  onError,
  onAdded,
}: {
  packageId: string;
  onError: (message: string | null) => void;
  onAdded: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [subs, setSubs] = useState<Sub[]>([]);
  const [bidderName, setBidderName] = useState('');
  const [total, setTotal] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setSubs(await apiGet<Sub[]>('/subcontractors'));
    } catch {
      setSubs([]);
    }
  }, []);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  const submit = async () => {
    if (bidderName.trim() === '') return;
    setBusy(true);
    onError(null);
    try {
      const cleaned = total.replace(/[$,\s]/g, '');
      // R1 holds here too: no total entered is "not yet known", not zero.
      const parsed = cleaned === '' ? null : Number(cleaned);

      const existing = subs.find(
        (sub) => sub.name.toLowerCase() === bidderName.trim().toLowerCase(),
      );

      await apiPost(`/packages/${packageId}/quotes/manual`, {
        subcontractorId: existing?.id ?? null,
        bidderName: bidderName.trim(),
        quotedTotal: parsed !== null && Number.isFinite(parsed) ? parsed : null,
      });

      setBidderName('');
      setTotal('');
      onAdded();
      await load();
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="rounded-md border border-ink-300 px-3 py-1.5 text-xs font-medium text-ink-700"
      >
        + Enter a bid by hand
      </button>
    );
  }

  return (
    <div className="rounded-xl border border-ink-200 bg-white p-3">
      <div className="mb-2 flex items-baseline justify-between">
        <p className="text-[13px] font-semibold text-ink-900">Enter a bid</p>
        <button onClick={() => setOpen(false)} className="text-xs text-ink-400">
          close
        </button>
      </div>

      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-0.5">
          <span className="text-[10px] uppercase tracking-wide text-ink-400">Bidder</span>
          <input
            autoFocus
            list="known-subs"
            value={bidderName}
            onChange={(event) => setBidderName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void submit();
            }}
            placeholder="Oro Pro Plumbing"
            className="w-56 rounded border border-ink-300 px-2 py-1 text-xs outline-none focus:border-ink-800"
          />
          <datalist id="known-subs">
            {subs.map((sub) => (
              <option key={sub.id} value={sub.name} />
            ))}
          </datalist>
        </label>

        <label className="flex flex-col gap-0.5">
          <span className="text-[10px] uppercase tracking-wide text-ink-400">Quoted total</span>
          <input
            value={total}
            onChange={(event) => setTotal(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void submit();
            }}
            placeholder="44,000"
            className="w-32 rounded border border-ink-300 px-2 py-1 text-right text-xs outline-none focus:border-ink-800"
          />
        </label>

        <button
          disabled={busy || bidderName.trim() === ''}
          onClick={() => void submit()}
          className="rounded-md bg-ink-900 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-40"
        >
          {busy ? '…' : 'Add bid'}
        </button>
      </div>

      <p className="mt-2 text-[11px] text-ink-400">
        A new bidder is created if the name is not already on your list. Break the total down
        per scope item on the Leveling step — or leave it as a lump and level on the total.
      </p>
    </div>
  );
}

import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { money } from './Layout';
import { apiGet, apiPost } from '../lib/api';

type Bidder = {
  quoteId: string;
  name: string;
  status: string;
  quotedTotal: number | null;
  adjustedTotal: number | null;
  advisoryRank: number;
};

type ScopeItem = {
  id: string;
  scope_id: string;
  csi_division: string | null;
  csi_section: string | null;
  title: string;
  description: string | null;
  unit: string | null;
  quantity: number | null;
  is_locked: boolean;
};

type Cell = {
  scopeItemId: string;
  quoteId: string;
  rolledTotal: number | null;
  overrideTotal: number | null;
  note: string | null;
  lineCount: number;
  isExcluded: boolean;
  isCarried: boolean;
  matchBasis: string | null;
};

type Detail = {
  scopeItems: (ScopeItem & { quantity_basis: string | null })[];
  bidders: { quoteId: string; name: string; quotedTotal: number | null }[];
  lines: Record<string, unknown>[];
  exclusions: Record<string, unknown>[];
  cells: Record<string, unknown>[];
};

/** How many bidder columns are shown at once. */
const COLUMNS = 3;

/** The number that counts: what the estimator said, else what rolled up. */
const effective = (cell: Cell | undefined): number | null =>
  cell?.overrideTotal ?? cell?.rolledTotal ?? null;

/**
 * The bid tab sheet.
 *
 * One row per scope item, one column per bidder — the sheet an estimator would
 * otherwise build in Excel, and the reason they keep going back to Excel. The
 * adjusted comparison above it answers "which bid is lowest"; this answers
 * "where does the difference actually come from", which is the question you
 * have to answer before you can defend the first one.
 *
 * Three columns at a time because three is what fits and three is what a GC
 * levels. More bidders are swapped in from the header rather than squeezed in,
 * and the default three are the three adjusted-lowest.
 *
 * A blank cell is never a zero. A sub who did not price something and a sub who
 * priced it at nothing are different facts, and collapsing them is how a
 * comparison ends up wrong.
 */
export function BidTab({
  packageId,
  onError,
}: {
  packageId: string;
  onError: (message: string | null) => void;
}) {
  const [bidders, setBidders] = useState<Bidder[]>([]);
  const [scopeItems, setScopeItems] = useState<ScopeItem[]>([]);
  const [cells, setCells] = useState<Cell[]>([]);
  const [shown, setShown] = useState<string[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<{ key: string; value: string } | null>(null);
  const [noteFor, setNoteFor] = useState<string | null>(null);
  const [noteDraft, setNoteDraft] = useState('');
  const [detail, setDetail] = useState<Detail | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const data = await apiGet<{ scopeItems: ScopeItem[]; bidders: Bidder[]; cells: Cell[] }>(
      `/packages/${packageId}/scope-leveling`,
    );
    setScopeItems(data.scopeItems);
    setBidders(data.bidders);
    setCells(data.cells);
    setShown((current) =>
      current.length > 0
        ? current.filter((id) => data.bidders.some((bidder) => bidder.quoteId === id))
        : data.bidders.slice(0, COLUMNS).map((bidder) => bidder.quoteId),
    );
  }, [packageId]);

  useEffect(() => {
    load().catch((caught: Error) => onError(caught.message));
  }, [load, onError]);

  const cellAt = useMemo(() => {
    const map = new Map<string, Cell>();
    for (const cell of cells) map.set(`${cell.scopeItemId}|${cell.quoteId}`, cell);
    return map;
  }, [cells]);

  const columns = useMemo(
    () =>
      shown
        .map((id) => bidders.find((bidder) => bidder.quoteId === id))
        .filter((bidder): bidder is Bidder => bidder !== undefined),
    [shown, bidders],
  );

  /** Scope items grouped by division, so a division reads as a block. */
  const groups = useMemo(() => {
    const byDivision = new Map<string, ScopeItem[]>();
    for (const item of scopeItems) {
      const code = item.csi_division ?? '—';
      byDivision.set(code, [...(byDivision.get(code) ?? []), item]);
    }
    return [...byDivision.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [scopeItems]);

  const write = async (scopeItemId: string, quoteId: string, patch: Record<string, unknown>) => {
    setBusy(true);
    onError(null);
    try {
      await apiPost(`/packages/${packageId}/scope-leveling/cell`, {
        scopeItemId,
        quoteId,
        ...patch,
      });
      await load();
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  async function saveOverride() {
    if (!editing) return;
    const [scopeItemId, quoteId] = editing.key.split('|');
    const raw = editing.value.replace(/[$,\s]/g, '');
    const parsed = raw === '' ? null : Number(raw);
    setEditing(null);
    if (!scopeItemId || !quoteId) return;
    if (raw !== '' && !Number.isFinite(parsed)) return;
    await write(scopeItemId, quoteId, { overrideTotal: parsed });
  }

  async function saveNote() {
    if (!noteFor) return;
    const [scopeItemId, quoteId] = noteFor.split('|');
    const value = noteDraft;
    setNoteFor(null);
    if (!scopeItemId || !quoteId) return;
    await write(scopeItemId, quoteId, { note: value });
  }

  async function openDetail() {
    if (selected.size === 0) return;
    setBusy(true);
    onError(null);
    try {
      const query = new URLSearchParams({
        scopeItemIds: [...selected].join(','),
        quoteIds: columns.map((column) => column.quoteId).join(','),
      });
      setDetail(
        await apiGet<Detail>(`/packages/${packageId}/scope-leveling/detail?${query.toString()}`),
      );
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  const toggle = (id: string) =>
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const toggleGroup = (items: ScopeItem[]) =>
    setSelected((current) => {
      const next = new Set(current);
      const allIn = items.every((item) => next.has(item.id));
      for (const item of items) {
        if (allIn) next.delete(item.id);
        else next.add(item.id);
      }
      return next;
    });

  const swapColumn = (index: number, quoteId: string) =>
    setShown((current) => current.map((id, at) => (at === index ? quoteId : id)));

  const columnTotal = (quoteId: string): number | null => {
    const values = scopeItems
      .map((item) => effective(cellAt.get(`${item.id}|${quoteId}`)))
      .filter((value): value is number => value !== null);
    return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0);
  };

  if (bidders.length === 0) {
    return (
      <p className="rounded-lg border border-ink-200 bg-white px-4 py-6 text-sm text-ink-400">
        No bids on this package yet. Upload sub bids, extract them, then recompute on the Leveling
        step — the tab sheet is built from mapped quote lines.
      </p>
    );
  }

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-sm font-medium text-ink-900">Bid tab</h2>
          <p className="text-xs text-ink-500">
            What each sub carried, scope item by scope item. Click a number to type your own over
            it; the rolled-up figure is kept underneath either way.
          </p>
        </div>
        <button
          onClick={() => void openDetail()}
          disabled={busy || selected.size === 0}
          className="rounded-md border border-ink-300 px-3 py-1.5 text-xs font-medium text-ink-700 disabled:opacity-40"
          title="Open the sub detail and full scope wording for everything selected"
        >
          Open {selected.size || ''} selected
        </button>
      </div>

      <div className="overflow-x-auto rounded-lg border border-ink-200 bg-white">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-ink-200 text-left text-xs text-ink-500">
              <th className="w-8 px-2 py-2" />
              <th className="px-3 py-2 font-medium uppercase tracking-wide">Scope item</th>
              <th className="px-3 py-2 text-right font-medium uppercase tracking-wide">Qty</th>
              {columns.map((column, index) => (
                <th key={column.quoteId} className="px-3 py-1.5">
                  <select
                    value={column.quoteId}
                    onChange={(event) => swapColumn(index, event.target.value)}
                    className="w-full max-w-[11rem] truncate rounded border border-transparent bg-transparent px-1 py-0.5 text-xs font-semibold text-ink-900 hover:border-ink-300 focus:border-ink-900 focus:outline-none"
                  >
                    {bidders.map((bidder) => (
                      <option key={bidder.quoteId} value={bidder.quoteId}>
                        {bidder.name}
                      </option>
                    ))}
                  </select>
                  <span className="mt-0.5 block px-1 text-[11px] font-normal normal-case text-ink-400">
                    {column.status === 'EXTRACTED' ? (
                      <>
                        {column.advisoryRank > 0 ? `#${column.advisoryRank} adjusted` : 'unranked'}{' '}
                        · {money(column.adjustedTotal)}
                      </>
                    ) : (
                      // An empty column with no explanation reads as "this sub
                      // priced nothing", which is a different and much worse
                      // claim than "we have not read their bid yet".
                      <span className="text-amber-600">
                        {column.status.replace(/_/g, ' ').toLowerCase()} — not levelled yet
                      </span>
                    )}
                  </span>
                </th>
              ))}
            </tr>
          </thead>

          {groups.map(([code, items]) => (
            <tbody key={code} className="border-b border-ink-200 last:border-0">
              <tr className="bg-ink-50 text-xs">
                <td className="px-2 py-1.5">
                  <input
                    type="checkbox"
                    checked={items.every((item) => selected.has(item.id))}
                    onChange={() => toggleGroup(items)}
                  />
                </td>
                <td className="px-3 py-1.5 font-semibold text-ink-900" colSpan={2}>
                  <span className="font-mono">{code}</span>
                  <span className="ml-2 font-normal text-ink-400">
                    {items.length} item{items.length === 1 ? '' : 's'}
                  </span>
                </td>
                {columns.map((column) => {
                  const values = items
                    .map((item) => effective(cellAt.get(`${item.id}|${column.quoteId}`)))
                    .filter((value): value is number => value !== null);
                  return (
                    <td
                      key={column.quoteId}
                      className="px-3 py-1.5 text-right font-medium text-ink-600"
                    >
                      {values.length === 0
                        ? '—'
                        : money(values.reduce((sum, value) => sum + value, 0))}
                    </td>
                  );
                })}
              </tr>

              {items.map((item) => (
                <Fragment key={item.id}>
                  <tr className="border-t border-ink-100">
                    <td className="px-2 py-1.5">
                      <input
                        type="checkbox"
                        checked={selected.has(item.id)}
                        onChange={() => toggle(item.id)}
                      />
                    </td>
                    <td className="px-3 py-1.5">
                      <span className="font-mono text-[11px] text-ink-400">{item.scope_id}</span>
                      <span className="ml-2 text-ink-800">{item.title}</span>
                      {!item.is_locked && (
                        <span
                          className="ml-1.5 text-[11px] text-amber-600"
                          title="Not locked — the baseline can still move under this comparison"
                        >
                          open
                        </span>
                      )}
                    </td>
                    <td className="whitespace-nowrap px-3 py-1.5 text-right text-xs text-ink-500">
                      {item.quantity === null ? '—' : `${item.quantity} ${item.unit ?? ''}`}
                    </td>

                    {columns.map((column) => {
                      const key = `${item.id}|${column.quoteId}`;
                      const cell = cellAt.get(key);
                      const value = effective(cell);
                      const active = editing?.key === key;
                      const overridden = cell?.overrideTotal !== null && cell?.overrideTotal !== undefined;

                      return (
                        <td
                          key={column.quoteId}
                          onClick={() =>
                            setEditing({ key, value: value === null ? '' : String(value) })
                          }
                          onContextMenu={(event) => {
                            event.preventDefault();
                            setNoteFor(key);
                            setNoteDraft(cell?.note ?? '');
                          }}
                          className="cursor-text px-3 py-1.5 text-right hover:bg-ink-50"
                        >
                          {active ? (
                            <input
                              autoFocus
                              value={editing.value}
                              onChange={(event) =>
                                setEditing({ ...editing, value: event.target.value })
                              }
                              onBlur={() => void saveOverride()}
                              onKeyDown={(event) => {
                                if (event.key === 'Enter') void saveOverride();
                                if (event.key === 'Escape') setEditing(null);
                              }}
                              className="w-24 rounded border border-ink-900 px-1 text-right outline-none"
                            />
                          ) : (
                            <span className="inline-flex items-baseline justify-end gap-1">
                              {value === null ? (
                                <span
                                  className={
                                    cell?.isExcluded ? 'text-xs text-amber-600' : 'text-ink-300'
                                  }
                                  title={
                                    cell?.isExcluded
                                      ? 'Named as excluded by this bidder'
                                      : 'Not priced by this bidder'
                                  }
                                >
                                  {cell?.isExcluded ? 'excluded' : '——'}
                                </span>
                              ) : (
                                <span
                                  className={overridden ? 'font-medium text-sky-700' : 'text-ink-700'}
                                  title={
                                    overridden
                                      ? `Your number. Rolled up: ${money(cell?.rolledTotal ?? null)}`
                                      : `${cell?.lineCount ?? 0} line(s) mapped here`
                                  }
                                >
                                  {money(value)}
                                </span>
                              )}
                              <button
                                onClick={(event) => {
                                  event.stopPropagation();
                                  setNoteFor(key);
                                  setNoteDraft(cell?.note ?? '');
                                }}
                                className={`text-[11px] ${
                                  cell?.note ? 'text-sky-600' : 'text-ink-200 hover:text-ink-500'
                                }`}
                                title={cell?.note ?? 'Add a note'}
                              >
                                ✎
                              </button>
                            </span>
                          )}
                        </td>
                      );
                    })}
                  </tr>

                  {noteFor?.startsWith(`${item.id}|`) &&
                    columns.some((column) => noteFor === `${item.id}|${column.quoteId}`) && (
                      <tr className="border-t border-ink-100 bg-sky-50/50">
                        <td />
                        <td colSpan={2 + columns.length} className="px-3 py-2">
                          <div className="flex items-center gap-2">
                            <span className="shrink-0 text-[11px] text-ink-500">
                              {bidders.find((bidder) => bidder.quoteId === noteFor.split('|')[1])
                                ?.name ?? 'Bidder'}{' '}
                              · {item.title}
                            </span>
                            <input
                              autoFocus
                              value={noteDraft}
                              onChange={(event) => setNoteDraft(event.target.value)}
                              onKeyDown={(event) => {
                                if (event.key === 'Enter') void saveNote();
                                if (event.key === 'Escape') setNoteFor(null);
                              }}
                              placeholder="20ga assumed, not 18. Said they would revise Friday."
                              className="flex-1 rounded border border-ink-300 px-2 py-1 text-xs outline-none focus:border-ink-900"
                            />
                            <button
                              onClick={() => void saveNote()}
                              disabled={busy}
                              className="rounded-md bg-ink-900 px-2 py-1 text-xs font-medium text-white disabled:opacity-40"
                            >
                              Save
                            </button>
                            <button
                              onClick={() => setNoteFor(null)}
                              className="text-xs text-ink-400"
                            >
                              cancel
                            </button>
                          </div>
                        </td>
                      </tr>
                    )}
                </Fragment>
              ))}
            </tbody>
          ))}

          {scopeItems.length === 0 && (
            <tbody>
              <tr>
                <td colSpan={3 + columns.length} className="px-4 py-6 text-sm text-ink-400">
                  This package has no scope attached. Add scope items to it on the package Scope
                  step — a quote can only be levelled against a baseline.
                </td>
              </tr>
            </tbody>
          )}

          {scopeItems.length > 0 && (
            <tfoot>
              <tr className="border-t-2 border-ink-300 bg-ink-50 text-xs font-semibold">
                <td />
                <td className="px-3 py-2" colSpan={2}>
                  Tabbed total
                </td>
                {columns.map((column) => (
                  <td key={column.quoteId} className="px-3 py-2 text-right">
                    {money(columnTotal(column.quoteId))}
                  </td>
                ))}
              </tr>
              <tr className="bg-ink-50 text-xs text-ink-500">
                <td />
                <td className="px-3 pb-2" colSpan={2}>
                  Quoted total
                </td>
                {columns.map((column) => (
                  <td key={column.quoteId} className="px-3 pb-2 text-right">
                    {money(column.quotedTotal)}
                  </td>
                ))}
              </tr>
            </tfoot>
          )}
        </table>
      </div>

      <p className="text-xs text-ink-400">
        A tabbed total below the quoted total means lines are still unmapped, not that the sub is
        cheaper than they said. Normalise the quote before reading the difference as real.
      </p>

      {detail && <DetailView detail={detail} onClose={() => setDetail(null)} />}
    </section>
  );
}

/**
 * The drill-down for everything selected.
 *
 * Multi-select because a GC frequently buys several scopes under one contract,
 * and the scope wording matters as much as the number — an estimator opening
 * this is about to write a subcontract, and what the sub actually said is the
 * thing they need in front of them.
 */
function DetailView({ detail, onClose }: { detail: Detail; onClose: () => void }) {
  const lineFor = (scopeItemId: string, quoteId: string) =>
    detail.lines.filter(
      (line) => line.scope_item_id === scopeItemId && line.quote_id === quoteId,
    );

  const exclusionFor = (scopeItemId: string, quoteId: string) =>
    detail.exclusions.filter(
      (row) => row.scope_item_id === scopeItemId && row.quote_id === quoteId,
    );

  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-ink-900/20" onClick={onClose}>
      <div
        onClick={(event) => event.stopPropagation()}
        className="h-full w-full max-w-3xl overflow-y-auto border-l border-ink-300 bg-white shadow-2xl"
      >
        <header className="sticky top-0 flex items-center justify-between border-b border-ink-200 bg-white px-5 py-3">
          <div>
            <h3 className="text-sm font-semibold text-ink-900">
              {detail.scopeItems.length} scope item{detail.scopeItems.length === 1 ? '' : 's'} ·{' '}
              {detail.bidders.length} bidder{detail.bidders.length === 1 ? '' : 's'}
            </h3>
            <p className="text-xs text-ink-500">
              What each sub wrote, against what the scope actually says.
            </p>
          </div>
          <button onClick={onClose} className="text-xs text-ink-400 hover:text-ink-900">
            close
          </button>
        </header>

        <div className="space-y-5 px-5 py-4">
          {detail.scopeItems.map((item) => (
            <article key={item.id} className="rounded-lg border border-ink-200">
              <div className="border-b border-ink-200 bg-ink-50 px-3 py-2">
                <p className="font-mono text-[11px] text-ink-400">
                  {item.scope_id}
                  {item.csi_section ? ` · §${item.csi_section}` : ''}
                </p>
                <h4 className="text-sm font-medium text-ink-900">{item.title}</h4>
                {item.description && (
                  <p className="mt-1 whitespace-pre-wrap text-xs text-ink-600">
                    {item.description}
                  </p>
                )}
                <p className="mt-1 text-xs text-ink-500">
                  {item.quantity === null
                    ? 'Quantity not stated in the documents'
                    : `${item.quantity} ${item.unit ?? ''}${
                        item.quantity_basis ? ` — ${item.quantity_basis}` : ''
                      }`}
                </p>
              </div>

              <div className="divide-y divide-ink-100">
                {detail.bidders.map((bidder) => {
                  const lines = lineFor(item.id, bidder.quoteId);
                  const exclusions = exclusionFor(item.id, bidder.quoteId);

                  return (
                    <div key={bidder.quoteId} className="px-3 py-2">
                      <p className="text-xs font-medium text-ink-800">{bidder.name}</p>

                      {lines.length === 0 && exclusions.length === 0 && (
                        <p className="mt-1 text-xs text-ink-400">
                          Nothing mapped to this scope item.
                        </p>
                      )}

                      {lines.map((line) => (
                        <div
                          key={String(line.id)}
                          className="mt-1 flex items-baseline justify-between gap-3 text-xs"
                        >
                          <span className="text-ink-600">
                            {String(line.description ?? line.original_text ?? 'Unlabelled line')}
                            {line.is_lumped ? (
                              <span className="ml-1 text-amber-600" title="Lumped with other scope">
                                lumped
                              </span>
                            ) : null}
                          </span>
                          <span className="shrink-0 tabular-nums text-ink-800">
                            {money(typeof line.line_total === 'number' ? line.line_total : null)}
                          </span>
                        </div>
                      ))}

                      {exclusions.map((exclusion) => (
                        <p
                          key={String(exclusion.id)}
                          className="mt-1 rounded border border-amber-200 bg-amber-50 px-2 py-1 text-xs text-amber-800"
                        >
                          Excluded: {String(exclusion.excerpt ?? 'no wording captured')}
                          {exclusion.source_location ? (
                            <span className="text-amber-600">
                              {' '}
                              ({String(exclusion.source_location)})
                            </span>
                          ) : null}
                        </p>
                      ))}
                    </div>
                  );
                })}
              </div>
            </article>
          ))}
        </div>
      </div>
    </div>
  );
}

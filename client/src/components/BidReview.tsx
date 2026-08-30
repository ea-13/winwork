import { useCallback, useEffect, useState } from 'react';
import type { QuoteDocument } from 'shared';
import { ActivityStream } from './ActivityStream';
import { fileSize, money } from './Layout';
import { SplitBid } from './SplitBid';
import { apiGet, apiPatch, apiPost } from '../lib/api';

type Line = {
  id: string;
  description: string | null;
  original_text: string | null;
  qty: number | null;
  unit: string | null;
  line_total: number | null;
  scope_item_id: string | null;
  is_lumped: boolean;
  match_basis: string | null;
};

type Exclusion = { id: string; excerpt: string | null; source_location: string | null };
type Term = { id: string; term_key: string | null; term_value: string | null };
type ScopeItem = { id: string; scope_id: string; title: string };

type Read = {
  quote: { id: string; quotedTotal: number | null; status: string; bidder: string | null };
  lines: Line[];
  exclusions: Exclusion[];
  terms: Term[];
  scopeItems: ScopeItem[];
  published: boolean;
};

/**
 * One bid: what we read out of it, and what you do about it.
 *
 * This replaced a four-step strip reading Extract → Accept extraction →
 * Normalise → Accept mapping. Every one of those is a real operation, and not
 * one of them is a thing an estimator does — "normalise" and "accept mapping"
 * are our internal vocabulary leaking through the screen, and a button whose
 * name you have to be taught is a button that does not get pressed.
 *
 * What an estimator actually does is: read the bid, check what it says, fix
 * what is wrong, put it into the project. So that is what this is. The
 * extraction and the scope matching still happen — they are the same two model
 * passes as before, and the same gate at the end — but they happen behind one
 * verb each, with the results on screen and editable in between.
 */
export function BidReview({
  packageId,
  projectId,
  document,
  onError,
  onChanged,
}: {
  packageId: string;
  projectId: string | null;
  document: QuoteDocument;
  onError: (message: string | null) => void;
  onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<Read | null>(null);
  const [runId, setRunId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [rationale, setRationale] = useState('');
  const [editing, setEditing] = useState<{ id: string; field: string; value: string } | null>(null);

  const load = useCallback(async () => {
    setData(await apiGet<Read>(`/quotes/${document.id}/read`));
  }, [document.id]);

  useEffect(() => {
    if (open) load().catch((caught: Error) => onError(caught.message));
  }, [open, load, onError]);

  const guard = async (work: () => Promise<void>) => {
    setBusy(true);
    onError(null);
    try {
      await work();
      await load().catch(() => undefined);
      onChanged();
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  const read = () =>
    guard(async () => {
      const { runId: id } = await apiPost<{ runId: string }>(`/quotes/${document.id}/extract`);
      setRunId(id);
      setOpen(true);
    });

  /**
   * Publishes into the project.
   *
   * One press, three things: accept what was read, match the lines to your
   * scope, accept the matching. They were three buttons and they are one act —
   * nobody accepts an extraction and then declines to use it.
   */
  const publish = () =>
    guard(async () => {
      await apiPost<{ runId: string }>(`/quotes/${document.id}/publish`, {
        rationale: rationale.trim(),
      });
      setPublishing(false);
      setRationale('');
    });

  const save = () =>
    guard(async () => {
      if (!editing) return;
      const { id, field, value } = editing;
      setEditing(null);

      const patch: Record<string, unknown> =
        field === 'line_total' || field === 'qty'
          ? { [field]: value.replace(/[$,\s]/g, '') === '' ? null : Number(value.replace(/[$,\s]/g, '')) }
          : field === 'scope_item_id'
            ? { scope_item_id: value || null }
            : { [field]: value.trim() || null };

      await apiPatch(`/records/quote_line/${id}`, patch);
    });

  const cell = (line: Line, field: 'description' | 'line_total', width: string) => {
    const value = line[field];
    const active = editing?.id === line.id && editing.field === field;
    return (
      <td
        className={`cursor-text px-2 py-1 ${field === 'line_total' ? 'text-right' : ''} hover:bg-ink-50`}
        onClick={() => setEditing({ id: line.id, field, value: value === null ? '' : String(value) })}
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
            className={`${width} rounded border border-ink-800 px-1 outline-none ${
              field === 'line_total' ? 'text-right' : ''
            }`}
          />
        ) : field === 'line_total' ? (
          money(value as number | null)
        ) : (
          <span className="text-ink-800">{String(value ?? line.original_text ?? '—')}</span>
        )}
      </td>
    );
  };

  const status = document.status;
  const hasBeenRead = status === 'EXTRACTED' || status === 'MANUAL';

  return (
    <div className="rounded-xl border border-ink-200 bg-white">
      <div className="flex flex-wrap items-center gap-3 px-4 py-2.5">
        <button
          onClick={() => setOpen((value) => !value)}
          className="min-w-0 flex-1 text-left"
        >
          <span className="block truncate text-[13px] font-medium text-ink-900">
            {document.sourceFilename ?? 'Bid entered by hand'}
          </span>
          <span className="text-xs text-ink-400">
            {fileSize(document.sourceSizeBytes)}
            {data?.quote.bidder ? ` · ${data.quote.bidder}` : ''}
            {data?.quote.quotedTotal != null ? ` · ${money(data.quote.quotedTotal)}` : ''}
          </span>
        </button>

        <span
          className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${
            data?.published
              ? 'bg-emerald-100 text-emerald-800'
              : hasBeenRead
                ? 'bg-flag-100 text-flag-700'
                : 'bg-ink-100 text-ink-600'
          }`}
        >
          {data?.published ? 'in the project' : hasBeenRead ? 'read, not published' : 'not read yet'}
        </span>

        {!hasBeenRead && (
          <button
            onClick={() => void read()}
            disabled={busy}
            className="rounded-md bg-ink-900 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-40"
          >
            {busy ? 'Reading…' : 'Read the bid'}
          </button>
        )}

        {hasBeenRead && !data?.published && !publishing && (
          <button
            onClick={() => setPublishing(true)}
            disabled={busy}
            className="rounded-md bg-ink-900 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-40"
            title="Accepts what was read, matches it to your scope, and puts it in the comparison"
          >
            Publish to project
          </button>
        )}

        {publishing && (
          <span className="flex items-center gap-1">
            <input
              autoFocus
              value={rationale}
              onChange={(event) => setRationale(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && rationale.trim()) void publish();
                if (event.key === 'Escape') setPublishing(false);
              }}
              placeholder="Why are you accepting this?"
              className="w-56 rounded border border-ink-300 px-2 py-1 text-xs outline-none focus:border-ink-800"
            />
            <button
              disabled={busy || rationale.trim() === ''}
              onClick={() => void publish()}
              className="rounded bg-ink-900 px-2 py-1 text-xs font-medium text-white disabled:opacity-40"
            >
              {busy ? '…' : 'Publish'}
            </button>
            <button onClick={() => setPublishing(false)} className="px-1 text-xs text-ink-400">
              cancel
            </button>
          </span>
        )}

        <button onClick={() => setOpen((value) => !value)} className="text-xs text-ink-400">
          {open ? 'hide' : 'show'}
        </button>
      </div>

      {open && (
        <div className="space-y-3 border-t border-ink-100 px-4 py-3">
          {runId && <ActivityStream runId={runId} />}

          {!data && <p className="text-xs text-ink-400">Loading…</p>}

          {data && !hasBeenRead && (
            <p className="text-xs text-ink-400">
              Nothing read out of this bid yet. Press <b>Read the bid</b> — it pulls out the lines,
              the exclusions and the terms, and shows them here before anything touches the project.
            </p>
          )}

          {data && projectId && (
            <SplitBid
              quoteId={document.id}
              projectId={projectId}
              onError={onError}
              onChanged={onChanged}
            />
          )}

          {data && hasBeenRead && (
            <>
              <div>
                <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-ink-400">
                  Lines · {data.lines.length}
                  <span className="ml-2 font-normal normal-case text-ink-400">
                    click any cell to correct it before publishing
                  </span>
                </p>
                <table className="w-full text-xs">
                  <tbody>
                    {data.lines.map((line) => (
                      <tr key={line.id} className="border-b border-ink-50 last:border-0">
                        {cell(line, 'description', 'w-full')}
                        <td className="w-56 px-2 py-1">
                          <select
                            value={line.scope_item_id ?? ''}
                            onChange={(event) =>
                              void guard(async () => {
                                await apiPatch(`/records/quote_line/${line.id}`, {
                                  scope_item_id: event.target.value || null,
                                });
                              })
                            }
                            className={`w-full rounded border px-1 py-0.5 text-[11px] ${
                              line.scope_item_id ? 'border-ink-200' : 'border-flag-500 text-flag-700'
                            }`}
                            title="Which scope item this line pays for"
                          >
                            <option value="">— not matched —</option>
                            {data.scopeItems.map((item) => (
                              <option key={item.id} value={item.id}>
                                {item.scope_id} {item.title}
                              </option>
                            ))}
                          </select>
                        </td>
                        {cell(line, 'line_total', 'w-24')}
                      </tr>
                    ))}
                    {data.lines.length === 0 && (
                      <tr>
                        <td className="py-2 text-ink-400">
                          No priced lines were found. That is common on a lump-sum quote — the total
                          still levels, it just cannot be compared item by item.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>

              {data.exclusions.length > 0 && (
                <div>
                  <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-flag-700">
                    Exclusions · {data.exclusions.length}
                    <span className="ml-2 font-normal normal-case text-ink-400">
                      the part nobody reads to the end of, and where the overruns live
                    </span>
                  </p>
                  <ul className="space-y-0.5">
                    {data.exclusions.map((exclusion) => (
                      <li key={exclusion.id} className="text-xs text-ink-700">
                        <span className="text-flag-700">·</span> {exclusion.excerpt}
                        {exclusion.source_location && (
                          <span className="ml-1 text-ink-400">({exclusion.source_location})</span>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {data.terms.length > 0 && (
                <div>
                  <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-ink-400">
                    Terms · {data.terms.length}
                  </p>
                  <ul className="grid gap-0.5 sm:grid-cols-2">
                    {data.terms.map((term) => (
                      <li key={term.id} className="text-xs text-ink-600">
                        <span className="text-ink-400">{term.term_key}:</span> {term.term_value}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

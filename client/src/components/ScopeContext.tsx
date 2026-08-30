import { useCallback, useEffect, useState } from 'react';
import { apiGet, apiPatch, apiPost } from '../lib/api';
import { money } from './Layout';

type Record_ = {
  caughtGap: number;
  pricedByAll: number;
  excludedByBidder: number;
  changeOrders: number;
};

type ContextLine = {
  id: string;
  scope_item_id: string;
  kind: string;
  text: string;
  origin: string;
  source_location: string | null;
  gap_pattern_id: string | null;
  confidence: number | null;
  is_active: boolean;
  retired_reason: string | null;
  pattern: {
    id: string;
    text: string;
    division: string;
    csi_section: string | null;
    times_proposed: number;
    times_confirmed: number;
  } | null;
  record: Record_;
};

type Missed = {
  id: string;
  context_id: string | null;
  outcome: string;
  amount: number | null;
  note: string | null;
  recorded_at: string;
};

const KINDS = [
  { value: 'INCLUSION', label: 'Includes', style: 'bg-emerald-100 text-emerald-800' },
  { value: 'EXCLUSION', label: 'Excludes', style: 'bg-red-100 text-red-800' },
  { value: 'INTERFACE', label: 'Interface', style: 'bg-violet-100 text-violet-800' },
  { value: 'ASSUMPTION', label: 'Assumes', style: 'bg-sky-100 text-sky-800' },
  { value: 'RISK', label: 'Risk', style: 'bg-amber-100 text-amber-800' },
  { value: 'BASIS_OF_DESIGN', label: 'Basis', style: 'bg-ink-200 text-ink-700' },
] as const;

const styleFor = (kind: string) =>
  KINDS.find((entry) => entry.value === kind)?.style ?? 'bg-ink-100 text-ink-600';

const labelFor = (kind: string) =>
  KINDS.find((entry) => entry.value === kind)?.label ?? kind.toLowerCase();

const ORIGIN_HINT: Record<string, string> = {
  DOCUMENT: 'read off the bid set',
  PATTERN: 'division knowledge',
  HISTORY: 'a past job taught us this',
  HUMAN: 'written by an estimator',
};

/**
 * How well a context line has actually done.
 *
 * Shown as a plain count, never as a percentage or a score. "Caught 3" is a
 * fact an estimator can check; "87% reliable" is a number with a model's
 * opinion buried in it, and the first time it is wrong nobody trusts any of
 * them again.
 *
 * A line with no record says so rather than showing a zero. Untested and
 * failed are very different, and a zero reads as failed.
 */
function TrackRecord({ record }: { record: Record_ }) {
  const tested = record.caughtGap + record.pricedByAll + record.changeOrders;

  if (tested === 0) {
    return <span className="text-[11px] text-ink-300">not yet tested</span>;
  }

  return (
    <span className="flex flex-wrap items-center gap-1.5 text-[11px]">
      {record.caughtGap > 0 && (
        <span className="rounded bg-emerald-50 px-1 text-emerald-700" title="A gap opened where this warned it might">
          caught {record.caughtGap}
        </span>
      )}
      {record.changeOrders > 0 && (
        <span className="rounded bg-red-50 px-1 text-red-700" title="A change order came back here anyway">
          CO {record.changeOrders}
        </span>
      )}
      {record.pricedByAll > 0 && (
        <span className="text-ink-400" title="Every bidder carried it and nothing came loose">
          held {record.pricedByAll}
        </span>
      )}
    </span>
  );
}

/**
 * The context underneath one scope item.
 *
 * This is the layer where scope actually goes missing. "Metal stud framing,
 * 4,200 SF" is enough to check that somebody priced framing; it is not enough
 * to check that anybody priced the head-of-wall detail, and the head-of-wall
 * detail is the change order.
 *
 * Every line says where it came from and how it has done. Both matter: an
 * estimator will act on "this cost us money on two past jobs" and will
 * reasonably ignore an unattributed assertion, and showing the difference is
 * what keeps them reading.
 */
export function ScopeContext({
  scopeItemId,
  scopeLabel,
  onError,
}: {
  scopeItemId: string;
  scopeLabel: string;
  onError: (message: string | null) => void;
}) {
  const [lines, setLines] = useState<ContextLine[]>([]);
  const [missed, setMissed] = useState<Missed[]>([]);
  const [adding, setAdding] = useState(false);
  const [kind, setKind] = useState<string>('INCLUSION');
  const [text, setText] = useState('');
  const [editing, setEditing] = useState<{ id: string; value: string } | null>(null);
  const [retiring, setRetiring] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [showRetired, setShowRetired] = useState(false);
  const [promoting, setPromoting] = useState<string | null>(null);
  const [patternText, setPatternText] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const data = await apiGet<{ lines: ContextLine[]; missed: Missed[] }>(
      `/scope-items/${scopeItemId}/context`,
    );
    setLines(data.lines);
    setMissed(data.missed);
  }, [scopeItemId]);

  useEffect(() => {
    load().catch((caught: Error) => onError(caught.message));
  }, [load, onError]);

  const guard = async (work: () => Promise<void>) => {
    setBusy(true);
    onError(null);
    try {
      await work();
      await load();
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  const add = () =>
    guard(async () => {
      await apiPost(`/scope-items/${scopeItemId}/context`, { kind, text: text.trim() });
      setText('');
      setAdding(false);
    });

  const saveEdit = () =>
    guard(async () => {
      if (!editing) return;
      await apiPatch(`/records/scope_context/${editing.id}`, { text: editing.value.trim() });
      setEditing(null);
    });

  const retire = (id: string) =>
    guard(async () => {
      await apiPost(`/context/${id}/retire`, { reason: reason.trim() });
      setRetiring(null);
      setReason('');
    });

  const active = lines.filter((line) => line.is_active);
  const retired = lines.filter((line) => !line.is_active);

  return (
    <div className="space-y-2 rounded-lg border border-ink-200 bg-ink-50/60 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs font-medium text-ink-700">
          What {scopeLabel} actually means
          <span className="ml-2 font-normal text-ink-400">
            {active.length} line{active.length === 1 ? '' : 's'}
          </span>
        </p>
        <div className="flex items-center gap-2">
          {retired.length > 0 && (
            <button
              onClick={() => setShowRetired((current) => !current)}
              className="text-[11px] text-ink-400 underline"
            >
              {showRetired ? 'hide' : `${retired.length} retired`}
            </button>
          )}
          <button
            onClick={() => setAdding((current) => !current)}
            className="rounded-md border border-ink-300 bg-white px-2 py-0.5 text-xs text-ink-700"
          >
            + line
          </button>
        </div>
      </div>

      {missed.length > 0 && (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-2.5 py-2">
          <p className="text-xs font-medium text-amber-900">
            {missed.length} gap{missed.length === 1 ? '' : 's'} opened here with nothing written
            against {missed.length === 1 ? 'it' : 'them'}
          </p>
          {missed.slice(0, 3).map((entry, index) => (
            <p key={index} className="mt-0.5 text-[11px] text-amber-800">
              {entry.note}
              {entry.amount ? ` — ${money(entry.amount)} exposure` : ''}
            </p>
          ))}
          <p className="mt-1 text-[11px] text-amber-700">
            This is the seam the system did not know about.
          </p>

          {/* Closing the loop. A missed gap becomes a pattern the drafter will
              reach for on the next job — but a person writes it, because a
              system that promotes its own failures into rules unsupervised
              gets worse in a way nobody notices until it is expensive. */}
          {(() => {
            const first = missed[0];
            if (!first) return null;
            return promoting === first.id ? (
              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                <input
                  autoFocus
                  value={patternText}
                  onChange={(event) => setPatternText(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Escape') setPromoting(null);
                  }}
                  placeholder="Write it as you would want to read it next job"
                  className="min-w-[18rem] flex-1 rounded border border-flag-500 px-2 py-1 text-[11px] outline-none"
                />
                <button
                  disabled={busy || patternText.trim() === ''}
                  onClick={() =>
                    void guard(async () => {
                      await apiPost(`/context/outcomes/${first.id}/promote`, {
                        text: patternText.trim(),
                      });
                      setPromoting(null);
                      setPatternText('');
                    })
                  }
                  className="rounded bg-flag-700 px-2 py-1 text-[11px] font-medium text-white disabled:opacity-40"
                >
                  Add pattern
                </button>
                <button
                  onClick={() => setPromoting(null)}
                  className="px-1 text-[11px] text-flag-500"
                >
                  cancel
                </button>
              </div>
            ) : (
              <button
                onClick={() => {
                  setPromoting(first.id);
                  setPatternText('');
                }}
                className="mt-1.5 rounded-md border border-flag-500 px-2 py-1 text-[11px] font-medium text-flag-700"
              >
                Make this a pattern for next time
              </button>
            );
          })()}
        </div>
      )}

      {adding && (
        <div className="flex flex-wrap items-center gap-1.5 rounded-md border border-ink-200 bg-white p-2">
          <select
            value={kind}
            onChange={(event) => setKind(event.target.value)}
            className="rounded border border-ink-300 px-1.5 py-1 text-xs"
          >
            {KINDS.map((entry) => (
              <option key={entry.value} value={entry.value}>
                {entry.label}
              </option>
            ))}
          </select>
          <input
            autoFocus
            value={text}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && text.trim() !== '') void add();
              if (event.key === 'Escape') setAdding(false);
            }}
            placeholder="Deflection track at head of all full-height partitions"
            className="min-w-[18rem] flex-1 rounded border border-ink-300 px-2 py-1 text-xs outline-none focus:border-ink-900"
          />
          <button
            onClick={() => void add()}
            disabled={busy || text.trim() === ''}
            className="rounded-md bg-ink-900 px-2 py-1 text-xs font-medium text-white disabled:opacity-40"
          >
            Add
          </button>
        </div>
      )}

      {active.length === 0 && !adding && (
        <p className="text-xs text-ink-400">
          Nothing written yet. Draft it from the Scope step, or add the first line by hand — this
          is what a sub&apos;s quote gets checked against.
        </p>
      )}

      <ul className="space-y-1.5">
        {active.map((line) => (
          <li key={line.id} className="rounded-md border border-ink-200 bg-white px-2.5 py-1.5">
            <div className="flex items-start gap-2">
              <span
                className={`mt-0.5 shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium ${styleFor(line.kind)}`}
              >
                {labelFor(line.kind)}
              </span>

              <div className="min-w-0 flex-1">
                {editing?.id === line.id ? (
                  <input
                    autoFocus
                    value={editing.value}
                    onChange={(event) => setEditing({ ...editing, value: event.target.value })}
                    onBlur={() => void saveEdit()}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') void saveEdit();
                      if (event.key === 'Escape') setEditing(null);
                    }}
                    className="w-full rounded border border-ink-900 px-1 py-0.5 text-xs outline-none"
                  />
                ) : (
                  <p
                    onClick={() => setEditing({ id: line.id, value: line.text })}
                    className="cursor-text text-xs text-ink-800"
                  >
                    {line.text}
                  </p>
                )}

                <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span
                    className="text-[11px] text-ink-400"
                    title={ORIGIN_HINT[line.origin] ?? line.origin}
                  >
                    {ORIGIN_HINT[line.origin] ?? line.origin.toLowerCase()}
                    {line.source_location ? ` · ${line.source_location}` : ''}
                  </span>
                  <TrackRecord record={line.record} />
                  {line.pattern && line.pattern.times_proposed > 0 && (
                    <span
                      className="text-[11px] text-ink-400"
                      title={line.pattern.text}
                    >
                      pattern confirmed {line.pattern.times_confirmed}/
                      {line.pattern.times_proposed}
                    </span>
                  )}
                </div>
              </div>

              <button
                onClick={() => setRetiring(retiring === line.id ? null : line.id)}
                className="shrink-0 text-[11px] text-ink-300 hover:text-ink-600"
                title="Retire this line"
              >
                retire
              </button>
            </div>

            {retiring === line.id && (
              <div className="mt-2 flex items-center gap-1.5 border-t border-ink-100 pt-2">
                <input
                  autoFocus
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && reason.trim() !== '') void retire(line.id);
                    if (event.key === 'Escape') setRetiring(null);
                  }}
                  placeholder="Why does this not apply here?"
                  className="flex-1 rounded border border-ink-300 px-2 py-1 text-xs outline-none focus:border-ink-900"
                />
                <button
                  onClick={() => void retire(line.id)}
                  disabled={busy || reason.trim() === ''}
                  className="rounded-md bg-ink-900 px-2 py-1 text-xs font-medium text-white disabled:opacity-40"
                >
                  Retire
                </button>
              </div>
            )}
          </li>
        ))}
      </ul>

      {showRetired &&
        retired.map((line) => (
          <p key={line.id} className="px-2.5 text-[11px] text-ink-400 line-through">
            {labelFor(line.kind)}: {line.text}
            <span className="ml-2 no-underline">— {line.retired_reason}</span>
          </p>
        ))}
    </div>
  );
}

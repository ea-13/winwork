import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ActivityStream } from './ActivityStream';
import { apiGet, apiPost } from '../lib/api';

type Suggestion = {
  id: string;
  kind: 'AGENT' | 'HUMAN';
  title: string;
  why: string;
  urgency: 'BLOCKING' | 'HIGH' | 'NORMAL';
  step: string;
  packageId?: string;
  packageName?: string;
  action?: { path: string; body?: Record<string, unknown> };
  estimate?: string;
};

const URGENCY: Record<string, { dot: string; label: string }> = {
  BLOCKING: { dot: 'bg-red-500', label: 'blocking' },
  HIGH: { dot: 'bg-flag-500', label: '' },
  NORMAL: { dot: 'bg-ink-300', label: '' },
};

/**
 * What the tool would do next, and why.
 *
 * Seven agents existed before this and every one was a button on a screen you
 * had to think to visit. That is a tool that HAS AI, and it only works for
 * somebody who has already been taught it. This is the difference: the work the
 * system can do is offered where you are, with its reasoning attached, and you
 * press it or you don't.
 *
 * Every suggestion states a reason in the estimator's own terms rather than an
 * instruction. "Run the extractor" is a command; "three bids are sitting unread,
 * so the comparison below is missing two of them" is an argument, and an
 * argument is something you can disagree with. A copilot you cannot disagree
 * with is one you stop reading.
 *
 * The ordering is rules over real state, not a model's guess — see
 * server/src/lib/suggestions.ts.
 */
export function Copilot({
  projectId,
  refreshKey,
  onDid,
}: {
  projectId: string;
  refreshKey?: number;
  onDid?: () => void;
}) {
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [open, setOpen] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [runId, setRunId] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();

  const load = useCallback(async () => {
    if (!projectId) return;
    try {
      setSuggestions(await apiGet<Suggestion[]>(`/projects/${projectId}/suggestions`));
    } catch {
      setSuggestions([]);
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  const run = async (suggestion: Suggestion) => {
    if (!suggestion.action) {
      // Nothing to POST — this is a human step. Take them to it.
      navigate(
        suggestion.packageId
          ? `/packages/${suggestion.packageId}?step=${suggestion.step}`
          : `/projects/${projectId}?step=${suggestion.step}`,
      );
      return;
    }

    setBusy(suggestion.id);
    setError(null);
    try {
      const result = await apiPost<{ runId?: string; note?: string }>(
        suggestion.action.path,
        suggestion.action.body ?? {},
      );
      if (result.runId) setRunId(result.runId);
      if (result.note) setError(result.note);
      await load();
      onDid?.();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(null);
    }
  };

  const shown = suggestions.filter((suggestion) => !dismissed.has(suggestion.id));

  if (shown.length === 0) {
    return null;
  }

  return (
    <section className="rounded-xl border border-ink-200 bg-white">
      <button
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center justify-between px-4 py-2.5 text-left"
      >
        <span className="flex items-baseline gap-2">
          <span className="text-[13px] font-semibold text-ink-900">Next</span>
          <span className="text-xs text-ink-400">
            {shown.length} thing{shown.length === 1 ? '' : 's'} worth doing
            {shown.some((s) => s.urgency === 'BLOCKING') && (
              <span className="ml-2 font-medium text-red-700">
                {shown.filter((s) => s.urgency === 'BLOCKING').length} blocking
              </span>
            )}
          </span>
        </span>
        <span className="text-xs text-ink-400">{open ? 'hide' : 'show'}</span>
      </button>

      {open && (
        <div className="divide-y divide-ink-100 border-t border-ink-100">
          {shown.map((suggestion) => (
            <div key={suggestion.id} className="flex items-start gap-3 px-4 py-2.5">
              <span
                className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${
                  URGENCY[suggestion.urgency]?.dot ?? 'bg-ink-300'
                }`}
              />

              <div className="min-w-0 flex-1">
                <p className="text-xs font-medium text-ink-900">
                  {suggestion.title}
                  {suggestion.kind === 'AGENT' && (
                    <span className="ml-2 rounded bg-ink-100 px-1.5 py-0.5 text-[10px] font-normal text-ink-500">
                      agent
                    </span>
                  )}
                  {URGENCY[suggestion.urgency]?.label ? (
                    <span className="ml-1.5 text-[10px] font-normal text-red-700">
                      {URGENCY[suggestion.urgency]?.label}
                    </span>
                  ) : null}
                </p>
                <p className="mt-0.5 text-[11px] leading-snug text-ink-500">{suggestion.why}</p>
                {suggestion.estimate && (
                  <p className="mt-0.5 text-[10px] text-ink-400">takes {suggestion.estimate}</p>
                )}
              </div>

              <div className="flex shrink-0 items-center gap-2">
                <button
                  onClick={() => void run(suggestion)}
                  disabled={busy === suggestion.id}
                  className={`rounded-md px-2.5 py-1 text-xs font-medium disabled:opacity-40 ${
                    suggestion.kind === 'AGENT'
                      ? 'bg-ink-900 text-white'
                      : 'border border-ink-300 text-ink-700'
                  }`}
                >
                  {busy === suggestion.id ? '…' : suggestion.kind === 'AGENT' ? 'Do it' : 'Go'}
                </button>
                <button
                  onClick={() =>
                    setDismissed((current) => new Set(current).add(suggestion.id))
                  }
                  className="text-[11px] text-ink-300 hover:text-ink-600"
                  title="Hide until the state changes"
                >
                  skip
                </button>
              </div>
            </div>
          ))}

          {error && (
            <p className="px-4 py-2 text-[11px] text-flag-700">{error}</p>
          )}

          {runId && (
            <div className="px-4 py-2">
              <ActivityStream runId={runId} />
            </div>
          )}
        </div>
      )}
    </section>
  );
}

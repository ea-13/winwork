import { useCallback, useEffect, useState } from 'react';
import { ActivityStream } from './ActivityStream';
import { apiGet } from '../lib/api';

type Run = {
  id: string;
  agent_type: string;
  status: string;
  input_ref: string | null;
  started_at: string | null;
  finished_at: string | null;
  token_cost: number | null;
};

const LABEL: Record<string, string> = {
  draft_scope: 'Drafting scope',
  index_sheets: 'Indexing sheets',
  draft_scope_context: 'Writing scope context',
  audit_coverage: 'Auditing coverage',
  compare_bids: 'Comparing bids',
  map_cost_codes: 'Mapping cost codes',
  extract_quote: 'Reading a bid',
  normalise_quote: 'Matching to scope',
  co_archaeology: 'Reading change orders',
  division_consult: 'Asking an expert',
};

/**
 * Work happening right now, wherever you are.
 *
 * The worker polls the job queue inside the server process, so a run has never
 * depended on a browser staying open — it survives navigation, a reload, and
 * closing the laptop. What did not survive was the run id, which lived in the
 * state of whichever component started it. Leave the page and the work carried
 * on, invisibly, still costing money, with no way to look at it again.
 *
 * So this asks the SERVER what is running rather than remembering it locally.
 * Progress becomes a property of the project instead of one browser tab, which
 * is what it always was underneath.
 *
 * Recently finished runs linger for a few minutes. Something that completed
 * while you were on another screen should not vanish having never been seen.
 */
export function RunningWork({ projectId }: { projectId: string | null }) {
  const [running, setRunning] = useState<Run[]>([]);
  const [finished, setFinished] = useState<Run[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    if (!projectId) return;
    try {
      const data = await apiGet<{ running: Run[]; recentlyFinished: Run[] }>(
        `/projects/${projectId}/runs/active`,
      );
      setRunning(data.running);
      setFinished(data.recentlyFinished);
    } catch {
      setRunning([]);
      setFinished([]);
    }
  }, [projectId]);

  useEffect(() => {
    void load();
    // Polled rather than streamed: this is a status light, and one SSE
    // connection per screen for a list that changes every few minutes would be
    // a lot of machinery for a dot.
    const timer = window.setInterval(() => void load(), running.length > 0 ? 4000 : 15000);
    return () => window.clearInterval(timer);
  }, [load, running.length]);

  const shown = [...running, ...finished.filter((run) => !dismissed.has(run.id))];
  if (shown.length === 0) return null;

  return (
    <div className="fixed bottom-5 left-5 z-40 w-80 max-w-[90vw] space-y-1.5">
      {shown.map((run) => {
        const active = run.status === 'QUEUED' || run.status === 'RUNNING';
        const failed = run.status === 'FAILED';

        return (
          <div
            key={run.id}
            className={`rounded-lg border bg-white shadow-lg ${
              failed ? 'border-red-200' : active ? 'border-ink-300' : 'border-emerald-200'
            }`}
          >
            <div className="flex items-center gap-2 px-3 py-2">
              <span
                className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                  failed
                    ? 'bg-red-500'
                    : active
                      ? 'animate-pulse bg-ink-800'
                      : 'bg-emerald-500'
                }`}
              />

              <button
                onClick={() => setOpen(open === run.id ? null : run.id)}
                className="min-w-0 flex-1 text-left"
              >
                <span className="block truncate text-xs font-medium text-ink-900">
                  {LABEL[run.agent_type] ?? run.agent_type.replace(/_/g, ' ')}
                  {failed && <span className="ml-1.5 text-red-700">failed</span>}
                  {!active && !failed && <span className="ml-1.5 text-emerald-700">done</span>}
                </span>
                {run.input_ref && (
                  <span className="block truncate text-[10px] text-ink-400">{run.input_ref}</span>
                )}
              </button>

              {run.token_cost != null && (
                <span className="shrink-0 text-[10px] tabular-nums text-ink-400">
                  ${Number(run.token_cost).toFixed(2)}
                </span>
              )}

              {!active && (
                <button
                  onClick={() => setDismissed((current) => new Set(current).add(run.id))}
                  className="shrink-0 text-[11px] text-ink-300 hover:text-ink-700"
                >
                  ×
                </button>
              )}
            </div>

            {open === run.id && (
              <div className="max-h-64 overflow-y-auto border-t border-ink-100 px-3 py-2">
                {/* The stream replays from the beginning, so opening this after
                    the fact shows the whole run rather than only what is left. */}
                <ActivityStream runId={run.id} />
              </div>
            )}
          </div>
        );
      })}

      {running.length > 0 && (
        <p className="px-1 text-[10px] text-ink-400">
          Keep working — this runs on the server and does not need this page open.
        </p>
      )}
    </div>
  );
}

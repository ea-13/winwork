import { useCallback, useEffect, useState } from 'react';
import { ActivityStream } from './ActivityStream';
import { apiGet, apiPost } from '../lib/api';

type Run = {
  id: string;
  agent_type: string;
  status: string;
  input_ref: string | null;
  started_at: string | null;
  finished_at: string | null;
  token_cost: number | null;
  jobId: string | null;
  jobStatus: string | null;
  priority: number;
  attempts: number;
  maxAttempts: number;
  lastError: string | null;
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

/** Remembered per browser, because a panel you hid should stay hidden. */
const HIDDEN_KEY = 'winprojects.runningWork.hidden';

const readHidden = (): boolean => {
  try {
    return window.localStorage.getItem(HIDDEN_KEY) === '1';
  } catch {
    return false;
  }
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
 * IT CAN BE PUT AWAY, and it can be acted on. Both were missing and both are
 * the same complaint: a panel that covers the corner of every screen, that you
 * cannot dismiss and cannot do anything with, is an interruption pretending to
 * be a feature. Collapsed it is one line. Open it can cancel, reprioritise and
 * retry — which are operations on the JOB, not the run, so each row carries the
 * job behind it.
 */
export function RunningWork({ projectId }: { projectId: string | null }) {
  const [running, setRunning] = useState<Run[]>([]);
  const [finished, setFinished] = useState<Run[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const [hidden, setHidden] = useState(readHidden);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

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

  const setHiddenPersisted = (value: boolean) => {
    setHidden(value);
    try {
      window.localStorage.setItem(HIDDEN_KEY, value ? '1' : '0');
    } catch {
      // A browser that refuses storage still gets a working toggle for this
      // session. Nothing here is worth failing over.
    }
  };

  const act = async (jobId: string, path: string, body?: Record<string, unknown>) => {
    setBusy(jobId);
    setNote(null);
    try {
      const result = await apiPost<{ note?: string }>(`/jobs/${jobId}/${path}`, body ?? {});
      if (result.note) setNote(result.note);
      await load();
    } catch (caught) {
      setNote(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(null);
    }
  };

  const shown = [...running, ...finished.filter((run) => !dismissed.has(run.id))];
  if (shown.length === 0) return null;

  const active = running.length;

  // Put away: one line, bottom-left, out of the way of the work. It still shows
  // a count and still pulses, because hiding it must not mean losing track of
  // money being spent.
  if (hidden) {
    return (
      <button
        onClick={() => setHiddenPersisted(false)}
        className="fixed bottom-5 left-5 z-40 flex items-center gap-2 rounded-full border border-ink-300 bg-white px-3 py-1.5 text-xs text-ink-600 shadow-md hover:border-ink-400"
        title="Show what is running"
      >
        <span
          className={`h-1.5 w-1.5 rounded-full ${
            active > 0 ? 'animate-pulse bg-ink-800' : 'bg-emerald-500'
          }`}
        />
        {active > 0 ? `${active} running` : `${shown.length} finished`}
      </button>
    );
  }

  return (
    <div className="fixed bottom-5 left-5 z-40 w-80 max-w-[90vw] space-y-1.5">
      {shown.map((run) => {
        const live = run.status === 'QUEUED' || run.status === 'RUNNING';
        const failed = run.status === 'FAILED' || run.jobStatus === 'CANCELLED';
        const queued = run.jobStatus === 'QUEUED';
        const canRetry = Boolean(run.jobId) && !live;
        const working = busy === run.jobId;

        return (
          <div
            key={run.id}
            className={`rounded-lg border bg-white shadow-lg ${
              failed ? 'border-red-200' : live ? 'border-ink-300' : 'border-emerald-200'
            }`}
          >
            <div className="flex items-center gap-2 px-3 py-2">
              <span
                className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                  failed ? 'bg-red-500' : live ? 'animate-pulse bg-ink-800' : 'bg-emerald-500'
                }`}
              />

              <button
                onClick={() => setOpen(open === run.id ? null : run.id)}
                className="min-w-0 flex-1 text-left"
              >
                <span className="block truncate text-xs font-medium text-ink-900">
                  {LABEL[run.agent_type] ?? run.agent_type.replace(/_/g, ' ')}
                  {run.jobStatus === 'CANCELLED' && (
                    <span className="ml-1.5 text-ink-500">cancelled</span>
                  )}
                  {run.status === 'FAILED' && <span className="ml-1.5 text-red-700">failed</span>}
                  {!live && run.status === 'DONE' && (
                    <span className="ml-1.5 text-emerald-700">done</span>
                  )}
                  {queued && <span className="ml-1.5 text-ink-400">queued</span>}
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

              {!live && (
                <button
                  onClick={() => setDismissed((current) => new Set(current).add(run.id))}
                  className="shrink-0 text-[11px] text-ink-300 hover:text-ink-700"
                  title="Dismiss"
                >
                  ×
                </button>
              )}
            </div>

            {/* What you can do about it. Every one of these is an operation on
                the job, and each says plainly what it will and will not do —
                a running model call cannot be interrupted, and claiming
                otherwise while the money is still being spent would be a lie
                the interface tells. */}
            {run.jobId && (
              <div className="flex flex-wrap items-center gap-1 border-t border-ink-100 px-3 py-1.5">
                {queued && (
                  <button
                    disabled={working}
                    onClick={() => void act(run.jobId as string, 'priority', { direction: 'up' })}
                    className="rounded border border-ink-200 px-1.5 py-0.5 text-[10px] text-ink-600 hover:border-ink-400 disabled:opacity-40"
                    title="Move to the front of the queue"
                  >
                    ↑ first
                  </button>
                )}
                {live && (
                  <button
                    disabled={working}
                    onClick={() => void act(run.jobId as string, 'cancel')}
                    className="rounded border border-ink-200 px-1.5 py-0.5 text-[10px] text-ink-600 hover:border-red-300 hover:text-red-700 disabled:opacity-40"
                    title="Stops before the next batch. A request already in flight finishes."
                  >
                    Cancel
                  </button>
                )}
                {canRetry && (
                  <button
                    disabled={working}
                    onClick={() => void act(run.jobId as string, 'retry')}
                    className="rounded border border-ink-200 px-1.5 py-0.5 text-[10px] text-ink-600 hover:border-ink-400 disabled:opacity-40"
                    title="Queue it again at the front. The failed run and its error are kept."
                  >
                    Run again
                  </button>
                )}
                {run.attempts > 1 && (
                  <span className="text-[10px] text-ink-400">
                    attempt {run.attempts} of {run.maxAttempts}
                  </span>
                )}
                {working && <span className="text-[10px] text-ink-400">…</span>}
              </div>
            )}

            {run.lastError && (
              <p className="border-t border-ink-100 px-3 py-1.5 text-[10px] leading-snug text-red-700">
                {run.lastError}
              </p>
            )}

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

      {note && (
        <p className="rounded-lg border border-ink-200 bg-white px-3 py-1.5 text-[10px] leading-snug text-ink-600 shadow">
          {note}
        </p>
      )}

      <div className="flex items-center justify-between px-1">
        <span className="text-[10px] text-ink-400">
          {active > 0 ? 'Runs on the server — this page need not stay open.' : ' '}
        </span>
        <button
          onClick={() => setHiddenPersisted(true)}
          className="text-[10px] text-ink-400 underline hover:text-ink-700"
        >
          hide
        </button>
      </div>
    </div>
  );
}

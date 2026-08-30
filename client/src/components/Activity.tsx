import { useCallback, useEffect, useState } from 'react';
import { ActivityStream } from './ActivityStream';
import { apiGet, apiPost } from '../lib/api';

type Job = {
  id: string;
  label: string;
  jobType: string;
  status: string;
  priority: number;
  attempts: number;
  maxAttempts: number;
  lastError: string | null;
  runId: string | null;
  inputRef: string | null;
  cost: number | null;
  position?: number;
};

type Queue = { running: Job[]; queued: Job[]; finished: Job[] };

/**
 * What the agents are doing, and what to do about it.
 *
 * Agents are the slow, expensive part of this product, and until now they were
 * also the invisible part: you pressed something, a stream appeared, and if you
 * navigated away it was gone. There was no queue to look at, nothing to stop,
 * and no way to say "that one matters more" — which matters the moment somebody
 * queues a coverage audit across a plan set and then needs a bid comparison for
 * a meeting in ten minutes.
 *
 * Stopping a running job is honest about what it can do: the request already in
 * flight finishes, because there is no way to interrupt one, and it stops before
 * the next. On a plan set that is one more model call rather than twelve. Saying
 * "cancelled" while money was still being spent would be the wrong kind of
 * reassuring.
 */
export function Activity({ onError }: { onError?: (message: string | null) => void }) {
  const [queue, setQueue] = useState<Queue>({ running: [], queued: [], finished: [] });
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setQueue(await apiGet<Queue>('/queue'));
    } catch {
      // A failed poll is not worth a banner — this is a status view.
    }
  }, []);

  useEffect(() => {
    void load();
    // Faster while something is happening, slower when nothing is.
    const active = queue.running.length + queue.queued.length > 0;
    const timer = window.setInterval(() => void load(), active ? 3000 : 12000);
    return () => window.clearInterval(timer);
  }, [load, queue.running.length, queue.queued.length]);

  const act = async (jobId: string, path: string, body?: Record<string, unknown>) => {
    setBusy(jobId);
    setError(null);
    try {
      const result = await apiPost<{ note?: string }>(`/jobs/${jobId}/${path}`, body ?? {});
      await load();
      if (result.note) {
        setError(result.note);
        onError?.(result.note);
      }
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      setError(message);
      onError?.(message);
    } finally {
      setBusy(null);
    }
  };

  const row = (job: Job, kind: 'running' | 'queued' | 'finished') => {
    const failed = job.status === 'FAILED' || job.status === 'DEAD_LETTER';
    const cancelled = job.status === 'CANCELLED' || job.lastError?.startsWith('Cancelled');

    return (
      <div key={job.id} className="border-b border-ink-50 last:border-0">
        <div className="flex items-center gap-2 px-4 py-2">
          <span
            className={`h-1.5 w-1.5 shrink-0 rounded-full ${
              kind === 'running'
                ? 'animate-pulse bg-ink-800'
                : kind === 'queued'
                  ? 'bg-ink-300'
                  : cancelled
                    ? 'bg-ink-300'
                    : failed
                      ? 'bg-red-500'
                      : 'bg-emerald-500'
            }`}
          />

          <button
            onClick={() => job.runId && setOpen(open === job.runId ? null : job.runId)}
            className="min-w-0 flex-1 text-left"
            disabled={!job.runId}
          >
            <span className="block truncate text-xs font-medium text-ink-900">
              {job.label}
              {kind === 'queued' && job.position !== undefined && (
                <span className="ml-2 font-normal text-ink-400">#{job.position} in line</span>
              )}
              {cancelled && <span className="ml-2 font-normal text-ink-400">stopped</span>}
              {failed && !cancelled && <span className="ml-2 font-normal text-red-700">failed</span>}
            </span>
            {(job.inputRef || job.lastError) && (
              <span className="block truncate text-[10px] text-ink-400">
                {failed && !cancelled ? job.lastError : job.inputRef}
              </span>
            )}
          </button>

          {job.cost != null && (
            <span className="shrink-0 text-[10px] tabular-nums text-ink-400">
              ${Number(job.cost).toFixed(2)}
            </span>
          )}

          {kind === 'queued' && (
            <button
              onClick={() => void act(job.id, 'priority', { direction: 'up' })}
              disabled={busy === job.id || job.position === 1}
              className="shrink-0 rounded px-1.5 py-0.5 text-[11px] text-ink-500 hover:bg-ink-100 disabled:opacity-30"
              title="Run this next"
            >
              ↑ first
            </button>
          )}

          {(kind === 'running' || kind === 'queued') && (
            <button
              onClick={() => void act(job.id, 'cancel')}
              disabled={busy === job.id}
              className="shrink-0 rounded px-1.5 py-0.5 text-[11px] text-ink-400 hover:bg-red-50 hover:text-red-700 disabled:opacity-30"
              title={
                kind === 'running'
                  ? 'Stops after the request already in flight'
                  : 'Stops before it starts'
              }
            >
              stop
            </button>
          )}
        </div>

        {open === job.runId && job.runId && (
          <div className="max-h-72 overflow-y-auto border-t border-ink-50 bg-ink-50/40 px-4 py-2">
            <ActivityStream runId={job.runId} />
          </div>
        )}
      </div>
    );
  };

  const nothing =
    queue.running.length === 0 && queue.queued.length === 0 && queue.finished.length === 0;

  return (
    <section className="rounded-xl border border-ink-200 bg-white">
      <header className="flex items-baseline justify-between border-b border-ink-100 px-4 py-2.5">
        <h2 className="text-[13px] font-semibold text-ink-900">Activity</h2>
        <p className="text-xs text-ink-400">
          {queue.running.length > 0
            ? `${queue.running.length} running${queue.queued.length > 0 ? `, ${queue.queued.length} waiting` : ''}`
            : queue.queued.length > 0
              ? `${queue.queued.length} waiting`
              : 'nothing running'}
        </p>
      </header>

      {nothing && (
        <p className="px-4 py-6 text-xs text-ink-400">
          Nothing has run yet. Agents show here while they work — you can stop one, or move it to
          the front of the queue.
        </p>
      )}

      {queue.running.map((job) => row(job, 'running'))}
      {queue.queued.map((job) => row(job, 'queued'))}
      {queue.finished.map((job) => row(job, 'finished'))}

      {error && <p className="px-4 py-2 text-[11px] text-flag-700">{error}</p>}

      {queue.running.length + queue.queued.length > 0 && (
        <p className="border-t border-ink-100 px-4 py-2 text-[10px] text-ink-400">
          Up to three run at once. This keeps going whether or not this page is open.
        </p>
      )}
    </section>
  );
}

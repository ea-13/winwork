import { useEffect, useRef, useState } from 'react';
import type { AgentEvent } from 'shared';
import { openEventStream } from '../lib/api';

type Props = { runId: string };

const TONE: Record<string, string> = {
  INFO: 'text-ink-600',
  RESULT: 'text-ink-900 font-medium',
  WARNING: 'text-amber-700',
  ERROR: 'text-red-700',
};

function elapsed(from: number, to: number): string {
  const seconds = Math.max(0, Math.round((to - from) / 1000));
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

/**
 * A first-class screen, not a loading spinner.
 *
 * A 60-second agent run is the most persuasive part of this product — it shows
 * an estimator's own work being done. So the latency is displayed rather than
 * hidden: elapsed time runs, lines arrive one at a time, and findings are amber
 * because those are the lines that make someone look up.
 */
export function ActivityStream({ runId }: Props) {
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [finished, setFinished] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [stoppedAt, setStoppedAt] = useState<number | null>(null);
  const startedAt = useRef(Date.now());
  const bottom = useRef<HTMLDivElement>(null);

  useEffect(() => {
    startedAt.current = Date.now();
    setEvents([]);
    setFinished(null);
    setStoppedAt(null);
    setError(null);

    const controller = new AbortController();

    void (async () => {
      try {
        const reader = await openEventStream(`/agent-runs/${runId}/stream`, controller.signal);
        const decoder = new TextDecoder();
        let buffer = '';

        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const frames = buffer.split('\n\n');
          buffer = frames.pop() ?? '';

          for (const frame of frames) {
            const name = /^event: (.+)$/m.exec(frame)?.[1];
            const raw = /^data: (.+)$/m.exec(frame)?.[1];
            if (!name || !raw) continue;

            if (name === 'agent-event') {
              setEvents((current) => [...current, JSON.parse(raw) as AgentEvent]);
            } else if (name === 'agent-run-finished') {
              setFinished((JSON.parse(raw) as { status: string }).status);
              setStoppedAt(Date.now());
            }
          }
        }
      } catch (caught) {
        if (!controller.signal.aborted) {
          setError(caught instanceof Error ? caught.message : String(caught));
        }
      }
    })();

    return () => controller.abort();
  }, [runId]);

  // The clock stops when the run does, so the final duration stays readable.
  useEffect(() => {
    if (finished) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [finished]);

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: 'smooth' });
  }, [events.length, finished]);

  return (
    <section className="rounded-lg border border-ink-200 bg-white">
      <header className="flex items-center justify-between border-b border-ink-200 px-4 py-2.5">
        <div className="flex items-center gap-2">
          <span
            className={`inline-block h-2 w-2 rounded-full ${
              finished ? 'bg-ink-300' : 'animate-pulse bg-emerald-500'
            }`}
          />
          <h2 className="text-sm font-medium text-ink-900">Activity</h2>
        </div>
        <span className="font-mono text-xs text-ink-500">
          {elapsed(startedAt.current, stoppedAt ?? now)}
        </span>
      </header>

      <ol className="max-h-96 overflow-y-auto px-4 py-3 font-mono text-[13px] leading-relaxed">
        {events.length === 0 && !error && (
          <li className="text-ink-400">waiting for the worker to pick this up…</li>
        )}

        {events.map((event) => (
          <li key={event.seq} className={`flex gap-2 ${TONE[event.eventType] ?? 'text-ink-600'}`}>
            <span aria-hidden className="select-none">
              {event.eventType === 'WARNING' || event.eventType === 'ERROR' ? '!' : '>'}
            </span>
            <span className="min-w-0 break-words">{event.message}</span>
          </li>
        ))}

        {error && <li className="text-red-700">stream error: {error}</li>}
        {finished && (
          <li className="mt-2 text-ink-400">
            — run {finished.toLowerCase()} in {elapsed(startedAt.current, stoppedAt ?? now)} —
          </li>
        )}
        <div ref={bottom} />
      </ol>
    </section>
  );
}

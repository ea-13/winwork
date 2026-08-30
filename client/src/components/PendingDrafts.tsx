import { useCallback, useEffect, useState } from 'react';
import { apiGet, apiPost } from '../lib/api';

type Group = {
  run: {
    id: string;
    agent_type: string;
    input_ref: string | null;
    project_id?: string | null;
    finished_at: string | null;
  };
  accepted: boolean;
  draftCount: number;
  byTable: Record<string, number>;
};

/**
 * Agent proposals waiting on a human, shown where they landed.
 *
 * There is still a review queue, and there still has to be: an agent may not
 * write the scope baseline, and something has to record who accepted what and
 * why. But sending an estimator to a different page to do it was friction with
 * no purpose — the drafts are about the scope they are already looking at, and
 * the decision belongs next to the thing being decided.
 *
 * So the gate stays and the detour goes. The queue remains as an audit view of
 * everything ever proposed; this is the same acceptance, in place.
 */
export function PendingDrafts({
  projectId,
  onError,
  onAccepted,
}: {
  projectId: string;
  onError: (message: string | null) => void;
  onAccepted: () => void;
}) {
  const [groups, setGroups] = useState<Group[]>([]);
  const [openFor, setOpenFor] = useState<string | null>(null);
  const [rationale, setRationale] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const data = await apiGet<{ groups: Group[] }>('/review-queue');
    // Drafted scope items are no longer announced here. They are shown as
    // shaded rows in the scope table itself, where they can be read against
    // the scope they are proposals about, edited, and accepted at the bottom.
    // A banner saying "34 items await you" was a count, not a review.
    setGroups(
      data.groups.filter(
        (group) => !group.accepted && group.byTable.scope_context !== undefined,
      ),
    );
  }, []);

  useEffect(() => {
    load().catch(() => setGroups([]));
  }, [load, projectId]);

  const accept = async (group: Group) => {
    setBusy(true);
    onError(null);
    try {
      const kind = 'context';
      const result = await apiPost<{ created?: number; updated?: number; note?: string | null }>(
        `/runs/${group.run.id}/promote-${kind}`,
        { rationale: rationale.trim() },
      );
      setOpenFor(null);
      setRationale('');
      await load();
      onAccepted();
      if (result.note) onError(result.note);
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  if (groups.length === 0) return null;

  return (
    <div className="space-y-2 rounded-xl border border-flag-100 bg-flag-50 px-4 py-3">
      <p className="text-[13px] font-semibold text-flag-700">
        {groups.length} agent run{groups.length === 1 ? '' : 's'} waiting on you
      </p>

      {groups.map((group) => {
        const context = group.byTable.scope_context ?? 0;

        return (
          <div key={group.run.id} className="flex flex-wrap items-center gap-2 text-xs">
            <span className="text-flag-700">
              {`${context} context line${context === 1 ? '' : 's'}`}
              {group.run.input_ref && (
                <span className="text-flag-500"> from {group.run.input_ref}</span>
              )}
            </span>

            {openFor === group.run.id ? (
              <span className="flex items-center gap-1">
                <input
                  autoFocus
                  value={rationale}
                  onChange={(event) => setRationale(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && rationale.trim()) void accept(group);
                    if (event.key === 'Escape') setOpenFor(null);
                  }}
                  placeholder="Why are you accepting this?"
                  className="w-64 rounded border border-ink-300 px-2 py-1 text-xs outline-none focus:border-ink-800"
                />
                <button
                  disabled={busy || rationale.trim() === ''}
                  onClick={() => void accept(group)}
                  className="rounded-md bg-ink-900 px-2 py-1 text-xs font-medium text-white disabled:opacity-40"
                >
                  {busy ? '…' : 'Accept'}
                </button>
                <button onClick={() => setOpenFor(null)} className="px-1 text-xs text-ink-400">
                  cancel
                </button>
              </span>
            ) : (
              <button
                onClick={() => {
                  setOpenFor(group.run.id);
                  setRationale('');
                }}
                className="rounded-md border border-flag-500 px-2 py-0.5 text-xs font-medium text-flag-700"
              >
                Review and accept
              </button>
            )}
          </div>
        );
      })}

      <p className="text-[11px] text-flag-500">
        An agent proposes; you decide. Acceptance is recorded with your name and your reason.
      </p>
    </div>
  );
}

import { useEffect, useState } from 'react';
import { ErrorBanner, Layout } from '../components/Layout';
import { apiGet } from '../lib/api';

type Group = {
  run: {
    id: string;
    agent_type: string;
    input_ref: string | null;
    model: string | null;
    prompt_version: string | null;
    finished_at: string | null;
    token_cost: number | null;
  };
  accepted: boolean;
  draftCount: number;
  byTable: Record<string, number>;
  sample: {
    id: string;
    field: string;
    proposed_value: unknown;
    source_location: string | null;
    confidence: number | null;
    fill_tag: string;
  }[];
};

const FILL_TAG: Record<string, string> = {
  S: 'bg-slate-100 text-slate-600',
  AI: 'bg-sky-100 text-sky-800',
  H: 'bg-emerald-100 text-emerald-800',
  L: 'bg-violet-100 text-violet-800',
};

/**
 * P17 · The review queue.
 *
 * Everything an agent has proposed and nobody has accepted yet, with the
 * evidence attached. Drafts are immutable, so nothing here marks them read —
 * acceptance is recorded separately, in the ledger, by the person who did it.
 */
export function ReviewQueuePage() {
  const [groups, setGroups] = useState<Group[]>([]);
  const [awaiting, setAwaiting] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [showAccepted, setShowAccepted] = useState(false);

  useEffect(() => {
    apiGet<{ groups: Group[]; awaiting: number }>('/review-queue')
      .then((data) => {
        setGroups(data.groups);
        setAwaiting(data.awaiting);
      })
      .catch((caught: Error) => setError(caught.message));
  }, []);

  const shown = showAccepted ? groups : groups.filter((group) => !group.accepted);

  return (
    <Layout breadcrumb={<span>Review queue</span>}>
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold text-slate-900">Review queue</h1>
          <p className="text-sm text-slate-500">
            {awaiting} agent run{awaiting === 1 ? '' : 's'} waiting on a human
          </p>
        </div>
        <label className="flex items-center gap-2 text-xs text-slate-500">
          <input
            type="checkbox"
            checked={showAccepted}
            onChange={(event) => setShowAccepted(event.target.checked)}
          />
          show already accepted
        </label>
      </div>

      <ErrorBanner message={error} />

      <div className="space-y-2">
        {shown.map((group) => (
          <div key={group.run.id} className="rounded-lg border border-slate-200 bg-white">
            <button
              onClick={() => setOpen(open === group.run.id ? null : group.run.id)}
              className="flex w-full items-center justify-between px-4 py-3 text-left"
            >
              <div>
                <div className="text-sm font-medium text-slate-900">
                  {group.run.agent_type.replace(/_/g, ' ')}
                  {group.run.input_ref && (
                    <span className="ml-2 font-normal text-slate-500">{group.run.input_ref}</span>
                  )}
                </div>
                <div className="mt-0.5 text-xs text-slate-400">
                  {group.draftCount} proposals ·{' '}
                  {Object.entries(group.byTable)
                    .map(([table, count]) => `${count} ${table.replace(/_/g, ' ')}`)
                    .join(', ')}
                  {group.run.model && ` · ${group.run.model}`}
                  {group.run.prompt_version && ` · ${group.run.prompt_version}`}
                </div>
              </div>
              <span
                className={`rounded px-2 py-0.5 text-xs font-medium ${
                  group.accepted ? 'bg-emerald-100 text-emerald-800' : 'bg-amber-100 text-amber-800'
                }`}
              >
                {group.accepted ? 'accepted' : 'awaiting review'}
              </span>
            </button>

            {open === group.run.id && (
              <div className="border-t border-slate-100 px-4 py-3">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-left text-slate-500">
                      <th className="py-1 font-medium">Field</th>
                      <th className="py-1 font-medium">Proposed</th>
                      <th className="py-1 font-medium">Source</th>
                      <th className="py-1 font-medium">Confidence</th>
                      <th className="py-1 font-medium">Tag</th>
                    </tr>
                  </thead>
                  <tbody>
                    {group.sample.map((draft) => (
                      <tr key={draft.id} className="border-t border-slate-50 align-top">
                        <td className="py-1 pr-2 font-mono text-slate-500">{draft.field}</td>
                        <td className="max-w-md py-1 pr-2 text-slate-800">
                          {typeof draft.proposed_value === 'object'
                            ? JSON.stringify(draft.proposed_value).slice(0, 160)
                            : String(draft.proposed_value)}
                        </td>
                        <td className="py-1 pr-2 text-slate-500">{draft.source_location ?? '—'}</td>
                        <td className="py-1 pr-2 text-slate-500">
                          {draft.confidence === null ? '—' : draft.confidence.toFixed(2)}
                        </td>
                        <td className="py-1">
                          <span
                            className={`rounded px-1.5 py-0.5 ${
                              FILL_TAG[draft.fill_tag] ?? FILL_TAG.S
                            }`}
                          >
                            {draft.fill_tag}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {group.draftCount > group.sample.length && (
                  <p className="mt-2 text-xs text-slate-400">
                    Showing {group.sample.length} of {group.draftCount}. Accept on the package page.
                  </p>
                )}
              </div>
            )}
          </div>
        ))}

        {shown.length === 0 && (
          <p className="rounded-lg border border-slate-200 bg-white px-4 py-8 text-center text-sm text-slate-400">
            Nothing waiting. Run an agent, or turn on autopilot for a package.
          </p>
        )}
      </div>

      <p className="text-xs text-slate-400">
        Autopilot fills this queue and crosses no gate. Acceptance is a human act, and it is recorded
        with the name of the person who did it.
      </p>
    </Layout>
  );
}

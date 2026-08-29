import { useCallback, useEffect, useState } from 'react';
import { apiGet, apiPost } from '../lib/api';

type Candidate = {
  id: string;
  name: string;
  trade_csi: string[] | null;
  prequal_status: string | null;
  emr: number | null;
  bonding_capacity: number | null;
  contact_email: string | null;
  score: number;
  matched: string[];
  onList: boolean;
  reasons: string[];
};

type Draft = { id: string; subject: string; body: string; approved_at: string | null };

/**
 * P16 · Bidder list and solicitation.
 *
 * The ranking is advisory arithmetic on facts an estimator already knows. It
 * saves scrolling; it does not choose.
 *
 * And there is no send button. Where one would be, there is a sentence
 * explaining why — which is not an apology, it is the reason a GC who has had
 * software email his subs without asking will trust this.
 */
export function Solicitation({
  packageId,
  onError,
}: {
  packageId: string;
  onError: (message: string | null) => void;
}) {
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [divisions, setDivisions] = useState<string[]>([]);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [list, existing] = await Promise.all([
      apiGet<{ candidates: Candidate[]; divisions: string[] }>(`/packages/${packageId}/candidates`),
      apiGet<Draft[]>(`/packages/${packageId}/solicitation`),
    ]);
    setCandidates(list.candidates);
    setDivisions(list.divisions);
    setDrafts(existing);
  }, [packageId]);

  useEffect(() => {
    load().catch((caught: Error) => onError(caught.message));
  }, [load, onError]);

  const act = async (work: () => Promise<void>) => {
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

  const latest = drafts[0];

  return (
    <section className="space-y-5">
      <div>
        <h2 className="text-sm font-medium text-slate-900">Bidder list</h2>
        <p className="text-xs text-slate-500">
          Ranked on trade match, prequal, EMR and bonding. Advisory — approving the list is H4.
          {divisions.length > 0 && ` Divisions in play: ${divisions.join(', ')}.`}
        </p>
      </div>

      <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
              <th className="px-4 py-2 font-medium">Subcontractor</th>
              <th className="px-4 py-2 font-medium">Why</th>
              <th className="px-4 py-2 text-right font-medium">Score</th>
              <th className="px-4 py-2 text-right font-medium" />
            </tr>
          </thead>
          <tbody>
            {candidates.slice(0, 25).map((candidate) => (
              <tr key={candidate.id} className="border-b border-slate-100 last:border-0">
                <td className="px-4 py-2">
                  <div className="font-medium text-slate-900">{candidate.name}</div>
                  {candidate.contact_email && (
                    <div className="text-xs text-slate-400">{candidate.contact_email}</div>
                  )}
                </td>
                <td className="px-4 py-2 text-xs text-slate-500">{candidate.reasons.join(' · ')}</td>
                <td className="px-4 py-2 text-right font-mono text-xs text-slate-600">
                  {candidate.score}
                </td>
                <td className="px-4 py-2 text-right">
                  {candidate.onList ? (
                    <button
                      onClick={() =>
                        void act(async () => {
                          await apiPost(`/packages/${packageId}/bidders`, {
                            remove: [candidate.id],
                          });
                        })
                      }
                      disabled={busy}
                      className="text-xs text-slate-500 underline"
                    >
                      on the list — remove
                    </button>
                  ) : (
                    <button
                      onClick={() =>
                        void act(async () => {
                          await apiPost(`/packages/${packageId}/bidders`, { add: [candidate.id] });
                        })
                      }
                      disabled={busy}
                      className="rounded-md border border-slate-300 px-2 py-1 text-xs font-medium text-slate-700"
                    >
                      Add
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {candidates.length === 0 && (
              <tr>
                <td colSpan={4} className="px-4 py-6 text-sm text-slate-400">
                  No subs carry these trades. Import a sub list, or assign trades on the
                  Subcontractors screen.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium text-slate-900">Solicitation</h2>
        <button
          onClick={() =>
            void act(async () => {
              await apiPost(`/packages/${packageId}/solicitation`);
            })
          }
          disabled={busy}
          className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700"
        >
          {drafts.length > 0 ? 'Re-draft' : 'Draft invitation'}
        </button>
      </div>

      {latest ? (
        <div className="space-y-2 rounded-lg border border-slate-200 bg-white p-4">
          <div className="text-sm font-medium text-slate-900">{latest.subject}</div>
          <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded bg-slate-50 p-3 font-mono text-xs text-slate-700">
            {latest.body}
          </pre>

          <div className="flex items-center justify-between rounded-md border border-slate-200 bg-slate-50 px-3 py-2">
            <p className="text-xs text-slate-600">
              <strong>Drafted.</strong> WinProjects does not send email — copy this into your own
              system.
            </p>
            <button
              onClick={() => {
                void navigator.clipboard.writeText(`${latest.subject}\n\n${latest.body}`);
                setCopied(latest.id);
                setTimeout(() => setCopied(null), 2000);
              }}
              className="rounded-md bg-slate-900 px-3 py-1.5 text-xs font-medium text-white"
            >
              {copied === latest.id ? 'Copied' : 'Copy'}
            </button>
          </div>

          <p className="text-xs text-slate-400">
            There is no send button anywhere in this product. Not disabled — absent. Nothing here can
            contact your subs.
          </p>
        </div>
      ) : (
        <p className="rounded-lg border border-slate-200 bg-white px-4 py-6 text-sm text-slate-400">
          No invitation drafted yet.
        </p>
      )}
    </section>
  );
}

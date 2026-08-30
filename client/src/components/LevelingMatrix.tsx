import { useCallback, useEffect, useState } from 'react';
import { apiGet, apiPatch, apiPost } from '../lib/api';
import { money } from './Layout';

type Row = {
  id: string;
  quote_id: string;
  bidder: string;
  quoted_total: number | null;
  addback_total: number | null;
  risk_allowance: number | null;
  adjusted_total: number | null;
  advisory_rank: number;
  score_price: number | null;
  score_scope: number | null;
  score_risk: number | null;
  score_commercial: number | null;
  score_programme: number | null;
  weighted_score: number | null;
  weighted_rank: number | null;
};

type Weights = {
  weight_price: number;
  weight_scope: number;
  weight_risk: number;
  weight_commercial: number;
  weight_programme: number;
};

type Selection = { quote_id: string; rationale: string; selected_at: string } | null;

const AXES = [
  { key: 'weight_price', score: 'score_price', label: 'Price' },
  { key: 'weight_scope', score: 'score_scope', label: 'Scope' },
  { key: 'weight_risk', score: 'score_risk', label: 'Risk' },
  { key: 'weight_commercial', score: 'score_commercial', label: 'Commercial' },
  { key: 'weight_programme', score: 'score_programme', label: 'Programme' },
] as const;

/**
 * P11 · The adjusted comparison — the flip.
 *
 * Both rankings are shown side by side on purpose. The argument is not "here is
 * a number"; it is "the order you would have awarded in is not the right order",
 * and that only lands if the old order is visible next to the new one.
 *
 * The weighted score is a THIRD view and deliberately subordinate. Weights are
 * the estimator's and they can move them, but moving them must never reorder
 * the adjusted comparison — that ranking is the product's claim, not an opinion
 * to be tuned. So `advisory_rank` stays on adjusted total and the weighted order
 * sits beside it in its own column, where the two disagreeing is informative
 * rather than alarming.
 *
 * Commercial and programme are blank until a human fills them in. Nothing in a
 * quote PDF reliably says whether terms are acceptable or whether they can hit
 * the date, and a null axis drops out of the weighting rather than scoring zero.
 */
export function LevelingMatrix({
  packageId,
  onError,
}: {
  packageId: string;
  onError: (message: string | null) => void;
}) {
  const [rows, setRows] = useState<Row[]>([]);
  const [weights, setWeights] = useState<Weights | null>(null);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [selection, setSelection] = useState<Selection>(null);
  const [busy, setBusy] = useState(false);
  const [selecting, setSelecting] = useState<string | null>(null);
  const [rationale, setRationale] = useState('');
  const [editing, setEditing] = useState<
    { rowId: string; quoteId: string; field: string; value: string } | null
  >(null);

  const load = useCallback(async () => {
    const [matrix, chosen] = await Promise.all([
      apiGet<Row[]>(`/packages/${packageId}/leveling`),
      apiGet<{ selection: Selection; projectId: string | null; weights: Weights | null }>(
        `/packages/${packageId}/selection`,
      ).catch(() => ({ selection: null, projectId: null, weights: null })),
    ]);
    setRows(matrix);
    setSelection(chosen.selection);
    setProjectId(chosen.projectId);
    setWeights(chosen.weights);
  }, [packageId]);

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

  const recompute = () => guard(async () => { await apiPost(`/packages/${packageId}/level`); });

  const setWeight = (field: keyof Weights, raw: string) =>
    guard(async () => {
      if (!projectId) return;
      const value = Math.max(0, Math.min(100, Number(raw) || 0));
      await apiPatch(`/records/project/${projectId}`, { [field]: value });
      // Weights only mean anything once the scores are recomputed against them.
      await apiPost(`/packages/${packageId}/level`);
    });

  const saveScore = () =>
    guard(async () => {
      if (!editing) return;
      const raw = editing.value.trim();
      const value = raw === '' ? null : Math.max(0, Math.min(100, Number(raw)));
      setEditing(null);
      if (raw !== '' && !Number.isFinite(value)) return;
      await apiPatch(`/records/leveling_result/${editing.rowId}`, { [editing.field]: value });
      await apiPost(`/packages/${packageId}/level`);
    });

  const select = (quoteId: string) =>
    guard(async () => {
      await apiPost('/gates/h6/selection', {
        packageId,
        quoteId,
        rationale: rationale.trim(),
      });
      setSelecting(null);
      setRationale('');
    });

  // What the spreadsheet would have said, before anything was costed back in.
  const quotedOrder = [...rows]
    .filter((row) => row.quoted_total !== null)
    .sort((a, b) => Number(a.quoted_total) - Number(b.quoted_total))
    .map((row) => row.quote_id);

  const flipped = rows.some(
    (row) => row.advisory_rank > 0 && quotedOrder.indexOf(row.quote_id) + 1 !== row.advisory_rank,
  );

  const scoreCell = (row: Row, field: string, editableAxis: boolean) => {
    const value = row[field as keyof Row] as number | null;
    const active = editing?.quoteId === row.quote_id && editing.field === field;

    return (
      <td
        key={field}
        className={`px-2 py-2 text-center text-xs ${
          editableAxis ? 'cursor-text hover:bg-ink-50' : 'text-ink-500'
        }`}
        onClick={() =>
          editableAxis &&
          setEditing({
            rowId: row.id,
            quoteId: row.quote_id,
            field,
            value: value === null ? '' : String(value),
          })
        }
        title={editableAxis ? 'Your call — nothing in a quote answers this reliably' : undefined}
      >
        {active ? (
          <input
            autoFocus
            value={editing.value}
            onChange={(event) => setEditing({ ...editing, value: event.target.value })}
            onBlur={() => void saveScore()}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void saveScore();
              if (event.key === 'Escape') setEditing(null);
            }}
            className="w-12 rounded border border-ink-800 px-1 text-center outline-none"
          />
        ) : value === null ? (
          <span className="text-ink-300">{editableAxis ? '—' : ''}</span>
        ) : (
          value
        )}
      </td>
    );
  };

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-[13px] font-semibold text-ink-900">Adjusted comparison</h2>
          <p className="text-xs text-ink-400">
            Ranked on adjusted total, never on quoted. The weighted score is advisory and does
            not reorder it.
          </p>
        </div>
        <button
          onClick={() => void recompute()}
          disabled={busy}
          className="rounded-md border border-ink-300 px-3 py-1.5 text-xs font-medium text-ink-700 disabled:opacity-50"
        >
          {busy ? 'Computing…' : 'Recompute'}
        </button>
      </div>

      {flipped && (
        <p className="rounded-lg border border-flag-100 bg-flag-50 px-3 py-2 text-sm text-flag-700">
          The ranking changed once exclusions were costed back in. The apparent low bidder is not
          the low bidder.
        </p>
      )}

      {weights && projectId && (
        <div className="flex flex-wrap items-center gap-3 rounded-xl border border-ink-200 bg-white px-4 py-2.5">
          <span className="text-xs font-medium text-ink-700">Weights</span>
          {AXES.map((axis) => (
            <label key={axis.key} className="flex items-center gap-1 text-xs text-ink-500">
              {axis.label}
              <input
                type="number"
                min={0}
                max={100}
                defaultValue={weights[axis.key]}
                onBlur={(event) => {
                  if (Number(event.target.value) !== weights[axis.key]) {
                    void setWeight(axis.key, event.target.value);
                  }
                }}
                className="w-12 rounded border border-ink-300 px-1 py-0.5 text-center outline-none focus:border-ink-800"
              />
            </label>
          ))}
          <span className="text-[11px] text-ink-400">
            Re-weight and the weighted column reorders. The adjusted ranking does not move.
          </span>
        </div>
      )}

      <div className="overflow-x-auto rounded-xl border border-ink-200 bg-white">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-ink-200 text-left text-xs uppercase tracking-wide text-ink-500">
              <th className="px-3 py-2 font-medium">Bidder</th>
              <th className="px-3 py-2 text-right font-medium">Quoted</th>
              <th className="px-2 py-2 text-center font-medium">Was</th>
              <th className="px-3 py-2 text-right font-medium">Add-backs</th>
              <th className="px-3 py-2 text-right font-medium">Risk</th>
              <th className="px-3 py-2 text-right font-medium">Adjusted</th>
              <th className="px-2 py-2 text-center font-medium">Rank</th>
              {AXES.map((axis) => (
                <th key={axis.key} className="px-2 py-2 text-center font-medium">
                  {axis.label.slice(0, 4)}
                </th>
              ))}
              <th className="px-2 py-2 text-center font-medium">Weighted</th>
              <th className="px-3 py-2 text-center font-medium">Award</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const wasRank = quotedOrder.indexOf(row.quote_id) + 1;
              const moved = wasRank > 0 && row.advisory_rank > 0 && wasRank !== row.advisory_rank;
              const won = selection?.quote_id === row.quote_id;

              return (
                <tr
                  key={row.quote_id}
                  className={`border-b border-ink-100 last:border-0 ${won ? 'bg-emerald-50/60' : ''}`}
                >
                  <td className="px-3 py-2 font-medium text-ink-900">
                    {row.bidder}
                    {won && (
                      <span className="ml-2 rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-medium text-emerald-800">
                        selected
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right text-ink-600">{money(row.quoted_total)}</td>
                  <td className="px-2 py-2 text-center text-xs text-ink-400">
                    {wasRank > 0 ? `#${wasRank}` : '—'}
                  </td>
                  <td className="px-3 py-2 text-right text-flag-700">
                    {row.addback_total ? `+${money(row.addback_total)}` : '—'}
                  </td>
                  <td className="px-3 py-2 text-right text-ink-500">
                    {row.risk_allowance ? `+${money(row.risk_allowance)}` : '—'}
                  </td>
                  <td className="px-3 py-2 text-right font-semibold text-ink-900">
                    {row.adjusted_total === null ? 'no total stated' : money(row.adjusted_total)}
                  </td>
                  <td className="px-2 py-2 text-center">
                    {row.advisory_rank > 0 ? (
                      <span
                        className={`inline-block rounded px-1.5 py-0.5 text-xs font-medium ${
                          moved ? 'bg-flag-100 text-flag-700' : 'bg-ink-100 text-ink-600'
                        }`}
                      >
                        #{row.advisory_rank}
                        {moved && wasRank < row.advisory_rank && ' ▼'}
                        {moved && wasRank > row.advisory_rank && ' ▲'}
                      </span>
                    ) : (
                      <span className="text-xs text-ink-300">unranked</span>
                    )}
                  </td>

                  {AXES.map((axis) =>
                    scoreCell(
                      row,
                      axis.score,
                      axis.score === 'score_commercial' || axis.score === 'score_programme',
                    ),
                  )}

                  <td className="px-2 py-2 text-center text-xs font-semibold text-ink-900">
                    {row.weighted_score === null ? (
                      <span className="text-ink-300">—</span>
                    ) : (
                      <>
                        {row.weighted_score}
                        {row.weighted_rank && (
                          <span className="ml-1 font-normal text-ink-400">
                            #{row.weighted_rank}
                          </span>
                        )}
                      </>
                    )}
                  </td>

                  <td className="px-3 py-2 text-center">
                    {selection ? (
                      won ? (
                        <span className="text-[11px] text-emerald-700">awarded</span>
                      ) : (
                        <span className="text-[11px] text-ink-300">—</span>
                      )
                    ) : selecting === row.quote_id ? (
                      <span className="flex items-center gap-1">
                        <input
                          autoFocus
                          value={rationale}
                          onChange={(event) => setRationale(event.target.value)}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter' && rationale.trim()) void select(row.quote_id);
                            if (event.key === 'Escape') setSelecting(null);
                          }}
                          placeholder="Why this bidder?"
                          className="w-48 rounded border border-ink-300 px-2 py-1 text-xs outline-none focus:border-ink-800"
                        />
                        <button
                          disabled={busy || rationale.trim() === ''}
                          onClick={() => void select(row.quote_id)}
                          className="rounded bg-ink-900 px-2 py-1 text-xs font-medium text-white disabled:opacity-40"
                        >
                          Confirm
                        </button>
                        <button
                          onClick={() => setSelecting(null)}
                          className="px-1 text-xs text-ink-400"
                        >
                          cancel
                        </button>
                      </span>
                    ) : (
                      <button
                        onClick={() => {
                          setSelecting(row.quote_id);
                          setRationale('');
                        }}
                        className="rounded-md border border-ink-300 px-2 py-1 text-xs font-medium text-ink-700"
                        title="H6 · EST only, rationale required. Nothing is sent to anyone."
                      >
                        Select
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}

            {rows.length === 0 && (
              <tr>
                <td colSpan={13} className="px-4 py-6 text-sm text-ink-400">
                  Nothing levelled yet. Enter a bid by hand or extract one, then recompute.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {selection && (
        <p className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800">
          Selected {new Date(selection.selected_at).toLocaleDateString()} — “{selection.rationale}”.
          This package now shows as awarded on the Buyout step. Nothing has been sent to anyone:
          this system has no way to tell a bidder they won.
        </p>
      )}

      <p className="text-xs text-ink-400">
        Commercial and programme are yours to score — nothing in a quote answers them reliably, and
        a blank axis drops out of the weighting rather than counting as zero.
      </p>
    </section>
  );
}

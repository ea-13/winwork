import { useCallback, useEffect, useMemo, useState } from 'react';
import { Grid, type GridColumn, type GridRow } from './Grid';
import { apiGet, apiPatch, apiPost } from '../lib/api';

type ScopeItem = {
  id: string;
  scope_id: string;
  csi_division: string | null;
  csi_section: string | null;
  title: string;
  description: string | null;
  unit: string | null;
  quantity: number | null;
  quantity_basis: string | null;
  is_locked: boolean;
  locked_at: string | null;
};

type Division = { code: string; title: string };

const UNITS = ['EA', 'SF', 'LF', 'SY', 'CY', 'LB', 'TON', 'HR', 'LS', 'ALLOW'] as const;

/**
 * The Scope of Work workspace.
 *
 * This is the baseline every quote is measured against, so it is the screen an
 * estimator spends the most time in — which is why it is a grid rather than a
 * list of forms. Locked items are read-only here: unlocking is crossing H2
 * backwards, and that is a gate with a rationale, not a keystroke.
 */
export function ScopeGrid({ projectId, onError }: { projectId: string; onError: (message: string | null) => void }) {
  const [items, setItems] = useState<ScopeItem[]>([]);
  const [divisions, setDivisions] = useState<Division[]>([]);
  const [adding, setAdding] = useState('09');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const [rows, divs] = await Promise.all([
      apiGet<ScopeItem[]>(`/projects/${projectId}/scope-items`),
      apiGet<Division[]>('/divisions'),
    ]);
    setItems(rows);
    setDivisions(divs);
  }, [projectId]);

  useEffect(() => {
    load().catch((caught: Error) => onError(caught.message));
  }, [load, onError]);

  const columns = useMemo<GridColumn[]>(
    () => [
      { key: 'scope_id', label: 'Scope ID', width: 190, editable: false },
      { key: 'csi_division', label: 'Div', width: 64 },
      { key: 'csi_section', label: 'Section', width: 92 },
      { key: 'title', label: 'Title', width: 280 },
      { key: 'description', label: 'Description', width: 340 },
      { key: 'unit', label: 'Unit', width: 84, type: 'select', options: UNITS },
      { key: 'quantity', label: 'Quantity', width: 110, type: 'number' },
      { key: 'quantity_basis', label: 'Basis', width: 240 },
    ],
    [],
  );

  const rows = useMemo<GridRow[]>(
    () => items.map((item) => ({ ...item }) as unknown as GridRow),
    [items],
  );

  const commit = useCallback(
    async (rowId: string, patch: Record<string, unknown>) => {
      const item = items.find((row) => row.id === rowId);
      if (item?.is_locked) {
        throw new Error('This scope item is locked. Unlocking is a gate crossing, not an edit.');
      }

      const { record } = await apiPatch<{ record: ScopeItem }>(`/records/scope_item/${rowId}`, patch);
      setItems((current) => current.map((row) => (row.id === rowId ? { ...row, ...record } : row)));
    },
    [items],
  );

  const addRow = useCallback(async () => {
    setBusy(true);
    onError(null);
    try {
      const created = await apiPost<ScopeItem>(`/projects/${projectId}/scope-items`, {
        csiDivision: adding,
      });
      setItems((current) => [...current, created]);
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }, [projectId, adding, onError]);

  const locked = items.filter((item) => item.is_locked).length;

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="text-sm text-slate-600">
          {items.length} scope item{items.length === 1 ? '' : 's'}
          {locked > 0 && (
            <span className="ml-2 rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-500">
              {locked} locked
            </span>
          )}
        </div>

        <div className="flex items-center gap-2">
          <select
            value={adding}
            onChange={(event) => setAdding(event.target.value)}
            className="rounded-md border border-slate-300 px-2 py-1 text-xs"
          >
            {divisions.map((division) => (
              <option key={division.code} value={division.code}>
                {division.code} · {division.title}
              </option>
            ))}
          </select>
          <button
            onClick={() => void addRow()}
            disabled={busy}
            className="rounded-md bg-slate-900 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
          >
            + Add scope item
          </button>
        </div>
      </div>

      <Grid
        columns={columns}
        rows={rows}
        onCommit={commit}
        onAddRow={addRow}
        emptyMessage="No scope items yet. Add one, or let P18 draft them from the bid set."
      />
    </section>
  );
}

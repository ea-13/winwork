import { useCallback, useEffect, useState } from 'react';
import { apiGet, apiPost } from '../lib/api';

type ScopeItem = {
  id: string;
  scope_id: string;
  csi_division: string | null;
  csi_section: string | null;
  title: string;
  unit: string | null;
  quantity: number | null;
  is_locked: boolean;
};

/**
 * Which scope items this package is bought against.
 *
 * This is the baseline every quote on the package is measured to, so it is also
 * what the gap detector does its set difference against. An item not in here
 * cannot be found missing from a bid.
 *
 * Locking is H2: EST only, rationale required, and once locked the item stops
 * being editable in the Scope of Work grid.
 */
export function PackageScope({
  packageId,
  projectId,
  onError,
}: {
  packageId: string;
  projectId: string | null;
  onError: (message: string | null) => void;
}) {
  const [items, setItems] = useState<ScopeItem[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [rationale, setRationale] = useState('');
  const [locking, setLocking] = useState(false);

  const load = useCallback(async () => {
    if (!projectId) return;
    const [all, attached] = await Promise.all([
      apiGet<ScopeItem[]>(`/projects/${projectId}/scope-items`),
      apiPost<{ scopeItemIds: string[] }>(`/packages/${packageId}/scope`, {}),
    ]);
    setItems(all);
    setSelected(new Set(attached.scopeItemIds));
  }, [projectId, packageId]);

  useEffect(() => {
    load().catch((caught: Error) => onError(caught.message));
  }, [load, onError]);

  async function toggle(item: ScopeItem) {
    setBusy(true);
    onError(null);
    try {
      const inPackage = selected.has(item.id);
      await apiPost(`/packages/${packageId}/scope`, {
        [inPackage ? 'remove' : 'add']: [item.id],
      });
      const next = new Set(selected);
      if (inPackage) next.delete(item.id);
      else next.add(item.id);
      setSelected(next);
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  async function lock() {
    const unlocked = items.filter((item) => selected.has(item.id) && !item.is_locked);
    if (unlocked.length === 0) {
      onError('Every scope item on this package is already locked.');
      return;
    }
    setBusy(true);
    onError(null);
    try {
      const result = await apiPost<{ affected: number; approvalId: string }>(
        '/gates/h2/scope-lock',
        { scopeItemIds: unlocked.map((item) => item.id), rationale: rationale.trim() },
      );
      setLocking(false);
      setRationale('');
      await load();
      onError(`H2 crossed — ${result.affected} scope items locked. Approval ${result.approvalId.slice(0, 8)}.`);
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  const inPackage = items.filter((item) => selected.has(item.id));
  const lockedCount = inPackage.filter((item) => item.is_locked).length;

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-medium text-slate-900">Scope in this package</h2>
          <p className="text-xs text-slate-500">
            {inPackage.length} of {items.length} scope items · {lockedCount} locked. Quotes are
            measured against these, and gaps are found among them.
          </p>
        </div>

        {locking ? (
          <div className="flex items-center gap-1">
            <input
              autoFocus
              value={rationale}
              onChange={(event) => setRationale(event.target.value)}
              placeholder="Why is this scope ready to lock?"
              className="w-64 rounded border border-slate-300 px-2 py-1 text-xs outline-none focus:border-slate-900"
            />
            <button
              onClick={() => void lock()}
              disabled={busy || rationale.trim() === ''}
              className="rounded-md bg-slate-900 px-2 py-1 text-xs font-medium text-white disabled:opacity-40"
            >
              Lock
            </button>
            <button onClick={() => setLocking(false)} className="px-1 text-xs text-slate-400">
              cancel
            </button>
          </div>
        ) : (
          <button
            onClick={() => setLocking(true)}
            disabled={inPackage.length === 0}
            className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 disabled:opacity-40"
            title="H2 · EST only, rationale required"
          >
            Lock scope (H2)
          </button>
        )}
      </div>

      <div className="max-h-96 overflow-auto rounded-lg border border-slate-200 bg-white">
        <table className="w-full text-sm">
          <thead className="sticky top-0 bg-slate-50">
            <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
              <th className="w-10 px-3 py-2" />
              <th className="px-3 py-2 font-medium">Scope ID</th>
              <th className="px-3 py-2 font-medium">Section</th>
              <th className="px-3 py-2 font-medium">Title</th>
              <th className="px-3 py-2 text-right font-medium">Qty</th>
              <th className="px-3 py-2 font-medium">Locked</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.id} className="border-b border-slate-100 last:border-0">
                <td className="px-3 py-1.5">
                  <input
                    type="checkbox"
                    checked={selected.has(item.id)}
                    disabled={busy}
                    onChange={() => void toggle(item)}
                  />
                </td>
                <td className="px-3 py-1.5 font-mono text-xs text-slate-500">{item.scope_id}</td>
                <td className="px-3 py-1.5 font-mono text-xs text-slate-600">
                  {item.csi_section ?? item.csi_division ?? '—'}
                </td>
                <td className="px-3 py-1.5 text-slate-800">{item.title}</td>
                <td className="px-3 py-1.5 text-right text-slate-600">
                  {item.quantity ?? '—'} {item.unit ?? ''}
                </td>
                <td className="px-3 py-1.5">
                  {item.is_locked ? (
                    <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-xs text-emerald-800">
                      locked
                    </span>
                  ) : (
                    <span className="text-xs text-slate-400">open</span>
                  )}
                </td>
              </tr>
            ))}
            {items.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-6 text-sm text-slate-400">
                  No scope items on this project yet. Add them on the project's Scope tab.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <p className="text-xs text-slate-400">
        Normalisation compares quotes against <strong>locked</strong> items only. A moving baseline
        produces numbers nobody can defend.
      </p>
    </section>
  );
}

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ActivityStream } from './ActivityStream';
import { Grid, type GridColumn, type GridRow } from './Grid';
import { money } from './Layout';
import { PendingDrafts } from './PendingDrafts';
import { ScopeContext } from './ScopeContext';
import { TableCommand } from './TableCommand';
import { apiDelete, apiGet, apiPatch, apiPost } from '../lib/api';

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
  cost_code_id: string | null;
  is_locked: boolean;
};

type WorkPackage = {
  id: string;
  name: string;
  status: string;
  lead_division: string | null;
  csi_divisions: string[] | null;
  notes: string | null;
  budget_amount: number | null;
  allowance_amount: number | null;
  contingency_amount: number | null;
};

type Division = { code: string; title: string };

const UNITS = ['EA', 'SF', 'LF', 'SY', 'CY', 'LB', 'TON', 'HR', 'LS', 'ALLOW'] as const;

/** Scope with no package cannot be bid, so it gets its own group, not a blank. */
const UNASSIGNED = '__unassigned__';

/**
 * Scope of Work and packages, as one table.
 *
 * They were two screens, and that was wrong: a scope item's only job is to end
 * up in a package somebody bids, and a package is only worth anything as the
 * scope it contains. Splitting them meant the most important question on either
 * screen — what is not in a package yet — could not be asked on either.
 *
 * So packages are group headers and scope items sit under them, with an
 * Unassigned group that is impossible to miss. The grid underneath is the same
 * spreadsheet surface as everywhere else: arrows, ranges, copy/paste to Excel,
 * formulas in the numeric columns.
 */
export function ScopePackages({
  projectId,
  onError,
  onChanged,
}: {
  projectId: string;
  onError: (message: string | null) => void;
  onChanged?: () => void;
}) {
  const [items, setItems] = useState<ScopeItem[]>([]);
  const [packages, setPackages] = useState<WorkPackage[]>([]);
  const [divisions, setDivisions] = useState<Division[]>([]);
  const [costCodes, setCostCodes] = useState<{ id: string; code: string; description: string }[]>([]);
  const [assignment, setAssignment] = useState<Record<string, string>>({});
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [adding, setAdding] = useState(false);
  /** Division new rows land in. Editable in the row itself afterwards. */
  const [newDivision, setNewDivision] = useState('09');
  const [templating, setTemplating] = useState(false);
  const [template, setTemplate] = useState<
    { code: string; packageName: string; items: number; titles: string[] }[]
  >([]);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [showNotes, setShowNotes] = useState(true);
  const [noteFor, setNoteFor] = useState<string | null>(null);
  const [noteDraft, setNoteDraft] = useState('');
  const [contextFor, setContextFor] = useState<string | null>(null);
  const [runId, setRunId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [editingPackage, setEditingPackage] = useState<{
    id: string;
    field: 'budget_amount' | 'allowance_amount' | 'contingency_amount' | 'name';
    value: string;
  } | null>(null);

  const load = useCallback(async () => {
    const [scope, pkgs, divs, codes] = await Promise.all([
      apiGet<ScopeItem[]>(`/projects/${projectId}/scope-items`),
      apiGet<WorkPackage[]>(`/projects/${projectId}/packages`),
      apiGet<Division[]>('/divisions'),
      apiGet<{ id: string; code: string; description: string }[]>('/cost-codes').catch(() => []),
    ]);

    // Which package each scope item sits in. package_scope is many-to-many in
    // the schema, but a scope item bid under two packages is double-counted
    // money, so the UI treats it as one and the first wins.
    const map: Record<string, string> = {};
    await Promise.all(
      pkgs.map(async (pkg) => {
        const { scopeItemIds } = await apiPost<{ scopeItemIds: string[] }>(
          `/packages/${pkg.id}/scope`,
          {},
        );
        for (const id of scopeItemIds) map[id] ??= pkg.id;
      }),
    );

    setItems(scope);
    setPackages(pkgs);
    setDivisions(divs);
    setCostCodes(codes);
    setAssignment(map);
  }, [projectId]);

  useEffect(() => {
    load().catch((caught: Error) => onError(caught.message));
  }, [load, onError]);

  useEffect(() => {
    if (!templating || template.length > 0) return;
    apiGet<typeof template>('/scope-template').then(setTemplate).catch(() => setTemplate([]));
  }, [templating, template.length]);

  const guard = async (work: () => Promise<void>) => {
    setBusy(true);
    onError(null);
    try {
      await work();
      await load();
      onChanged?.();
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  const packageById = useMemo(
    () => new Map(packages.map((pkg) => [pkg.id, pkg])),
    [packages, costCodes],
  );

  /** Scope sorted so each package's items are contiguous, unassigned last. */
  const ordered = useMemo(() => {
    const groupKey = (item: ScopeItem) => assignment[item.id] ?? UNASSIGNED;

    return [...items].sort((a, b) => {
      const ga = groupKey(a);
      const gb = groupKey(b);
      if (ga !== gb) {
        if (ga === UNASSIGNED) return 1;
        if (gb === UNASSIGNED) return -1;
        const pa = packageById.get(ga)?.lead_division ?? '';
        const pb = packageById.get(gb)?.lead_division ?? '';
        return pa.localeCompare(pb) || ga.localeCompare(gb);
      }
      return (a.scope_id ?? '').localeCompare(b.scope_id ?? '');
    });
  }, [items, assignment, packageById]);

  const visible = useMemo(
    () => ordered.filter((item) => !collapsed.has(assignment[item.id] ?? UNASSIGNED)),
    [ordered, collapsed, assignment],
  );

  const columns = useMemo<GridColumn[]>(
    () => [
      { key: 'scope_id', label: 'Scope ID', width: 170, editable: false },
      { key: 'csi_section', label: 'Section', width: 90 },
      { key: 'title', label: 'Title', width: 300 },
      { key: 'description', label: 'Description', width: 360 },
      { key: 'unit', label: 'Unit', width: 80, type: 'select', options: UNITS },
      { key: 'quantity', label: 'Qty', width: 100, type: 'number' },
      { key: 'quantity_basis', label: 'Basis', width: 220 },
      { key: 'cost_code', label: 'Cost code', width: 130, type: 'select',
        options: ['', ...costCodes.map((code) => code.code)] },
      { key: 'package', label: 'Package', width: 170, type: 'select',
        options: ['', ...packages.map((pkg) => pkg.name)] },
    ],
    [packages],
  );

  const rows = useMemo<GridRow[]>(
    () =>
      visible.map((item) => ({
        ...item,
        package: packageById.get(assignment[item.id] ?? '')?.name ?? '',
        cost_code: costCodes.find((code) => code.id === item.cost_code_id)?.code ?? '',
      })) as unknown as GridRow[],
    [visible, assignment, packageById, costCodes],
  );

  const commit = useCallback(
    async (rowId: string, patch: Record<string, unknown>) => {
      const item = items.find((row) => row.id === rowId);
      if (!item) return;

      // Moving a scope item between packages is not a field edit; it is two
      // membership writes, and it must not go through the records PATCH.
      if ('package' in patch) {
        const name = String(patch.package ?? '').trim();
        const target = packages.find((pkg) => pkg.name === name);
        const current = assignment[rowId];

        if (current && current !== target?.id) {
          await apiPost(`/packages/${current}/scope`, { remove: [rowId] });
        }
        if (target && current !== target.id) {
          await apiPost(`/packages/${target.id}/scope`, { add: [rowId] });
        }

        setAssignment((state) => {
          const next = { ...state };
          if (target) next[rowId] = target.id;
          else delete next[rowId];
          return next;
        });

        delete patch.package;
        if (Object.keys(patch).length === 0) return;
      }

      if ('cost_code' in patch) {
        const wanted = String(patch.cost_code ?? '').trim();
        const code = costCodes.find((entry) => entry.code === wanted);
        delete patch.cost_code;
        patch.cost_code_id = code?.id ?? null;
      }

      if (item.is_locked) {
        throw new Error('This scope item is locked. Unlocking is a gate crossing, not an edit.');
      }

      const { record } = await apiPatch<{ record: ScopeItem }>(
        `/records/scope_item/${rowId}`,
        patch,
      );
      setItems((current) => current.map((row) => (row.id === rowId ? { ...row, ...record } : row)));
    },
    [items, packages, assignment, costCodes],
  );

  /**
   * Brings a blank row into existence when somebody types into it.
   *
   * It lands unassigned and in the division currently selected for new rows.
   * Both are then editable in the row itself, which is less presumptuous than
   * guessing a package from a title that has not been typed yet.
   */
  const createScope = useCallback(async (): Promise<string | null> => {
    try {
      const created = await apiPost<ScopeItem>(`/projects/${projectId}/scope-items`, {
        csiDivision: newDivision,
      });
      setItems((current) => [...current, created]);
      return created.id;
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : String(caught));
      return null;
    }
  }, [projectId, newDivision, onError]);

  const addScope = useCallback(
    () =>
      guard(async () => {
        await apiPost(`/projects/${projectId}/scope-items`, { csiDivision: newDivision });
      }),
    [projectId, newDivision],
  );

  const savePackage = async () => {
    if (!editingPackage) return;
    const { id, field, value } = editingPackage;
    setEditingPackage(null);

    const patch =
      field === 'name'
        ? { name: value.trim() }
        : { [field]: value.replace(/[$,\s]/g, '') === '' ? null : Number(value.replace(/[$,\s]/g, '')) };

    if (field === 'name' && !patch.name) return;
    await guard(async () => {
      await apiPatch(`/records/work_package/${id}`, patch);
    });
  };

  const toggle = (groupKey: string) =>
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(groupKey)) next.delete(groupKey);
      else next.add(groupKey);
      return next;
    });

  const packageCell = (
    pkg: WorkPackage,
    field: 'budget_amount' | 'allowance_amount' | 'contingency_amount',
    label: string,
  ) => {
    const active = editingPackage?.id === pkg.id && editingPackage.field === field;
    const value = pkg[field];
    return (
      <span className="inline-flex items-baseline gap-1">
        <span className="text-[10px] uppercase text-slate-400">{label}</span>
        {active ? (
          <input
            autoFocus
            value={editingPackage.value}
            onChange={(event) => setEditingPackage({ ...editingPackage, value: event.target.value })}
            onBlur={() => void savePackage()}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void savePackage();
              if (event.key === 'Escape') setEditingPackage(null);
            }}
            className="w-20 rounded border border-slate-900 px-1 text-right text-xs outline-none"
          />
        ) : (
          <button
            onClick={() =>
              setEditingPackage({ id: pkg.id, field, value: value === null ? '' : String(value) })
            }
            className={`tabular-nums ${value === null ? 'text-slate-300' : 'text-slate-700'}`}
          >
            {money(value)}
          </button>
        )}
      </span>
    );
  };

  const renderGroup = (groupKey: string, rowsInGroup: GridRow[]) => {
    if (groupKey === UNASSIGNED) {
      return (
        <div className="flex items-center gap-3">
          <button onClick={() => toggle(groupKey)} className="w-4 text-slate-500">
            {collapsed.has(groupKey) ? '▸' : '▾'}
          </button>
          <span className="text-xs font-semibold text-amber-800">
            Unassigned — {rowsInGroup.length} scope item
            {rowsInGroup.length === 1 ? '' : 's'} in no package
          </span>
          <span className="text-[11px] text-amber-700">
            Nothing here can be bid. Set a package in the last column.
          </span>
        </div>
      );
    }

    const pkg = packageById.get(groupKey);
    if (!pkg) return null;

    return (
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <button onClick={() => toggle(groupKey)} className="w-4 text-slate-500">
          {collapsed.has(groupKey) ? '▸' : '▾'}
        </button>

        <span className="text-xs font-semibold text-slate-900">
          <span className="font-mono text-slate-500">{pkg.lead_division ?? '—'}</span> · {pkg.name}
        </span>

        <span className="text-[11px] text-slate-400">
          {rowsInGroup.length} item{rowsInGroup.length === 1 ? '' : 's'}
        </span>

        {packageCell(pkg, 'budget_amount', 'bud')}
        {packageCell(pkg, 'allowance_amount', 'allow')}
        {packageCell(pkg, 'contingency_amount', 'cont')}

        <span className="ml-auto flex items-center gap-2">
          {showNotes && (
            <button
              onClick={() => {
                setNoteFor(noteFor === pkg.id ? null : pkg.id);
                setNoteDraft(pkg.notes ?? '');
              }}
              className={`max-w-[14rem] truncate text-[11px] ${
                pkg.notes ? 'text-slate-600 underline' : 'text-slate-300'
              }`}
            >
              {pkg.notes ?? '+ note'}
            </button>
          )}
          <Link to={`/packages/${pkg.id}`} className="text-[11px] text-slate-500 underline">
            bids
          </Link>
          <button
            onClick={() => void guard(async () => { await apiDelete(`/packages/${pkg.id}`); })}
            className="text-[11px] text-slate-300 hover:text-red-600"
            title="Refused once anything has been bid against it"
          >
            remove
          </button>
        </span>
      </div>
    );
  };

  const unassigned = items.filter((item) => !assignment[item.id]).length;
  const locked = items.filter((item) => item.is_locked).length;
  const usedDivisions = new Set(packages.map((pkg) => pkg.lead_division));

  return (
    <section className="space-y-3">
      <PendingDrafts
        projectId={projectId}
        onError={onError}
        onAccepted={() => void load().then(() => onChanged?.())}
      />

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="text-sm text-slate-600">
          {items.length} scope item{items.length === 1 ? '' : 's'} in {packages.length} package
          {packages.length === 1 ? '' : 's'}
          {locked > 0 && (
            <span className="ml-2 rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-500">
              {locked} locked
            </span>
          )}
          {unassigned > 0 && (
            <span className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-xs text-amber-800">
              {unassigned} unassigned
            </span>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-1.5 text-xs text-slate-500">
            <input
              type="checkbox"
              checked={showNotes}
              onChange={(event) => {
                setShowNotes(event.target.checked);
                if (!event.target.checked) setNoteFor(null);
              }}
            />
            Notes
          </label>
          <button
            onClick={() =>
              setCollapsed(
                collapsed.size > 0
                  ? new Set()
                  : new Set([...packages.map((pkg) => pkg.id), UNASSIGNED]),
              )
            }
            className="rounded-md border border-slate-300 px-2 py-1 text-xs text-slate-600"
          >
            {collapsed.size > 0 ? 'Expand all' : 'Collapse all'}
          </button>
          <button
            onClick={() =>
              void guard(async () => {
                const result = await apiPost<{ runId: string }>(
                  `/projects/${projectId}/draft-context`,
                  {},
                );
                setRunId(result.runId);
              })
            }
            disabled={busy || items.length === 0}
            className="rounded-md border border-slate-300 px-2.5 py-1 text-xs font-medium text-slate-700 disabled:opacity-40"
            title="Writes what each item includes, excludes and assumes"
          >
            Draft context
          </button>
          <button
            onClick={() => setTemplating((current) => !current)}
            className="rounded-md border border-ink-300 px-2.5 py-1 text-xs font-medium text-ink-700"
            title="Start from the containers a package of this trade always has"
          >
            Standard scope
          </button>
          <button
            onClick={() => setAdding((current) => !current)}
            className="rounded-md border border-ink-300 px-2.5 py-1 text-xs font-medium text-ink-700"
          >
            + Package
          </button>
          <span className="flex items-center gap-1 text-xs text-ink-500">
            new rows in
            <select
              value={newDivision}
              onChange={(event) => setNewDivision(event.target.value)}
              className="rounded border border-ink-300 px-1.5 py-1 text-xs"
              title="Division a blank row lands in. Change it per row afterwards."
            >
              {divisions.map((division) => (
                <option key={division.code} value={division.code}>
                  {division.code} · {division.title}
                </option>
              ))}
            </select>
          </span>
        </div>
      </div>

      {templating && (
        <div className="space-y-2 rounded-xl border border-ink-200 bg-white p-4">
          <div className="flex items-baseline justify-between gap-3">
            <div>
              <p className="text-[13px] font-semibold text-ink-900">Start from standard scope</p>
              <p className="text-xs text-ink-400">
                The containers a package of each trade always has, with the inclusions,
                exclusions and interfaces that go with them. No quantities — those come
                from your documents, never from a template.
              </p>
            </div>
            <button
              disabled={busy || picked.size === 0}
              onClick={() =>
                void guard(async () => {
                  const result = await apiPost<{
                    createdItems: number;
                    createdPackages: number;
                    createdContext: number;
                    skipped: number;
                  }>(`/projects/${projectId}/scope-template`, { divisions: [...picked] });
                  setTemplating(false);
                  setPicked(new Set());
                  onError(
                    `Added ${result.createdItems} scope items in ${result.createdPackages} package(s), ` +
                      `with ${result.createdContext} context lines` +
                      (result.skipped > 0 ? `. ${result.skipped} already existed.` : '.'),
                  );
                })
              }
              className="shrink-0 rounded-md bg-ink-900 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-40"
            >
              Add {picked.size || ''} division{picked.size === 1 ? '' : 's'}
            </button>
          </div>

          <div className="grid gap-1.5 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
            {template.map((division) => {
              const on = picked.has(division.code);
              return (
                <button
                  key={division.code}
                  onClick={() =>
                    setPicked((current) => {
                      const next = new Set(current);
                      if (next.has(division.code)) next.delete(division.code);
                      else next.add(division.code);
                      return next;
                    })
                  }
                  className={`rounded-lg border px-3 py-2 text-left transition ${
                    on ? 'border-ink-800 bg-ink-50' : 'border-ink-200 hover:border-ink-300'
                  }`}
                >
                  <span className="flex items-baseline justify-between gap-2">
                    <span className="text-xs font-medium text-ink-900">
                      <span className="font-mono text-ink-400">{division.code}</span>{' '}
                      {division.packageName}
                    </span>
                    <span className="text-[11px] text-ink-400">{division.items}</span>
                  </span>
                  <span className="mt-1 block text-[11px] leading-snug text-ink-400">
                    {division.titles.join(' · ')}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {adding && (
        <div className="flex flex-wrap gap-1.5 rounded-lg border border-slate-200 bg-white p-3">
          {divisions.map((division) => (
            <button
              key={division.code}
              onClick={() =>
                void guard(async () => {
                  await apiPost(`/projects/${projectId}/packages`, { leadDivision: division.code });
                  setAdding(false);
                })
              }
              disabled={busy}
              className={`rounded-md border px-2 py-1 text-xs disabled:opacity-40 ${
                usedDivisions.has(division.code)
                  ? 'border-slate-200 text-slate-400'
                  : 'border-slate-300 text-slate-700'
              }`}
              title={
                usedDivisions.has(division.code)
                  ? 'Already has a package — adding another is allowed'
                  : division.title
              }
            >
              {division.code} {division.title}
            </button>
          ))}
        </div>
      )}

      {/* Say what you want changed rather than clicking every cell. The diff
          is always shown before anything is written. */}
      <TableCommand
        table="scope_item"
        rows={rows}
        // csi_division and package are how an estimator actually describes a
        // set of rows ("the plumbing ones"), so they have to be visible even
        // though package is not directly writable here.
        columns={[
          { key: 'csi_division', label: 'Div' },
          ...columns,
        ]}
        onApplied={() => void load().then(() => onChanged?.())}
        onError={onError}
        placeholder='Tell it what to change — "set every division 22 basis to per fixture schedule"'
      />

      <Grid
        columns={columns}
        rows={rows}
        onCommit={commit}
        onAddRow={addScope}
        onCreateRow={createScope}
        blankRows={12}
        groupOf={(row) => assignment[String(row.id)] ?? UNASSIGNED}
        renderGroup={renderGroup}
        emptyMessage="No scope yet. Draft it from the bid set on the Documents step, or start typing below."
      />

      {noteFor && (
        <aside className="fixed bottom-6 right-6 z-30 w-80 rounded-lg border border-slate-300 bg-white shadow-xl">
          <header className="flex items-center justify-between border-b border-slate-200 px-3 py-2">
            <p className="text-xs font-medium text-slate-900">
              {packageById.get(noteFor)?.name ?? 'Package'} · notes
            </p>
            <button onClick={() => setNoteFor(null)} className="text-xs text-slate-400">
              close
            </button>
          </header>
          <textarea
            autoFocus
            value={noteDraft}
            onChange={(event) => setNoteDraft(event.target.value)}
            rows={6}
            placeholder="Why the budget, allowance and contingency are what they are."
            className="w-full resize-none px-3 py-2 text-xs outline-none placeholder:text-slate-300"
          />
          <footer className="flex justify-end border-t border-slate-200 px-3 py-2">
            <button
              onClick={() =>
                void guard(async () => {
                  await apiPatch(`/records/work_package/${noteFor}`, {
                    notes: noteDraft.trim() || null,
                  });
                  setNoteFor(null);
                })
              }
              className="rounded-md bg-slate-900 px-2.5 py-1 text-xs font-medium text-white"
            >
              Save note
            </button>
          </footer>
        </aside>
      )}

      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2">
        <span className="text-xs text-slate-500">Context for</span>
        <select
          value={contextFor ?? ''}
          onChange={(event) => setContextFor(event.target.value || null)}
          className="max-w-lg flex-1 rounded border border-slate-300 px-2 py-1 text-xs"
        >
          <option value="">Pick a scope item…</option>
          {items.map((item) => (
            <option key={item.id} value={item.id}>
              {item.scope_id} — {item.title}
            </option>
          ))}
        </select>
      </div>

      {contextFor && (
        <ScopeContext
          key={contextFor}
          scopeItemId={contextFor}
          scopeLabel={items.find((item) => item.id === contextFor)?.title ?? 'this item'}
          onError={onError}
        />
      )}

      {runId && <ActivityStream runId={runId} />}
    </section>
  );
}

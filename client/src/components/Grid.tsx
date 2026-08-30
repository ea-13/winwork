import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { columnLetter, evaluateFormula, isFormula } from '../lib/formula';

/**
 * A spreadsheet grid.
 *
 * An estimator lives in Excel. If this feels like a web form with editable
 * boxes, they will export to Excel and the audit trail dies at the export. So
 * the interaction model is copied deliberately: type over a cell to replace it,
 * F2 to edit in place, Enter commits and moves down, Tab commits and moves
 * right, Escape reverts, arrows navigate, Shift+arrows select a range,
 * Ctrl+C/V round-trips through Excel's own TSV clipboard format, Ctrl+D fills
 * down, Ctrl+Z undoes.
 *
 * Every commit goes through onCommit, which writes an audited PATCH. Nothing
 * here writes to the database directly — the grid is a keyboard surface over
 * the same endpoint a form would use.
 */

export type CellType = 'text' | 'number' | 'currency' | 'date' | 'select' | 'tags';

export type GridColumn = {
  key: string;
  label: string;
  type?: CellType;
  width?: number;
  options?: readonly string[];
  editable?: boolean;
  /** Shown under the header, e.g. a unit. */
  hint?: string;
};

export type GridRow = { id: string } & Record<string, unknown>;

type Props = {
  columns: GridColumn[];
  rows: GridRow[];
  /** Applies one row's changed fields. Should throw on failure. */
  onCommit: (rowId: string, patch: Record<string, unknown>) => Promise<void>;
  onAddRow?: () => Promise<void>;
  /**
   * Creates a real row and returns its id, so typing into a blank row at the
   * bottom materialises it — the way a spreadsheet behaves.
   *
   * Without this the grid shows `blankRows` phantom rows that cannot be typed
   * into, which would be worse than not showing them.
   */
  onCreateRow?: () => Promise<string | null>;
  /**
   * How many empty rows to keep at the bottom.
   *
   * An empty grid with an "Add row" button makes you click once per line, and
   * entering twenty scope items becomes twenty clicks and twenty round trips.
   * A spreadsheet just has rows. These are not saved until something is typed
   * into them, so an untouched grid still writes nothing.
   */
  blankRows?: number;
  emptyMessage?: string;
  /**
   * Optional grouping. `groupOf` names the group a row belongs to; a header
   * row is drawn whenever that name changes going down the list.
   *
   * Presentational only, and deliberately so: `rows` still contains nothing
   * but data rows, so cell coordinates, ranges, copy/paste and formula
   * references all keep counting the same things a user counts. A group header
   * that occupied a row index would make =SUM(D2:D9) mean something different
   * depending on which packages happened to be expanded.
   */
  groupOf?: (row: GridRow) => string;
  renderGroup?: (groupKey: string, rowsInGroup: GridRow[]) => ReactNode;
  /**
   * Per-row tint. `review` is for rows a person still has to accept — they are
   * shown in the table with everything else on purpose, because a proposal you
   * have to leave the table to look at is a proposal nobody looks at.
   */
  rowTone?: (row: GridRow) => 'review' | 'muted' | null;
  /**
   * Row picking, from the row-number gutter. Separate from cell selection: a
   * cell range is for copying values, a row pick is for doing something to
   * whole records — merging them, retitling them, accepting them.
   *
   * Click picks one, shift-click extends, click again unpicks.
   */
  pickedIds?: ReadonlySet<string>;
  onPick?: (ids: Set<string>) => void;
};

type Cell = { r: number; c: number };
type SaveState = 'saving' | 'saved' | 'error';

const key = (cell: Cell): string => `${cell.r}:${cell.c}`;

/** Marks a row that exists only on screen until somebody types into it. */
const PHANTOM = '__blank__';

// ---------------------------------------------------------------- formatting

function display(value: unknown, type: CellType | undefined): string {
  if (value === null || value === undefined || value === '') return '';
  if (Array.isArray(value)) return value.join(', ');

  switch (type) {
    case 'currency': {
      const n = Number(value);
      return Number.isFinite(n)
        ? n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 })
        : String(value);
    }
    case 'number': {
      const n = Number(value);
      return Number.isFinite(n) ? n.toLocaleString('en-US') : String(value);
    }
    case 'date': {
      const d = new Date(String(value));
      return Number.isNaN(d.getTime()) ? String(value) : d.toLocaleDateString();
    }
    default:
      return String(value);
  }
}

/** What goes into the input when editing — raw, not formatted. */
function editable(value: unknown, type: CellType | undefined): string {
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) return value.join(', ');
  if (type === 'date' && value) {
    const d = new Date(String(value));
    if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  }
  return String(value);
}

/** Excel tolerance: "$1,200.50" and "1200.5" are the same number. */
function parse(input: string, type: CellType | undefined): unknown {
  const text = input.trim();
  if (text === '') return null;

  switch (type) {
    case 'number':
    case 'currency': {
      const n = Number(text.replace(/[$,\s]/g, ''));
      return Number.isFinite(n) ? n : null;
    }
    case 'date': {
      const d = new Date(text);
      return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
    }
    case 'tags':
      return text
        .split(',')
        .map((part) => part.trim())
        .filter(Boolean);
    default:
      return text;
  }
}

// ---------------------------------------------------------------------------

export function Grid({
  columns,
  rows: dataRows,
  onCommit,
  onAddRow,
  onCreateRow,
  blankRows = 0,
  emptyMessage,
  groupOf,
  renderGroup,
  rowTone,
  pickedIds,
  onPick,
}: Props) {
  const [active, setActive] = useState<Cell>({ r: 0, c: 0 });
  const [anchor, setAnchor] = useState<Cell | null>(null);
  /** Last row picked from the gutter, so shift-click has something to span. */
  const [lastPick, setLastPick] = useState<number | null>(null);
  const [editing, setEditing] = useState<{ cell: Cell; value: string } | null>(null);
  const [saveState, setSaveState] = useState<Record<string, SaveState>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [undoStack, setUndoStack] = useState<{ rowId: string; patch: Record<string, unknown> }[]>([]);
  // What was typed, per cell, when it was a formula. Kept in the browser only:
  // the stored value is the number, and a formula is an input convenience, not
  // a fact about the project that other users need to see.
  const [formulas, setFormulas] = useState<Record<string, string>>({});

  const wrapper = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);

  const editableColumns = useMemo(
    () => columns.map((column) => column.editable !== false),
    [columns],
  );

  /**
   * The real rows plus the blank ones on the end.
   *
   * Phantom ids are prefixed so nothing downstream can mistake one for a
   * database row; committing into a phantom creates the real row first.
   */
  const phantomCount = onCreateRow ? blankRows : 0;

  const rows = useMemo<GridRow[]>(
    () => [
      ...dataRows,
      ...Array.from({ length: phantomCount }, (_, index) => ({
        id: `${PHANTOM}${index}`,
      })) as GridRow[],
    ],
    [dataRows, phantomCount],
  );

  const isPhantom = (row: GridRow | undefined): boolean =>
    typeof row?.id === 'string' && row.id.startsWith(PHANTOM);

  const clampCell = useCallback(
    (cell: Cell): Cell => ({
      r: Math.max(0, Math.min(rows.length - 1, cell.r)),
      c: Math.max(0, Math.min(columns.length - 1, cell.c)),
    }),
    [rows.length, columns.length],
  );

  const selection = useMemo(() => {
    const from = anchor ?? active;
    return {
      r0: Math.min(from.r, active.r),
      r1: Math.max(from.r, active.r),
      c0: Math.min(from.c, active.c),
      c1: Math.max(from.c, active.c),
    };
  }, [anchor, active]);

  const inSelection = (r: number, c: number): boolean =>
    r >= selection.r0 && r <= selection.r1 && c >= selection.c0 && c <= selection.c1;

  useEffect(() => {
    if (editing) input.current?.focus();
  }, [editing]);

  // ------------------------------------------------------------- committing

  const commit = useCallback(
    async (rowId: string, patch: Record<string, unknown>, cells: Cell[], previous: Record<string, unknown>) => {
      setSaveState((state) => {
        const next = { ...state };
        for (const cell of cells) next[key(cell)] = 'saving';
        return next;
      });

      try {
        await onCommit(rowId, patch);
        setUndoStack((stack) => [...stack.slice(-49), { rowId, patch: previous }]);
        setSaveState((state) => {
          const next = { ...state };
          for (const cell of cells) next[key(cell)] = 'saved';
          return next;
        });
        setErrors((state) => {
          const next = { ...state };
          for (const cell of cells) delete next[key(cell)];
          return next;
        });
      } catch (caught) {
        const message = caught instanceof Error ? caught.message : String(caught);
        setSaveState((state) => {
          const next = { ...state };
          for (const cell of cells) next[key(cell)] = 'error';
          return next;
        });
        setErrors((state) => {
          const next = { ...state };
          for (const cell of cells) next[key(cell)] = message;
          return next;
        });
      }
    },
    [onCommit],
  );

  /**
   * Reads any cell as a number, for a formula to refer to.
   *
   * Blank is null rather than 0, and the formula engine drops nulls rather
   * than summing them as zeros — in a bid tab the difference between "nobody
   * priced this" and "somebody priced it at nothing" is the entire product.
   */
  const lookup = useCallback(
    (r: number, c: number): number | null => {
      const row = rows[r];
      const column = columns[c];
      if (!row || !column) return null;
      const raw = row[column.key];
      if (raw === null || raw === undefined || raw === '') return null;
      const value = Number(String(raw).replace(/[$,\s]/g, ''));
      return Number.isFinite(value) ? value : null;
    },
    [rows, columns],
  );

  const commitCell = useCallback(
    async (cell: Cell, raw: string) => {
      let row = rows[cell.r];
      const column = columns[cell.c];
      if (!row || !column) return;

      // Typing into one of the blank rows at the bottom brings it into
      // existence. Nothing is written for a blank row nobody touched, so an
      // untouched grid stays an empty grid.
      if (isPhantom(row)) {
        if (raw.trim() === '' || !onCreateRow) return;
        const createdId = await onCreateRow();
        if (!createdId) return;
        row = { ...row, id: createdId };
      }

      let input = raw;

      // A formula is a way of typing a number, not a new kind of value. It is
      // evaluated here and the RESULT is what gets stored, so that leveling,
      // the buyout totals and every export keep reading plain numbers and none
      // of them has to know formulas exist.
      if (isFormula(raw)) {
        const numeric = column.type === 'number' || column.type === 'currency';
        if (!numeric) {
          setErrors((state) => ({
            ...state,
            [key(cell)]: 'Formulas only work in number and currency columns.',
          }));
          setSaveState((state) => ({ ...state, [key(cell)]: 'error' }));
          return;
        }

        const result = evaluateFormula(raw, lookup);
        if (!result.ok) {
          setErrors((state) => ({ ...state, [key(cell)]: result.error }));
          setSaveState((state) => ({ ...state, [key(cell)]: 'error' }));
          return;
        }
        input = String(result.value);
        setFormulas((state) => ({ ...state, [`${row.id}:${column.key}`]: raw.trim() }));
      } else {
        // Typing over a formula retires it. Otherwise the cell would show a
        // formula that no longer produced the number sitting in it.
        setFormulas((state) => {
          const next = { ...state };
          delete next[`${row.id}:${column.key}`];
          return next;
        });
      }

      const value = parse(input, column.type);
      const before = row[column.key] ?? null;
      if (JSON.stringify(before) === JSON.stringify(value)) return;

      await commit(row.id, { [column.key]: value }, [cell], { [column.key]: before });
    },
    [rows, columns, commit, lookup, onCreateRow],
  );

  // ------------------------------------------------------------- navigation

  const move = useCallback(
    (dr: number, dc: number, extend = false) => {
      const next = clampCell({ r: active.r + dr, c: active.c + dc });
      if (extend) {
        setAnchor((current) => current ?? active);
      } else {
        setAnchor(null);
      }
      setActive(next);
    },
    [active, clampCell],
  );

  const beginEdit = useCallback(
    (cell: Cell, initial?: string) => {
      const column = columns[cell.c];
      const row = rows[cell.r];
      if (!column || !row || column.editable === false) return;
      setEditing({
        cell,
        value:
          initial ??
          formulas[`${row.id}:${column.key}`] ??
          editable(row[column.key], column.type),
      });
    },
    [columns, rows, formulas],
  );

  const finishEdit = useCallback(
    async (moveBy: { dr: number; dc: number } | null) => {
      if (!editing) return;
      const { cell, value } = editing;
      setEditing(null);
      await commitCell(cell, value);
      if (moveBy) move(moveBy.dr, moveBy.dc);
    },
    [editing, commitCell, move],
  );

  // ------------------------------------------------------------- clipboard

  const onCopy = useCallback(
    (event: ClipboardEvent) => {
      if (editing) return;
      const lines: string[] = [];
      for (let r = selection.r0; r <= selection.r1; r += 1) {
        const cells: string[] = [];
        for (let c = selection.c0; c <= selection.c1; c += 1) {
          const column = columns[c];
          const row = rows[r];
          cells.push(column && row ? editable(row[column.key], column.type) : '');
        }
        lines.push(cells.join('\t'));
      }
      event.clipboardData.setData('text/plain', lines.join('\n'));
      event.preventDefault();
    },
    [editing, selection, columns, rows],
  );

  const onPaste = useCallback(
    (event: ClipboardEvent) => {
      if (editing) return;
      const text = event.clipboardData.getData('text/plain');
      if (!text) return;
      event.preventDefault();

      // Excel and Sheets both put tab-separated rows on the clipboard, so a
      // block copied from either pastes straight in.
      const grid = text.replace(/\r/g, '').replace(/\n$/, '').split('\n').map((line) => line.split('\t'));

      for (const [dr, line] of grid.entries()) {
        const r = active.r + dr;
        const row = rows[r];
        if (!row) break;

        const patch: Record<string, unknown> = {};
        const previous: Record<string, unknown> = {};
        const cells: Cell[] = [];

        for (const [dc, cellText] of line.entries()) {
          const c = active.c + dc;
          const column = columns[c];
          if (!column || column.editable === false) continue;

          const value = parse(cellText, column.type);
          const before = row[column.key] ?? null;
          if (JSON.stringify(before) === JSON.stringify(value)) continue;

          patch[column.key] = value;
          previous[column.key] = before;
          cells.push({ r, c });
        }

        // One request per row, not per cell — a 20x5 paste is 20 calls.
        if (cells.length > 0) void commit(row.id, patch, cells, previous);
      }
    },
    [editing, active, rows, columns, commit],
  );

  const fillDown = useCallback(() => {
    const sourceRow = rows[selection.r0];
    if (!sourceRow || selection.r1 === selection.r0) return;

    for (let r = selection.r0 + 1; r <= selection.r1; r += 1) {
      const row = rows[r];
      if (!row) continue;
      const patch: Record<string, unknown> = {};
      const previous: Record<string, unknown> = {};
      const cells: Cell[] = [];

      for (let c = selection.c0; c <= selection.c1; c += 1) {
        const column = columns[c];
        if (!column || column.editable === false) continue;
        const value = sourceRow[column.key] ?? null;
        const before = row[column.key] ?? null;
        if (JSON.stringify(before) === JSON.stringify(value)) continue;
        patch[column.key] = value;
        previous[column.key] = before;
        cells.push({ r, c });
      }
      if (cells.length > 0) void commit(row.id, patch, cells, previous);
    }
  }, [rows, columns, selection, commit]);

  const clearSelection = useCallback(() => {
    for (let r = selection.r0; r <= selection.r1; r += 1) {
      const row = rows[r];
      if (!row) continue;
      const patch: Record<string, unknown> = {};
      const previous: Record<string, unknown> = {};
      const cells: Cell[] = [];

      for (let c = selection.c0; c <= selection.c1; c += 1) {
        const column = columns[c];
        if (!column || column.editable === false) continue;
        if ((row[column.key] ?? null) === null) continue;
        patch[column.key] = null;
        previous[column.key] = row[column.key] ?? null;
        cells.push({ r, c });
      }
      if (cells.length > 0) void commit(row.id, patch, cells, previous);
    }
  }, [rows, columns, selection, commit]);

  const undo = useCallback(() => {
    const last = undoStack[undoStack.length - 1];
    if (!last) return;
    setUndoStack((stack) => stack.slice(0, -1));
    void onCommit(last.rowId, last.patch).catch(() => undefined);
  }, [undoStack, onCommit]);

  // -------------------------------------------------------------- keyboard

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      const meta = event.ctrlKey || event.metaKey;

      if (editing) {
        if (event.key === 'Escape') {
          event.preventDefault();
          setEditing(null);
        } else if (event.key === 'Enter') {
          event.preventDefault();
          void finishEdit({ dr: event.shiftKey ? -1 : 1, dc: 0 });
        } else if (event.key === 'Tab') {
          event.preventDefault();
          void finishEdit({ dr: 0, dc: event.shiftKey ? -1 : 1 });
        }
        return;
      }

      switch (event.key) {
        case 'ArrowUp':
          event.preventDefault();
          move(-1, 0, event.shiftKey);
          return;
        case 'ArrowDown':
          event.preventDefault();
          move(1, 0, event.shiftKey);
          return;
        case 'ArrowLeft':
          event.preventDefault();
          move(0, -1, event.shiftKey);
          return;
        case 'ArrowRight':
          event.preventDefault();
          move(0, 1, event.shiftKey);
          return;
        case 'Tab':
          event.preventDefault();
          move(0, event.shiftKey ? -1 : 1);
          return;
        case 'Enter':
          event.preventDefault();
          beginEdit(active);
          return;
        case 'F2':
          event.preventDefault();
          beginEdit(active);
          return;
        case 'Escape':
          setAnchor(null);
          return;
        case 'Home':
          event.preventDefault();
          setAnchor(null);
          setActive(meta ? { r: 0, c: 0 } : { r: active.r, c: 0 });
          return;
        case 'End':
          event.preventDefault();
          setAnchor(null);
          setActive(
            meta
              ? { r: rows.length - 1, c: columns.length - 1 }
              : { r: active.r, c: columns.length - 1 },
          );
          return;
        case 'Delete':
        case 'Backspace':
          event.preventDefault();
          clearSelection();
          return;
        default:
          break;
      }

      if (meta && event.key.toLowerCase() === 'd') {
        event.preventDefault();
        fillDown();
        return;
      }
      if (meta && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        undo();
        return;
      }
      if (meta && event.key.toLowerCase() === 'a') {
        event.preventDefault();
        setAnchor({ r: 0, c: 0 });
        setActive({ r: rows.length - 1, c: columns.length - 1 });
        return;
      }

      // Typing over a cell replaces it, exactly as it does in a spreadsheet.
      if (!meta && !event.altKey && event.key.length === 1) {
        event.preventDefault();
        beginEdit(active, event.key);
      }
    },
    [editing, finishEdit, move, active, beginEdit, rows.length, columns.length, clearSelection, fillDown, undo],
  );

  // ---------------------------------------------------------------- render

  if (rows.length === 0) {
    return (
      <div className="rounded-lg border border-ink-200 bg-white px-4 py-10 text-center text-sm text-ink-400">
        {emptyMessage ?? 'Nothing here yet.'}
        {onAddRow && (
          <div className="mt-3">
            <button
              onClick={() => void onAddRow()}
              className="rounded-md border border-ink-300 px-3 py-1.5 text-xs font-medium text-ink-700"
            >
              Add row
            </button>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div
        ref={wrapper}
        tabIndex={0}
        onKeyDown={onKeyDown}
        onCopy={onCopy}
        onPaste={onPaste}
        className="overflow-auto rounded-lg border border-ink-300 bg-white outline-none focus:border-ink-400"
        style={{ maxHeight: '65vh' }}
      >
        <table className="border-collapse text-[13px]" style={{ tableLayout: 'fixed' }}>
          <thead className="sticky top-0 z-10">
            <tr>
              <th className="sticky left-0 z-20 w-12 border-b border-r border-ink-300 bg-ink-100 px-2 py-1.5 text-xs font-normal text-ink-400">
                #
              </th>
              {columns.map((column, index) => (
                <th
                  key={column.key}
                  style={{ width: column.width ?? 160, minWidth: column.width ?? 160 }}
                  className="border-b border-r border-ink-300 bg-ink-100 px-2 py-1.5 text-left text-xs font-semibold text-ink-700"
                >
                  <span className="flex items-baseline gap-1.5">
                    <span className="text-[10px] font-normal text-ink-400">
                      {columnLetter(index)}
                    </span>
                    {column.label}
                  </span>
                  {column.hint && (
                    <span className="font-normal text-ink-400">{column.hint}</span>
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, r) => {
              const tone = rowTone?.(row) ?? null;
              const picked = pickedIds?.has(row.id) ?? false;
              return (
              <Fragment key={row.id}>
                {groupOf && renderGroup && groupOf(row) !== (r > 0 ? groupOf(rows[r - 1] as GridRow) : null) && (
                  <tr>
                    <td
                      colSpan={columns.length + 1}
                      className="sticky left-0 border-b border-t border-ink-300 bg-ink-100 px-2 py-1"
                    >
                      {renderGroup(
                        groupOf(row),
                        rows.filter((other) => groupOf(other) === groupOf(row)),
                      )}
                    </td>
                  </tr>
                )}
              <tr>
                <td
                  onClick={(event) => {
                    if (!onPick || isPhantom(row)) return;
                    const next = new Set(pickedIds ?? []);
                    if (event.shiftKey && lastPick !== null) {
                      const [from, to] = lastPick < r ? [lastPick, r] : [r, lastPick];
                      for (let i = from; i <= to; i += 1) {
                        const other = rows[i];
                        if (other && !isPhantom(other)) next.add(other.id);
                      }
                    } else if (next.has(row.id)) {
                      next.delete(row.id);
                    } else {
                      next.add(row.id);
                    }
                    setLastPick(r);
                    onPick(next);
                  }}
                  className={`sticky left-0 z-10 border-b border-r border-ink-200 px-2 py-1 text-right text-xs ${
                    onPick && !isPhantom(row) ? 'cursor-pointer hover:bg-ink-200' : ''
                  } ${
                    picked
                      ? 'bg-ink-900 font-medium text-white'
                      : isPhantom(row)
                        ? 'bg-white text-ink-300'
                        : 'bg-ink-50 text-ink-400'
                  }`}
                  title={onPick && !isPhantom(row) ? 'Click to pick this row · shift-click for a range' : undefined}
                >
                  {r + 1}
                </td>
                {columns.map((column, c) => {
                  const isActive = active.r === r && active.c === c;
                  const isEditing = editing?.cell.r === r && editing.cell.c === c;
                  const selected = inSelection(r, c);
                  const state = saveState[`${r}:${c}`];
                  const locked = column.editable === false;

                  return (
                    <td
                      key={column.key}
                      onMouseDown={(event) => {
                        if (event.shiftKey) {
                          setAnchor((current) => current ?? active);
                        } else {
                          setAnchor(null);
                        }
                        setActive({ r, c });
                        wrapper.current?.focus();
                      }}
                      onDoubleClick={() => beginEdit({ r, c })}
                      title={errors[`${r}:${c}`]}
                      className={[
                        'relative border-b border-r border-ink-200 px-2 py-1 align-top',
                        locked ? 'bg-ink-50 text-ink-500' : 'bg-white text-ink-900',
                        tone === 'review' ? 'bg-flag-50 text-ink-900' : '',
                        tone === 'muted' ? 'bg-ink-50 text-ink-400' : '',
                        picked ? 'bg-sky-100' : '',
                        selected && !isActive ? 'bg-sky-50' : '',
                        column.type === 'number' || column.type === 'currency' ? 'text-right' : '',
                        state === 'error' ? 'bg-red-50' : '',
                      ].join(' ')}
                      style={
                        isActive
                          ? { outline: '2px solid #0f172a', outlineOffset: '-2px' }
                          : undefined
                      }
                    >
                      {isEditing ? (
                        column.type === 'select' ? (
                          <select
                            autoFocus
                            value={editing.value}
                            onChange={(event) =>
                              setEditing({ cell: { r, c }, value: event.target.value })
                            }
                            onBlur={() => void finishEdit(null)}
                            className="w-full bg-white outline-none"
                          >
                            <option value="" />
                            {(column.options ?? []).map((option) => (
                              <option key={option} value={option}>
                                {option}
                              </option>
                            ))}
                          </select>
                        ) : (
                          <input
                            ref={input}
                            value={editing.value}
                            onChange={(event) =>
                              setEditing({ cell: { r, c }, value: event.target.value })
                            }
                            onBlur={() => void finishEdit(null)}
                            className="w-full bg-white outline-none"
                          />
                        )
                      ) : (
                        <span className="block truncate">
                          {display(row[column.key], column.type)}
                        </span>
                      )}

                      {state === 'saving' && (
                        <span className="absolute right-0.5 top-0.5 h-1.5 w-1.5 rounded-full bg-amber-400" />
                      )}
                      {state === 'error' && (
                        <span className="absolute right-0.5 top-0.5 h-1.5 w-1.5 rounded-full bg-red-500" />
                      )}
                    </td>
                  );
                })}
              </tr>
              </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="flex items-center justify-between text-xs text-ink-400">
        <span>
          Type to replace · F2 or double-click to edit · Enter down · Tab right · Shift+arrows select
          · Ctrl+C/V with Excel · Ctrl+D fill down · Ctrl+Z undo
          {onPick ? ' · click a row number to pick it' : ''}
        </span>
        {onAddRow && (
          <button
            onClick={() => void onAddRow()}
            className="rounded-md border border-ink-300 px-2.5 py-1 font-medium text-ink-700"
          >
            + Add row
          </button>
        )}
      </div>
    </div>
  );
}

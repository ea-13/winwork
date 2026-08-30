/**
 * Spreadsheet formulas, for the cells an estimator does arithmetic in.
 *
 * An estimator types `=SUM(D2:D9)` without thinking about it. Making them reach
 * for a calculator and paste the answer back is the small friction that ends
 * with the real numbers living in a spreadsheet and this app holding a stale
 * copy — which is the failure the whole product exists to prevent.
 *
 * Deliberately small. This is not a spreadsheet engine and should not grow into
 * one: no cross-sheet references, no circular resolution, no volatile
 * functions, no dependency graph that recalculates the world. It evaluates one
 * expression against the grid as it currently stands, stores the RESULT as the
 * value, and keeps the formula text beside it so the next edit starts from what
 * you typed rather than from the number it produced.
 *
 * Storing the result rather than the formula is the important decision. The
 * database holds numbers that other things — leveling, buyout totals, exports —
 * read directly, and none of them should have to know what a formula is. The
 * formula is a convenience for entering a number, not a new kind of number.
 */

/** A1-style reference: column letters then a 1-based row number. */
const REFERENCE = /^\$?([A-Z]+)\$?(\d+)$/i;

export type CellLookup = (row: number, column: number) => number | null;

export const isFormula = (input: string): boolean => input.trimStart().startsWith('=');

/** "A" -> 0, "B" -> 1, "AA" -> 26. */
function columnIndex(letters: string): number {
  let index = 0;
  for (const character of letters.toUpperCase()) {
    index = index * 26 + (character.charCodeAt(0) - 64);
  }
  return index - 1;
}

type Token =
  | { kind: 'number'; value: number }
  | { kind: 'operator'; value: string }
  | { kind: 'name'; value: string }
  | { kind: 'range'; from: string; to: string }
  | { kind: 'reference'; value: string };

function tokenise(input: string): Token[] {
  const tokens: Token[] = [];
  let at = 0;

  while (at < input.length) {
    const character = input[at] as string;

    if (/\s/.test(character)) {
      at += 1;
      continue;
    }

    if (/[0-9.]/.test(character)) {
      let text = '';
      while (at < input.length && /[0-9.]/.test(input[at] as string)) {
        text += input[at];
        at += 1;
      }
      const value = Number(text);
      if (!Number.isFinite(value)) throw new Error(`"${text}" is not a number`);
      tokens.push({ kind: 'number', value });
      continue;
    }

    if (/[A-Za-z]/.test(character)) {
      let text = '';
      while (at < input.length && /[A-Za-z0-9$]/.test(input[at] as string)) {
        text += input[at];
        at += 1;
      }

      // A range is two references joined by a colon: D2:D9.
      if (input[at] === ':' && REFERENCE.test(text)) {
        at += 1;
        let to = '';
        while (at < input.length && /[A-Za-z0-9$]/.test(input[at] as string)) {
          to += input[at];
          at += 1;
        }
        if (!REFERENCE.test(to)) throw new Error(`"${text}:${to}" is not a range`);
        tokens.push({ kind: 'range', from: text, to });
        continue;
      }

      tokens.push(
        REFERENCE.test(text)
          ? { kind: 'reference', value: text }
          : { kind: 'name', value: text.toUpperCase() },
      );
      continue;
    }

    if ('+-*/(),%'.includes(character)) {
      tokens.push({ kind: 'operator', value: character });
      at += 1;
      continue;
    }

    throw new Error(`"${character}" is not something a formula can contain`);
  }

  return tokens;
}

/**
 * The functions worth having.
 *
 * Kept to what an estimator actually types into a bid tab. Every addition here
 * is a promise to keep it working, and a long tail of rarely-used functions is
 * how a small helper turns into a spreadsheet engine nobody wanted to own.
 */
const FUNCTIONS: Record<string, (values: number[]) => number> = {
  SUM: (values) => values.reduce((total, value) => total + value, 0),
  AVERAGE: (values) =>
    values.length === 0 ? 0 : values.reduce((total, value) => total + value, 0) / values.length,
  MIN: (values) => (values.length === 0 ? 0 : Math.min(...values)),
  MAX: (values) => (values.length === 0 ? 0 : Math.max(...values)),
  COUNT: (values) => values.length,
  ROUND: (values) => {
    const [value = 0, places = 0] = values;
    const factor = 10 ** places;
    return Math.round(value * factor) / factor;
  },
  ABS: (values) => Math.abs(values[0] ?? 0),
};

/**
 * Recursive-descent evaluation.
 *
 * Small enough to read in one sitting, which matters more than speed for an
 * expression that runs once per keystroke-commit on a single cell.
 */
function evaluate(tokens: Token[], lookup: CellLookup): number {
  let at = 0;

  const peek = (): Token | undefined => tokens[at];
  const take = (): Token | undefined => tokens[at++];

  /** Every number a token stands for — one for a cell, many for a range. */
  const valuesOf = (token: Token): number[] => {
    if (token.kind === 'reference') {
      const match = REFERENCE.exec(token.value);
      if (!match) throw new Error(`"${token.value}" is not a cell`);
      const value = lookup(Number(match[2]) - 1, columnIndex(match[1] as string));
      // An empty cell is not zero in a SUM of three cells where two are blank —
      // but it must not poison the total either. It contributes nothing.
      return value === null ? [] : [value];
    }

    if (token.kind === 'range') {
      const from = REFERENCE.exec(token.from);
      const to = REFERENCE.exec(token.to);
      if (!from || !to) throw new Error('That is not a range');

      const r0 = Math.min(Number(from[2]), Number(to[2])) - 1;
      const r1 = Math.max(Number(from[2]), Number(to[2])) - 1;
      const c0 = Math.min(columnIndex(from[1] as string), columnIndex(to[1] as string));
      const c1 = Math.max(columnIndex(from[1] as string), columnIndex(to[1] as string));

      const values: number[] = [];
      for (let r = r0; r <= r1; r += 1) {
        for (let c = c0; c <= c1; c += 1) {
          const value = lookup(r, c);
          if (value !== null) values.push(value);
        }
      }
      return values;
    }

    throw new Error('Expected a cell or a range');
  };

  function primary(): number {
    const token = take();
    if (!token) throw new Error('The formula ends before it finishes');

    if (token.kind === 'number') return token.value;

    if (token.kind === 'operator' && token.value === '-') return -primary();
    if (token.kind === 'operator' && token.value === '+') return primary();

    if (token.kind === 'operator' && token.value === '(') {
      const value = expression();
      const closing = take();
      if (!closing || closing.kind !== 'operator' || closing.value !== ')') {
        throw new Error('A bracket is not closed');
      }
      return value;
    }

    if (token.kind === 'reference' || token.kind === 'range') {
      const values = valuesOf(token);
      if (token.kind === 'range') throw new Error('A range only makes sense inside a function');
      return values[0] ?? 0;
    }

    if (token.kind === 'name') {
      const fn = FUNCTIONS[token.value];
      if (!fn) throw new Error(`${token.value} is not a function this supports`);

      const open = take();
      if (!open || open.kind !== 'operator' || open.value !== '(') {
        throw new Error(`${token.value} needs brackets`);
      }

      const values: number[] = [];
      if (peek()?.kind === 'operator' && (peek() as { value: string }).value === ')') {
        take();
        return fn(values);
      }

      for (;;) {
        const next = peek();
        if (next && next.kind === 'range') {
          take();
          values.push(...valuesOf(next));
        } else {
          values.push(expression());
        }

        const separator = take();
        if (!separator || separator.kind !== 'operator') throw new Error('Expected , or )');
        if (separator.value === ')') break;
        if (separator.value !== ',') throw new Error('Expected , or )');
      }

      return fn(values);
    }

    throw new Error('The formula does not make sense here');
  }

  function unary(): number {
    let value = primary();
    // Trailing percent, so 15% reads as 0.15 the way it does in a spreadsheet.
    while (peek()?.kind === 'operator' && (peek() as { value: string }).value === '%') {
      take();
      value /= 100;
    }
    return value;
  }

  function term(): number {
    let value = unary();
    for (;;) {
      const next = peek();
      if (!next || next.kind !== 'operator' || (next.value !== '*' && next.value !== '/')) {
        return value;
      }
      take();
      const right = unary();
      if (next.value === '/' && right === 0) throw new Error('Division by zero');
      value = next.value === '*' ? value * right : value / right;
    }
  }

  function expression(): number {
    let value = term();
    for (;;) {
      const next = peek();
      if (!next || next.kind !== 'operator' || (next.value !== '+' && next.value !== '-')) {
        return value;
      }
      take();
      const right = term();
      value = next.value === '+' ? value + right : value - right;
    }
  }

  const result = expression();
  if (at < tokens.length) throw new Error('There is something left over at the end');
  if (!Number.isFinite(result)) throw new Error('That does not come out to a number');
  return result;
}

export type FormulaResult =
  | { ok: true; value: number }
  | { ok: false; error: string };

/** Evaluates `=...` against the grid. The leading = is optional. */
export function evaluateFormula(input: string, lookup: CellLookup): FormulaResult {
  try {
    const body = input.trimStart().startsWith('=') ? input.trimStart().slice(1) : input;
    if (body.trim() === '') return { ok: false, error: 'The formula is empty' };
    return { ok: true, value: evaluate(tokenise(body), lookup) };
  } catch (caught) {
    return { ok: false, error: caught instanceof Error ? caught.message : String(caught) };
  }
}

/** "A", "B" … "AA" — the header letters a formula refers to. */
export function columnLetter(index: number): string {
  let letters = '';
  let n = index + 1;
  while (n > 0) {
    const remainder = (n - 1) % 26;
    letters = String.fromCharCode(65 + remainder) + letters;
    n = Math.floor((n - remainder) / 26);
  }
  return letters;
}

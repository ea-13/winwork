import * as XLSX from 'xlsx';

/**
 * Parsing real subcontractor lists.
 *
 * These are spreadsheets a human maintains, not an export contract. The header
 * row is not always row 1, column names vary, casing and trailing spaces are
 * arbitrary, and one of the two formats carries no trade information at all.
 * So: find the header, map by meaning, and never invent what is not there.
 */

export type ParsedSub = {
  name: string;
  vendorCode: string | null;
  contactName: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  addressLine: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
  unionStatus: 'UNION' | 'NON_UNION' | 'UNKNOWN';
  /** The sheet's own words for what they do. Empty when the file has none. */
  scopeText: string | null;
  /** CSI divisions, only where the scope text actually matched. */
  divisions: string[];
  /** Why this row would not be imported, if it would not be. */
  skipReason: string | null;
  raw: Record<string, unknown>;
};

export type ParseResult = {
  sourceKind: 'SUB_DIRECTORY' | 'VENDOR_MASTER' | 'OTHER';
  sheetNames: string[];
  rowCount: number;
  rows: ParsedSub[];
  /** Scope strings that matched no division, for a human to map. */
  unmatchedScopes: string[];
};

const clean = (value: unknown): string =>
  String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * Trade words to CSI divisions. Deliberately conservative: a term earns a
 * division only when it unambiguously names that work. Anything else is left
 * unclassified for a human, because a wrong trade assignment sends a package to
 * the wrong bidders.
 */
const TRADE_TO_DIVISION: { pattern: RegExp; divisions: string[] }[] = [
  { pattern: /final clean|janitorial|cleaning service|temp(orary)? (fence|power|toilet)/i, divisions: ['01'] },
  { pattern: /\bdemo(lition)?\b|abatement|asbestos/i, divisions: ['02'] },
  { pattern: /concrete|rebar|reinforc|shotcrete|gunite|foundation|gyp ?-? ?crete|gycrete|underlayment/i, divisions: ['03'] },
  { pattern: /masonry|brick|block|stone\b|cmu/i, divisions: ['04'] },
  { pattern: /structural steel|steel erect|miscellaneous metal|handrail|ornamental/i, divisions: ['05'] },
  { pattern: /carpentry|carpenter|mill ?work|milwork|casework|cabinet|framing lumber|rough carp|labou?rs? ?(&|and)? ?carp/i, divisions: ['06'] },
  { pattern: /roof|waterproof|insulation|firestop|sheet metal flashing|siding|caulk|sealant/i, divisions: ['07'] },
  { pattern: /door|window|glazing|glass|storefront|curtain ?wall|hardware/i, divisions: ['08'] },
  { pattern: /drywall|taping|gypsum|plaster|stucco|acoustic|ceiling|floor(ing)?|carpet|tile|paint|wall ?paper|epoxy|terrazzo|resilient/i, divisions: ['09'] },
  { pattern: /toilet accessor|signage|lockers|partitions|specialt/i, divisions: ['10'] },
  { pattern: /appliance|food service|kitchen equip|laundry equip/i, divisions: ['11'] },
  { pattern: /window treatment|blinds|shades?\b|furnishing|furniture/i, divisions: ['12'] },
  { pattern: /pool|spa\b|sauna|special construction/i, divisions: ['13'] },
  { pattern: /elevator|escalator|lift\b|conveying/i, divisions: ['14'] },
  { pattern: /fire ?sprinkler|fire suppress|standpipe/i, divisions: ['21'] },
  { pattern: /plumb|piping|water heater|sewer|gas fitting/i, divisions: ['22'] },
  { pattern: /hvac|mechanical|duct|air condition|heating|ventilat|sheet ?metal\b/i, divisions: ['23'] },
  { pattern: /electric|lighting|power|switchgear/i, divisions: ['26'] },
  { pattern: /low ?voltage|data\b|telecom|communication|structured cabl/i, divisions: ['27'] },
  { pattern: /fire alarm|security|access control|cctv|surveillance/i, divisions: ['28'] },
  { pattern: /excavat|earthwork|grading|shoring|underground|site ?work/i, divisions: ['31'] },
  { pattern: /landscap|irrigation|pav(ing|er)|asphalt|fencing|striping|hardscape/i, divisions: ['32'] },
  { pattern: /utilit|storm drain|septic/i, divisions: ['33'] },
];

/** Divisions named by a scope string, or an empty array when nothing matches. */
export function divisionsFor(scopeText: string): string[] {
  const found = new Set<string>();
  for (const { pattern, divisions } of TRADE_TO_DIVISION) {
    if (pattern.test(scopeText)) divisions.forEach((division) => found.add(division));
  }
  return [...found].sort();
}

const LABELS: Record<string, RegExp> = {
  name: /^(company|vendor[_ ]?name|sub(contractor)?|business|firm|name)$/i,
  vendorCode: /^(vendor[_ ]?code|code|id|account)$/i,
  contactName: /^(owner|owner\/pm|pm|contact|contact[_ ]?name|rep|estimator)$/i,
  contactEmail: /^(e?[_ ]?mail|vendor[_ ]?email|email[_ ]?address)$/i,
  contactPhone: /^(phone|number|tel|telephone|mobile|cell|contact[_ ]?number)$/i,
  scopeText: /^(scope|trade|category|type[_ ]?of[_ ]?work|discipline|division)$/i,
  addressLine: /^(address([_ ]?1)?|street)$/i,
  city: /^(city|address[_ ]?2|town)$/i,
  state: /^(state|province|address[_ ]?3)$/i,
  postalCode: /^(zip([_ ]?code)?|postal([_ ]?code)?)$/i,
  kindColumn: /^(type|vendor[_ ]?type|class)$/i,
};

/**
 * Finds the row that is actually the header.
 *
 * A hand-kept directory often has a title, a blank row, or a merged banner
 * above the real headers, which is why reading row 1 blind produced empty
 * columns for every field.
 */
function findHeaderRow(rows: unknown[][]): number {
  const limit = Math.min(rows.length, 15);
  let best = -1;
  let bestScore = 0;

  for (let index = 0; index < limit; index += 1) {
    const cells = (rows[index] ?? []).map(clean).filter(Boolean);
    if (cells.length < 2) continue;

    const score = cells.filter((cell) =>
      Object.values(LABELS).some((pattern) => pattern.test(cell)),
    ).length;

    if (score > bestScore) {
      bestScore = score;
      best = index;
    }
  }
  // Two recognised labels is enough to call it a header; one is a coincidence.
  return bestScore >= 2 ? best : -1;
}

function mapColumns(header: unknown[]): Record<string, number> {
  const mapping: Record<string, number> = {};
  header.forEach((cell, index) => {
    const label = clean(cell);
    if (!label) return;
    for (const [field, pattern] of Object.entries(LABELS)) {
      if (mapping[field] === undefined && pattern.test(label)) mapping[field] = index;
    }
  });
  return mapping;
}

/**
 * Vendor-master Type codes that mean "this is a subcontractor". Everything else
 * — employees, credit cards, clients, plain vendors — is skipped rather than
 * imported as a bidder.
 */
const SUB_TYPES = /^(sub|subs|sub ?contractor|hi ?ic|sole)$/i;

export function parseSubWorkbook(buffer: Buffer): ParseResult {
  const workbook = XLSX.read(buffer, { type: 'buffer' });
  const rows: ParsedSub[] = [];
  const unmatched = new Set<string>();
  let hasScopeColumn = false;
  let hasTypeColumn = false;
  let total = 0;

  for (const sheetName of workbook.SheetNames) {
    const grid = XLSX.utils.sheet_to_json<unknown[]>(workbook.Sheets[sheetName]!, {
      header: 1,
      blankrows: false,
      defval: '',
    });

    const headerIndex = findHeaderRow(grid);
    if (headerIndex === -1) continue;

    const columns = mapColumns(grid[headerIndex] ?? []);
    if (columns.name === undefined) continue;
    if (columns.scopeText !== undefined) hasScopeColumn = true;
    if (columns.kindColumn !== undefined) hasTypeColumn = true;

    // The sheet name is often the only place union status is recorded.
    const unionStatus: ParsedSub['unionStatus'] = /non[- ]?union/i.test(sheetName)
      ? 'NON_UNION'
      : /union/i.test(sheetName)
        ? 'UNION'
        : 'UNKNOWN';

    for (const row of grid.slice(headerIndex + 1)) {
      const at = (field: string): string =>
        columns[field] === undefined ? '' : clean(row[columns[field]!]);

      const name = at('name');
      if (!name) continue;
      total += 1;

      const kind = at('kindColumn');
      const scopeText = at('scopeText');
      const divisions = scopeText ? divisionsFor(scopeText) : [];
      if (scopeText && divisions.length === 0) unmatched.add(scopeText);

      let skipReason: string | null = null;
      if (kind && !SUB_TYPES.test(kind)) {
        skipReason = `Type "${kind}" is not a subcontractor`;
      }

      const raw: Record<string, unknown> = { sheet: sheetName };
      (grid[headerIndex] ?? []).forEach((label, index) => {
        const key = clean(label);
        if (key) raw[key] = clean(row[index]);
      });

      rows.push({
        name,
        vendorCode: at('vendorCode') || null,
        contactName: at('contactName') || null,
        contactEmail: at('contactEmail') || null,
        contactPhone: at('contactPhone') || null,
        addressLine: at('addressLine') || null,
        city: at('city') || null,
        state: at('state') || null,
        postalCode: at('postalCode') || null,
        unionStatus,
        scopeText: scopeText || null,
        divisions,
        skipReason,
        raw,
      });
    }
  }

  // Two rows for the same company, common when a directory has union and
  // non-union sheets. Keep the first and let the caller see the count.
  const seen = new Set<string>();
  for (const row of rows) {
    const key = row.name.toLowerCase();
    if (seen.has(key) && !row.skipReason) row.skipReason = 'Duplicate name in this file';
    seen.add(key);
  }

  return {
    sourceKind: hasScopeColumn ? 'SUB_DIRECTORY' : hasTypeColumn ? 'VENDOR_MASTER' : 'OTHER',
    sheetNames: workbook.SheetNames,
    rowCount: total,
    rows,
    unmatchedScopes: [...unmatched].sort(),
  };
}

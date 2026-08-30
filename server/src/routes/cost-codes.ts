import { Router, type NextFunction, type Request, type Response } from 'express';
import multer from 'multer';
import * as XLSX from 'xlsx';
import { requireRole } from '../lib/auth.js';
import { supabaseForUser } from '../lib/supabase.js';

export const costCodesRouter = Router();

/**
 * Cost codes — the tenant's own structure.
 *
 * CSI divisions stay as the shared vocabulary between tenants, because gap
 * patterns and division experts are knowledge that has to travel. Cost codes are
 * the opposite: they are a house standard, they are what the estimator has in
 * their head and what accounting reconciles against, and a tool that makes them
 * translate at every step is a tool they use once.
 *
 * Import is deliberately forgiving. A GC's cost structure arrives as whatever
 * they have — a codes tab in a template, a column in last year's bid, sometimes
 * a sheet with three header rows and a logo. Refusing anything that is not a
 * clean two-column file would mean nobody ever imports one.
 */

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024, files: 1 },
});

function handleUpload(req: Request, res: Response, next: NextFunction): void {
  upload.single('file')(req, res, (error: unknown) => {
    if (!error) {
      next();
      return;
    }
    const message = error instanceof Error ? error.message : 'Upload failed';
    res.status(/LIMIT_FILE_SIZE/.test(message) ? 413 : 400).json({ error: message });
  });
}

type ParsedCode = {
  code: string;
  description: string;
  csiDivision: string | null;
  csiSection: string | null;
};

/** Header names seen in the wild, lowercased. */
const CODE_HEADERS = ['cost code', 'code', 'cost_code', 'costcode', 'item', 'phase', 'phase code'];
const DESC_HEADERS = ['description', 'desc', 'name', 'scope', 'title', 'item description'];
const DIV_HEADERS = ['division', 'div', 'csi', 'csi division', 'csi_division'];

const norm = (value: unknown): string => String(value ?? '').trim();

/**
 * Finds the header row and the columns that matter.
 *
 * The header is rarely row 1. A bid export routinely opens with a company name,
 * a project name and a blank line, so this scans the first fifteen rows for the
 * one that looks like headers rather than assuming.
 */
function locate(rows: unknown[][]): { headerRow: number; code: number; desc: number; div: number } | null {
  for (let r = 0; r < Math.min(rows.length, 15); r += 1) {
    const cells = (rows[r] ?? []).map((cell) => norm(cell).toLowerCase());
    const code = cells.findIndex((cell) => CODE_HEADERS.includes(cell));
    const desc = cells.findIndex((cell) => DESC_HEADERS.includes(cell));
    if (code >= 0 && desc >= 0) {
      return { headerRow: r, code, desc, div: cells.findIndex((cell) => DIV_HEADERS.includes(cell)) };
    }
  }
  return null;
}

/**
 * Pulls a CSI division out of a code where one is recognisable.
 *
 * "09 21 16" and "09-100" both start with a division. "1200-A" does not, and
 * guessing would map a house code onto the wrong trade — so it returns null and
 * the estimator says.
 */
function divisionOf(code: string, stated: string | null): string | null {
  if (stated) {
    const digits = stated.replace(/\D/g, '');
    if (digits.length >= 2) return digits.slice(0, 2);
  }
  const match = /^(\d{2})[\s.\-]/.exec(code.trim());
  return match ? (match[1] as string) : null;
}

function parseWorkbook(buffer: Buffer): { codes: ParsedCode[]; note: string | null } {
  const book = XLSX.read(buffer, { type: 'buffer' });
  const codes: ParsedCode[] = [];
  const seen = new Set<string>();
  let scanned = 0;

  for (const sheetName of book.SheetNames) {
    const sheet = book.Sheets[sheetName];
    if (!sheet) continue;

    const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, blankrows: false });
    const found = locate(rows);
    if (!found) continue;

    scanned += 1;

    for (let r = found.headerRow + 1; r < rows.length; r += 1) {
      const row = rows[r] ?? [];
      const code = norm(row[found.code]);
      const description = norm(row[found.desc]);

      // A row with a code and no description is a section header in most
      // exports; one with neither is padding. Neither is a cost code.
      if (code === '' || description === '') continue;
      if (seen.has(code.toLowerCase())) continue;
      seen.add(code.toLowerCase());

      const stated = found.div >= 0 ? norm(row[found.div]) : null;
      const division = divisionOf(code, stated || null);

      codes.push({
        code,
        description,
        csiDivision: division,
        csiSection: /^\d{2}\s\d{2}\s\d{2}$/.test(code.trim()) ? code.trim() : null,
      });
    }
  }

  return {
    codes,
    note:
      scanned === 0
        ? 'No sheet had a recognisable code and description column. Headers looked for: ' +
          `${CODE_HEADERS.slice(0, 4).join(', ')} and ${DESC_HEADERS.slice(0, 4).join(', ')}.`
        : null,
  };
}

/** Reads a file and shows what would be imported. Writes nothing. */
costCodesRouter.post(
  '/cost-codes/import/preview',
  requireRole('BC', 'EST', 'ADMIN'),
  handleUpload,
  (req, res) => {
    const file = req.file;
    if (!file) {
      res.status(400).json({ error: 'No file was sent' });
      return;
    }

    try {
      const { codes, note } = parseWorkbook(file.buffer);
      res.json({
        filename: file.originalname,
        found: codes.length,
        note,
        // Enough to judge the parse without shipping a thousand rows to a
        // browser that is only being asked "does this look right".
        sample: codes.slice(0, 40),
        codes,
      });
    } catch (caught) {
      res.status(400).json({
        error: `Could not read that file: ${caught instanceof Error ? caught.message : caught}`,
      });
    }
  },
);

/** Commits a reviewed set. Idempotent on code within the tenant. */
costCodesRouter.post('/cost-codes/import', requireRole('BC', 'EST', 'ADMIN'), async (req, res) => {
  const auth = req.auth;
  if (!auth) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }

  const body = (req.body ?? {}) as { codes?: ParsedCode[]; source?: string };
  const codes = Array.isArray(body.codes) ? body.codes : [];

  if (codes.length === 0) {
    res.status(400).json({ error: 'Nothing to import' });
    return;
  }

  const db = supabaseForUser(auth.token);

  const { data: existing } = await db.from('cost_code').select('code').eq('tenant_id', auth.tenantId);
  const already = new Set((existing ?? []).map((row) => String(row.code).toLowerCase()));

  const fresh = codes.filter(
    (entry) => entry.code && !already.has(String(entry.code).toLowerCase()),
  );

  if (fresh.length > 0) {
    const { error } = await db.from('cost_code').insert(
      fresh.map((entry, index) => ({
        tenant_id: auth.tenantId,
        code: entry.code,
        description: entry.description,
        csi_division: entry.csiDivision,
        csi_section: entry.csiSection,
        sort_order: index,
        source: body.source === 'TEMPLATE' ? 'TEMPLATE' : 'IMPORTED',
      })),
    );

    if (error) {
      res.status(400).json({ error: error.message });
      return;
    }
  }

  await db.from('audit_event').insert({
    tenant_id: auth.tenantId,
    actor_id: auth.userId,
    action: 'IMPORT_COST_CODES',
    table_name: 'cost_code',
    record_id: auth.tenantId,
    before: null,
    after: { imported: fresh.length, skipped: codes.length - fresh.length },
  });

  res.status(201).json({ imported: fresh.length, skipped: codes.length - fresh.length });
});

/** The tenant's codes, in their own order. */
costCodesRouter.get('/cost-codes', async (req, res) => {
  const auth = req.auth;
  if (!auth) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }

  const { data, error } = await supabaseForUser(auth.token)
    .from('cost_code')
    .select('id, code, description, csi_division, csi_section, parent_id, sort_order, is_active, source')
    .eq('is_active', true)
    .order('sort_order')
    .order('code');

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }
  res.json(data ?? []);
});

/** One code, by hand. */
costCodesRouter.post('/cost-codes', requireRole('BC', 'EST', 'ADMIN'), async (req, res) => {
  const auth = req.auth;
  if (!auth) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }

  const body = (req.body ?? {}) as Record<string, unknown>;
  const code = typeof body.code === 'string' ? body.code.trim() : '';
  const description = typeof body.description === 'string' ? body.description.trim() : '';

  if (code === '' || description === '') {
    res.status(400).json({ error: 'Both a code and a description are required' });
    return;
  }

  const { data, error } = await supabaseForUser(auth.token)
    .from('cost_code')
    .insert({
      tenant_id: auth.tenantId,
      code,
      description,
      csi_division:
        typeof body.csiDivision === 'string' ? body.csiDivision.trim() || null : null,
      source: 'MANUAL',
    })
    .select('*')
    .single();

  if (error) {
    res.status(error.code === '23505' ? 409 : 400).json({
      error: error.code === '23505' ? `${code} already exists` : error.message,
    });
    return;
  }

  res.status(201).json(data);
});

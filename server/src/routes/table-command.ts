import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { Router } from 'express';
import { z } from 'zod';
import { MODEL } from '../lib/anthropic.js';
import { requireRole } from '../lib/auth.js';
import { EDITABLE } from '../lib/editable.js';
import { env } from '../env.js';
import { supabaseForUser } from '../lib/supabase.js';

export const tableCommandRouter = Router();

/**
 * Editing a table by describing the change.
 *
 * "Set every division 22 quantity basis to 'per fixture schedule'", "merge these
 * four lines into one", "the drywall items should all be package 09" — each is
 * one sentence and forty clicks, and an estimator with a bid due does the forty
 * clicks in a spreadsheet instead.
 *
 * THE RULE THIS DOES NOT BREAK. R2 says agents write evidence and humans write
 * state, and this still holds — because here the human IS the author. They said
 * what to change; the model only works out which rows and fields that means. So
 * it never writes: it returns a diff, the person looks at it, and applying it
 * goes through the same audited PATCH as typing would. The model is a faster
 * keyboard, not a decision-maker, and the review step is what keeps it one.
 *
 * Two hard constraints make that real rather than aspirational:
 *
 *   - It may only touch columns already in EDITABLE for that table. The same
 *     whitelist that stops a human typing over a gate-controlled column stops
 *     this too, so there is no path here that a form does not also have.
 *   - It may only touch row ids it was given. It cannot widen the selection,
 *     and "update everything" reaches exactly the rows on screen.
 */

const Edit = z.object({
  rowId: z.string(),
  field: z.string(),
  /** The new value, as text. Coerced by the same parser the grid uses. */
  value: z.string().nullable(),
  /** Why this row, in the user's terms. Shown in the diff. */
  reason: z.string(),
});

const Plan = z.object({
  /** One sentence on what the change does, for the confirm step. */
  summary: z.string(),
  edits: z.array(Edit),
  /** Rows deliberately left alone, when that is surprising. */
  skipped: z.array(z.string()),
  /** Set when the instruction is ambiguous — the plan is then empty. */
  question: z.string().nullable(),
});

const SYSTEM = `You turn an estimator's instruction into a precise set of cell
edits on a construction estimating table.

You are given the table's columns, the rows currently on screen, and what the
user said. Return the edits that carry out their instruction.

RULES YOU MAY NOT BREAK:

- ONLY THE ROWS YOU WERE GIVEN. Never invent a row id. If the instruction implies
  rows that are not in front of you, say so in the question field and return no edits.
- ONLY THE FIELDS LISTED AS EDITABLE. Anything else is controlled by a gate and
  is not yours to touch.
- NO INVENTED VALUES. If they say "set the quantity to what the schedule says"
  and you were not given the schedule, that is a question, not a guess. A blank
  stays blank unless they told you what to put in it.
- ASK WHEN IT IS AMBIGUOUS. "Fix the framing lines" could mean four things.
  Returning the wrong forty edits is far worse than one clarifying question,
  because the person has to find and undo them.
- BE LITERAL ABOUT SCOPE. "All of them" means every row you were given. "The
  drywall ones" means the ones that are actually drywall — if you are unsure
  which, ask.
- The reason field is per row and short: why THIS row matched. It is what the person
  reads before accepting, so "division 22" beats "matches criteria".

You are not deciding anything. The person decides; you are working out which
cells they meant.`;

let client: Anthropic | null = null;

function getClient(): Anthropic {
  if (!env.anthropicApiKey) throw new Error('ANTHROPIC_API_KEY is not set');
  client ??= new Anthropic({ apiKey: env.anthropicApiKey });
  return client;
}

/**
 * Works out what the instruction means. Writes nothing.
 *
 * Deliberately split from applying it: the person sees the diff first, every
 * time. An instruction that turned straight into forty writes would be the
 * moment this stops being a faster keyboard and becomes something that edits
 * your project on its own.
 */
tableCommandRouter.post('/table-command/plan', requireRole('EST', 'BC', 'PM'), async (req, res) => {
  const auth = req.auth;
  if (!auth) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }

  const body = (req.body ?? {}) as {
    table?: string;
    instruction?: string;
    rows?: Record<string, unknown>[];
    columns?: { key: string; label: string }[];
    selectedRowIds?: string[];
  };

  const table = typeof body.table === 'string' ? body.table : '';
  const instruction = typeof body.instruction === 'string' ? body.instruction.trim() : '';
  const rows = Array.isArray(body.rows) ? body.rows : [];

  const editable = EDITABLE[table];
  if (!editable) {
    res.status(400).json({ error: `${table} is not an editable table` });
    return;
  }
  if (instruction === '') {
    res.status(400).json({ error: 'Say what you want changed' });
    return;
  }
  if (rows.length === 0) {
    res.status(400).json({ error: 'There are no rows on screen to change' });
    return;
  }

  // Only what is on screen, and only as much of it as is useful. A table of
  // four hundred rows would be mostly irrelevant to any one instruction, and
  // sending it all would cost money to have the model ignore it.
  const selected = new Set(body.selectedRowIds ?? []);
  const scoped = selected.size > 0 ? rows.filter((row) => selected.has(String(row.id))) : rows;
  const capped = scoped.slice(0, 200);

  // Two different lists, and conflating them was a bug.
  //
  // WRITABLE is what may be changed — the same whitelist a form obeys. CONTEXT
  // is everything else on the row, shown to the model read-only so it can
  // filter on it. Without that separation "set the basis on the plumbing items"
  // is impossible, because `package` is not writable and so the model never saw
  // it — it can only select rows by fields it is allowed to edit, which is a
  // strange and useless constraint.
  const provided = body.columns ?? [];
  const writable = provided.filter((column) => editable.includes(column.key));
  const context = provided.filter((column) => !editable.includes(column.key));

  const describe = (row: Record<string, unknown>, keys: { key: string }[]) =>
    keys.map((column) => `${column.key}=${JSON.stringify(row[column.key] ?? null)}`).join(' ');

  const described = capped
    .map(
      (row) =>
        `  ${row.id}: ${describe(row, writable)}` +
        (context.length > 0 ? `  [read-only: ${describe(row, context)}]` : ''),
    )
    .join('\n');

  try {
    const response = await getClient().messages.parse({
      model: MODEL,
      max_tokens: 8000,
      system: SYSTEM,
      thinking: { type: 'adaptive' },
      output_config: { format: zodOutputFormat(Plan), effort: 'low' },
      messages: [
        {
          role: 'user',
          content: [
            `TABLE: ${table}`,
            `FIELDS YOU MAY CHANGE: ${writable.map((column) => column.key).join(', ')}`,
            context.length > 0
              ? `FIELDS YOU MAY READ BUT NOT CHANGE (use them to pick rows): ${context.map((column) => column.key).join(', ')}`
              : '',
            selected.size > 0
              ? `THE USER HAS SELECTED ${capped.length} ROW(S). Only these.`
              : `ROWS ON SCREEN (${capped.length}${scoped.length > capped.length ? `, showing the first ${capped.length} of ${scoped.length}` : ''}):`,
            described,
            '',
            '---',
            '',
            `INSTRUCTION: ${instruction}`,
          ].join('\n'),
        },
      ],
    });

    if (!response.parsed_output) {
      res.status(502).json({ error: 'Could not work out what that meant. Try rephrasing it.' });
      return;
    }

    const plan = response.parsed_output;
    const known = new Set(capped.map((row) => String(row.id)));

    // Belt and braces over the prompt. A row id or field the model invented is
    // dropped here rather than trusted, because the prompt is a request and
    // this is the guarantee.
    const edits = plan.edits.filter(
      (edit) => known.has(edit.rowId) && editable.includes(edit.field),
    );

    res.json({
      summary: plan.summary,
      question: plan.question,
      edits,
      dropped: plan.edits.length - edits.length,
      skipped: plan.skipped,
    });
  } catch (caught) {
    res.status(500).json({ error: caught instanceof Error ? caught.message : String(caught) });
  }
});

/**
 * Applies a reviewed plan.
 *
 * Goes through the same validation and the same audit_event as typing into the
 * cell would — every edit lands with the actor and the before/after, and is
 * indistinguishable in the ledger from a person having typed it. Which is what
 * it is: a person typed the instruction.
 */
tableCommandRouter.post('/table-command/apply', requireRole('EST', 'BC', 'PM'), async (req, res) => {
  const auth = req.auth;
  if (!auth) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }

  const body = (req.body ?? {}) as {
    table?: string;
    instruction?: string;
    edits?: { rowId: string; field: string; value: string | null }[];
  };

  const table = typeof body.table === 'string' ? body.table : '';
  const edits = Array.isArray(body.edits) ? body.edits : [];
  const editable = EDITABLE[table];

  if (!editable) {
    res.status(400).json({ error: `${table} is not an editable table` });
    return;
  }

  const refused = edits.filter((edit) => !editable.includes(edit.field));
  if (refused.length > 0) {
    res.status(403).json({
      error: `Not editable on ${table}: ${[...new Set(refused.map((edit) => edit.field))].join(', ')}`,
    });
    return;
  }

  const db = supabaseForUser(auth.token);

  // Grouped per row so one row is one PATCH and one audit entry, matching what
  // a person editing several cells on a row produces.
  const byRow = new Map<string, Record<string, unknown>>();
  for (const edit of edits) {
    byRow.set(edit.rowId, { ...(byRow.get(edit.rowId) ?? {}), [edit.field]: edit.value });
  }

  let applied = 0;
  const failures: string[] = [];

  for (const [rowId, patch] of byRow) {
    const { data: before } = await db.from(table).select('*').eq('id', rowId).maybeSingle();
    if (!before) {
      failures.push(`${rowId}: no longer exists`);
      continue;
    }

    const { error } = await db.from(table).update(patch).eq('id', rowId);
    if (error) {
      failures.push(`${rowId}: ${error.message}`);
      continue;
    }

    await db.from('audit_event').insert({
      tenant_id: auth.tenantId,
      actor_id: auth.userId,
      action: 'HUMAN_EDIT',
      table_name: table,
      record_id: rowId,
      before: Object.fromEntries(Object.keys(patch).map((key) => [key, before[key] ?? null])),
      // The instruction rides in `after` under a reserved key rather than its
      // own column: audit_event has no rationale field, and adding one to a
      // table with an append-only trigger is a migration for a string. Six
      // months on, "set division 22 basis from the fixture schedule" is what
      // explains forty rows that otherwise look arbitrary.
      after: {
        ...patch,
        __instruction:
          typeof body.instruction === 'string' ? body.instruction.slice(0, 500) : null,
      },
    });

    applied += 1;
  }

  res.json({ applied, failures });
});

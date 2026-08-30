import Anthropic from '@anthropic-ai/sdk';
import { Router } from 'express';
import { MODEL } from '../lib/anthropic.js';
import { CHAT_TOOLS, runTool, type QueueFn, type ToolResult } from '../lib/chat-tools.js';
import { COMPARE_BIDS_PROMPT_VERSION } from '../agents/compare-bids.js';
import { SCOPE_CONTEXT_PROMPT_VERSION } from '../agents/scope-context.js';
import { AUDIT_COVERAGE_PROMPT_VERSION } from '../agents/audit-coverage.js';
import { MAP_COST_CODES_PROMPT_VERSION } from '../agents/map-cost-codes.js';
import { env } from '../env.js';
import { computeAddBacks, computeLeveling, computeScopeLeveling, detectGaps, recordContextOutcomes } from '../lib/leveling.js';
import { supabaseForUser } from '../lib/supabase.js';

export const chatRouter = Router();

const SYSTEM = `You are the assistant inside WinProjects, preconstruction
software for a general contractor's estimating team.

The product makes the Scope of Work the baseline every subcontractor bid is
measured against, then proves who carried which scope and who did not. The chain
is Scope of Work → Sub Solicitation → Bid Leveling, with a scope-gap risk log and
a buyout log as the output.

WHAT YOU CAN DO

Read anything about the project with the tools, and run the drafting agents and
the leveling arithmetic. Use the tools rather than guessing — get_project_state
first for almost any question. If somebody asks about a number, go and read it.

WHAT YOU CANNOT DO, AND WHY

You cannot write project state. Not a scope item, not an accepted extraction,
not a gap disposition, not a bidder selection. Those are gate crossings and they
belong to a person with a written rationale — the audit trail has to be a record
of what an estimator decided, and this product is sold on exactly that. So you
may say "there are four undecided gaps and here is what I would carry against
each", and then the person clicks. Do not apologise for this or treat it as a
limitation; it is the design.

You never state a price you were not given, never invent a quantity, and never
recommend a bidder. Ranking is arithmetic; selection is a human act at H6.

HOW TO ANSWER

Short. An estimator reading this is mid-task with a bid due. Lead with the
answer, not with what you are about to do.

Cite what you read — a scope id, a sheet number, a bidder name. If a tool comes
back empty, say so plainly rather than filling the space.

When something is missing or wrong, say what it costs. "Nobody priced
firestopping" is a fact; "nobody priced firestopping, so it becomes your cost at
buyout" is the reason they care.

If a question needs work that would take minutes and money, say what it will do
and roughly what it costs before running it.`;

let client: Anthropic | null = null;

function getClient(): Anthropic {
  if (!env.anthropicApiKey) throw new Error('ANTHROPIC_API_KEY is not set');
  client ??= new Anthropic({ apiKey: env.anthropicApiKey });
  return client;
}

/**
 * A conversation that can act.
 *
 * The Ask panel reasons about trades and reads documents; it cannot see the
 * project. This can: it holds the same tools the UI does, over the caller's own
 * database client so RLS applies to it exactly as it applies to them.
 *
 * The tool loop is capped. A runaway agent calling tools in a circle is the
 * failure mode that burns an API budget silently, and eight rounds is far more
 * than any real question here needs.
 */
const MAX_ROUNDS = 8;

chatRouter.post('/projects/:projectId/chat', async (req, res) => {
  const projectId = req.params.projectId ?? '';
  const auth = req.auth;
  if (!auth) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }

  const body = (req.body ?? {}) as {
    messages?: { role: 'user' | 'assistant'; content: string }[];
  };

  const history = Array.isArray(body.messages) ? body.messages.slice(-20) : [];
  if (history.length === 0) {
    res.status(400).json({ error: 'Send at least one message' });
    return;
  }

  const db = supabaseForUser(auth.token);

  /**
   * Queuing work, on the assistant's behalf.
   *
   * Leveling runs inline because it is deterministic arithmetic that finishes
   * in under a second. The agents are queued and return a run id, because they
   * are model calls that take minutes and must not sit behind this request.
   */
  const queue: QueueFn = async (kind, args): Promise<ToolResult> => {
    if (kind === 'level') {
      if (!args.packageId) return { ok: false, error: 'packageId is required' };
      try {
        const addBacks = await computeAddBacks(db, { tenantId: auth.tenantId, packageId: args.packageId });
        const gaps = await detectGaps(db, { tenantId: auth.tenantId, packageId: args.packageId });
        const leveling = await computeLeveling(db, { tenantId: auth.tenantId, packageId: args.packageId });
        await computeScopeLeveling(db, { tenantId: auth.tenantId, packageId: args.packageId });
        const learned = await recordContextOutcomes(db, { tenantId: auth.tenantId, packageId: args.packageId });
        return { ok: true, data: { addBacks, gaps, ranked: leveling.length, learned } };
      } catch (caught) {
        return { ok: false, error: caught instanceof Error ? caught.message : String(caught) };
      }
    }

    const VERSIONS: Record<string, string> = {
      draft_scope_context: SCOPE_CONTEXT_PROMPT_VERSION,
      audit_coverage: AUDIT_COVERAGE_PROMPT_VERSION,
      compare_bids: COMPARE_BIDS_PROMPT_VERSION,
      map_cost_codes: MAP_COST_CODES_PROMPT_VERSION,
    };

    const agent = args.agent ?? '';
    if (!VERSIONS[agent]) return { ok: false, error: `Unknown agent: ${agent}` };

    // The agents need payloads assembled from the database. Rather than
    // duplicate that here, point the assistant at the endpoint that already
    // does it — and tell it to say the work is running, not that it is done.
    return {
      ok: true,
      data: {
        queued: false,
        note:
          `To run ${agent}, the user presses it in the Next panel — it needs a payload assembled ` +
          'from the documents and that assembly lives in the endpoint. Tell them it is available ' +
          'there and what it will do.',
      },
    };
  };

  const messages: Anthropic.MessageParam[] = history.map((entry) => ({
    role: entry.role,
    content: entry.content,
  }));

  const used: { tool: string; ok: boolean }[] = [];

  try {
    for (let round = 0; round < MAX_ROUNDS; round += 1) {
      const response = await getClient().messages.create({
        model: MODEL,
        max_tokens: 4000,
        system: SYSTEM,
        thinking: { type: 'adaptive' },
        tools: CHAT_TOOLS,
        messages,
      });

      const toolUses = response.content.filter(
        (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use',
      );

      if (toolUses.length === 0) {
        const text = response.content
          .filter((block): block is Anthropic.TextBlock => block.type === 'text')
          .map((block) => block.text)
          .join('');

        res.json({ reply: text, toolsUsed: used });
        return;
      }

      messages.push({ role: 'assistant', content: response.content });

      const results: Anthropic.ToolResultBlockParam[] = [];
      for (const call of toolUses) {
        const result = await runTool(
          db,
          { projectId, tenantId: auth.tenantId, userId: auth.userId, queue },
          call.name,
          (call.input ?? {}) as Record<string, unknown>,
        );

        used.push({ tool: call.name, ok: result.ok });

        results.push({
          type: 'tool_result',
          tool_use_id: call.id,
          content: JSON.stringify(result.ok ? result.data : { error: result.error }).slice(0, 60000),
          ...(result.ok ? {} : { is_error: true }),
        });
      }

      messages.push({ role: 'user', content: results });
    }

    res.json({
      reply:
        'I went round in circles on that one and stopped rather than keep spending. Try asking ' +
        'something narrower — a specific package or scope item.',
      toolsUsed: used,
    });
  } catch (caught) {
    res.status(500).json({
      error: caught instanceof Error ? caught.message : String(caught),
      toolsUsed: used,
    });
  }
});

import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import type { z } from 'zod';
import { env } from '../env.js';

/**
 * The product's own model calls. These bill against ANTHROPIC_API_KEY, which is
 * separate from any Claude subscription used to build the thing.
 *
 * P6 specifies claude-sonnet-5. Changing tier is a one-line change here; every
 * agent_run records which model produced it, so a regression stays attributable
 * to a model change rather than becoming a mystery.
 */
export const MODEL = 'claude-sonnet-5';

/** USD per million tokens, for claude-sonnet-5. */
const PRICE_PER_MTOK = { input: 2, output: 10 } as const;

let client: Anthropic | null = null;

function getClient(): Anthropic {
  if (!env.anthropicApiKey) {
    throw new Error('ANTHROPIC_API_KEY is not set — agent runs cannot call the model');
  }
  client ??= new Anthropic({ apiKey: env.anthropicApiKey });
  return client;
}

function costOf(inputTokens: number, outputTokens: number): number {
  return (
    (inputTokens / 1_000_000) * PRICE_PER_MTOK.input +
    (outputTokens / 1_000_000) * PRICE_PER_MTOK.output
  );
}

export type StructuredResult<T> = {
  value: T;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
};

/**
 * A model call that must return a specific shape.
 *
 * Structured output rather than "please reply with JSON": extraction feeds
 * arithmetic downstream, and a response that almost parses is worse than one
 * that fails loudly. The schema is enforced at the API, so a malformed reply is
 * retried by the SDK rather than becoming a runtime surprise here.
 */
export async function extractStructured<T extends z.ZodType>(options: {
  system: string;
  schema: T;
  instruction: string;
  pdf?: Buffer;
  maxTokens?: number;
}): Promise<StructuredResult<z.infer<T>>> {
  const content: Anthropic.ContentBlockParam[] = [];

  if (options.pdf) {
    // The document goes before the instruction: Claude reads better when the
    // material precedes the question asked of it.
    content.push({
      type: 'document',
      source: {
        type: 'base64',
        media_type: 'application/pdf',
        data: options.pdf.toString('base64'),
      },
    });
  }
  content.push({ type: 'text', text: options.instruction });

  const response = await getClient().messages.parse({
    model: MODEL,
    max_tokens: options.maxTokens ?? 16000,
    system: options.system,
    thinking: { type: 'adaptive' },
    output_config: { format: zodOutputFormat(options.schema) },
    messages: [{ role: 'user', content }],
  });

  if (!response.parsed_output) {
    throw new Error('The model did not return a parseable result');
  }

  const inputTokens = response.usage.input_tokens;
  const outputTokens = response.usage.output_tokens;

  return {
    value: response.parsed_output as z.infer<T>,
    inputTokens,
    outputTokens,
    costUsd: costOf(inputTokens, outputTokens),
  };
}

// -----------------------------------------------------------------------------
// Division expert consultation
// -----------------------------------------------------------------------------

export type ExpertPattern = {
  id: string;
  division: string;
  text: string;
  section: string | null;
  frequentChangeOrder: boolean;
};

export type ExpertScopeItem = {
  scopeId: string;
  section: string | null;
  title: string;
  description: string | null;
  quantity: number | null;
  unit: string | null;
  locked: boolean;
};

export type ExpertAnswer = {
  text: string;
  citations: { kind: string; ref: string }[];
  costUsd: number;
};

const EXPERT_SYSTEM = `You are a construction division expert advising a general
contractor's preconstruction team. You know your divisions' codes, standard
details, the trades that habitually split scope with each other, and the gaps
that recur job after job.

You are given: gap patterns for the divisions in play, the project's scope
baseline where one exists, and any documents the estimator has pointed you at.

HOW TO ANSWER:

- Answer the question that was asked, in the estimator's language. They are not
  a novice; do not explain what a submittal is.
- CITE. Every factual claim rests on something you were given: a gap pattern id
  in square brackets, a scope item's id, or a page in an attached document. Say
  which. If you are drawing on general construction knowledge rather than the
  material provided, say so plainly, so the estimator knows the difference.
- If the material does not answer the question, say so and say what document
  would. Do not fill the gap with a plausible answer. An expert who guesses is
  worse than no expert, because the guess gets bid.
- NEVER give a dollar figure or a unit cost. Costing has its own rules and its
  own step. If asked, say what the number depends on and where it would come
  from.
- When you spot something adjacent the estimator did not ask about but would
  want to know — a scope item nothing covers, a detail two trades both assume
  the other carries — add it briefly at the end, marked as such.

Be direct and brief. An estimator reading this is mid-task.`;

const NEWLINE = '\n';

/**
 * A question to a division expert, grounded in retrieved knowledge and any
 * documents the estimator attached.
 *
 * Streamed, because a question asked against a 40-page spec takes long enough
 * that a non-streaming request risks the SDK's HTTP timeout.
 */
export async function askExpert(options: {
  question: string;
  divisions: string[];
  patterns: ExpertPattern[];
  scope: ExpertScopeItem[];
  attachments: { filename: string; bytes: Buffer }[];
  history: { role: 'user' | 'assistant'; content: string }[];
}): Promise<ExpertAnswer> {
  const content: Anthropic.ContentBlockParam[] = [];

  for (const attachment of options.attachments) {
    content.push({
      type: 'document',
      source: {
        type: 'base64',
        media_type: 'application/pdf',
        data: attachment.bytes.toString('base64'),
      },
      title: attachment.filename,
    });
  }

  const patternLines =
    options.patterns.length === 0
      ? '  (none loaded for these divisions)'
      : options.patterns
          .map(
            (pattern) =>
              `  [${pattern.id.slice(0, 8)}] div ${pattern.division}` +
              (pattern.section ? ` sec ${pattern.section}` : '') +
              (pattern.frequentChangeOrder ? ' (frequent change order)' : '') +
              `: ${pattern.text}`,
          )
          .join(NEWLINE);

  const scopeLines =
    options.scope.length === 0
      ? '  (no scope items on this project yet)'
      : options.scope
          .map(
            (item) =>
              `  ${item.scopeId}` +
              (item.section ? ` sec ${item.section}` : '') +
              (item.locked ? ' [locked]' : ' [open]') +
              `: ${item.title}` +
              (item.quantity ? ` — ${item.quantity} ${item.unit ?? ''}` : ''),
          )
          .join(NEWLINE);

  const knowledge = [
    options.divisions.length > 0
      ? `DIVISIONS IN PLAY: ${options.divisions.join(', ')}`
      : 'DIVISIONS IN PLAY: all',
    '',
    'KNOWN GAP PATTERNS (cite by the id in square brackets):',
    patternLines,
    '',
    'SCOPE BASELINE (cite by scope id):',
    scopeLines,
    '',
    options.attachments.length > 0
      ? `ATTACHED DOCUMENTS: ${options.attachments.map((a) => a.filename).join(', ')}`
      : 'ATTACHED DOCUMENTS: none',
    '',
    '---',
    '',
    `QUESTION: ${options.question}`,
  ].join(NEWLINE);

  content.push({ type: 'text', text: knowledge });

  const messages: Anthropic.MessageParam[] = [
    ...options.history.map((entry) => ({ role: entry.role, content: entry.content })),
    { role: 'user' as const, content },
  ];

  const stream = getClient().messages.stream({
    model: MODEL,
    max_tokens: 8000,
    system: EXPERT_SYSTEM,
    thinking: { type: 'adaptive' },
    messages,
  });

  const message = await stream.finalMessage();

  const text = message.content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('');

  // Citations are read out of the answer rather than demanded as a schema:
  // forcing structure onto a conversational reply makes it read like a form,
  // and the point of a chat is that it does not.
  const citations: { kind: string; ref: string }[] = [];

  for (const match of text.matchAll(/\[([0-9a-f]{8})\]/g)) {
    citations.push({ kind: 'gap_pattern', ref: match[1] ?? '' });
  }
  for (const match of text.matchAll(/\b([A-Z0-9]+-\d{4}-\d{3}-\d{2}-\d{3})\b/g)) {
    citations.push({ kind: 'scope_item', ref: match[1] ?? '' });
  }
  for (const match of text.matchAll(/\bp(?:age)?\.?\s?(\d{1,4})\b/gi)) {
    citations.push({ kind: 'page', ref: match[1] ?? '' });
  }

  const unique = citations.filter(
    (citation, index, all) =>
      all.findIndex((other) => other.kind === citation.kind && other.ref === citation.ref) === index,
  );

  return {
    text,
    citations: unique,
    costUsd: costOf(message.usage.input_tokens, message.usage.output_tokens),
  };
}

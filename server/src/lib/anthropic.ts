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
  /**
   * How much of the budget may go to thinking.
   *
   * Adaptive is right when the hard part is judgement — deciding whether a
   * quote line means a scope item. It is wrong when the hard part is VOLUME:
   * reading two dense drawings produces a long structured answer, and adaptive
   * thinking spent 44k of a 48k budget reasoning and then truncated the answer
   * mid-string. Capping it leaves the budget where the work actually is.
   */
  thinkingBudget?: number | 'adaptive';
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

  // Streamed rather than a plain request, because the SDK refuses a
  // non-streaming call whose estimated duration passes ten minutes — and the
  // estimate scales with max_tokens, so a large output budget is refused
  // before the request is even sent. Drafting scope from a batch of scanned
  // drawings needs both the budget and the time, and streaming is how you get
  // them. `finalMessage()` still carries `parsed_output`, so the structured
  // guarantee is unchanged.
  const budget = options.thinkingBudget ?? 'adaptive';

  const stream = getClient().messages.stream({
    model: MODEL,
    max_tokens: options.maxTokens ?? 16000,
    system: options.system,
    thinking:
      budget === 'adaptive'
        ? { type: 'adaptive' }
        : { type: 'enabled', budget_tokens: budget },
    output_config: { format: zodOutputFormat(options.schema) },
    messages: [{ role: 'user', content }],
  });

  const response = await stream.finalMessage();

  if (!response.parsed_output) {
    // Say WHY. "Did not return a parseable result" is true of a refusal, a
    // truncation and a malformed reply alike, and those need three different
    // fixes — the first time this fired on a real plan set it cost an hour
    // because the message named the symptom instead of the cause.
    const reason = response.stop_reason ?? 'unknown';
    const detail =
      reason === 'max_tokens'
        ? `ran out of output budget at ${options.maxTokens ?? 16000} tokens — the answer was cut off mid-structure. Send fewer pages per request, or raise maxTokens.`
        : reason === 'refusal'
          ? 'the model declined to answer.'
          : `stop reason was "${reason}".`;

    throw new Error(`The model did not return a parseable result: ${detail}`);
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

/**
 * Reading the documents, rather than reasoning about the trade.
 *
 * A different job needs a different brief. The expert is constrained on
 * purpose — cite a pattern, never a price — and those constraints get in the
 * way when the question is "what does this letter actually say", where the
 * right answer is frequently a quote from page four and nothing else.
 */
const DOCUMENT_SYSTEM = `You answer questions about construction documents that
have been put in front of you: drawings, specifications, addenda, quotes,
letters, schedules.

HOW TO ANSWER:

- Answer from the documents. Quote them where a quote settles it, and always
  give the page.
- If the documents do not say, say they do not say. Do not reason your way to a
  likely answer and present it as what the document says — those are different
  claims and an estimator is about to act on the difference.
- Distinguish clearly when you are reading versus inferring. "Page 7 says X" and
  "that usually implies Y" are separate sentences.
- Numbers that appear in the document may be quoted as written. Do not compute
  new ones, do not total partial figures, and do not convert units silently.
- Be brief. Point at the passage rather than summarising around it.

You are reading for a preconstruction team, so lead with what they would act
on: what is required, who carries it, what is missing.`;

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
  /** EXPERT reasons from division knowledge; DOCUMENT answers from the files. */
  mode?: 'EXPERT' | 'DOCUMENT';
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

  const documentOnly = options.mode === 'DOCUMENT';

  const knowledge = documentOnly
    ? [
        options.attachments.length > 0
          ? `DOCUMENTS: ${options.attachments.map((a) => a.filename).join(', ')}`
          : 'NO DOCUMENTS ATTACHED — say so rather than answering from general knowledge.',
        '',
        '---',
        '',
        `QUESTION: ${options.question}`,
      ].join(NEWLINE)
    : [
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
    system: documentOnly ? DOCUMENT_SYSTEM : EXPERT_SYSTEM,
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

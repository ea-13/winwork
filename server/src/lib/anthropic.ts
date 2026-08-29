import Anthropic from '@anthropic-ai/sdk';
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

export type CompletionResult = {
  text: string;
  inputTokens: number;
  outputTokens: number;
  /** USD. Recorded onto agent_run.token_cost so a run's cost is auditable. */
  costUsd: number;
};

export type CompleteOptions = {
  system?: string;
  messages: Anthropic.MessageParam[];
  maxTokens?: number;
  /** low | medium | high | xhigh | max. Higher costs more and thinks longer. */
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
};

/**
 * One model call, streamed.
 *
 * Streaming rather than a plain create() because extraction responses are long
 * — a 40-page quote produces a lot of line items — and a non-streaming request
 * with a large max_tokens runs into the SDK's HTTP timeout.
 */
export async function complete(options: CompleteOptions): Promise<CompletionResult> {
  const stream = getClient().messages.stream({
    model: MODEL,
    max_tokens: options.maxTokens ?? 16000,
    thinking: { type: 'adaptive' },
    output_config: { effort: options.effort ?? 'high' },
    ...(options.system === undefined ? {} : { system: options.system }),
    messages: options.messages,
  });

  const message = await stream.finalMessage();

  const text = message.content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('');

  const inputTokens = message.usage.input_tokens;
  const outputTokens = message.usage.output_tokens;

  return {
    text,
    inputTokens,
    outputTokens,
    costUsd:
      (inputTokens / 1_000_000) * PRICE_PER_MTOK.input +
      (outputTokens / 1_000_000) * PRICE_PER_MTOK.output,
  };
}

/**
 * Per-user Anthropic spend tracking — the Node twin of mylibrary/usage.py.
 * trackedCreate wraps messages.create and records token usage + computed cost
 * into usage_events. Recording is best-effort: failures are logged and
 * swallowed so they can never break a Claude-powered flow.
 */
import { sql } from 'drizzle-orm';
import type { Db } from './db';
import { ApiError } from './errors';
import { acceptsForcedToolChoice } from './models';
import { logDebug } from './log';

export interface UsageLike {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

type Pricing = [number, number, number, number]; // USD/1M: input, output, cache_write, cache_read

// Official list prices, USD per 1M tokens. Sonnet 5 launched at an
// introductory $2/$10 that Anthropic later made permanent, so it carries no
// expiry: an earlier version of this table stepped it up to $3/$15 on
// 2026-09-01 and overstated every Sonnet 5 run by 50% until that was removed.
// Source: https://www.anthropic.com/pricing — last_verified 2026-09-23.
const MODEL_PRICING: Record<string, Pricing> = {
  'claude-sonnet-5': [2.0, 10.0, 2.5, 0.2],
  // Same list prices as Sonnet 5 (Claude API model table, cached 2026-09-25).
  'claude-sonnet-5-5': [2.0, 10.0, 2.5, 0.2],
  'claude-sonnet-4-6': [3.0, 15.0, 3.75, 0.3],
  'claude-haiku-4-5-20251001': [1.0, 5.0, 1.25, 0.1],
  // Not used by default (spec 2026-09-22 §6.8). Present so a per-operation switch to Opus
  // records its real cost instead of the $3/$15 fallback, which would under-report it.
  // Cache hits are 0.05x base input on Opus 5.5 ($0.20), not the usual 0.1x.
  'claude-opus-5-5': [4.0, 20.0, 5.0, 0.2],
};
// Unknown models bill at the priciest tier we know, so a missed table entry
// over-reports rather than hiding spend.
const DEFAULT_PRICING: Pricing = [3.0, 15.0, 3.75, 0.3];

function pricing(model: string): Pricing {
  return MODEL_PRICING[model] ?? DEFAULT_PRICING;
}

function tok(usage: UsageLike | null, name: keyof UsageLike): number {
  const v = usage?.[name];
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

export function costUsd(model: string, usage: UsageLike | null): number {
  const [inRate, outRate, cwRate, crRate] = pricing(model);
  return (
    (tok(usage, 'input_tokens') * inRate +
      tok(usage, 'output_tokens') * outRate +
      tok(usage, 'cache_creation_input_tokens') * cwRate +
      tok(usage, 'cache_read_input_tokens') * crRate) /
    1_000_000
  );
}

export async function recordUsage(
  db: Db,
  entry: { userId: string; model: string; operation: string; usage: UsageLike | null }
): Promise<void> {
  try {
    await db.execute(sql`
      insert into usage_events
        (user_id, model, operation, input_tokens, output_tokens,
         cache_creation_input_tokens, cache_read_input_tokens, cost_usd)
      values
        (${entry.userId}, ${entry.model}, ${entry.operation},
         ${tok(entry.usage, 'input_tokens')}, ${tok(entry.usage, 'output_tokens')},
         ${tok(entry.usage, 'cache_creation_input_tokens')},
         ${tok(entry.usage, 'cache_read_input_tokens')},
         ${costUsd(entry.model, entry.usage)})
    `);
  } catch (err) {
    // Recording must never break the calling operation (parity with Python).
    logDebug('usage', `usage recording failed for user=${entry.userId} op=${entry.operation}`, {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** The subset of the SDK's per-request options this app uses. */
export interface RequestOptionsLike {
  signal?: AbortSignal;
}

interface MessagesClient {
  messages: {
    create: (params: Record<string, unknown>, options?: RequestOptionsLike) => Promise<unknown>;
  };
}

export async function trackedCreate<T extends MessagesClient>(
  client: T,
  db: Db,
  meta: { userId: string; operation: string },
  params: { model: string } & Record<string, unknown>,
  // Optional and forwarded ONLY when given: every existing caller (and every test that
  // asserts `create` was called with exactly the params) keeps its one-argument call.
  requestOptions?: RequestOptionsLike
): Promise<Awaited<ReturnType<T['messages']['create']>>> {
  const pending = requestOptions
    ? client.messages.create(params, requestOptions)
    : client.messages.create(params);
  const message = (await pending) as Awaited<ReturnType<T['messages']['create']>>;
  const usage = (message as { usage?: UsageLike | null })?.usage ?? null;
  await recordUsage(db, {
    userId: meta.userId,
    model: params.model,
    operation: meta.operation,
    usage,
  });
  return message;
}

interface ToolCallParams extends Record<string, unknown> {
  model: string;
  system: unknown;
  tool_choice: { type: 'tool'; name: string };
}

function calledTool(message: unknown): boolean {
  const content = (message as { content?: Array<{ type?: string }> } | null)?.content ?? [];
  return content.some((block) => block.type === 'tool_use');
}

/**
 * trackedCreate for a call that must end in one named tool. Every call site states the forced
 * `tool_choice` it wants, and on a model that accepts one the params go out unchanged.
 *
 * Newer models (Sonnet 5.5, Opus 5.5, Fable 5.1) reject a forced choice with a 400, so on those
 * the request is rewritten: `tool_choice: auto`, a system-prompt line naming the tool, and on
 * Sonnet 5.5 `thinking: between_tools` so extended thinking cannot eat the max_tokens budgets,
 * which were sized for a direct tool call. `auto` does not guarantee the call, so a reply with
 * no tool_use is retried once and then fails loudly; the callers read a missing payload as an
 * empty result, which would otherwise persist an empty profile or recommendation list. A
 * `max_tokens` stop is returned as-is, exactly as on the forced path.
 */
export async function trackedToolCall<T extends MessagesClient>(
  client: T,
  db: Db,
  meta: { userId: string; operation: string },
  params: ToolCallParams,
  requestOptions?: RequestOptionsLike
): Promise<Awaited<ReturnType<T['messages']['create']>>> {
  if (acceptsForcedToolChoice(params.model)) {
    return trackedCreate(client, db, meta, params, requestOptions);
  }

  const toolName = params.tool_choice.name;
  const autoParams: { model: string } & Record<string, unknown> = {
    ...params,
    system:
      typeof params.system === 'string'
        ? `${params.system}\n\nRespond by calling the ${toolName} tool.`
        : params.system,
    tool_choice: { type: 'auto' },
    ...(params.model === 'claude-sonnet-5-5' ? { thinking: { type: 'between_tools' } } : {}),
  };

  for (let attempt = 0; attempt < 2; attempt++) {
    const message = await trackedCreate(client, db, meta, autoParams, requestOptions);
    const stop = (message as { stop_reason?: string | null })?.stop_reason;
    if (stop === 'refusal') {
      throw new ApiError(502, 'Claude declined this request. Try again.');
    }
    if (calledTool(message) || stop === 'max_tokens') return message;
  }
  throw new ApiError(502, `Claude response missing tool payload (${toolName}). Try again.`);
}

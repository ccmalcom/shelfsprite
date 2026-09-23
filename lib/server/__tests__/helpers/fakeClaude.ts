import type { ClaudeClient, ClaudeMessage } from '../../claude';

export interface RecordedCall {
  params: Record<string, unknown>;
  /** The per-request options (e.g. an AbortSignal), when the caller passed any. */
  options?: { signal?: AbortSignal };
}

/** Injectable Claude client. Records every create() call for prompt-parity
 *  assertions and returns queued responses in order. Never touches the network. */
export function fakeClaude(responses: ClaudeMessage[]): ClaudeClient & { calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  let i = 0;
  return {
    calls,
    messages: {
      async create(params: Record<string, unknown>, options?: { signal?: AbortSignal }) {
        calls.push(options === undefined ? { params } : { params, options });
        if (i >= responses.length) throw new Error(`fakeClaude: no queued response #${i}`);
        return responses[i++];
      },
    },
  };
}

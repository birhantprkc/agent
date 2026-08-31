// LLM client interfaces.
//
// Streaming uses an `onDelta` callback rather than an async iterator so
// the call site (agent.chat) can keep its imperative shape. The agent
// can wrap onDelta into an iterator if it wants to expose tokens as a
// stream further up.

import type { RetryInfo } from './retry.js';
import type { ChatRequest, ChatResponse } from './types.js';

export interface Client {
  /** Backend label (e.g. "ollama", "lmstudio", "openai-compat"). */
  name(): string;
  /** Currently-selected model id. */
  model(): string;
  /**
   * Non-streaming chat request. `onRetry`, when given, fires before each
   * transient-failure backoff wait — the caller's hook for surfacing "rate
   * limited, retrying…" to the user instead of a silent multi-second pause.
   */
  chat(
    req: ChatRequest,
    signal?: AbortSignal,
    onRetry?: (info: RetryInfo) => void,
  ): Promise<ChatResponse>;
}

export interface StreamingClient extends Client {
  /**
   * Streaming chat. `onDelta` is invoked for each token/chunk; the
   * returned promise resolves once the stream completes with the
   * accumulated message + finish reason. `onRetry` — see Client.chat().
   */
  chatStream(
    req: ChatRequest,
    onDelta: (delta: string) => void,
    signal?: AbortSignal,
    onRetry?: (info: RetryInfo) => void,
  ): Promise<ChatResponse>;
}

export interface Pinger {
  /**
   * Cheap GET against the backend's health endpoint. Resolves on
   * reachable (incl. 401/403 — server is up), rejects on transport
   * failure or 5xx. Used by the TUI's status-bar `ready`/`disconnected`
   * indicator.
   */
  ping(signal?: AbortSignal): Promise<void>;
}

export function isStreaming(c: Client): c is StreamingClient {
  return typeof (c as Partial<StreamingClient>).chatStream === 'function';
}

export function isPinger(c: Client): c is Client & Pinger {
  return typeof (c as Partial<Pinger>).ping === 'function';
}

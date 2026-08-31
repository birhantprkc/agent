// Ollama backend. behavior:
// - POST /api/chat with stream=true emits ND-JSON; accumulate tool calls
//   as they arrive (the terminal `done:true` chunk often carries an empty
//   tool_calls slice, so relying on the last chunk drops calls).
// - Malformed streamed chunks are logged with a preview (warn level) and
//   skipped — silently dropping them caused tool calls to vanish.
// - GET /api/tags for the health probe.

import { warn } from '../logger/logger.js';
import type { Client, Pinger, StreamingClient } from './client.js';
import { parseContentToolCalls } from './contentToolCalls.js';
import { BackendError, classifyBackend, parseRetryAfter } from './errors.js';
import { newCallID } from './ids.js';
import { type RetryInfo, withRetry } from './retry.js';
import type { ChatRequest, ChatResponse, FinishReason, Message, ToolCall, Usage } from './types.js';

/** Annotate a backend error with the server's Retry-After so withRetry can
 *  honor it instead of its computed backoff. */
function withRetryAfter(err: BackendError, resp: Response): BackendError {
  const ms = parseRetryAfter(resp.headers.get('retry-after'));
  if (ms !== undefined) err.retryAfterMs = ms;
  return err;
}

interface OllamaToolCall {
  function: {
    name: string;
    arguments: Record<string, unknown>;
  };
}

interface OllamaMessage {
  role: string;
  content: string;
  tool_calls?: OllamaToolCall[];
  // Required on role:'tool' replies so multi-tool turns associate each result
  // with the matching call. Without this, Ollama mis-pairs parallel tool
  // results and the agent loop degrades (wrong context for next step).
  tool_name?: string;
  // Reasoning models (deepseek-r1, qwen3, gpt-oss, ...) carry their
  // chain-of-thought here, separate from `content`. We surface it as live
  // streamed progress (mirrors reasoning_content in openai.ts / thought
  // parts in gemini.ts) but keep it OUT of the returned message so it never
  // re-enters the model's history.
  thinking?: string;
}

interface OllamaChatResp {
  message?: OllamaMessage;
  done?: boolean;
  /** Why generation stopped: 'stop', 'length' (hit num_predict/num_ctx), ... */
  done_reason?: string;
  // Only present on the terminal chunk (done:true) in streaming mode; always
  // present in the single non-streaming response.
  prompt_eval_count?: number;
  eval_count?: number;
}

function toUsage(prompt?: number, completion?: number): Usage | undefined {
  if (prompt === undefined && completion === undefined) return undefined;
  return { inputTokens: prompt ?? 0, outputTokens: completion ?? 0 };
}
const CHAT_TIMEOUT_MS = 10 * 60 * 1000;
// Floor for the context window when none is configured. Ollama silently
// defaults to num_ctx=2048 and truncates input every turn; 8192 is a sane
// minimum for agent histories. A probed/configured value overrides this.
const OLLAMA_DEFAULT_NUM_CTX = 8192;

export class OllamaClient implements Client, StreamingClient, Pinger {
  readonly baseURL: string;
  readonly modelID: string;
  private numCtx?: number;
  private readonly temperature?: number;
  private readonly maxTokens?: number;

  constructor(
    baseURL: string,
    model: string,
    numCtx?: number,
    genOpts: { temperature?: number; maxTokens?: number } = {},
  ) {
    // Strip trailing slashes so `${base}/api/chat` never becomes `//api/chat`
    // (some reverse proxies 404 the double-slash form).
    this.baseURL = (baseURL || 'http://localhost:11434').replace(/\/+$/, '');
    this.modelID = model;
    this.numCtx = numCtx;
    this.temperature = genOpts.temperature;
    this.maxTokens = genOpts.maxTokens;
  }

  /** Annotate classifyBackend detail with model + URL so the TUI can tell a
   *  dead proxy ("endpoint 404") from a missing local pull ("model not found"). */
  private backendError(status: number, body: string | undefined, path: string): BackendError {
    const ctx = `model=${this.modelID || '(none)'} url=${this.baseURL}${path}`;
    const raw = (body ?? '').trim();
    const detail = raw ? `${raw} (${ctx})` : ctx;
    return classifyBackend('ollama', null, status, detail);
  }

  /** Apply the context window detected at startup (detectOllamaContextWindow).
   *  Callers holding the client use this after the probe so the next request
   *  stops silently truncating input at Ollama's 2048 default. */
  setNumCtx(n: number): void {
    if (Number.isFinite(n) && n > 0) this.numCtx = n;
  }

  name(): string {
    return 'ollama';
  }

  model(): string {
    return this.modelID;
  }

  async ping(signal?: AbortSignal): Promise<void> {
    try {
      const resp = await fetch(`${this.baseURL}/api/tags`, { method: 'GET', signal });
      // 4xx (esp. empty 404 from a dead RunPod tunnel) must fail health —
      // previously only >=500 failed, so a 404 proxy still showed "ready".
      if (resp.status < 200 || resp.status >= 300) {
        const raw = await resp.text().catch(() => '');
        const hint = await this.openAICompatHint(signal);
        throw this.backendError(resp.status, hint ? `${raw} ${hint}`.trim() : raw, '/api/tags');
      }
    } catch (err) {
      if (err instanceof BackendError) throw err;
      throw classifyBackend('ollama', err, 0, undefined);
    }
  }

  /** Ollama's native /api/tags 404s on endpoints that only speak the
   *  OpenAI-compat surface (e.g. some RunPod/proxy setups exposing only
   *  /v1) — that reads as "model missing" or "dead tunnel" with no clue
   *  what's actually wrong. Best-effort probe /v1/models so the ping error
   *  can point the user at the fix instead. Never throws — a failed hint
   *  probe must not mask the original ping failure. */
  private async openAICompatHint(signal?: AbortSignal): Promise<string | undefined> {
    try {
      const resp = await fetch(`${this.baseURL}/v1/models`, { method: 'GET', signal });
      if (resp.status >= 200 && resp.status < 300) {
        return '(this endpoint responds on /v1/models — it looks OpenAI-compatible only; switch backend to "openai-compat" instead of "ollama")';
      }
    } catch {
      // Diagnostic only.
    }
    return undefined;
  }

  async chat(
    req: ChatRequest,
    signal?: AbortSignal,
    onRetry?: (info: RetryInfo) => void,
  ): Promise<ChatResponse> {
    // Retry rate limits / transient 5xx with backoff (E7). The non-streaming
    // call has no observable side effects before it returns, so re-running it
    // wholesale is safe.
    return withRetry(() => this.chatOnce(req, signal), { signal, onRetry });
  }

  private async chatOnce(req: ChatRequest, signal?: AbortSignal): Promise<ChatResponse> {
    const body = this.encodeRequest(req, false);
    const { signal: combinedSignal, dispose } = withTimeout(signal, CHAT_TIMEOUT_MS);
    try {
      let resp: Response;
      try {
        resp = await fetch(`${this.baseURL}/api/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: combinedSignal,
        });
      } catch (err) {
        throw classifyBackend('ollama', err, 0, undefined);
      }
      const raw = await resp.text();
      if (resp.status !== 200) {
        throw withRetryAfter(this.backendError(resp.status, raw, '/api/chat'), resp);
      }
      let parsed: OllamaChatResp;
      try {
        parsed = JSON.parse(raw) as OllamaChatResp;
      } catch {
        throw this.backendError(resp.status, `invalid JSON from ollama: ${raw}`, '/api/chat');
      }
      return this.assembleResponse(
        parsed.message ?? { role: 'assistant', content: '' },
        req.tools,
        parsed.done_reason,
        toUsage(parsed.prompt_eval_count, parsed.eval_count),
      );
    } finally {
      dispose();
    }
  }

  async chatStream(
    req: ChatRequest,
    onDelta: (delta: string) => void,
    signal?: AbortSignal,
    onRetry?: (info: RetryInfo) => void,
  ): Promise<ChatResponse> {
    // Retry only the connection setup (E7): a transient 429/5xx surfaces before
    // any delta is emitted, so re-opening can't double-emit tokens. Once the
    // 200 stream is flowing, a mid-stream failure is NOT retried.
    const { resp, dispose } = await withRetry(() => this.openStream(req, signal), {
      signal,
      onRetry,
    });
    if (!resp.body) {
      dispose();
      throw new Error('ollama: empty stream body');
    }

    let content = '';
    let thinking = '';
    const toolCalls: OllamaToolCall[] = [];
    let skipped = 0;
    let doneReason: string | undefined;
    let promptEvalCount: number | undefined;
    let evalCount: number | undefined;

    try {
      for await (const line of iterLines(resp.body)) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let chunk: OllamaChatResp;
        try {
          chunk = JSON.parse(trimmed) as OllamaChatResp;
        } catch (err) {
          // Defensive logging. Drop the chunk but
          // surface enough detail to diagnose vanished tool calls.
          skipped += 1;
          const preview = trimmed.length > 200 ? `${trimmed.slice(0, 200)}…` : trimmed;
          warn('ollama: dropped malformed stream chunk', {
            err: err instanceof Error ? err.message : String(err),
            preview,
            total_skipped: skipped,
          });
          continue;
        }
        // Stream reasoning as visible progress (drives the UI off "planning")
        // but never accumulate it into `content` — the returned message must
        // stay reasoning-free so it doesn't re-enter the model's history.
        if (chunk.message?.thinking) {
          thinking += chunk.message.thinking;
          onDelta(chunk.message.thinking);
        }
        if (chunk.message?.content) {
          content += chunk.message.content;
          onDelta(chunk.message.content);
        }
        if (chunk.message?.tool_calls?.length) {
          toolCalls.push(...chunk.message.tool_calls);
        }
        if (chunk.done) {
          doneReason = chunk.done_reason;
          promptEvalCount = chunk.prompt_eval_count;
          evalCount = chunk.eval_count;
          break;
        }
      }
    } finally {
      dispose();
    }

    return this.assembleResponse(
      { role: 'assistant', content, tool_calls: toolCalls, thinking },
      req.tools,
      doneReason,
      toUsage(promptEvalCount, evalCount),
    );
  }

  /** Open the streaming response and pair it with a `dispose` that cancels its
   *  timeout, or throw a (retry-annotated) BackendError. Extracted so withRetry
   *  can re-attempt setup without re-entering the consume loop; on success the
   *  caller owns `dispose` and must call it once the stream is consumed. */
  private async openStream(
    req: ChatRequest,
    signal?: AbortSignal,
  ): Promise<{ resp: Response; dispose: () => void }> {
    const body = this.encodeRequest(req, true);
    const { signal: combinedSignal, dispose } = withTimeout(signal, CHAT_TIMEOUT_MS);
    try {
      let resp: Response;
      try {
        resp = await fetch(`${this.baseURL}/api/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: combinedSignal,
        });
      } catch (err) {
        throw classifyBackend('ollama', err, 0, undefined);
      }
      if (resp.status !== 200) {
        const raw = await resp.text();
        throw withRetryAfter(this.backendError(resp.status, raw, '/api/chat'), resp);
      }
      return { resp, dispose };
    } catch (err) {
      // Failed attempt: clear its timer now so a retry doesn't leak it.
      dispose();
      throw err;
    }
  }

  private encodeRequest(req: ChatRequest, stream: boolean) {
    // Pin the context window so Ollama doesn't silently truncate at its 2048
    // default. A probed/configured value wins; otherwise floor at 8192 (M-num_ctx).
    // temperature / num_predict (max tokens) are forwarded only when the user
    // configured them, so the model's own defaults apply otherwise.
    const options: { num_ctx: number; temperature?: number; num_predict?: number } = {
      num_ctx: this.numCtx ?? OLLAMA_DEFAULT_NUM_CTX,
    };
    if (this.temperature !== undefined) options.temperature = this.temperature;
    if (this.maxTokens !== undefined && this.maxTokens > 0) options.num_predict = this.maxTokens;
    return {
      model: this.modelID,
      stream,
      options,
      messages: req.messages.map((m) => {
        const out: OllamaMessage = { role: m.role, content: m.content };
        // Ollama's tool-result shape is { role, tool_name, content }. Forward
        // the name we stored on role:'tool' messages so multi-tool steps
        // associate results correctly.
        if (m.role === 'tool' && m.name) {
          out.tool_name = m.name;
        }
        if (m.toolCalls?.length) {
          out.tool_calls = m.toolCalls.map((tc) => {
            let args: Record<string, unknown> = {};
            if (tc.function.arguments) {
              try {
                args = JSON.parse(tc.function.arguments) as Record<string, unknown>;
              } catch {
                args = {};
              }
            }
            return { function: { name: tc.function.name, arguments: args } };
          });
        }
        return out;
      }),
      tools: req.tools?.map((t) => ({
        type: 'function',
        function: {
          name: t.function.name,
          description: t.function.description,
          parameters: t.function.parameters,
        },
      })),
    };
  }

  private assembleResponse(
    msg: OllamaMessage,
    tools?: ChatRequest['tools'],
    doneReason?: string,
    usage?: Usage,
  ): ChatResponse {
    const rawContent = msg.content ?? '';
    // `thinking` is already streamed as live progress (onDelta above) when
    // present — it must not also land in the returned message's content, or
    // it re-enters history and gets replayed as context on every later turn.
    // A reasoning model that exhausts its budget mid-thought can legitimately
    // produce empty content here; that's an empty turn, not a bug.
    const out: Message = { role: 'assistant', content: rawContent };
    const hasNativeToolCalls = Boolean(msg.tool_calls?.length);
    const toolCalls = hasNativeToolCalls
      ? (msg.tool_calls ?? [])
      : parseContentToolCalls(rawContent, new Set((tools ?? []).map((t) => t.function.name))).map(
          (c) => ({ function: c }),
        );

    if (toolCalls.length) {
      out.toolCalls = toolCalls.map<ToolCall>((tc) => ({
        id: newCallID(),
        type: 'function',
        function: {
          name: tc.function.name,
          arguments: JSON.stringify(tc.function.arguments ?? {}),
        },
      }));
      // When the tool call was lifted out of the content text (no native
      // tool_calls), drop the raw JSON so it doesn't leak into the transcript
      // or get replayed to the provider alongside the structured call.
      if (!hasNativeToolCalls) out.content = '';
    }
    return {
      message: out,
      finishReason: mapFinishReason(doneReason, Boolean(out.toolCalls?.length)),
      usage,
    };
  }
}

/** Map Ollama's `done_reason` onto a FinishReason. A `length` truncation (hit
 *  num_predict / num_ctx) is surfaced so the agent can tell a capped turn from
 *  a clean one; otherwise tool calls win, then a plain stop. */
function mapFinishReason(doneReason: string | undefined, hasToolCalls: boolean): FinishReason {
  if (doneReason === 'length') return 'length';
  return hasToolCalls ? 'tool_calls' : 'stop';
}

// A broken or malicious proxy streaming a large payload with no newlines
// would otherwise grow `buffer` without limit (memory exhaustion) — it's
// only ever appended to between newlines and never capped.
const MAX_NDJSON_LINE_BYTES = 8 * 1024 * 1024;

/** Decode a byte stream into newline-delimited string chunks. */
async function* iterLines(body: ReadableStream<Uint8Array>): AsyncIterable<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx = buffer.indexOf('\n');
      while (idx >= 0) {
        yield buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        idx = buffer.indexOf('\n');
      }
      if (buffer.length > MAX_NDJSON_LINE_BYTES) {
        throw new Error(
          `ollama stream: line exceeded ${MAX_NDJSON_LINE_BYTES} bytes with no newline`,
        );
      }
    }
    buffer += decoder.decode();
    if (buffer.length > 0) yield buffer;
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

/** Build a per-request abort signal that fires when `parent` aborts OR after
 *  `ms`, paired with a `dispose` that clears the timer and detaches the
 *  listener. Replaces AbortSignal.timeout/any, whose 10-minute timers stay
 *  pending until they fire even after the request settles — leaking one timer
 *  per call. Call `dispose()` in a finally once the request is done. */
function withTimeout(
  parent: AbortSignal | undefined,
  ms: number,
): { signal: AbortSignal; dispose: () => void } {
  const ctl = new AbortController();
  const onAbort = () => ctl.abort();
  if (parent?.aborted) ctl.abort();
  else parent?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => ctl.abort(), ms);
  return {
    signal: ctl.signal,
    dispose: () => {
      clearTimeout(timer);
      parent?.removeEventListener('abort', onAbort);
    },
  };
}

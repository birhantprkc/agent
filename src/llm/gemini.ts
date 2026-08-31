import type { Client, Pinger, StreamingClient } from './client.js';
import { type BackendError, classifyBackend, parseRetryAfter } from './errors.js';
import { newCallID } from './ids.js';
import { type RetryInfo, withRetry } from './retry.js';
import type { ChatRequest, ChatResponse, Message, ToolSpec, Usage } from './types.js';

/** Annotate a backend error with the server's Retry-After so withRetry can
 *  honor it instead of its computed backoff. */
function withRetryAfter(err: BackendError, resp: Response): BackendError {
  const ms = parseRetryAfter(resp.headers.get('retry-after'));
  if (ms !== undefined) err.retryAfterMs = ms;
  return err;
}

interface GeminiPart {
  text?: string;
  // Gemini marks reasoning-summary parts with `thought: true`. We surface their
  // text as live progress but keep it OUT of the returned message — mirrors the
  // OpenAI provider's reasoning_content handling so thoughts never re-enter the
  // model's history.
  thought?: boolean;
  thoughtSignature?: string;
  thought_signature?: string;
  functionCall?: {
    name?: string;
    args?: Record<string, unknown>;
  };
  functionResponse?: {
    name: string;
    response: Record<string, unknown>;
  };
}

interface GeminiContent {
  role: 'user' | 'model' | 'function';
  parts: GeminiPart[];
}

interface GeminiUsage {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  cachedContentTokenCount?: number;
}

interface GeminiResponse {
  candidates?: Array<{
    content?: {
      parts?: GeminiPart[];
    };
    finishReason?: string;
  }>;
  error?: { message?: string };
  usageMetadata?: GeminiUsage;
}

function toUsage(u: GeminiUsage | undefined): Usage | undefined {
  if (!u) return undefined;
  return {
    inputTokens: u.promptTokenCount ?? 0,
    outputTokens: u.candidatesTokenCount ?? 0,
    cachedInputTokens: u.cachedContentTokenCount,
  };
}
const CHAT_TIMEOUT_MS = 10 * 60 * 1000;

export class GeminiClient implements Client, StreamingClient, Pinger {
  readonly baseURL: string;
  readonly apiKey: string;
  readonly modelID: string;
  private readonly temperature?: number;
  private readonly maxTokens?: number;
  private readonly thinkingBudget?: number;

  constructor(
    baseURL: string,
    apiKey: string,
    model: string,
    genOpts: { temperature?: number; maxTokens?: number; thinkingBudget?: number } = {},
  ) {
    this.baseURL = baseURL.replace(/\/$/, '');
    this.apiKey = apiKey;
    this.modelID = model;
    this.temperature = genOpts.temperature;
    this.maxTokens = genOpts.maxTokens;
    this.thinkingBudget = genOpts.thinkingBudget;
  }

  private genOpts(): { temperature?: number; maxTokens?: number; thinkingBudget?: number } {
    return {
      temperature: this.temperature,
      maxTokens: this.maxTokens,
      thinkingBudget: this.thinkingBudget,
    };
  }

  name(): string {
    return 'gemini';
  }

  model(): string {
    return this.modelID;
  }

  async ping(signal?: AbortSignal): Promise<void> {
    const resp = await fetch(`${this.baseURL}/models`, {
      method: 'GET',
      // Pass the key as a header, not a query param, so it can't leak into
      // access/proxy logs or error messages that echo the request URL.
      headers: { 'x-goog-api-key': this.apiKey },
      signal,
    });
    // Any non-2xx means disconnected — see openai.ts ping() for why 4xx
    // must fail too, not just 5xx.
    if (resp.status < 200 || resp.status >= 300) {
      throw new Error(`gemini status ${resp.status}`);
    }
  }

  async chat(
    req: ChatRequest,
    signal?: AbortSignal,
    onRetry?: (info: RetryInfo) => void,
  ): Promise<ChatResponse> {
    // Retry rate limits / transient 5xx with backoff (E7). The call has no
    // observable side effects before it returns, so re-running it is safe.
    return withRetry(() => this.chatOnce(req, signal), { signal, onRetry });
  }

  private async chatOnce(req: ChatRequest, signal?: AbortSignal): Promise<ChatResponse> {
    const body = encodeRequest(req, this.genOpts());
    const { signal: combinedSignal, dispose } = withTimeout(signal, CHAT_TIMEOUT_MS);
    try {
      let resp: Response;
      try {
        resp = await fetch(
          `${this.baseURL}/${withModelsPrefix(req.model || this.modelID)}:generateContent`,
          {
            method: 'POST',
            // Key in a header, not the URL query, to keep it out of logs.
            headers: { 'Content-Type': 'application/json', 'x-goog-api-key': this.apiKey },
            body: JSON.stringify(body),
            signal: combinedSignal,
          },
        );
      } catch (err) {
        throw classifyBackend('gemini', err, 0, undefined);
      }
      const raw = await resp.text();
      if (resp.status !== 200) {
        throw withRetryAfter(classifyBackend('gemini', null, resp.status, raw), resp);
      }
      let out: GeminiResponse;
      try {
        out = JSON.parse(raw) as GeminiResponse;
      } catch {
        throw classifyBackend('gemini', null, resp.status, `invalid JSON from gemini: ${raw}`);
      }
      if (out.error?.message) {
        // Route through the classifier so rate-limit phrasing in a 200 body
        // becomes a retryable BackendError rather than a plain Error.
        throw classifyBackend('gemini', null, resp.status, out.error.message);
      }
      const choice = out.candidates?.[0];
      if (!choice) throw new Error('gemini: empty candidates');
      const parts = choice.content?.parts ?? [];
      // Skip `thought` parts: they're reasoning summaries, not the answer, and
      // must not enter the model's history.
      const text = parts
        .filter((p) => !p.thought)
        .map((p) => p.text ?? '')
        .filter(Boolean)
        .join('');
      const calls = parts.filter((p) => Boolean(p.functionCall?.name));
      const msg: Message = { role: 'assistant', content: text };
      if (calls.length > 0) {
        msg.toolCalls = calls.map(partToToolCall);
      }
      return {
        message: msg,
        finishReason: choice.finishReason ?? '',
        usage: toUsage(out.usageMetadata),
      };
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
    // any delta is emitted, so re-running openStream can't double-emit tokens.
    // Once the 200 stream is flowing, a mid-stream failure is NOT retried.
    const { resp, dispose } = await withRetry(() => this.openStream(req, signal), {
      signal,
      onRetry,
    });
    if (!resp.body) {
      dispose();
      throw new Error('gemini: empty stream body');
    }

    // Join visible text once at the end (avoids O(n²) string concat). Thought
    // parts are streamed as progress but never accumulated, so the returned
    // message stays reasoning-free. functionCall parts arrive whole (Gemini
    // doesn't fragment them the way OpenAI splits tool-call deltas).
    const chunks: string[] = [];
    const calls: GeminiPart[] = [];
    let finish = '';
    let usage: GeminiUsage | undefined;

    try {
      for await (const line of iterSSE(resp.body)) {
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        let chunk: GeminiResponse;
        try {
          chunk = JSON.parse(data) as GeminiResponse;
        } catch {
          continue;
        }
        if (chunk.error?.message) {
          throw classifyBackend('gemini', null, 200, chunk.error.message);
        }
        // usageMetadata rides on every chunk cumulatively; keep the last one
        // seen so the final tally reflects the whole response.
        if (chunk.usageMetadata) usage = chunk.usageMetadata;
        const choice = chunk.candidates?.[0];
        if (!choice) continue;
        if (choice.finishReason) finish = choice.finishReason;
        for (const part of choice.content?.parts ?? []) {
          if (part.functionCall?.name) {
            calls.push(part);
            continue;
          }
          if (!part.text) continue;
          // Stream both thought summaries and answer text as visible progress
          // (so the UI shows movement instead of a frozen spinner), but only
          // accumulate answer text into the returned message.
          onDelta(part.text);
          if (!part.thought) chunks.push(part.text);
        }
      }
    } finally {
      dispose();
    }

    const msg: Message = { role: 'assistant', content: chunks.join('') };
    if (calls.length > 0) {
      msg.toolCalls = calls.map(partToToolCall);
    }
    return { message: msg, finishReason: finish, usage: toUsage(usage) };
  }

  /** Open the SSE stream and return the live 200 response paired with a
   *  `dispose` that cancels its timeout, or throw a (retry-annotated)
   *  BackendError. Extracted so withRetry can re-attempt the connection without
   *  re-entering the consume loop; on success the caller owns `dispose` and must
   *  call it once the stream is fully consumed. */
  private async openStream(
    req: ChatRequest,
    signal?: AbortSignal,
  ): Promise<{ resp: Response; dispose: () => void }> {
    const body = encodeRequest(req, this.genOpts());
    const { signal: combinedSignal, dispose } = withTimeout(signal, CHAT_TIMEOUT_MS);
    try {
      let resp: Response;
      try {
        // alt=sse switches streamGenerateContent from a JSON array to an SSE
        // stream of `data:` events, which iterSSE consumes incrementally.
        resp = await fetch(
          `${this.baseURL}/${withModelsPrefix(req.model || this.modelID)}:streamGenerateContent?alt=sse`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Accept: 'text/event-stream',
              'x-goog-api-key': this.apiKey,
            },
            body: JSON.stringify(body),
            signal: combinedSignal,
          },
        );
      } catch (err) {
        throw classifyBackend('gemini', err, 0, undefined);
      }
      if (resp.status !== 200) {
        const raw = await resp.text();
        throw withRetryAfter(classifyBackend('gemini', null, resp.status, raw), resp);
      }
      return { resp, dispose };
    } catch (err) {
      // Failed attempt: clear its timer now so a retry doesn't leak it.
      dispose();
      throw err;
    }
  }
}

/** Convert a Gemini functionCall part into a provider-neutral ToolCall,
 *  preserving the thoughtSignature so a follow-up turn can echo it back (the
 *  API pairs it with the call for multi-step tool use). */
function partToToolCall(part: GeminiPart): NonNullable<Message['toolCalls']>[number] {
  const fc = part.functionCall;
  const thoughtSignature = part.thoughtSignature ?? part.thought_signature;
  return {
    id: newCallID(),
    type: 'function',
    function: {
      name: fc?.name ?? '',
      arguments: JSON.stringify(fc?.args ?? {}),
    },
    ...(thoughtSignature ? { provider: { gemini: { thoughtSignature } } } : {}),
  };
}

/**
 * Decode a byte stream into SSE-style logical lines, splitting on `\n`. Yields
 * each non-empty line so the caller can inspect the `data:` prefix.
 */
// A broken or malicious proxy streaming a large payload with no newlines
// would otherwise grow `buffer` without limit (memory exhaustion) — it's
// only ever appended to between newlines and never capped.
const MAX_SSE_LINE_BYTES = 8 * 1024 * 1024;

async function* iterSSE(body: ReadableStream<Uint8Array>): AsyncIterable<string> {
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
        const line = buffer.slice(0, idx).replace(/\r$/, '');
        buffer = buffer.slice(idx + 1);
        if (line) yield line;
        idx = buffer.indexOf('\n');
      }
      if (buffer.length > MAX_SSE_LINE_BYTES) {
        throw new Error(`SSE stream: line exceeded ${MAX_SSE_LINE_BYTES} bytes with no newline`);
      }
    }
    buffer += decoder.decode();
    if (buffer.length > 0) yield buffer.replace(/\r$/, '');
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

function encodeRequest(
  req: ChatRequest,
  genOpts: { temperature?: number; maxTokens?: number; thinkingBudget?: number } = {},
): Record<string, unknown> {
  const systemText = req.messages
    .filter((m) => m.role === 'system')
    .map((m) => m.content)
    .join('\n\n');
  const contents = mergeAdjacentSameRole(
    req.messages.filter((m) => m.role !== 'system').flatMap((m) => encodeMessage(m)),
  );
  const body: Record<string, unknown> = {
    contents,
  };
  if (systemText) {
    body.systemInstruction = { parts: [{ text: systemText }] };
  }
  if (req.tools?.length) {
    body.tools = [{ functionDeclarations: req.tools.map(encodeTool) }];
  }
  // Generation knobs. Gemini nests these under generationConfig and names the
  // token cap maxOutputTokens (vs OpenAI's max_tokens). Emit only what's set.
  const generationConfig: Record<string, unknown> = {};
  if (genOpts.temperature !== undefined) generationConfig.temperature = genOpts.temperature;
  if (genOpts.maxTokens !== undefined && genOpts.maxTokens > 0) {
    generationConfig.maxOutputTokens = genOpts.maxTokens;
  }
  // Gemini 2.5/3 Flash models run an internal "thinking" pass on every turn,
  // which dominates latency across a multi-turn agent loop. Only emit
  // thinkingConfig when a budget is configured so models that don't support the
  // knob aren't sent it: 0 disables thinking entirely (fastest); a positive
  // budget caps it and surfaces thought summaries as streamed progress.
  if (genOpts.thinkingBudget !== undefined && genOpts.thinkingBudget >= 0) {
    generationConfig.thinkingConfig =
      genOpts.thinkingBudget === 0
        ? { thinkingBudget: 0 }
        : { thinkingBudget: genOpts.thinkingBudget, includeThoughts: true };
  }
  if (Object.keys(generationConfig).length > 0) {
    body.generationConfig = generationConfig;
  }
  return body;
}

/** Ensure the model id carries the `models/` (or `tunedModels/`) prefix the
 *  v1beta REST path requires, so a bare id from manual config doesn't build a
 *  404 URL (L5). */
function withModelsPrefix(id: string): string {
  if (id.startsWith('models/') || id.startsWith('tunedModels/')) return id;
  return `models/${id}`;
}

// Parallel tool execution (agent.ts executeToolCalls) records one 'tool'
// Message per call, which encodeMessage each turns into its own 'user'
// Content with a single functionResponse part. Gemini's function-call/
// function-response pairing degrades badly when a turn's responses are split
// across multiple Contents instead of batched into one — mirror the same
// merge used for the Anthropic backend so a turn's tool results land in a
// single Content with multiple parts, in order.
function mergeAdjacentSameRole(contents: GeminiContent[]): GeminiContent[] {
  const out: GeminiContent[] = [];
  for (const c of contents) {
    const last = out[out.length - 1];
    if (last && last.role === c.role) {
      last.parts = [...last.parts, ...c.parts];
    } else {
      out.push({ role: c.role, parts: [...c.parts] });
    }
  }
  return out;
}

function encodeMessage(m: Message): GeminiContent[] {
  if (m.role === 'tool') {
    return [
      {
        // v1beta Content.role accepts only 'user' / 'model'. A functionResponse
        // is delivered as a 'user' turn; the deprecated 'function' role makes
        // newer models 400 on multi-turn tool use (M8).
        role: 'user',
        parts: [
          {
            functionResponse: {
              name: m.name || 'tool_result',
              response: { result: m.content },
            },
          },
        ],
      },
    ];
  }
  if (m.role === 'assistant') {
    const parts: GeminiPart[] = [];
    if (m.content) parts.push({ text: m.content });
    for (const tc of m.toolCalls ?? []) {
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(tc.function.arguments || '{}') as Record<string, unknown>;
      } catch {
        args = {};
      }
      parts.push({
        functionCall: { name: tc.function.name, args },
        ...(tc.provider?.gemini?.thoughtSignature
          ? { thoughtSignature: tc.provider.gemini.thoughtSignature }
          : {}),
      });
    }
    return parts.length > 0 ? [{ role: 'model', parts }] : [];
  }
  return [{ role: 'user', parts: [{ text: m.content }] }];
}

function encodeTool(tool: ToolSpec): Record<string, unknown> {
  return {
    name: tool.function.name,
    description: tool.function.description,
    parameters: normalizeSchema(tool.function.parameters),
  };
}

function normalizeSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(normalizeSchema);
  if (!schema || typeof schema !== 'object') return schema;
  const src = schema as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(src)) {
    if (value === undefined) continue;
    if (key === 'type' && typeof value === 'string') {
      out.type = value.toUpperCase();
      continue;
    }
    if (key === 'properties' && value && typeof value === 'object' && !Array.isArray(value)) {
      out.properties = Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([name, prop]) => [
          name,
          normalizeSchema(prop),
        ]),
      );
      continue;
    }
    if (key === 'items') {
      out.items = normalizeSchema(value);
      continue;
    }
    if (['additionalProperties', '$schema', 'definitions', '$defs'].includes(key)) continue;
    out[key] = normalizeSchema(value);
  }
  return out;
}

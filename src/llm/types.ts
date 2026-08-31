// Core LLM types. The shape lets sessions, tool calls, and message
// lists round-trip through saved session files.

export type Role = 'system' | 'user' | 'assistant' | 'tool';

export interface FunctionCall {
  name: string;
  /** JSON-encoded arguments object, exactly as the model produced it. */
  arguments: string;
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: FunctionCall;
  provider?: {
    gemini?: {
      thoughtSignature?: string;
    };
  };
}

export interface Message {
  role: Role;
  content: string;
  toolCalls?: ToolCall[];
  toolCallID?: string;
  name?: string;
}

export interface ToolFunction {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ToolSpec {
  type: 'function';
  function: ToolFunction;
}

export interface ChatRequest {
  model: string;
  messages: Message[];
  tools?: ToolSpec[];
  stream?: boolean;
}

/**
 * Why the model stopped. The well-known values are surfaced so callers can
 * distinguish a clean `stop` / `tool_calls` turn from a `length`-truncated one
 * (the backend hit max tokens / num_ctx). `(string & {})` keeps the union open
 * for backend-specific reasons we pass through verbatim.
 */
export type FinishReason = 'stop' | 'length' | 'tool_calls' | (string & {});

/** Token accounting for one chat() / chatStream() call, as reported by the
 *  backend. Only populated when the backend's response actually carries
 *  usage data — never estimated, so callers can trust it for cost/spend
 *  tracking instead of guessing from string length. */
export interface Usage {
  inputTokens: number;
  outputTokens: number;
  /** Input tokens served from a provider-side prompt cache (e.g. Anthropic's
   *  cache_read_input_tokens), when the backend reports the split. */
  cachedInputTokens?: number;
}

export interface ChatResponse {
  message: Message;
  finishReason: FinishReason;
  usage?: Usage;
}

/**
 * Parse a FunctionCall's `arguments` string back into an object. Returns
 * an empty object when arguments is empty; throws on malformed JSON so
 * the caller can surface the error to the user.
 */
export function parsedArgs(call: FunctionCall): Record<string, unknown> {
  if (!call.arguments) return {};
  return JSON.parse(call.arguments) as Record<string, unknown>;
}

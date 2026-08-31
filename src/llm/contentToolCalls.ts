// Shared logic to extract tool calls from model *content* (text) when the
// backend does not return native structured `tool_calls`.
// This is necessary for many local / fine-tuned / smaller models that still
// "speak" tools via JSON in the response text (Qwen, Llama, uncensored variants, etc.).

export interface ParsedToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeNamedCall(
  nameValue: unknown,
  argsValue: unknown,
  knownTools: Set<string>,
): ParsedToolCall | undefined {
  if (typeof nameValue !== 'string' || !knownTools.has(nameValue)) return undefined;

  let args: unknown = argsValue;
  if (typeof args === 'string') {
    try {
      args = JSON.parse(args);
    } catch {
      args = {};
    }
  }
  const argsRecord = isRecord(args) ? args : {};

  return {
    name: nameValue,
    arguments: argsRecord,
  };
}

// Small/quantized local models degrading into repetition-loop output can
// produce deeply-nested pseudo-JSON that JSON.parse still accepts; without a
// depth limit the recursive walk below throws an uncaught RangeError (stack
// overflow) that crashes the turn instead of falling back to plain text.
// Legitimate tool-call payloads never nest anywhere close to this deep.
const MAX_NORMALIZE_DEPTH = 20;

function normalizeToolCalls(value: unknown, knownTools: Set<string>, depth = 0): ParsedToolCall[] {
  if (depth > MAX_NORMALIZE_DEPTH) return [];
  if (Array.isArray(value)) {
    return value.flatMap((item) => normalizeToolCalls(item, knownTools, depth + 1));
  }
  if (!isRecord(value)) return [];

  const calls =
    value.tool_calls ??
    value.toolCalls ??
    value.tool_call ??
    value.toolCall ??
    value.function_call ??
    value.functionCall;

  if (isRecord(calls)) {
    return normalizeToolCalls(calls, knownTools, depth + 1);
  }
  if (Array.isArray(calls)) {
    return calls.flatMap((item) => normalizeToolCalls(item, knownTools, depth + 1));
  }

  const functionValue = value.function;
  if (isRecord(functionValue)) {
    const call = normalizeNamedCall(functionValue.name, functionValue.arguments, knownTools);
    return call ? [call] : [];
  }
  if (typeof functionValue === 'string') {
    const args = value.arguments ?? value.args ?? value.parameters ?? value.input ?? {};
    const call = normalizeNamedCall(functionValue, args, knownTools);
    return call ? [call] : [];
  }

  const name =
    value.name ??
    value.tool ??
    value.tool_name ??
    value.toolName ??
    value.action ??
    value.action_name ??
    value.actionName;

  const args =
    value.arguments ??
    value.args ??
    value.parameters ??
    value.input ??
    value.action_input ??
    value.actionInput ??
    {};

  const call = normalizeNamedCall(name, args, knownTools);
  return call ? [call] : [];
}

function parseJSONFromContent(content: string): unknown {
  const trimmed = content.trim();
  if (!trimmed) return undefined;

  // Handle ```json ... ``` or ``` ... ```
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const candidate = fenced?.[1]?.trim() ?? trimmed;

  try {
    return JSON.parse(candidate);
  } catch {
    return undefined;
  }
}

/**
 * Attempt to extract tool calls from raw assistant content text.
 * Returns [] if nothing recognizable is found.
 */
export function parseContentToolCalls(content: string, knownTools: Set<string>): ParsedToolCall[] {
  if (knownTools.size === 0) return [];

  const parsed = parseJSONFromContent(content);
  if (parsed === undefined) return [];

  // Depth-limited above, but no caller (openai.ts, ollama.ts) wraps this in
  // try/catch, so a genuinely uncaught path here would still crash the turn.
  // Belt-and-suspenders: fall back to "no tool calls found" rather than throw.
  try {
    return normalizeToolCalls(parsed, knownTools);
  } catch {
    return [];
  }
}

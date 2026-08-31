export const KIMI_DEFAULT_BASE_URL = 'https://api.moonshot.ai/v1';
export const KIMI_DEFAULT_MODEL = 'kimi-k2.6';
export const KIMI_MODELS = [
  'kimi-k2.7-code',
  'kimi-k2.6',
  'kimi-k2.5',
  'moonshot-v1-auto',
  'moonshot-v1-8k',
  'moonshot-v1-32k',
  'moonshot-v1-128k',
  'moonshot-v1-8k-vision-preview',
  'moonshot-v1-32k-vision-preview',
  'moonshot-v1-128k-vision-preview',
];

// Context windows (tokens) for hosted Kimi/Moonshot models, from
// GET https://api.moonshot.ai/v1/models. kimi-k2.7-code / k2.6 / k2.5 are
// 256K — far larger than the generic 16K auto-compact default — so we size
// the compaction threshold off the real window instead of throttling the
// model.
export const KIMI_CONTEXT_WINDOWS: Record<string, number> = {
  'kimi-k2.7-code': 262144,
  'kimi-k2.6': 262144,
  'kimi-k2.5': 262144,
  'moonshot-v1-auto': 131072,
  'moonshot-v1-128k': 131072,
  'moonshot-v1-128k-vision-preview': 131072,
  'moonshot-v1-32k': 32768,
  'moonshot-v1-32k-vision-preview': 32768,
  'moonshot-v1-8k': 8192,
  'moonshot-v1-8k-vision-preview': 8192,
};

// kimi-k2.7-code / k2.6 / k2.5 reject any `temperature` other than 1 — the
// API returns `400 invalid temperature: only 1 is allowed for this model`
// (k2.7-code fixes temperature/top_p/penalties server-side). The other
// moonshot-v1-* models accept a normal range. Used to decide whether it's
// safe to send a configured temperature.
export function kimiLocksTemperature(model: string): boolean {
  return model === 'kimi-k2.7-code' || model === 'kimi-k2.6' || model === 'kimi-k2.5';
}

// kimi-k2.6 / k2.5 expose a thinking/non-thinking switch we can toggle.
// kimi-k2.7-code is deliberately excluded: thinking is mandatory and always
// on (disabling it returns an API error), so there is nothing to toggle.
export function kimiSupportsThinkingToggle(model: string): boolean {
  return model === 'kimi-k2.6' || model === 'kimi-k2.5';
}

// Default per-response token cap for Kimi. These models can't be slowed down
// via temperature (it's locked to 1), so an unbounded response lets them
// narrate for a long time. Capping each turn keeps the agent responsive;
// it's generous enough for a substantive step + tool call and is overridable
// via config `max_tokens`.
export const KIMI_DEFAULT_MAX_TOKENS = 2048;

/**
 * Recommended auto-compact threshold for a Kimi model: 75% of its context
 * window, leaving headroom for the response and the next round of tool
 * output before the hard context limit. Returns undefined for unknown models
 * (caller keeps the configured default). Note this also tightens the small
 * 8K model, where the generic 16K default exceeds the window and would let
 * the conversation silently overflow.
 */
export function kimiAutoCompactThreshold(model: string): number | undefined {
  const window = KIMI_CONTEXT_WINDOWS[model];
  if (window === undefined) return undefined;
  return Math.floor(window * 0.75);
}

export const GROQ_DEFAULT_BASE_URL = 'https://api.groq.com/openai/v1';
export const GROQ_DEFAULT_MODEL = 'openai/gpt-oss-20b';
// Curated first-class ids (prefer order in the picker). Live catalog extras
// still appear via appendUnknown in models.ts. compound-beta* retired in
// favor of groq/compound*; several Llama/Qwen ids are on deprecation paths
// but kept until Groq fully shuts them down.
export const GROQ_MODELS = [
  'openai/gpt-oss-120b',
  'openai/gpt-oss-20b',
  'openai/gpt-oss-safeguard-20b',
  'moonshotai/kimi-k2-instruct',
  'qwen/qwen3-32b',
  'qwen/qwen3.6-27b',
  'meta-llama/llama-4-maverick-17b-128e-instruct',
  'meta-llama/llama-4-scout-17b-16e-instruct',
  'llama-3.3-70b-versatile',
  'llama-3.1-8b-instant',
  'groq/compound',
  'groq/compound-mini',
];

export const OPENROUTER_DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';
export const OPENROUTER_DEFAULT_MODEL = 'openrouter/auto';
export const OPENROUTER_RECOMMENDED_MODELS = ['openrouter/auto'];

// Official OpenAI Chat Completions API (Bearer key, /v1). Distinct from
// openai-compat (any third-party base URL).
export const OPENAI_DEFAULT_BASE_URL = 'https://api.openai.com/v1';
export const OPENAI_DEFAULT_MODEL = 'gpt-4.1';
// Curated first-class OpenAI Chat Completions ids. Live GET /v1/models still
// surfaces anything else; /model <id> accepts custom ids (fine-tunes, dated
// snapshots, Azure/proxy renames).
export const OPENAI_MODELS = [
  'gpt-4.1',
  'gpt-4.1-mini',
  'gpt-4.1-nano',
  'gpt-4o',
  'gpt-4o-mini',
  'gpt-4o-2024-11-20',
  'chatgpt-4o-latest',
  'o3',
  'o3-mini',
  'o3-pro',
  'o4-mini',
  'o1',
  'o1-mini',
  'o1-pro',
  'gpt-4-turbo',
  'gpt-3.5-turbo',
];
export const OPENAI_RECOMMENDED_MODELS = OPENAI_MODELS;

// DeepSeek V4 is the current public API. Legacy deepseek-chat / deepseek-reasoner
// aliases were retired 2026-07-24 and now 404 — do not list them.
export const DEEPSEEK_DEFAULT_BASE_URL = 'https://api.deepseek.com';
export const DEEPSEEK_DEFAULT_MODEL = 'deepseek-v4-flash';
export const DEEPSEEK_MODELS = ['deepseek-v4-flash', 'deepseek-v4-pro'];

// Anthropic Claude (Messages API). Base URL includes the /v1 prefix so the
// client builds <base>/messages and the model-list probe hits <base>/models,
// matching the openai-compat convention. Auth is the x-api-key header plus a
// required anthropic-version header (NOT Bearer). Custom Anthropic-scheme
// gateways (LiteLLM, Bedrock proxy, etc.) use the same client with base_url
// overridden — any model id is accepted via /model <id> or the custom picker.
export const ANTHROPIC_DEFAULT_BASE_URL = 'https://api.anthropic.com/v1';
// Pinned wire version for the Messages API. Bump deliberately, not silently —
// new versions can change response shapes.
export const ANTHROPIC_VERSION = '2023-06-01';
// Prefer the current agentic default; live /models still surfaces anything new.
export const ANTHROPIC_DEFAULT_MODEL = 'claude-sonnet-5';
// Anthropic requires max_tokens on every request (unlike Gemini's optional
// maxOutputTokens). When the user hasn't set one, default to a value that
// leaves room for a substantive answer + tool call while staying under the
// SDK/HTTP timeout for non-streaming requests.
export const ANTHROPIC_DEFAULT_MAX_TOKENS = 16000;
export const ANTHROPIC_MODELS = [
  // Claude 5 family (2026)
  'claude-fable-5',
  'claude-opus-5',
  'claude-sonnet-5',
  // Claude 4.x still widely used
  'claude-opus-4-8',
  'claude-opus-4-7',
  'claude-opus-4-6',
  'claude-sonnet-4-6',
  'claude-haiku-4-5',
  'claude-haiku-4-5-20251001',
  'claude-opus-4-5',
  'claude-opus-4-5-20251101',
  'claude-sonnet-4-5',
  'claude-sonnet-4-5-20250929',
];
export const ANTHROPIC_RECOMMENDED_MODELS = ANTHROPIC_MODELS;

/** API wire schemes for custom / third-party gateways. */
export type ApiScheme = 'openai' | 'anthropic';

/**
 * Map a custom endpoint scheme to the internal backend that implements it.
 * - openai  → openai-compat (Bearer + /chat/completions + /models)
 * - anthropic → anthropic (x-api-key + /messages + /models)
 */
export function backendForScheme(scheme: ApiScheme): 'openai-compat' | 'anthropic' {
  return scheme === 'anthropic' ? 'anthropic' : 'openai-compat';
}

// Newer Claude families (Opus 4.7+, Fable/Mythos 5, Opus/Sonnet 5) reject the
// temperature sampling parameter (HTTP 400). Older Claude models still accept
// it. Mirrors kimiLocksTemperature.
export function anthropicAcceptsTemperature(model: string): boolean {
  const m = model.toLowerCase();
  return !(
    m.includes('opus-4-7') ||
    m.includes('opus-4-8') ||
    m.includes('opus-5') ||
    m.includes('sonnet-5') ||
    m.includes('fable-5') ||
    m.includes('mythos-5')
  );
}

// naraya.ai — a multi-vendor router (DeepSeek, Qwen, GLM, Mistral, MiniMax,
// Claude) behind one OpenAI-compatible /chat/completions endpoint, auth via a
// Bearer key (NARAYA_API_KEY). Inference lives on router.naraya.ai (NOT
// api.naraya.ai, which is a separate gateway). naraya's own model ids carry a
// "-naraya" suffix where they differ from the upstream (e.g.
// `deepseek-v4-flash-naraya`, `qwen3.7-max-naraya`); others use the bare id.
// The list below mirrors the router's GET /models catalog and is fetched live.
export const NARAYA_DEFAULT_BASE_URL = 'https://router.naraya.ai/v1';
export const NARAYA_DEFAULT_MODEL = 'deepseek-v4-flash-naraya';
export const NARAYA_MODELS = [
  'deepseek-v4-flash-naraya',
  'deepseek-v4-pro-naraya',
  'qwen3.7-max-naraya',
  'minimax-m3',
  'claude-sonnet-5',
  'claude-sonnet-4.5',
  'claude-haiku-4.5',
  'claude-opus-5',
  'glm-5',
  'glm-5.1',
  'deepseek-3.2',
  'mistral-large',
  'mistral-medium-3-5',
  'kimi-k2.6',
];
export const NARAYA_RECOMMENDED_MODELS = NARAYA_MODELS;

// dahl.global — OpenAI-compatible inference API, auth via Bearer key
// (DAHL_API_KEY). Model ids carry the upstream vendor prefix (e.g.
// `moonshotai/Kimi-K2.6`), suggesting a multi-model catalog behind one
// endpoint; recommended list below is seeded with the known-good id and
// grown as more are confirmed. Model list is fetched live like the other
// OpenAI-compatible backends.
export const DAHL_DEFAULT_BASE_URL = 'https://inference.dahl.global/v1';
export const DAHL_DEFAULT_MODEL = 'moonshotai/Kimi-K2.6';
// Confirmed live via GET /v1/models — a small multi-vendor catalog (owned_by
// "gonka"), so appendUnknown stays on in models.ts to surface anything new.
export const DAHL_MODELS = [
  'moonshotai/Kimi-K2.6',
  'moonshotai/Kimi-K2.5',
  'zai-org/GLM-5.2-FP8',
  'zai-org/GLM-5',
  'MiniMaxAI/MiniMax-M2.7',
  'MiniMaxAI/MiniMax-M2.5',
  'deepseek-ai/DeepSeek-V4-Flash',
  'Qwen/Qwen3-32B',
];
export const DAHL_RECOMMENDED_MODELS = DAHL_MODELS;

export const GEMINI_DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';
export const GEMINI_DEFAULT_MODEL = 'models/gemini-3.5-flash';

export const GEMINI_BEST_FIT_MODELS = [
  'models/gemini-3.5-flash',
  'models/gemini-3.1-pro-preview',
  'models/gemini-3-pro-preview',
  'models/gemini-flash-latest',
  'models/gemini-pro-latest',
  'models/gemini-3-flash-preview',
  'models/gemini-3.1-flash-lite',
  'models/gemini-2.5-flash',
  'models/gemini-2.5-pro',
  'models/gemini-2.5-flash-lite',
];

export const GEMINI_CHEAP_MODELS = [
  'models/gemini-flash-lite-latest',
  'models/gemini-3.1-flash-lite-preview',
  'models/gemini-2.0-flash',
  'models/gemini-2.0-flash-lite',
  'models/gemma-4-26b-a4b-it',
  'models/gemma-3-27b-it',
  'models/gemma-3-12b-it',
];

export const GEMINI_RECOMMENDED_MODELS = [...GEMINI_BEST_FIT_MODELS, ...GEMINI_CHEAP_MODELS];

// OpenRouter: only "auto" is hard-coded; the live catalog is huge. These are
// common agent-friendly ids floated when present.
export const OPENROUTER_POPULAR_MODELS = [
  'openrouter/auto',
  'anthropic/claude-sonnet-5',
  'anthropic/claude-opus-5',
  'openai/gpt-4.1',
  'openai/o3',
  'google/gemini-2.5-pro',
  'google/gemini-2.5-flash',
  'deepseek/deepseek-v4-pro',
  'moonshotai/kimi-k2.6',
  'qwen/qwen3-32b',
  'meta-llama/llama-4-maverick',
];

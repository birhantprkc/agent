// Fetch the list of available models from an LLM backend. Used by the
// interactive /provider flow to populate the model picker after the user
// chooses Ollama / LM Studio / openai-compat / Kimi / Groq / OpenRouter / DeepSeek / Gemini /
// Anthropic.

import type { Backend } from '../config/config.js';
import {
  getOpenAISchemeProvider,
  isOpenAISchemeProvider,
  openaiSchemeBackendIds,
} from './providerRegistry.js';
import {
  ANTHROPIC_DEFAULT_BASE_URL,
  ANTHROPIC_RECOMMENDED_MODELS,
  ANTHROPIC_VERSION,
  DAHL_DEFAULT_BASE_URL,
  DAHL_MODELS,
  DEEPSEEK_DEFAULT_BASE_URL,
  DEEPSEEK_MODELS,
  GEMINI_DEFAULT_BASE_URL,
  GEMINI_RECOMMENDED_MODELS,
  GROQ_DEFAULT_BASE_URL,
  GROQ_MODELS,
  KIMI_DEFAULT_BASE_URL,
  KIMI_MODELS,
  NARAYA_DEFAULT_BASE_URL,
  NARAYA_MODELS,
  OPENAI_DEFAULT_BASE_URL,
  OPENAI_RECOMMENDED_MODELS,
  OPENROUTER_DEFAULT_BASE_URL,
  OPENROUTER_POPULAR_MODELS,
  OPENROUTER_RECOMMENDED_MODELS,
} from './providers.js';

const DEFAULT_TIMEOUT_MS = 5_000;

function defaultBaseURL(backend: Exclude<Backend, ''>): string {
  const core: Partial<Record<Exclude<Backend, ''>, string>> = {
    ollama: 'http://localhost:11434',
    lmstudio: 'http://localhost:1234/v1',
    openai: OPENAI_DEFAULT_BASE_URL,
    'openai-compat': '',
    kimi: KIMI_DEFAULT_BASE_URL,
    groq: GROQ_DEFAULT_BASE_URL,
    openrouter: OPENROUTER_DEFAULT_BASE_URL,
    deepseek: DEEPSEEK_DEFAULT_BASE_URL,
    gemini: GEMINI_DEFAULT_BASE_URL,
    anthropic: ANTHROPIC_DEFAULT_BASE_URL,
    naraya: NARAYA_DEFAULT_BASE_URL,
    dahl: DAHL_DEFAULT_BASE_URL,
  };
  if (core[backend] !== undefined) return core[backend] ?? '';
  const preset = getOpenAISchemeProvider(backend);
  return preset?.baseURL ?? '';
}

/**
 * Query the backend's model-list endpoint and return the IDs. Throws
 * on transport failure or non-2xx. Trips a 5-second timeout so a stalled
 * endpoint doesn't wedge the UI.
 *
 *   ollama        → GET <base>/api/tags  → { models: [{ name }] }
 *   lmstudio      → GET <base>/models    → { data:   [{ id   }] }
 *   openai-compat → GET <base>/models    → same as lmstudio (Bearer header)
 *   kimi          → GET <base>/models    → same as openai-compat (Bearer header)
 *   groq          → GET <base>/models    → same as openai-compat (Bearer header)
 *   openrouter    → GET <base>/models    → same as openai-compat (Bearer header)
 *   deepseek      → GET <base>/models    → same as openai-compat (Bearer header)
 *   gemini        → GET <base>/models?key=... → { models: [{ name }] }
 *   anthropic     → GET <base>/models    → { data: [{ id }] } (x-api-key + anthropic-version)
 */
export async function listModels(
  backend: Backend,
  baseURL = '',
  apiKey = '',
  signal?: AbortSignal,
): Promise<string[]> {
  const b: Exclude<Backend, ''> = backend === '' ? 'ollama' : backend;
  const base = baseURL || defaultBaseURL(b);
  if (!base) throw new Error(`${b} backend requires a base URL`);

  const path = b === 'ollama' ? '/api/tags' : '/models';
  const headers: Record<string, string> = {};
  if (apiKey && b === 'gemini') {
    // Gemini takes the key as a header, not a query param, so it stays out of logs.
    headers['x-goog-api-key'] = apiKey;
  } else if (b === 'anthropic') {
    // Anthropic authenticates with x-api-key (not Bearer) and requires a
    // pinned wire version on every request, including the model list.
    if (apiKey) headers['x-api-key'] = apiKey;
    headers['anthropic-version'] = ANTHROPIC_VERSION;
  } else if (apiKey && b !== 'ollama') {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  const ctl = new AbortController();
  const onAbort = () => ctl.abort();
  if (signal?.aborted) ctl.abort();
  else signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => ctl.abort(), DEFAULT_TIMEOUT_MS);

  try {
    const resp = await fetch(`${base}${path}`, {
      method: 'GET',
      headers,
      signal: ctl.signal,
    });
    if (resp.status !== 200) {
      throw new Error(`${b} list-models returned ${resp.status}`);
    }
    const body = (await resp.json()) as unknown;
    return parseModels(b, body);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

function parseModels(backend: Exclude<Backend, ''>, body: unknown): string[] {
  if (!body || typeof body !== 'object') return [];
  if (backend === 'ollama') {
    const models = (body as { models?: Array<{ name?: unknown }> }).models ?? [];
    return models
      .map((m) => (typeof m.name === 'string' ? m.name : ''))
      .filter((n): n is string => n.length > 0);
  }
  if (backend === 'gemini') {
    const models =
      (body as { models?: Array<{ name?: unknown; supportedGenerationMethods?: unknown }> })
        .models ?? [];
    const names = models
      .filter((m) => {
        const methods = Array.isArray(m.supportedGenerationMethods)
          ? m.supportedGenerationMethods
          : [];
        return methods.includes('generateContent');
      })
      .map((m) => (typeof m.name === 'string' ? m.name : ''))
      .filter((n): n is string => n.length > 0);
    return preferGeminiRecommended(names);
  }
  const data = (body as { data?: Array<{ id?: unknown }> }).data ?? [];
  const ids = data
    .map((m) => (typeof m.id === 'string' ? m.id : ''))
    .filter((n): n is string => n.length > 0);
  // Always appendUnknown so a live catalog that adds models we haven't curated
  // yet still surfaces them in /model list (previously kimi/groq/deepseek
  // silently dropped anything not in the hard-coded list).
  if (backend === 'kimi') return preferKnownModels(ids, KIMI_MODELS, { appendUnknown: true });
  if (backend === 'groq') return preferKnownModels(ids, GROQ_MODELS, { appendUnknown: true });
  if (backend === 'openrouter') {
    return preferOpenRouterModels(ids);
  }
  if (backend === 'openai') {
    return preferKnownModels(ids, OPENAI_RECOMMENDED_MODELS, { appendUnknown: true });
  }
  if (backend === 'deepseek')
    return preferKnownModels(ids, DEEPSEEK_MODELS, { appendUnknown: true });
  if (backend === 'naraya') {
    // naraya serves a huge multi-vendor catalog; float the curated first-class
    // ids to the top and keep the rest below so nothing is hidden.
    return preferKnownModels(ids, NARAYA_MODELS, { appendUnknown: true });
  }
  if (backend === 'anthropic') {
    // Anthropic's /v1/models uses the same { data: [{ id }] } envelope; float
    // the known recommended ids to the top, keep any newer ones below.
    return preferKnownModels(ids, ANTHROPIC_RECOMMENDED_MODELS, { appendUnknown: true });
  }
  if (backend === 'dahl') return preferKnownModels(ids, DAHL_MODELS, { appendUnknown: true });
  if (isOpenAISchemeProvider(backend)) {
    const p = getOpenAISchemeProvider(backend);
    return preferKnownModels(ids, p?.models ?? [], { appendUnknown: true });
  }
  return ids;
}

/** Curated model lists for OpenCode-aligned OpenAI-scheme backends (tests/help). */
export function registeredOpenAISchemeBackends(): string[] {
  return openaiSchemeBackendIds();
}

function preferGeminiRecommended(models: string[]): string[] {
  return preferKnownModels(models, GEMINI_RECOMMENDED_MODELS, { appendUnknown: true });
}

function preferOpenRouterModels(models: string[]): string[] {
  const withAuto = models.includes('openrouter/auto')
    ? models
    : [...OPENROUTER_RECOMMENDED_MODELS, ...models];
  // Float auto + popular agent-friendly ids, then the full live catalog.
  return preferKnownModels(withAuto, OPENROUTER_POPULAR_MODELS, { appendUnknown: true });
}

function preferKnownModels(
  models: string[],
  known: readonly string[],
  opts: { appendUnknown?: boolean } = {},
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of known) {
    if (models.includes(m) && !seen.has(m)) {
      out.push(m);
      seen.add(m);
    }
  }
  if (!opts.appendUnknown) return out;
  for (const m of models) {
    if (!seen.has(m)) {
      out.push(m);
      seen.add(m);
    }
  }
  return out;
}

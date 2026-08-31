// /provider (interactive backend picker) and /model (id or `list`) — the
// largest command group since every remote backend needs its own
// "prompt for an API key, then fetch its model list" flow.

import type { Backend } from '../../config/config.js';
import { listModels } from '../../llm/models.js';
import {
  OPENAI_SCHEME_PROVIDERS,
  type ProviderDef,
  getOpenAISchemeProvider,
  isOpenAISchemeProvider,
} from '../../llm/providerRegistry.js';
import {
  ANTHROPIC_DEFAULT_BASE_URL,
  ANTHROPIC_RECOMMENDED_MODELS,
  DAHL_DEFAULT_BASE_URL,
  DAHL_MODELS,
  DEEPSEEK_DEFAULT_BASE_URL,
  DEEPSEEK_MODELS,
  GEMINI_CHEAP_MODELS,
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
  OPENROUTER_RECOMMENDED_MODELS,
} from '../../llm/providers.js';
import { apply as redact } from '../../redact/redact.js';
import type { ApplyProvider } from '../appTypes.js';
import type { AskRequest } from '../askBridge.js';
import type { SecretInputRequest } from '../secretInput.js';
import type { Action } from '../state.js';
import type { SlashContext } from './context.js';

/** Sentinel option label for free-form model id entry in the picker. */
export const CUSTOM_MODEL_OPTION = '✦ Enter custom model id…';
const CUSTOM_OPENAI_SCHEME = 'Custom OpenAI scheme';
const CUSTOM_ANTHROPIC_SCHEME = 'Custom Anthropic scheme';
let modelLoadGeneration = 0;

export function handleProvider(ctx: SlashContext): void {
  openProviderPicker(ctx.dispatch, ctx.readConfig, ctx.applyProvider, ctx.promptSecret);
}

export function handleModel(ctx: SlashContext): void {
  const { agent, rest, dispatch, readConfig, applyProvider, promptSecret } = ctx;
  const m = rest.join(' ').trim();
  if (!m) {
    const cur = readConfig();
    dispatch({
      type: 'append',
      entry: {
        kind: 'system',
        text: `current model: ${cur.model || '(unset)'}\nusage: /model <id>  ·  /model list  ·  /model custom  ·  or run /provider for an interactive picker\ncustom ids are always allowed (fine-tunes, dated snapshots, proxy renames)`,
      },
    });
    return;
  }
  const cur = readConfig();
  if (m.toLowerCase() === 'list' || m.toLowerCase() === 'ls') {
    void fetchAndPickModel(cur.backend, cur.baseURL, cur.apiKey, dispatch, applyProvider, {
      currentModel: cur.model || agent.client.model(),
      customModels: cur.customModels,
      promptSecret,
      successText: (picked) => `model set to ${picked}`,
    });
    return;
  }
  if (m.toLowerCase() === 'custom') {
    void promptCustomModelId(promptSecret, dispatch).then((id) => {
      if (!id) return;
      return applyCustomModel(cur.backend, id, applyProvider, dispatch);
    });
    return;
  }
  // Soft-validate against the live catalog: warn + did-you-mean on unknown
  // ids, but still allow them. Custom OpenAI/Anthropic gateways often use
  // names that never appear in GET /models (fine-tunes, Azure deployments,
  // LiteLLM aliases). Hard-rejecting blocked those workflows.
  void (async () => {
    let known: string[] = [];
    try {
      known = await listModels(cur.backend, cur.baseURL, cur.apiKey);
    } catch (err) {
      dispatch({
        type: 'append',
        entry: {
          kind: 'system',
          text: `(could not list models from backend: ${(err as Error).message} — accepting custom id)`,
        },
      });
    }
    const remembered = cur.customModels ?? [];
    const allowed = new Set([...known, ...remembered]);
    if (known.length > 0 && !allowed.has(m)) {
      const suggestion = suggestClosest(m, [...known, ...remembered]);
      dispatch({
        type: 'append',
        entry: {
          kind: 'system',
          text: suggestion
            ? `model "${m}" not in live catalog (did you mean ${suggestion}?). using custom id anyway.`
            : `model "${m}" not in live catalog — using as custom model id.`,
        },
      });
    }
    try {
      await applyProvider({ backend: cur.backend, model: m });
      dispatch({ type: 'append', entry: { kind: 'system', text: `model set to ${m}` } });
    } catch (err: unknown) {
      dispatch({
        type: 'append',
        entry: { kind: 'error', text: `model: ${(err as Error).message}` },
      });
    }
  })();
}

async function applyCustomModel(
  backend: Backend,
  model: string,
  applyProvider: ApplyProvider,
  dispatch: React.Dispatch<Action>,
): Promise<void> {
  try {
    await applyProvider({ backend, model });
    dispatch({
      type: 'append',
      entry: { kind: 'system', text: `model set to ${model} (custom)` },
    });
  } catch (err: unknown) {
    dispatch({
      type: 'append',
      entry: { kind: 'error', text: `model: ${(err as Error).message}` },
    });
  }
}

async function promptCustomModelId(
  promptSecret: (req: Omit<SecretInputRequest, 'resolve' | 'reject'>) => Promise<string>,
  dispatch: React.Dispatch<Action>,
): Promise<string> {
  try {
    const id = (
      await promptSecret({
        header: 'Custom model',
        question: 'Enter a model id',
        subtitle: 'Fine-tune · dated snapshot · proxy rename · any gateway id',
        placeholder: 'gpt-4.1 · claude-sonnet-5 · my-ft:abc',
        footer: 'type id · Enter confirm · Esc cancel',
      })
    ).trim();
    if (!id) {
      dispatch({
        type: 'append',
        entry: { kind: 'error', text: 'custom model id cannot be empty.' },
      });
      return '';
    }
    return id;
  } catch {
    dispatch({ type: 'append', entry: { kind: 'system', text: 'custom model cancelled.' } });
    return '';
  }
}

function backendLabel(backend: Backend): string {
  const preset = getOpenAISchemeProvider(backend);
  if (preset) return preset.name;
  switch (backend) {
    case '':
    case 'ollama':
      return 'ollama';
    case 'lmstudio':
      return 'LM Studio';
    case 'openai':
      return 'OpenAI';
    case 'openai-compat':
      return 'OpenAI-compatible';
    case 'kimi':
      return 'Kimi';
    case 'groq':
      return 'Groq';
    case 'openrouter':
      return 'OpenRouter';
    case 'deepseek':
      return 'DeepSeek';
    case 'gemini':
      return 'Gemini';
    case 'anthropic':
      return 'Claude';
    case 'naraya':
      return 'Naraya';
    case 'dahl':
      return 'Dahl';
    default:
      return backend;
  }
}

const OPENCODE_MORE_LABEL = 'More providers…';

/** Open the backend picker. Re-uses the AskModal plumbing by synthesizing
 *  an AskRequest dispatched straight into pendingAsk — the modal's
 *  arrow-key + Enter handling works without modification. */
type ConfigView = {
  backend: Backend;
  baseURL: string;
  apiKey: string;
  model: string;
  customModels?: string[];
};

/** Append " · current" when this backend is active (stable prefix for matchers). */
function withCurrent(label: string, active: boolean): string {
  return active ? `${label} · current` : label;
}

function openProviderPicker(
  dispatch: React.Dispatch<Action>,
  readConfig: () => ConfigView,
  applyProvider: ApplyProvider,
  promptSecret: (req: Omit<SecretInputRequest, 'resolve' | 'reject'>) => Promise<string>,
): void {
  const cur = readConfig();
  const isLocalOllama = cur.backend === 'ollama' || cur.backend === '';
  const isOfficialClaude =
    cur.backend === 'anthropic' &&
    (cur.baseURL === '' || cur.baseURL.includes('api.anthropic.com'));
  const isCustomAnthropic =
    cur.backend === 'anthropic' && cur.baseURL !== '' && !cur.baseURL.includes('api.anthropic.com');
  const isCustomOpenAI = cur.backend === 'openai-compat';
  const activeName = backendLabel(cur.backend || 'ollama');
  const activeModel = cur.model || '(no model)';

  const req: AskRequest = {
    question: {
      header: 'Provider',
      question: 'Select an LLM provider for this session',
      subtitle: `Active  ${activeName}  ·  ${activeModel}`,
      footer: '↑↓ navigate · 1-9 jump · Enter select · Esc cancel',
      options: [
        // —— Local ————————————————————————————————————————————————
        {
          group: 'Local',
          label: withCurrent('Ollama', isLocalOllama),
          badge: 'Local',
          description: 'localhost · Ollama /api/chat',
        },
        {
          group: 'Local',
          label: withCurrent('LM Studio', cur.backend === 'lmstudio'),
          badge: 'Local',
          description: 'localhost · OpenAI-compatible',
        },
        // —— Hosted ——————————————————————————————————————————————
        {
          group: 'Hosted',
          label: withCurrent('OpenAI', cur.backend === 'openai'),
          badge: 'Cloud',
          description: 'api.openai.com',
        },
        {
          group: 'Hosted',
          label: withCurrent('Claude', isOfficialClaude),
          badge: 'Cloud',
          description: 'api.anthropic.com · Messages API',
        },
        {
          group: 'Hosted',
          label: withCurrent('Gemini', cur.backend === 'gemini'),
          badge: 'Cloud',
          description: 'Google Generative Language API',
        },
        {
          group: 'Hosted',
          label: withCurrent('Kimi', cur.backend === 'kimi'),
          badge: 'Cloud',
          description: 'Moonshot · api.moonshot.ai',
        },
        {
          group: 'Hosted',
          label: withCurrent('Groq', cur.backend === 'groq'),
          badge: 'Cloud',
          description: 'api.groq.com · fast inference',
        },
        {
          group: 'Hosted',
          label: withCurrent('OpenRouter', cur.backend === 'openrouter'),
          badge: 'Cloud',
          description: 'openrouter.ai · multi-model router',
        },
        {
          group: 'Hosted',
          label: withCurrent('DeepSeek', cur.backend === 'deepseek'),
          badge: 'Cloud',
          description: 'api.deepseek.com',
        },
        {
          group: 'Hosted',
          label: withCurrent('Naraya', cur.backend === 'naraya'),
          badge: 'Cloud',
          description: 'router.naraya.ai',
        },
        {
          group: 'Hosted',
          label: withCurrent('Dahl', cur.backend === 'dahl'),
          badge: 'Cloud',
          description: 'inference.dahl.global',
        },
        // —— Catalog —————————————————————————————————————————————
        {
          group: 'Catalog',
          label: OPENCODE_MORE_LABEL,
          badge: 'OpenCode',
          description: 'xAI · Mistral · Together · Venice · Alibaba · NVIDIA · …',
        },
        // —— Custom ——————————————————————————————————————————————
        {
          group: 'Custom endpoint',
          label: withCurrent(CUSTOM_OPENAI_SCHEME, isCustomOpenAI),
          badge: 'Gateway',
          description: 'Bearer · /chat/completions · any base URL',
        },
        {
          group: 'Custom endpoint',
          label: withCurrent(CUSTOM_ANTHROPIC_SCHEME, isCustomAnthropic),
          badge: 'Gateway',
          description: 'x-api-key · /messages · any base URL',
        },
        {
          group: 'Custom endpoint',
          label: withCurrent('OpenAI-compatible', isCustomOpenAI && !!cur.baseURL && !!cur.apiKey),
          badge: 'Legacy',
          description: 'use saved base URL + key from config',
        },
      ],
    },
    resolve: (picked) => {
      dispatch({ type: 'set-ask', req: null });
      // Strip " · current" suffix before matching.
      const name = picked.replace(/\s*·\s*current\s*$/i, '').trim();
      // Custom schemes first (longer labels), then hosted names.
      if (name.startsWith(OPENCODE_MORE_LABEL) || name.startsWith('More providers')) {
        openOpenCodeProviderPicker(dispatch, readConfig, applyProvider, promptSecret);
        return;
      }
      if (name.startsWith(CUSTOM_OPENAI_SCHEME)) {
        void setupCustomScheme('openai', dispatch, applyProvider, promptSecret, readConfig());
        return;
      }
      if (name.startsWith(CUSTOM_ANTHROPIC_SCHEME)) {
        void setupCustomScheme('anthropic', dispatch, applyProvider, promptSecret, readConfig());
        return;
      }
      // Match longer / more specific labels first: "OpenAI-compatible" must not
      // be classified as official "OpenAI". Use `name` (current suffix stripped).
      const backend: Backend = name.startsWith('Ollama')
        ? 'ollama'
        : name.startsWith('LM Studio')
          ? 'lmstudio'
          : name.startsWith('OpenAI-compatible')
            ? 'openai-compat'
            : name.startsWith('OpenAI')
              ? 'openai'
              : name.startsWith('Kimi')
                ? 'kimi'
                : name.startsWith('Groq')
                  ? 'groq'
                  : name.startsWith('Gemini')
                    ? 'gemini'
                    : name.startsWith('OpenRouter')
                      ? 'openrouter'
                      : name.startsWith('DeepSeek')
                        ? 'deepseek'
                        : name.startsWith('Claude')
                          ? 'anthropic'
                          : name.startsWith('Naraya')
                            ? 'naraya'
                            : name.startsWith('Dahl')
                              ? 'dahl'
                              : 'openai-compat';
      const config = readConfig();
      // For openai-compat we need URL + key already in config — otherwise
      // send the user through the Custom OpenAI scheme wizard.
      if (backend === 'openai-compat' && (!config.baseURL || !config.apiKey)) {
        void setupCustomScheme('openai', dispatch, applyProvider, promptSecret, config);
        return;
      }
      // Registry presets (xai, mistral, …) — same key → list → model flow.
      if (isOpenAISchemeProvider(backend) && (config.backend !== backend || !config.apiKey)) {
        const preset = getOpenAISchemeProvider(backend);
        if (preset) {
          startPresetProvider(preset, dispatch, readConfig, applyProvider, promptSecret);
          return;
        }
      }
      if (backend === 'openai' && (config.backend !== 'openai' || !config.apiKey)) {
        void promptSecret({
          header: 'OpenAI API',
          question: 'Enter your API key',
          subtitle: 'Env  OPENAI_API_KEY  ·  stored in ~/.pentesterflow/config.json',
          placeholder: 'sk-…',
        })
          .then((apiKey) => {
            if (!apiKey) {
              dispatch({
                type: 'append',
                entry: { kind: 'error', text: 'OpenAI API key cannot be empty.' },
              });
              return;
            }
            void fetchAndPickModel(
              backend,
              config.backend === 'openai'
                ? config.baseURL || OPENAI_DEFAULT_BASE_URL
                : OPENAI_DEFAULT_BASE_URL,
              apiKey,
              dispatch,
              applyProvider,
              {
                customModels: config.customModels,
                promptSecret,
                successText: (picked) => `provider set to OpenAI · model ${picked}`,
              },
            );
          })
          .catch(() => {
            dispatch({
              type: 'append',
              entry: { kind: 'system', text: 'OpenAI setup cancelled.' },
            });
          });
        return;
      }
      if (backend === 'kimi' && (config.backend !== 'kimi' || !config.apiKey)) {
        void promptSecret({
          header: 'Kimi API',
          question: 'Enter your API key',
          subtitle: 'Env  MOONSHOT_API_KEY / KIMI_API_KEY',
          placeholder: 'sk-…',
        })
          .then((apiKey) => {
            if (!apiKey) {
              dispatch({
                type: 'append',
                entry: { kind: 'error', text: 'Kimi API key cannot be empty.' },
              });
              return;
            }
            void fetchAndPickModel(
              backend,
              config.backend === 'kimi'
                ? config.baseURL || KIMI_DEFAULT_BASE_URL
                : KIMI_DEFAULT_BASE_URL,
              apiKey,
              dispatch,
              applyProvider,
              {
                customModels: config.customModels,
                promptSecret,
                successText: (picked) => `provider set to Kimi · model ${picked}`,
              },
            );
          })
          .catch(() => {
            dispatch({
              type: 'append',
              entry: { kind: 'system', text: 'Kimi setup cancelled.' },
            });
          });
        return;
      }
      if (backend === 'groq' && (config.backend !== 'groq' || !config.apiKey)) {
        void promptSecret({
          header: 'Groq API',
          question: 'Enter your API key',
          subtitle: 'Env  GROQ_API_KEY',
          placeholder: 'gsk_…',
        })
          .then((apiKey) => {
            if (!apiKey) {
              dispatch({
                type: 'append',
                entry: { kind: 'error', text: 'Groq API key cannot be empty.' },
              });
              return;
            }
            void fetchAndPickModel(
              backend,
              GROQ_DEFAULT_BASE_URL,
              apiKey,
              dispatch,
              applyProvider,
              {
                customModels: config.customModels,
                promptSecret,
                successText: (picked) => `provider set to Groq · model ${picked}`,
              },
            );
          })
          .catch(() => {
            dispatch({
              type: 'append',
              entry: { kind: 'system', text: 'Groq setup cancelled.' },
            });
          });
        return;
      }
      if (backend === 'gemini' && (config.backend !== 'gemini' || !config.apiKey)) {
        void promptSecret({
          header: 'Gemini API',
          question: 'Enter your API key',
          subtitle: 'Env  GEMINI_API_KEY',
          placeholder: 'AIza…',
        })
          .then((apiKey) => {
            if (!apiKey) {
              dispatch({
                type: 'append',
                entry: { kind: 'error', text: 'Gemini API key cannot be empty.' },
              });
              return;
            }
            void fetchAndPickModel(
              backend,
              GEMINI_DEFAULT_BASE_URL,
              apiKey,
              dispatch,
              applyProvider,
              {
                customModels: config.customModels,
                promptSecret,
                successText: (picked) => `provider set to Gemini · model ${picked}`,
              },
            );
          })
          .catch(() => {
            dispatch({
              type: 'append',
              entry: { kind: 'system', text: 'Gemini setup cancelled.' },
            });
          });
        return;
      }
      if (backend === 'openrouter' && (config.backend !== 'openrouter' || !config.apiKey)) {
        void promptSecret({
          header: 'OpenRouter API',
          question: 'Enter your API key',
          subtitle: 'Env  OPENROUTER_API_KEY',
          placeholder: 'sk-or-…',
        })
          .then((apiKey) => {
            if (!apiKey) {
              dispatch({
                type: 'append',
                entry: { kind: 'error', text: 'OpenRouter API key cannot be empty.' },
              });
              return;
            }
            void fetchAndPickModel(
              backend,
              OPENROUTER_DEFAULT_BASE_URL,
              apiKey,
              dispatch,
              applyProvider,
              {
                customModels: config.customModels,
                promptSecret,
                successText: (picked) => `provider set to OpenRouter · model ${picked}`,
              },
            );
          })
          .catch(() => {
            dispatch({
              type: 'append',
              entry: { kind: 'system', text: 'OpenRouter setup cancelled.' },
            });
          });
        return;
      }
      if (backend === 'deepseek' && (config.backend !== 'deepseek' || !config.apiKey)) {
        void promptSecret({
          header: 'DeepSeek API',
          question: 'Enter your API key',
          subtitle: 'Env  DEEPSEEK_API_KEY',
          placeholder: 'sk-…',
        })
          .then((apiKey) => {
            if (!apiKey) {
              dispatch({
                type: 'append',
                entry: { kind: 'error', text: 'DeepSeek API key cannot be empty.' },
              });
              return;
            }
            void fetchAndPickModel(
              backend,
              DEEPSEEK_DEFAULT_BASE_URL,
              apiKey,
              dispatch,
              applyProvider,
              {
                customModels: config.customModels,
                promptSecret,
                successText: (picked) => `provider set to DeepSeek · model ${picked}`,
              },
            );
          })
          .catch(() => {
            dispatch({
              type: 'append',
              entry: { kind: 'system', text: 'DeepSeek setup cancelled.' },
            });
          });
        return;
      }
      if (backend === 'naraya' && (config.backend !== 'naraya' || !config.apiKey)) {
        void promptSecret({
          header: 'Naraya API',
          question: 'Enter your API key',
          subtitle: 'Env  NARAYA_API_KEY',
          placeholder: 'sk-nry-…',
        })
          .then((apiKey) => {
            if (!apiKey) {
              dispatch({
                type: 'append',
                entry: { kind: 'error', text: 'Naraya API key cannot be empty.' },
              });
              return;
            }
            void fetchAndPickModel(
              backend,
              config.backend === 'naraya'
                ? config.baseURL || NARAYA_DEFAULT_BASE_URL
                : NARAYA_DEFAULT_BASE_URL,
              apiKey,
              dispatch,
              applyProvider,
              {
                customModels: config.customModels,
                promptSecret,
                successText: (picked) => `provider set to Naraya · model ${picked}`,
              },
            );
          })
          .catch(() => {
            dispatch({
              type: 'append',
              entry: { kind: 'system', text: 'Naraya setup cancelled.' },
            });
          });
        return;
      }
      if (backend === 'dahl' && (config.backend !== 'dahl' || !config.apiKey)) {
        void promptSecret({
          header: 'Dahl API',
          question: 'Enter your API key',
          subtitle: 'Env  DAHL_API_KEY',
          placeholder: 'dahl_…',
        })
          .then((apiKey) => {
            if (!apiKey) {
              dispatch({
                type: 'append',
                entry: { kind: 'error', text: 'Dahl API key cannot be empty.' },
              });
              return;
            }
            void fetchAndPickModel(
              backend,
              config.backend === 'dahl'
                ? config.baseURL || DAHL_DEFAULT_BASE_URL
                : DAHL_DEFAULT_BASE_URL,
              apiKey,
              dispatch,
              applyProvider,
              {
                customModels: config.customModels,
                promptSecret,
                successText: (picked) => `provider set to Dahl · model ${picked}`,
              },
            );
          })
          .catch(() => {
            dispatch({
              type: 'append',
              entry: { kind: 'system', text: 'Dahl setup cancelled.' },
            });
          });
        return;
      }
      if (backend === 'anthropic' && (config.backend !== 'anthropic' || !config.apiKey)) {
        void promptSecret({
          header: 'Claude API',
          question: 'Enter your API key',
          subtitle: 'Env  ANTHROPIC_API_KEY',
          placeholder: 'sk-ant-…',
        })
          .then((apiKey) => {
            if (!apiKey) {
              dispatch({
                type: 'append',
                entry: { kind: 'error', text: 'Anthropic API key cannot be empty.' },
              });
              return;
            }
            void fetchAndPickModel(
              backend,
              ANTHROPIC_DEFAULT_BASE_URL,
              apiKey,
              dispatch,
              applyProvider,
              {
                customModels: config.customModels,
                promptSecret,
                successText: (picked) => `provider set to Claude · model ${picked}`,
              },
            );
          })
          .catch(() => {
            dispatch({
              type: 'append',
              entry: { kind: 'system', text: 'Claude setup cancelled.' },
            });
          });
        return;
      }
      const baseURL = resolveProviderBaseURL(backend, config);
      const apiKey =
        backend === 'openai-compat' || backend === 'openai' || config.backend === backend
          ? config.apiKey
          : '';
      void fetchAndPickModel(backend, baseURL, apiKey, dispatch, applyProvider, {
        customModels: config.customModels,
        promptSecret,
      });
    },
    reject: () => dispatch({ type: 'set-ask', req: null }),
  };
  dispatch({ type: 'set-ask', req });
}

/**
 * Pick the closest candidate to `input` from `known` for did-you-mean
 * messages. Strategy: prefer longest common prefix (handles typos at the
 * end like "qwen2.5-coder-32b" → "qwen2.5-coder-32b-instruct"); fall back
 * to substring containment in either direction. Returns undefined when no
 * candidate is meaningfully close.
 */
function suggestClosest(input: string, known: string[]): string | undefined {
  const needle = input.toLowerCase();
  let best: { name: string; score: number } | undefined;
  for (const cand of known) {
    const lower = cand.toLowerCase();
    let score = 0;
    // Longest common prefix.
    const prefLen = Math.min(needle.length, lower.length);
    for (let i = 0; i < prefLen; i += 1) {
      if (needle[i] !== lower[i]) break;
      score += 2;
    }
    if (lower.includes(needle) || needle.includes(lower)) score += 5;
    if (!best || score > best.score) best = { name: cand, score };
  }
  // Require at least 4 chars of shared prefix (or substring hit) to avoid
  // proposing wildly unrelated models on totally bogus input.
  return best && best.score >= 4 ? best.name : undefined;
}

/** Fetch the model list from the chosen backend and open the model picker.
 *  Caps the list to MODEL_PICKER_CAP entries so the modal stays readable;
 *  the user can always fall back to `/model <id>` or the custom-id option. */
const MODEL_PICKER_CAP = 12;

/**
 * Interactive wizard for a custom gateway using either the OpenAI Chat
 * Completions scheme (Bearer + /chat/completions) or the Anthropic Messages
 * scheme (x-api-key + /messages). Collects base URL, API key, then model.
 */
async function setupCustomScheme(
  scheme: 'openai' | 'anthropic',
  dispatch: React.Dispatch<Action>,
  applyProvider: ApplyProvider,
  promptSecret: (req: Omit<SecretInputRequest, 'resolve' | 'reject'>) => Promise<string>,
  config: ConfigView,
): Promise<void> {
  const backend: Backend = scheme === 'anthropic' ? 'anthropic' : 'openai-compat';
  const defaultBase = scheme === 'anthropic' ? ANTHROPIC_DEFAULT_BASE_URL : OPENAI_DEFAULT_BASE_URL;
  const schemeLabel = scheme === 'anthropic' ? 'Anthropic Messages' : 'OpenAI Chat Completions';
  try {
    const baseURL =
      (
        await promptSecret({
          header: `${schemeLabel}`,
          question: 'Enter the API base URL',
          subtitle: 'Include /v1 if the gateway requires it',
          placeholder: defaultBase,
          footer: 'type URL · Enter confirm · Esc cancel',
        })
      ).trim() ||
      config.baseURL ||
      defaultBase;
    if (!baseURL) {
      dispatch({
        type: 'append',
        entry: { kind: 'error', text: 'base URL cannot be empty.' },
      });
      return;
    }
    const apiKey = (
      await promptSecret({
        header: `${schemeLabel} API`,
        question: 'Enter your API key',
        subtitle:
          scheme === 'anthropic' ? 'Sent as x-api-key header' : 'Sent as Authorization: Bearer',
        placeholder: scheme === 'anthropic' ? 'sk-ant-…' : 'sk-…',
      })
    ).trim();
    if (!apiKey) {
      dispatch({
        type: 'append',
        entry: { kind: 'error', text: 'API key cannot be empty.' },
      });
      return;
    }
    await fetchAndPickModel(backend, baseURL, apiKey, dispatch, applyProvider, {
      customModels: config.customModels,
      promptSecret,
      successText: (picked) =>
        `provider set to custom ${schemeLabel} · ${redact(baseURL)} · model ${picked}`,
    });
  } catch {
    dispatch({
      type: 'append',
      entry: { kind: 'system', text: `custom ${schemeLabel} setup cancelled.` },
    });
  }
}

async function fetchAndPickModel(
  backend: Backend,
  baseURL: string,
  apiKey: string,
  dispatch: React.Dispatch<Action>,
  applyProvider: ApplyProvider,
  opts?: {
    currentModel?: string;
    customModels?: string[];
    promptSecret?: (req: Omit<SecretInputRequest, 'resolve' | 'reject'>) => Promise<string>;
    successText?: (picked: string) => string;
  },
): Promise<void> {
  const generation = ++modelLoadGeneration;
  dispatch({
    type: 'set-ask',
    req: {
      question: {
        header: 'Models',
        question: `Fetching models · ${backendLabel(backend)}`,
        subtitle: 'The provider is responding…',
        footer: 'Esc cancel',
        options: [{ label: 'Loading model catalog…', disabled: true }],
      },
      resolve: () => undefined,
      reject: () => {
        modelLoadGeneration += 1;
        dispatch({ type: 'set-ask', req: null });
      },
    },
  });
  let models: string[] = [];
  try {
    models = await listModels(backend, baseURL, apiKey);
  } catch (err) {
    if (generation !== modelLoadGeneration) return;
    dispatch({
      type: 'append',
      entry: {
        kind: 'system',
        text: `${backend} list-models failed: ${redact((err as Error).message)} — you can still enter a custom model id.`,
      },
    });
  }
  if (generation !== modelLoadGeneration) return;
  const currentModel = opts?.currentModel;
  const remembered = opts?.customModels ?? [];
  // Prefer: current → remembered customs → live catalog (deduped).
  const merged: string[] = [];
  const seen = new Set<string>();
  for (const m of [...(currentModel ? [currentModel] : []), ...remembered, ...models]) {
    if (!m || seen.has(m)) continue;
    seen.add(m);
    merged.push(m);
  }
  const shown = merged.slice(0, MODEL_PICKER_CAP);
  const overflow = merged.length - shown.length;
  const options = [
    ...shown.map((m) => {
      const desc = modelDescription(backend, m, currentModel, remembered);
      const isCurrent = currentModel === m;
      return {
        group: 'Models',
        label: withCurrent(m, isCurrent),
        badge: isCurrent ? 'Active' : remembered.includes(m) ? 'Custom' : undefined,
        description: desc && !isCurrent ? desc : undefined,
      };
    }),
    {
      group: 'Custom',
      label: CUSTOM_MODEL_OPTION,
      badge: 'Custom',
      description: 'fine-tune · dated snapshot · proxy rename',
    },
  ];
  if (shown.length === 0 && !opts?.promptSecret) {
    dispatch({
      type: 'append',
      entry: {
        kind: 'error',
        text: `${backendLabel(backend)} has no models and custom entry is unavailable — use /model <id>.`,
      },
    });
    return;
  }
  const req: AskRequest = {
    question: {
      header: 'Model',
      question: `Select a model · ${backendLabel(backend)}`,
      subtitle:
        overflow > 0
          ? `Showing ${shown.length} of ${merged.length} · type /model <id> for unlisted`
          : merged.length === 0
            ? 'No catalog models — enter a custom id'
            : `${merged.length} available`,
      footer: '↑↓ navigate · Enter select · Esc cancel',
      options,
    },
    resolve: (picked) => {
      dispatch({ type: 'set-ask', req: null });
      const modelId = picked.replace(/\s*·\s*current\s*$/i, '').trim();
      if (modelId === CUSTOM_MODEL_OPTION || modelId.startsWith('✦')) {
        if (!opts?.promptSecret) {
          dispatch({
            type: 'append',
            entry: {
              kind: 'error',
              text: 'custom model entry unavailable — use /model <id> instead.',
            },
          });
          return;
        }
        void promptCustomModelId(opts.promptSecret, dispatch).then((id) => {
          if (!id) return;
          return applyProvider({ backend, model: id, baseURL, apiKey })
            .then(() =>
              dispatch({
                type: 'append',
                entry: {
                  kind: 'system',
                  text:
                    opts.successText?.(id) ?? `provider set to ${backend} · model ${id} (custom)`,
                },
              }),
            )
            .catch((err: unknown) =>
              dispatch({
                type: 'append',
                entry: {
                  kind: 'error',
                  text: `provider switch failed: ${(err as Error).message}`,
                },
              }),
            );
        });
        return;
      }
      void applyProvider({ backend, model: modelId, baseURL, apiKey })
        .then(() =>
          dispatch({
            type: 'append',
            entry: {
              kind: 'system',
              text: opts?.successText?.(modelId) ?? `provider set to ${backend} · model ${modelId}`,
            },
          }),
        )
        .catch((err: unknown) =>
          dispatch({
            type: 'append',
            entry: { kind: 'error', text: `provider switch failed: ${(err as Error).message}` },
          }),
        );
    },
    reject: () => dispatch({ type: 'set-ask', req: null }),
  };
  dispatch({ type: 'set-ask', req });
}

/** Second-level picker for OpenCode-aligned OpenAI-scheme providers. */
function openOpenCodeProviderPicker(
  dispatch: React.Dispatch<Action>,
  readConfig: () => ConfigView,
  applyProvider: ApplyProvider,
  promptSecret: (req: Omit<SecretInputRequest, 'resolve' | 'reject'>) => Promise<string>,
): void {
  const cur = readConfig();
  const req: AskRequest = {
    question: {
      header: 'Provider catalog',
      question: 'OpenCode-compatible providers',
      subtitle: 'OpenAI Chat Completions scheme · Bearer auth',
      footer: '↑↓ navigate · Enter select · Esc cancel',
      options: OPENAI_SCHEME_PROVIDERS.map((p) => ({
        group: 'OpenCode catalog',
        label: withCurrent(p.name, cur.backend === p.id),
        badge: 'Cloud',
        description: p.description.replace(/^remote — /i, ''),
      })),
    },
    resolve: (picked) => {
      dispatch({ type: 'set-ask', req: null });
      const name = picked.replace(/\s*·\s*current\s*$/i, '').trim();
      const preset = OPENAI_SCHEME_PROVIDERS.find(
        (p) => name === p.name || name.startsWith(`${p.name} `) || name.startsWith(p.name),
      );
      if (!preset) {
        dispatch({
          type: 'append',
          entry: { kind: 'error', text: `unknown provider: ${picked}` },
        });
        return;
      }
      startPresetProvider(preset, dispatch, readConfig, applyProvider, promptSecret);
    },
    reject: () => dispatch({ type: 'set-ask', req: null }),
  };
  dispatch({ type: 'set-ask', req });
}

function startPresetProvider(
  preset: ProviderDef,
  dispatch: React.Dispatch<Action>,
  readConfig: () => ConfigView,
  applyProvider: ApplyProvider,
  promptSecret: (req: Omit<SecretInputRequest, 'resolve' | 'reject'>) => Promise<string>,
): void {
  const config = readConfig();
  const backend = preset.id as Backend;
  if (config.backend === backend && config.apiKey) {
    void fetchAndPickModel(
      backend,
      config.baseURL || preset.baseURL,
      config.apiKey,
      dispatch,
      applyProvider,
      {
        customModels: config.customModels,
        promptSecret,
        successText: (m) => `provider set to ${preset.name} · model ${m}`,
      },
    );
    return;
  }
  void promptSecret({
    header: `${preset.name} API`,
    question: 'Enter your API key',
    subtitle: `Env  ${preset.envKeys.join(' / ')}`,
    placeholder: 'sk-…',
  })
    .then((apiKey) => {
      if (!apiKey) {
        dispatch({
          type: 'append',
          entry: { kind: 'error', text: `${preset.name} API key cannot be empty.` },
        });
        return;
      }
      void fetchAndPickModel(backend, preset.baseURL, apiKey, dispatch, applyProvider, {
        customModels: config.customModels,
        promptSecret,
        successText: (m) => `provider set to ${preset.name} · model ${m}`,
      });
    })
    .catch(() => {
      dispatch({
        type: 'append',
        entry: { kind: 'system', text: `${preset.name} setup cancelled.` },
      });
    });
}

/** Default base URL when switching providers with a key already on hand. */
function resolveProviderBaseURL(
  backend: Backend,
  config: { backend: Backend; baseURL: string },
): string {
  if (backend === 'openai-compat') return config.baseURL;
  if (backend === 'ollama' || backend === '') {
    return config.backend === 'ollama' || config.backend === ''
      ? config.baseURL || 'http://localhost:11434'
      : 'http://localhost:11434';
  }
  if (backend === 'lmstudio') {
    return config.backend === 'lmstudio'
      ? config.baseURL || 'http://localhost:1234/v1'
      : 'http://localhost:1234/v1';
  }
  const preset = getOpenAISchemeProvider(backend);
  if (preset) {
    return config.backend === backend ? config.baseURL || preset.baseURL : preset.baseURL;
  }
  const defaults: Partial<Record<Backend, string>> = {
    openai: OPENAI_DEFAULT_BASE_URL,
    kimi: KIMI_DEFAULT_BASE_URL,
    groq: GROQ_DEFAULT_BASE_URL,
    gemini: GEMINI_DEFAULT_BASE_URL,
    openrouter: OPENROUTER_DEFAULT_BASE_URL,
    deepseek: DEEPSEEK_DEFAULT_BASE_URL,
    anthropic: ANTHROPIC_DEFAULT_BASE_URL,
    naraya: NARAYA_DEFAULT_BASE_URL,
    dahl: DAHL_DEFAULT_BASE_URL,
  };
  const def = defaults[backend] ?? '';
  return config.backend === backend ? config.baseURL || def : def;
}

function modelDescription(
  backend: Backend,
  model: string,
  currentModel: string | undefined,
  customModels: string[] = [],
): string | undefined {
  const parts: string[] = [];
  if (currentModel && model === currentModel) parts.push('current / used before');
  if (customModels.includes(model) && model !== currentModel) parts.push('custom / remembered');
  if (backend === 'openai' && OPENAI_RECOMMENDED_MODELS.includes(model)) parts.push('OpenAI');
  if (backend === 'kimi' && KIMI_MODELS.includes(model)) parts.push('Kimi/Moonshot');
  if (backend === 'groq' && GROQ_MODELS.includes(model)) parts.push('Groq');
  if (backend === 'openrouter' && OPENROUTER_RECOMMENDED_MODELS.includes(model)) {
    parts.push('OpenRouter router');
  }
  if (backend === 'deepseek' && DEEPSEEK_MODELS.includes(model)) parts.push('DeepSeek');
  if (backend === 'naraya' && NARAYA_MODELS.includes(model)) parts.push('Naraya');
  if (backend === 'dahl' && DAHL_MODELS.includes(model)) parts.push('Dahl');
  if (backend === 'gemini') {
    if (GEMINI_CHEAP_MODELS.includes(model)) parts.push('cheap cost');
    else if (GEMINI_RECOMMENDED_MODELS.includes(model)) parts.push('best fit');
  }
  if (backend === 'anthropic' && ANTHROPIC_RECOMMENDED_MODELS.includes(model)) parts.push('Claude');
  if (backend === 'openai-compat') parts.push('OpenAI scheme');
  return parts.length > 0 ? parts.join(' · ') : undefined;
}

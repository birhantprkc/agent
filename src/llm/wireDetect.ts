// Detect whether a base_url speaks native Ollama (/api/*) or OpenAI-compat
// (/v1/*). RunPod / reverse proxies often expose only one surface; mislabeling
// the backend as "ollama" then yields empty 404s on /api/chat.

export type WireKind = 'ollama' | 'openai-compat' | 'unknown';

export interface WireProbeResult {
  kind: WireKind;
  /** Human-readable note for logs / notices. */
  detail: string;
}

/**
 * Probe a base URL. Prefer native Ollama when both work (local default).
 * Timeout is short — this runs at startup / provider switch.
 */
export async function detectWireKind(
  baseURL: string,
  opts: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<WireProbeResult> {
  const base = (baseURL || '').replace(/\/+$/, '');
  if (!base) {
    return { kind: 'unknown', detail: 'empty base_url' };
  }

  const timeoutMs = opts.timeoutMs ?? 4000;
  const [ollama, openai] = await Promise.all([
    probeOk(`${base}/api/tags`, opts.signal, timeoutMs),
    probeOk(`${base}/v1/models`, opts.signal, timeoutMs),
  ]);

  if (ollama && openai) {
    return {
      kind: 'ollama',
      detail: 'both /api/tags and /v1/models respond — using native ollama',
    };
  }
  if (ollama) {
    return { kind: 'ollama', detail: '/api/tags ok' };
  }
  if (openai) {
    return {
      kind: 'openai-compat',
      detail: '/v1/models ok but /api/tags failed — use openai-compat, not ollama',
    };
  }
  return {
    kind: 'unknown',
    detail: 'neither /api/tags nor /v1/models responded OK',
  };
}

/**
 * When config says ollama but the endpoint is OpenAI-only, return the
 * corrected backend id. Otherwise return null (no change).
 */
export async function suggestBackendForOllamaUrl(
  baseURL: string,
  signal?: AbortSignal,
): Promise<'openai-compat' | null> {
  const probe = await detectWireKind(baseURL, { signal });
  return probe.kind === 'openai-compat' ? 'openai-compat' : null;
}

async function probeOk(
  url: string,
  outer: AbortSignal | undefined,
  timeoutMs: number,
): Promise<boolean> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  const onOuter = () => ctl.abort();
  outer?.addEventListener('abort', onOuter, { once: true });
  try {
    const resp = await fetch(url, { method: 'GET', signal: ctl.signal });
    return resp.status >= 200 && resp.status < 300;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
    outer?.removeEventListener('abort', onOuter);
  }
}

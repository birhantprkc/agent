// Shared HTTP plumbing for the HTTP-backed memory providers (mem0, honcho,
// hindsight, retaindb, supermemory, openviking) — every one of them needs
// the same "POST JSON, bounded timeout, never throw" shape, so unlike the
// per-file duplication in src/llm/*.ts (each hand-rolled client differs
// enough in auth/streaming/retry to justify its own copy), these five+
// providers are close enough to warrant one shared helper.

const DEFAULT_TIMEOUT_MS = 5000;

/** Build a per-request abort signal bounded by `ms`, paired with a `dispose`
 *  that clears the timer. Never uses AbortSignal.timeout() directly — its
 *  pending timer stays alive (leaking) until it fires even after the
 *  request settles, and these providers get called on every turn. */
function withTimeout(ms: number): { signal: AbortSignal; dispose: () => void } {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  return { signal: ctl.signal, dispose: () => clearTimeout(timer) };
}

export interface HttpJsonResult {
  ok: boolean;
  status: number;
  json: unknown;
}

/**
 * POST `body` as JSON to `url` and parse the JSON response. Returns null on
 * ANY failure (network error, timeout, non-JSON body) instead of throwing —
 * every memory provider treats its backing service as unreliable by design,
 * so a down/misconfigured service degrades to "no recall this turn" rather
 * than breaking the agent loop.
 */
export async function postJSON(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<HttpJsonResult | null> {
  const { signal, dispose } = withTimeout(timeoutMs);
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal,
    });
    const raw = await resp.text();
    let json: unknown = null;
    if (raw) {
      try {
        json = JSON.parse(raw);
      } catch {
        return null;
      }
    }
    return { ok: resp.ok, status: resp.status, json };
  } catch {
    return null;
  } finally {
    dispose();
  }
}

/** GET `url` and parse the JSON response. Same never-throw contract as postJSON. */
export async function getJSON(
  url: string,
  headers: Record<string, string>,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<HttpJsonResult | null> {
  const { signal, dispose } = withTimeout(timeoutMs);
  try {
    const resp = await fetch(url, { method: 'GET', headers, signal });
    const raw = await resp.text();
    let json: unknown = null;
    if (raw) {
      try {
        json = JSON.parse(raw);
      } catch {
        return null;
      }
    }
    return { ok: resp.ok, status: resp.status, json };
  } catch {
    return null;
  } finally {
    dispose();
  }
}

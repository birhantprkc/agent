// Backend error classification. The UI cares about three categories:
// "no model loaded" (lmstudio's typical first-launch state), "model not
// found" (ollama pull missing), and "backend unreachable" (daemon down).
// Anything else is just a generic BackendError so the raw upstream message
// still reaches the log file.
//
// The classifier pattern set is the source of truth for these categories;
// keep it in sync with the backend error shapes.

export type ErrorCategory =
  | 'model-not-loaded'
  | 'model-not-found'
  | 'backend-down'
  /** HTTP 404 with no model-not-found body — wrong base_url, dead proxy, bad path. */
  | 'endpoint-not-found'
  | 'unknown';

export class BackendError extends Error {
  readonly backend: string;
  readonly category: ErrorCategory;
  readonly statusCode: number;
  readonly detail: string;
  /** Server-advised wait before retrying (from a Retry-After header), in ms. */
  retryAfterMs?: number;

  constructor(backend: string, category: ErrorCategory, statusCode: number, detail: string) {
    const msg =
      statusCode !== 0 ? `${backend} error ${statusCode}: ${detail}` : `${backend}: ${detail}`;
    super(msg);
    this.name = 'BackendError';
    this.backend = backend;
    this.category = category;
    this.statusCode = statusCode;
    this.detail = detail;
  }
}

/**
 * True for errors worth retrying with backoff: rate limits (429), request
 * timeouts (408), and transient upstream failures (502/503/504), plus a
 * `backend-down` transport error (the daemon may be mid-restart). A plain 500
 * is treated as deterministic and NOT retried, since it usually reflects a bad
 * request rather than a blip.
 */
export function isTransient(err: unknown): boolean {
  if (!(err instanceof BackendError)) return false;
  if (err.category === 'backend-down') return true;
  // 529 is Anthropic's documented "server temporarily overloaded" status —
  // one of its most common transient failures under load — and was falling
  // through to 'unknown'/not-retried, surfacing immediately instead of
  // backing off like every other transient status here.
  return err.statusCode === 429 || [408, 502, 503, 504, 529].includes(err.statusCode);
}

/**
 * Parse a Retry-After header (delta-seconds or an HTTP-date) into ms relative to
 * `now`. Returns undefined when absent/unparseable so the caller falls back to
 * its own backoff schedule. `now` is injectable for deterministic tests.
 */
export function parseRetryAfter(
  header: string | null | undefined,
  now = Date.now(),
): number | undefined {
  if (!header) return undefined;
  const trimmed = header.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const when = Date.parse(trimmed);
  if (Number.isNaN(when)) return undefined;
  return Math.max(0, when - now);
}

/**
 * Classify a transport or non-2xx response into a BackendError. Pass
 * `transportErr` (from fetch/undici) OR `statusCode` + `body` (from a
 * non-2xx response), not both — pass undefined for the unused half.
 */
export function classifyBackend(
  backend: string,
  transportErr: unknown,
  statusCode: number,
  body: string | undefined,
): BackendError {
  if (transportErr !== undefined && transportErr !== null) {
    const msg = transportErr instanceof Error ? transportErr.message : String(transportErr);
    const lower = msg.toLowerCase();
    if (
      lower.includes('econnrefused') ||
      lower.includes('connection refused') ||
      lower.includes('enotfound') ||
      lower.includes('no such host') ||
      lower.includes('etimedout') ||
      lower.includes('i/o timeout') ||
      lower.includes('network is unreachable') ||
      lower.includes('socket hang up') ||
      lower.includes('fetch failed')
    ) {
      return new BackendError(backend, 'backend-down', 0, msg);
    }
    return new BackendError(backend, 'unknown', 0, msg);
  }

  // Extract a human message from whichever error envelope the backend used.
  let msg = (body ?? '').trim();
  if (body) {
    try {
      const parsed = JSON.parse(body) as {
        error?: string | { message?: string };
      };
      if (typeof parsed.error === 'string' && parsed.error) {
        msg = parsed.error;
      } else if (parsed.error && typeof parsed.error === 'object' && parsed.error.message) {
        msg = parsed.error.message;
      }
    } catch {
      // Not JSON — keep raw body as msg.
    }
  }

  const lower = msg.toLowerCase();
  // Rate-limit phrasing in the body. Some proxies (OpenRouter, ...) surface a
  // transient rate limit inside an HTTP 200, where `statusCode` doesn't signal
  // it. Map it to 429 so isTransient treats it as retryable; real error
  // statuses keep their own code (already transient when they should be).
  if (
    lower.includes('rate limit') ||
    lower.includes('rate_limit') ||
    lower.includes('too many requests') ||
    lower.includes('quota exceeded')
  ) {
    return new BackendError(backend, 'unknown', statusCode < 400 ? 429 : statusCode, msg);
  }
  if (
    lower.includes('no models loaded') ||
    lower.includes('no model loaded') ||
    lower.includes('model not loaded') ||
    lower.includes('please load a model')
  ) {
    return new BackendError(backend, 'model-not-loaded', statusCode, msg);
  }
  if (
    lower.includes('try pulling it first') ||
    lower.includes('model not found') ||
    lower.includes('unknown model') ||
    (lower.includes('model') && lower.includes('not found')) ||
    // OpenAI-style: "The model `x` does not exist"
    (lower.includes('model') && lower.includes('does not exist'))
  ) {
    return new BackendError(backend, 'model-not-found', statusCode, msg);
  }
  // Bare / empty 404s are almost always a bad base_url or dead reverse-proxy
  // (RunPod tunnel expired, wrong path). Do NOT call these "model not found"
  // — that sends people to `ollama pull` when the daemon was never reached.
  if (statusCode === 404) {
    const detail = msg || 'empty 404 response — base_url may be wrong, or the proxy/pod is down';
    return new BackendError(backend, 'endpoint-not-found', 404, detail);
  }
  // Auth failures — keep category unknown but preserve a clear detail.
  if (statusCode === 401 || statusCode === 403) {
    return new BackendError(backend, 'unknown', statusCode, msg || 'unauthorized');
  }
  return new BackendError(backend, 'unknown', statusCode, msg);
}

/**
 * Multi-line, actionable copy for the TUI transcript.
 *
 * Raw BackendError.message looks like `ollama error 404: model x not found`.
 * Operators need the category, a short cause, and a concrete fix — not the
 * wire string alone.
 */
export function formatUserError(err: unknown): string {
  const be = asBackendError(err);
  if (be) return formatBackendError(be);

  const raw = err instanceof Error ? err.message : String(err);
  // Recover structured shape from a re-wrapped BackendError.message.
  const parsed = parseBackendErrorMessage(raw);
  if (parsed) return formatBackendError(parsed);

  return raw.trim() || 'unknown error';
}

function formatBackendError(err: BackendError): string {
  const backend = displayBackend(err.backend);
  const detail = cleanDetail(err.detail);

  switch (err.category) {
    case 'model-not-found':
      return [
        `Model not found on ${backend}`,
        detail ? detail : 'The configured model id is missing or not installed.',
        fixLine(backend, 'model-not-found'),
      ].join('\n');
    case 'model-not-loaded':
      return [
        `No model loaded on ${backend}`,
        detail || 'Load a model in the backend UI, then retry.',
        fixLine(backend, 'model-not-loaded'),
      ].join('\n');
    case 'backend-down':
      return [
        `Can't reach ${backend}`,
        detail || 'Connection failed.',
        fixLine(backend, 'backend-down'),
      ].join('\n');
    case 'endpoint-not-found':
      return [
        `Endpoint not found on ${backend} (404)`,
        detail || 'The server responded 404 with no model-not-found body.',
        fixLine(backend, 'endpoint-not-found'),
      ].join('\n');
    default:
      return formatUnknown(err, backend, detail);
  }
}

function formatUnknown(err: BackendError, backend: string, detail: string): string {
  const code = err.statusCode;
  if (code === 401 || code === 403) {
    return [
      `Auth failed on ${backend}${code ? ` (${code})` : ''}`,
      detail || 'API key missing, invalid, or not authorized for this model.',
      '→ /provider to set or re-test your API key',
    ].join('\n');
  }
  if (code === 429) {
    return [
      `Rate limited by ${backend}`,
      detail || 'Too many requests — wait and retry.',
      '→ wait a moment, or switch model/provider with /model · /provider',
    ].join('\n');
  }
  if (code === 408 || /timeout/i.test(detail)) {
    return [
      `Request timed out on ${backend}`,
      detail || 'The model took too long to respond.',
      '→ retry, lower context, or try a faster model via /model',
    ].join('\n');
  }
  if (code >= 500) {
    return [
      `${backend} server error${code ? ` (${code})` : ''}`,
      detail || 'Upstream failure.',
      '→ retry shortly · check provider status · /provider to switch',
    ].join('\n');
  }
  if (code > 0) {
    return [
      `${backend} error ${code}`,
      detail || 'Request failed.',
      '→ /model · /provider · /help',
    ].join('\n');
  }
  return detail ? `${backend}: ${detail}` : `${backend}: unknown error`;
}

function fixLine(backend: string, category: ErrorCategory): string {
  const b = backend.toLowerCase();
  if (category === 'model-not-found') {
    if (b.includes('ollama')) {
      return '→ ollama pull <model>  ·  /model to switch  ·  /provider';
    }
    return '→ /model list or enter a valid id  ·  /provider to switch backend';
  }
  if (category === 'model-not-loaded') {
    return '→ load a model in the backend UI  ·  /model after it is ready';
  }
  if (category === 'endpoint-not-found') {
    return '→ fix base_url (pod/proxy up?)  ·  /provider  ·  curl $base_url/api/tags';
  }
  // backend-down
  if (b.includes('ollama')) {
    return '→ start ollama (ollama serve)  ·  check base_url  ·  /provider';
  }
  if (b.includes('lmstudio') || b.includes('lm-studio')) {
    return '→ start LM Studio local server  ·  /provider';
  }
  return '→ check the endpoint is up  ·  /provider to reconfigure';
}

function displayBackend(backend: string): string {
  const t = backend.trim();
  if (!t) return 'backend';
  // openai-compat → OpenAI-compat for readability
  if (t === 'openai-compat') return 'OpenAI-compat';
  if (t === 'lmstudio') return 'LM Studio';
  return t;
}

/** Strip redundant "error: " prefixes and collapse whitespace. */
function cleanDetail(detail: string): string {
  return detail
    .replace(/^error:\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Best-effort recover BackendError fields from `err.message`. */
function parseBackendErrorMessage(message: string): BackendError | null {
  const m = message.match(/^([\w.-]+)\s+error\s+(\d+):\s*(.*)$/i);
  if (m) {
    const backend = m[1] ?? 'backend';
    const status = Number(m[2]);
    const detail = (m[3] ?? '').trim();
    return classifyBackend(backend, null, status, detail || undefined);
  }
  const m2 = message.match(/^([\w.-]+):\s*(.*)$/i);
  if (m2 && /econnrefused|enotfound|fetch failed|socket hang up/i.test(m2[2] ?? '')) {
    return new BackendError(m2[1] ?? 'backend', 'backend-down', 0, m2[2] ?? '');
  }
  return null;
}

function asBackendError(err: unknown): BackendError | null {
  if (err instanceof BackendError) return err;
  return null;
}

// OpenViking memory provider — https://github.com/volcengine/OpenViking
// Self-hosted only: run `pip install openviking && openviking-server`,
// default server at http://127.0.0.1:1933. POST /api/v1/search/find to
// recall; POST /api/v1/resources to store.
//
// Confidence note: OpenViking's public docs confirm the search endpoint and
// its {query} request shape, but the store endpoint's documented example
// only shows ingesting a resource BY PATH/URL (`{"path": "https://..."}`),
// not raw inline text. This provider sends `{content: text}` on the
// (unconfirmed) assumption the server accepts inline content as an
// alternative to path — the same REST convention every other provider here
// follows. If OpenViking's real server expects something else, record()
// simply gets a non-2xx back and silently no-ops (never throws), same
// degrade-gracefully contract as every other provider.

import { createHttpMemoryProvider } from './httpProviderBase.js';
import type { MemoryProvider } from './types.js';

interface OpenVikingResultRow {
  text?: string;
  content?: string;
  summary?: string;
}

export interface OpenVikingProviderOptions {
  baseURL?: string;
  apiKey?: string;
}

export function createOpenVikingProvider(opts: OpenVikingProviderOptions = {}): MemoryProvider {
  const baseURL = (
    opts.baseURL ||
    process.env.OPENVIKING_BASE_URL ||
    'http://127.0.0.1:1933'
  ).replace(/\/$/, '');
  const apiKey = opts.apiKey || process.env.OPENVIKING_API_KEY || '';

  return createHttpMemoryProvider({
    name: 'openviking',
    label: 'OpenViking',
    statusDetail: baseURL,
    headers: (): Record<string, string> => (apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    recallRequest: (query, limit) => ({
      url: `${baseURL}/api/v1/search/find`,
      body: { query, limit },
    }),
    recordRequest: async (entry) => ({
      url: `${baseURL}/api/v1/resources`,
      body: { content: `${entry.role}: ${entry.content}` },
    }),
    extractRows,
    rowText: (row) =>
      (row as OpenVikingResultRow).text ??
      (row as OpenVikingResultRow).content ??
      (row as OpenVikingResultRow).summary,
  });
}

function extractRows(json: unknown): OpenVikingResultRow[] {
  if (!json || typeof json !== 'object') return [];
  for (const key of ['results', 'resources', 'items']) {
    const val = (json as Record<string, unknown>)[key];
    if (Array.isArray(val)) return val as OpenVikingResultRow[];
  }
  return [];
}

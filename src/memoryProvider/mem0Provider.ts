// Mem0 self-hosted (OSS) memory provider — https://docs.mem0.ai/open-source/overview
// Unlike the Platform (cloud) API, the self-hosted server has no /v1/ prefix:
// POST /memories to add, POST /search to recall. Auth is a per-user
// X-API-Key header (omitted entirely when AUTH_DISABLED, the server's own
// default for local dev).
//
// Built from Mem0's documented/public API shape, not verified against a live
// account — tested against an in-process mock server matching that shape
// (same rigor this repo already applies to src/llm/*.ts provider clients).

import { createHttpMemoryProvider } from './httpProviderBase.js';
import type { MemoryProvider } from './types.js';

interface Mem0MemoryRow {
  id?: string;
  memory?: string;
  content?: string;
}

export interface Mem0ProviderOptions {
  baseURL?: string;
  apiKey?: string;
  userId?: string;
}

export function createMem0Provider(opts: Mem0ProviderOptions = {}): MemoryProvider {
  const baseURL = (opts.baseURL || process.env.MEM0_HOST || 'http://localhost:8888').replace(
    /\/$/,
    '',
  );
  const apiKey = opts.apiKey || process.env.MEM0_API_KEY || '';
  const userId = opts.userId || 'pentesterflow';

  return createHttpMemoryProvider({
    name: 'mem0',
    label: 'Mem0',
    statusDetail: baseURL,
    headers: (): Record<string, string> => (apiKey ? { 'X-API-Key': apiKey } : {}),
    recallRequest: (query, limit) => ({
      url: `${baseURL}/search`,
      body: { query, user_id: userId, limit },
    }),
    recordRequest: async (entry) => ({
      url: `${baseURL}/memories`,
      body: { messages: [{ role: entry.role, content: entry.content }], user_id: userId },
    }),
    extractRows: extractRows,
    rowText: (row) => (row as Mem0MemoryRow).memory ?? (row as Mem0MemoryRow).content,
  });
}

/** Mem0's search response is either a bare array of rows or `{ results: [...] }`
 *  depending on server version — accept either shape defensively. */
function extractRows(json: unknown): Mem0MemoryRow[] {
  if (Array.isArray(json)) return json as Mem0MemoryRow[];
  if (json && typeof json === 'object' && Array.isArray((json as { results?: unknown }).results)) {
    return (json as { results: Mem0MemoryRow[] }).results;
  }
  return [];
}

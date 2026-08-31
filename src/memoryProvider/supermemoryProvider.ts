// Supermemory memory provider — https://supermemory.ai/docs
// POST /v3/documents to add (dreaming: "instant" for immediate processing,
// not the default "dynamic"/batched — a pentest session needs same-turn
// recall, not eventual consistency), POST /v3/search to recall
// (searchMode: "memories"). containerTag namespaces this agent's memories;
// Bearer auth via SUPERMEMORY_API_KEY.
//
// Built from Supermemory's public docs, not verified against a live
// account — tested against an in-process mock server matching that shape
// (same rigor this repo already applies to src/llm/*.ts provider clients).

import { createHttpMemoryProvider } from './httpProviderBase.js';
import type { MemoryProvider } from './types.js';

interface SupermemoryResultRow {
  memory?: string;
  content?: string;
  text?: string;
}

export interface SupermemoryProviderOptions {
  baseURL?: string;
  apiKey?: string;
  containerTag?: string;
}

export function createSupermemoryProvider(opts: SupermemoryProviderOptions = {}): MemoryProvider {
  const baseURL = (
    opts.baseURL ||
    process.env.SUPERMEMORY_BASE_URL ||
    'https://api.supermemory.ai'
  ).replace(/\/$/, '');
  const apiKey = opts.apiKey || process.env.SUPERMEMORY_API_KEY || '';
  const containerTag = opts.containerTag || 'pentesterflow';

  return createHttpMemoryProvider({
    name: 'supermemory',
    label: 'Supermemory',
    statusDetail: `container: ${containerTag}`,
    headers: (): Record<string, string> => (apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    recallRequest: (query, limit) => ({
      url: `${baseURL}/v3/search`,
      body: { q: query, containerTag, searchMode: 'memories', limit },
    }),
    recordRequest: async (entry) => ({
      url: `${baseURL}/v3/documents`,
      body: { content: `${entry.role}: ${entry.content}`, containerTag, dreaming: 'instant' },
    }),
    extractRows,
    rowText: (row) =>
      (row as SupermemoryResultRow).memory ??
      (row as SupermemoryResultRow).content ??
      (row as SupermemoryResultRow).text,
  });
}

function extractRows(json: unknown): SupermemoryResultRow[] {
  if (json && typeof json === 'object' && Array.isArray((json as { results?: unknown }).results)) {
    return (json as { results: SupermemoryResultRow[] }).results;
  }
  return [];
}

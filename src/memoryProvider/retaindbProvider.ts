// RetainDB memory provider — https://www.retaindb.com/docs/api
// Generic memory write/search API (not the specialized agent-memory
// events/handoffs API): POST /v1/memory to write, POST /v1/memory/search to
// recall, scoped by project/user_id/session_id. Bearer auth.
//
// Built from RetainDB's public docs, not verified against a live account —
// tested against an in-process mock server matching that shape (same rigor
// this repo already applies to src/llm/*.ts provider clients).

import { createHttpMemoryProvider } from './httpProviderBase.js';
import type { MemoryProvider } from './types.js';

interface RetainDBResultRow {
  content?: string;
}

export interface RetainDBProviderOptions {
  baseURL?: string;
  apiKey?: string;
  project?: string;
  userId?: string;
}

export function createRetainDBProvider(opts: RetainDBProviderOptions = {}): MemoryProvider {
  const baseURL = (
    opts.baseURL ||
    process.env.RETAINDB_BASE_URL ||
    'https://api.retaindb.com'
  ).replace(/\/$/, '');
  const apiKey = opts.apiKey || process.env.RETAINDB_API_KEY || '';
  const project = opts.project || 'pentesterflow';
  const userId = opts.userId || 'pentesterflow-agent';

  return createHttpMemoryProvider({
    name: 'retaindb',
    label: 'RetainDB',
    statusDetail: `project: ${project}`,
    headers: (): Record<string, string> => (apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    recallRequest: (query, limit) => ({
      url: `${baseURL}/v1/memory/search`,
      body: { query, project, user_id: userId, limit },
    }),
    recordRequest: async (entry) => ({
      url: `${baseURL}/v1/memory`,
      body: { content: `[${entry.role}] ${entry.content}`, project, user_id: userId },
    }),
    extractRows,
    rowText: (row) => (row as RetainDBResultRow).content,
  });
}

function extractRows(json: unknown): RetainDBResultRow[] {
  if (Array.isArray(json)) return json as RetainDBResultRow[];
  if (json && typeof json === 'object' && Array.isArray((json as { results?: unknown }).results)) {
    return (json as { results: RetainDBResultRow[] }).results;
  }
  return [];
}

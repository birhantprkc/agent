// Honcho memory provider — https://honcho.dev (OpenAPI: honcho.dev/docs/v3/openapi.json)
// Workspace → session → messages model, HTTP Bearer auth. A session is
// created lazily on first record() and its id cached for the provider's
// lifetime; recall() uses workspace-level search (no session needed) so a
// fresh provider can answer a query before it's ever recorded anything.
//
// Built from Honcho's public OpenAPI spec, not verified against a live
// account — tested against an in-process mock server matching that shape
// (same rigor this repo already applies to src/llm/*.ts provider clients).

import { createHttpMemoryProvider } from './httpProviderBase.js';
import { postJSON } from './httpUtil.js';
import type { MemoryProvider } from './types.js';

interface HonchoMessageRow {
  content?: string;
  peer_id?: string;
}

export interface HonchoProviderOptions {
  baseURL?: string;
  apiKey?: string;
  workspaceId?: string;
  peerName?: string;
}

export function createHonchoProvider(opts: HonchoProviderOptions = {}): MemoryProvider {
  const baseURL = (opts.baseURL || process.env.HONCHO_BASE_URL || 'https://api.honcho.dev').replace(
    /\/$/,
    '',
  );
  const apiKey = opts.apiKey || process.env.HONCHO_API_KEY || '';
  const workspaceId = opts.workspaceId || 'pentesterflow';
  const peerName = opts.peerName || 'pentesterflow-agent';
  const headers = (): Record<string, string> =>
    apiKey ? { Authorization: `Bearer ${apiKey}` } : {};

  // Lazily created (once) the session messages get recorded into.
  let sessionId: string | null = null;
  async function ensureSession(): Promise<string | null> {
    if (sessionId) return sessionId;
    const result = await postJSON(
      `${baseURL}/v3/workspaces/${encodeURIComponent(workspaceId)}/sessions`,
      headers(),
      {},
    );
    if (!result || !result.ok) return null;
    const id = extractSessionId(result.json);
    if (id) sessionId = id;
    return sessionId;
  }

  return createHttpMemoryProvider({
    name: 'honcho',
    label: 'Honcho',
    statusDetail: `workspace: ${workspaceId}`,
    headers,
    recallRequest: (query, limit) => ({
      url: `${baseURL}/v3/workspaces/${encodeURIComponent(workspaceId)}/search`,
      body: { query, limit },
    }),
    recordRequest: async (entry) => {
      const sid = await ensureSession();
      if (!sid) return null;
      return {
        url: `${baseURL}/v3/workspaces/${encodeURIComponent(workspaceId)}/sessions/${encodeURIComponent(sid)}/messages`,
        body: {
          messages: [
            { peer_id: entry.role === 'user' ? 'user' : peerName, content: entry.content },
          ],
        },
      };
    },
    extractRows,
    rowText: (row) => (row as HonchoMessageRow).content,
  });
}

function extractRows(json: unknown): HonchoMessageRow[] {
  if (Array.isArray(json)) return json as HonchoMessageRow[];
  if (json && typeof json === 'object') {
    const items = (json as { items?: unknown; results?: unknown }).items;
    if (Array.isArray(items)) return items as HonchoMessageRow[];
    const results = (json as { results?: unknown }).results;
    if (Array.isArray(results)) return results as HonchoMessageRow[];
  }
  return [];
}

function extractSessionId(json: unknown): string | null {
  if (json && typeof json === 'object') {
    const id = (json as { id?: unknown }).id;
    if (typeof id === 'string' && id) return id;
  }
  return null;
}

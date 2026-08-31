// Hindsight memory provider — https://hindsight.vectorize.io (Vectorize)
// Bank-scoped write/recall: POST /v1/default/banks/{bank_id}/memories to
// write, POST /v1/default/banks/{bank_id}/memories/recall to recall. Bearer
// auth via HINDSIGHT_API_KEY.
//
// Built from Hindsight's public API reference docs, not verified against a
// live account — tested against an in-process mock server matching that
// shape (same rigor this repo already applies to src/llm/*.ts clients).

import { createHttpMemoryProvider } from './httpProviderBase.js';
import type { MemoryProvider } from './types.js';

interface HindsightResultRow {
  text?: string;
}

const DEFAULT_RECALL_LIMIT_TOKENS = 4096;

export interface HindsightProviderOptions {
  baseURL?: string;
  apiKey?: string;
  bankId?: string;
}

export function createHindsightProvider(opts: HindsightProviderOptions = {}): MemoryProvider {
  const baseURL = (
    opts.baseURL ||
    process.env.HINDSIGHT_BASE_URL ||
    'https://hindsight.vectorize.io'
  ).replace(/\/$/, '');
  const apiKey = opts.apiKey || process.env.HINDSIGHT_API_KEY || '';
  const bankId = opts.bankId || 'pentesterflow';
  const bankURL = `${baseURL}/v1/default/banks/${encodeURIComponent(bankId)}`;

  return createHttpMemoryProvider({
    name: 'hindsight',
    label: 'Hindsight',
    statusDetail: `bank: ${bankId}`,
    recallLimitDefault: DEFAULT_RECALL_LIMIT_TOKENS,
    headers: (): Record<string, string> => (apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    recallRequest: (query, limitTokens) => ({
      url: `${bankURL}/memories/recall`,
      body: { query, budget: 'mid', max_tokens: limitTokens },
    }),
    recordRequest: async (entry) => ({
      url: `${bankURL}/memories`,
      body: { text: `[${entry.role}] ${entry.content}` },
    }),
    extractRows,
    rowText: (row) => (row as HindsightResultRow).text,
  });
}

function extractRows(json: unknown): HindsightResultRow[] {
  if (json && typeof json === 'object' && Array.isArray((json as { results?: unknown }).results)) {
    return (json as { results: HindsightResultRow[] }).results;
  }
  return [];
}

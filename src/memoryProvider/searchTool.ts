// Shared "explicit search" tool every memory provider exposes. All
// providers use the SAME tool name/schema regardless of backend so the
// system prompt / model behavior stays identical when the active provider
// is swapped — only the underlying recall() implementation differs.

import type { Tool } from '../tools/types.js';
import type { MemoryProvider } from './types.js';

const DEFAULT_RECALL_LIMIT = 5;

export function createMemoryProviderSearchTool(provider: MemoryProvider): Tool {
  return {
    name(): string {
      return 'memory_provider_search';
    },

    description(): string {
      return `Explicitly search the ${provider.name()} memory provider for prior turns from this or past sessions — use this when you need to recall something beyond what's already been auto-injected this turn.`;
    },

    schema(): Record<string, unknown> {
      return {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Free-text search query.' },
          limit: { type: 'number', description: 'Max results (default 5).' },
        },
        required: ['query'],
      };
    },

    requiresPermission(): boolean {
      return false;
    },

    async run(args: Record<string, unknown>): Promise<string> {
      const query = typeof args.query === 'string' ? args.query : '';
      if (!query.trim()) return 'error: query is required';
      const limit = typeof args.limit === 'number' ? args.limit : DEFAULT_RECALL_LIMIT;
      const result = await provider.recall(query, limit);
      return result || 'no matches.';
    },
  };
}

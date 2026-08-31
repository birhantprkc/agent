// Build the right MemoryProvider (or null) from the parsed Config. Mirrors
// llm/factory.ts's newFromConfig — one switch, one place to add a provider.

import type { Config } from '../config/config.js';
import { createHindsightProvider } from './hindsightProvider.js';
import { createHonchoProvider } from './honchoProvider.js';
import { createMem0Provider } from './mem0Provider.js';
import { createOpenVikingProvider } from './openvikingProvider.js';
import { createRetainDBProvider } from './retaindbProvider.js';
import { createSqliteMemoryProvider } from './sqliteProvider.js';
import { createSupermemoryProvider } from './supermemoryProvider.js';
import type { MemoryProvider } from './types.js';

/**
 * Returns null for 'off', for an HTTP provider this never fails to
 * construct (network reachability is a per-call concern, not a startup
 * one), and for 'sqlite' specifically may return null when node:sqlite
 * isn't available on this Node build (caller should warn in that case).
 */
export async function newFromConfig(cfg: Config): Promise<MemoryProvider | null> {
  const pc = cfg.memory_provider_config;
  switch (cfg.memory_provider) {
    case 'off':
      return null;
    case 'sqlite':
      return createSqliteMemoryProvider();
    case 'mem0':
      return createMem0Provider({ baseURL: pc.base_url, apiKey: pc.api_key, userId: pc.user_id });
    case 'honcho':
      return createHonchoProvider({
        baseURL: pc.base_url,
        apiKey: pc.api_key,
        workspaceId: pc.workspace,
        peerName: pc.peer_name,
      });
    case 'hindsight':
      return createHindsightProvider({
        baseURL: pc.base_url,
        apiKey: pc.api_key,
        bankId: pc.bank_id,
      });
    case 'retaindb':
      return createRetainDBProvider({
        baseURL: pc.base_url,
        apiKey: pc.api_key,
        project: pc.project,
        userId: pc.user_id,
      });
    case 'supermemory':
      return createSupermemoryProvider({
        baseURL: pc.base_url,
        apiKey: pc.api_key,
        containerTag: pc.container_tag,
      });
    case 'openviking':
      return createOpenVikingProvider({ baseURL: pc.base_url, apiKey: pc.api_key });
  }
}

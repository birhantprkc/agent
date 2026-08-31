// Browser MCP is opt-in per session via --browser and never persisted.
// Extracted from the CLI so the filtering is unit-testable.

import { createHash } from 'node:crypto';
import type { MCPServerConfig } from '../config/config.js';

/** Names treated as "the Browser MCP server" — stripped unless --browser. */
export const BROWSER_MCP_NAMES: ReadonlySet<string> = new Set(['browser', 'browser-mcp']);

/** The server definition injected for the session when --browser is passed. */
export const BROWSER_MCP_SERVER: MCPServerConfig = {
  name: 'browser',
  command: 'npx',
  args: ['-y', '@browsermcp/mcp@latest'],
};

/**
 * Build the MCP server list to spawn for this session. Any browser-named
 * entry from config is dropped (so an older build's persisted entry can't
 * auto-start); the browser server is appended only when `browserEnabled`.
 * Pure — never mutates its input, never persisted.
 */
export function sessionMcpServers(
  configured: readonly MCPServerConfig[],
  browserEnabled: boolean,
): MCPServerConfig[] {
  const base = configured.filter((s) => !BROWSER_MCP_NAMES.has(s.name));
  return browserEnabled ? [...base, BROWSER_MCP_SERVER] : base;
}

/**
 * Stable fingerprint of the spawn-relevant fields of an MCP server config
 * (command/args/env — everything StdioClientTransport actually executes).
 * Used to detect when a config.json entry has changed since the user last
 * approved it, so a silently-edited command/args re-triggers consent rather
 * than inheriting a stale approval.
 */
export function mcpServerFingerprint(server: MCPServerConfig): string {
  const material = JSON.stringify({
    command: server.command,
    args: server.args,
    env: server.env ?? {},
  });
  return createHash('sha256').update(material).digest('hex');
}

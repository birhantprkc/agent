// Engagement-scope gate for the network tools (http, web_fetch). Mirrors
// privateHost.ts's gatePrivateRequest exactly: same call shape, same
// noSessionCache prompt, thrown on deny. A scope-deny entry hard-blocks
// (no prompt at all) — same idea as the shell tool's static denylist being
// independent of YOLO. An allowlist miss (or no scope configured) prompts
// like any other sensitive request; YOLO auto-approves it like every gate.

import type { Prompter } from '../permission/permission.js';
import type { ScopeStore } from '../target/scope.js';

/**
 * Checks `parsed.hostname` against `scope`. No-op (returns '') when scope is
 * empty or the host is in scope. Throws immediately (no prompt) for an
 * explicit deny match. Otherwise prompts with noSessionCache and throws on
 * deny. Returns the reason string (if any) for non-blocking trace output.
 */
export async function gateOutOfScope(
  p: Prompter,
  parsed: URL,
  signal: AbortSignal,
  toolName: string,
  scope: ScopeStore | undefined,
): Promise<string> {
  if (!scope || scope.isEmpty()) return '';
  const result = await scope.check(parsed.hostname);
  if (result.inScope) return '';

  if (result.reason.startsWith('matches deny rule')) {
    throw new Error(
      `request blocked: ${parsed.hostname} ${result.reason} (engagement scope, hard block)`,
    );
  }

  const decision = await p.ask(
    {
      tool: toolName,
      summary: `${toolName}: out-of-scope host ${parsed.hostname}`,
      detail: `host: ${parsed.hostname}\nreason: ${result.reason}\n\nThis host is not in your configured engagement scope. Approve only if it is intentionally in scope (e.g. you haven't added it to /scope yet).`,
      noSessionCache: true,
    },
    signal,
  );
  if (decision === 'deny') {
    throw new Error(`request to out-of-scope host denied: ${parsed.href}`);
  }
  return result.reason;
}

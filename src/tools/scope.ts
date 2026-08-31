// scope tool. Manages the engagement's in-scope/out-of-scope host list that
// gateOutOfScope (scopeGate.ts) enforces against http/web_fetch. Empty scope
// = no enforcement, so this is opt-in — call action='add' to start
// restricting requests to the engagement.

import type { Prompter } from '../permission/permission.js';
import type { ScopeEntry, ScopeStore } from '../target/scope.js';
import { type Tool, argString } from './types.js';

const ACTIONS = ['add', 'deny', 'remove', 'list', 'check', 'clear'] as const;
type Action = (typeof ACTIONS)[number];

export class ScopeTool implements Tool {
  private readonly store: ScopeStore;

  constructor(store: ScopeStore) {
    this.store = store;
  }

  name(): string {
    return 'scope';
  }

  description(): string {
    return [
      "Manage the engagement's allowed host list. When any entries exist, http/web_fetch requests to hosts outside it require explicit approval; a 'deny' entry hard-blocks with no prompt at all. Empty scope (the default) enforces nothing.",
      '',
      "action='add' pattern='example.com' allows that domain + subdomains. '*.example.com' (wildcard) and '10.0.0.0/8' (CIDR) are also accepted. action='deny' adds a hard-block carve-out (e.g. an in-scope program's own admin panel that's explicitly excluded).",
    ].join('\n');
  }

  schema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: [...ACTIONS],
          description:
            "'add' allows a host pattern; 'deny' hard-blocks one; 'remove' deletes a pattern; 'list' shows current scope; 'check' tests a hostname against current scope; 'clear' wipes scope (enforcement off).",
        },
        pattern: {
          type: 'string',
          description:
            "Host pattern: a domain ('example.com'), wildcard ('*.example.com'), or CIDR ('10.0.0.0/8'). Required for add/deny/remove/check.",
        },
      },
      required: ['action'],
    };
  }

  requiresPermission(): boolean {
    return false;
  }

  /** Live scope rules, straight from the store — used by the dashboard panel. */
  list(): ScopeEntry[] {
    return this.store.list();
  }

  async run(
    args: Record<string, unknown>,
    _signal: AbortSignal,
    _prompter: Prompter,
  ): Promise<string> {
    const action = (argString(args, 'action') || '') as Action;
    if (!ACTIONS.includes(action)) {
      return `error: action must be one of: ${ACTIONS.join(', ')}`;
    }
    const pattern = argString(args, 'pattern');

    switch (action) {
      case 'add':
      case 'deny': {
        if (!pattern) return "error: 'pattern' is required";
        const entry = this.store.add(pattern, action === 'deny' ? 'deny' : 'allow');
        return `${entry.mode === 'deny' ? 'denied' : 'allowed'}: ${entry.pattern} (${entry.kind})`;
      }
      case 'remove': {
        if (!pattern) return "error: 'pattern' is required";
        return this.store.remove(pattern) ? `removed: ${pattern}` : `no such entry: ${pattern}`;
      }
      case 'list': {
        const entries = this.store.list();
        if (entries.length === 0) return 'scope is empty — no enforcement (all requests allowed).';
        return entries.map((e) => `${e.mode}: ${e.pattern} (${e.kind})`).join('\n');
      }
      case 'check': {
        if (!pattern) return "error: 'pattern' is required";
        const result = await this.store.check(pattern);
        return `${pattern}: ${result.inScope ? 'in scope' : 'OUT OF SCOPE'}${result.reason ? ` (${result.reason})` : ''}`;
      }
      case 'clear':
        this.store.clear();
        return 'scope cleared — enforcement is off.';
    }
  }
}

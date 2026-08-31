// todo tool. A live, visible checklist for multi-step engagements — the
// model resends the whole list on every write (Claude Code TodoWrite
// semantics) so status changes are one call, not a diff protocol.
//
// Session-scoped, in-memory only. This is a working scratchpad the model
// uses to keep itself honest about what's next, not evidence — findings and
// coverage already cover the durable record.

import type { TodoItem } from '../agent/events.js';
import type { Prompter } from '../permission/permission.js';
import { type Tool, argString } from './types.js';

const ACTIONS = ['write', 'list'] as const;
type Action = (typeof ACTIONS)[number];
const STATUSES = ['pending', 'in_progress', 'completed'] as const;
type Status = (typeof STATUSES)[number];

let nextID = 1;

export class TodoTool implements Tool {
  private items: TodoItem[] = [];

  name(): string {
    return 'todo';
  }

  description(): string {
    return [
      "Keep a visible, live checklist of the current engagement's plan. Resend the FULL list every time you call action='write' — this replaces the whole list, it does not append.",
      '',
      "Use it for any engagement with more than ~3 distinct steps (recon, per-vuln-class testing, verification, reporting). Mark exactly one item 'in_progress' at a time so what's happening right now is unambiguous; mark items 'completed' as you finish them.",
      '',
      "action='list' reads the current list back without changing it.",
    ].join('\n');
  }

  schema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: [...ACTIONS],
          description: "'write' replaces the whole list; 'list' reads it back unchanged.",
        },
        items: {
          type: 'array',
          description:
            "For action='write': the full list, in order. Each item's id is optional (assigned if omitted) — pass back the ids you were given to keep referring to the same item.",
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              text: { type: 'string' },
              status: { type: 'string', enum: [...STATUSES] },
            },
            required: ['text', 'status'],
          },
        },
      },
      required: ['action'],
    };
  }

  requiresPermission(): boolean {
    return false;
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
    if (action === 'list') return this.render();

    const raw = Array.isArray(args.items) ? (args.items as unknown[]) : null;
    if (!raw) return "error: write requires 'items' (a non-empty array)";
    const parsed: TodoItem[] = [];
    for (const entry of raw) {
      if (typeof entry !== 'object' || entry === null) continue;
      const e = entry as Record<string, unknown>;
      const text = typeof e.text === 'string' ? e.text.trim() : '';
      const status = STATUSES.includes(e.status as Status) ? (e.status as Status) : undefined;
      if (!text || !status) continue;
      const id = typeof e.id === 'string' && e.id ? e.id : String(nextID++);
      parsed.push({ id, text, status });
    }
    if (parsed.length === 0) {
      return 'error: no valid items — each item needs a non-empty text and a valid status';
    }
    const inProgress = parsed.filter((i) => i.status === 'in_progress');
    if (inProgress.length > 1) {
      return `error: at most one item may be 'in_progress' at a time (got ${inProgress.length}) — finish or defer the others first`;
    }
    this.items = parsed;
    return this.render();
  }

  /** Snapshot for the agent to fold into a TodoEvent after a successful write. */
  snapshot(): TodoItem[] {
    return this.items.slice();
  }

  private render(): string {
    if (this.items.length === 0) return 'todo list is empty.';
    return this.items.map((i) => `[${glyph(i.status)}] ${i.text} (${i.id})`).join('\n');
  }
}

function glyph(status: Status): string {
  if (status === 'completed') return 'x';
  if (status === 'in_progress') return '~';
  return ' ';
}

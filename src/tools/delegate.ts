// delegate_task tool. Runs a second, ephemeral agent to completion inline
// for a self-contained sub-task and returns a compressed summary instead of
// the child's full transcript. Synchronous — parent blocks until the child finishes.
//
// Roles (Claude Code Explore-inspired):
//   worker  — default; inherits parent's tools minus delegate_task
//   explore — read-only tool subset (no shell/write/http mutations intent;
//             shell is still removed; http kept for GET-style recon)
//   skill   — same as worker but forces load_skill first (used by skill-fork)
//
// Recursion is blocked structurally: child registry never includes delegate_task.

import type { AgentEvent } from '../agent/events.js';
import type { Prompter } from '../permission/permission.js';
import { type Tool, argString } from './types.js';

export const DELEGATE_MAX_STEPS = 10;

export type DelegateRole = 'worker' | 'explore' | 'skill';

/** Tools disallowed for explore-role delegates (mutating / high-blast). */
export const EXPLORE_DENIED_TOOLS = new Set([
  'shell',
  'bash',
  'bashtool',
  'file_write',
  'filewritetool',
  'file_edit',
  'fileedittool',
  'confirm_finding',
  'delegate_task',
  // Scanners / plugins that change state or hammer the target.
  'plugin',
]);

export function isExploreAllowedTool(name: string): boolean {
  const key = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '');
  if (EXPLORE_DENIED_TOOLS.has(key)) return false;
  // Deny shell aliases that slip through.
  if (key.includes('shell') || key.includes('bash')) return false;
  if (key.includes('filewrite') || key.includes('fileedit')) return false;
  return true;
}

export interface DelegateResult {
  finalText: string;
  toolTally: Record<string, number>;
  stepCount: number;
  role?: DelegateRole;
  error?: string;
}

export function summarizeDelegateEvents(events: AgentEvent[], role?: DelegateRole): DelegateResult {
  let finalText = '';
  const toolTally: Record<string, number> = {};
  let stepCount = 0;
  let error: string | undefined;

  for (const e of events) {
    if (e.type === 'assistant-text') finalText = e.text;
    else if (e.type === 'tool-call') {
      toolTally[e.name] = (toolTally[e.name] ?? 0) + 1;
      stepCount += 1;
    } else if (e.type === 'error') {
      error = e.err.message;
    }
  }
  return { finalText, toolTally, stepCount, role, error };
}

export type DelegateRunner = (
  objective: string,
  skill: string | undefined,
  role: DelegateRole,
  signal: AbortSignal,
  /** Live progress from the child agent (tool steps). */
  onProgress?: (ev: {
    phase: 'start' | 'tool' | 'done';
    tool?: string;
    step?: number;
    detail?: string;
  }) => void,
) => Promise<DelegateResult>;

export class DelegateTool implements Tool {
  private readonly runner: DelegateRunner;

  constructor(runner: DelegateRunner) {
    this.runner = runner;
  }

  name(): string {
    return 'delegate_task';
  }

  description(): string {
    return [
      'Delegate a self-contained sub-task to a fresh, ephemeral agent and get back a compressed summary.',
      '',
      'Roles:',
      '- worker (default): full tools except further delegation — use for bounded act/validate work.',
      '- explore: READ-ONLY tool subset (no shell, no file write/edit, no scanners) — use for mapping, searching, summarizing without side effects.',
      '',
      'The sub-agent runs synchronously with a small step budget; you only see its final answer and a tool-call tally. It cannot delegate further.',
      'Give a specific, bounded objective. Optionally pass `skill` so the sub-agent loads that playbook first.',
    ].join('\n');
  }

  schema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        objective: {
          type: 'string',
          description: 'A specific, bounded sub-task for the delegated agent to complete.',
        },
        skill: {
          type: 'string',
          description: 'Optional: name of a skill the sub-agent should load first.',
        },
        role: {
          type: 'string',
          enum: ['worker', 'explore'],
          description: 'worker = full tools (default); explore = read-only tools only.',
        },
      },
      required: ['objective'],
    };
  }

  requiresPermission(): boolean {
    return false;
  }

  async run(
    args: Record<string, unknown>,
    signal: AbortSignal,
    _prompter: Prompter,
  ): Promise<string> {
    const objective = argString(args, 'objective');
    if (!objective) return "error: 'objective' is required";
    const skill = argString(args, 'skill') || undefined;
    const roleRaw = argString(args, 'role').toLowerCase();
    const role: DelegateRole = roleRaw === 'explore' ? 'explore' : 'worker';

    const result = await this.runner(objective, skill, role, signal);
    const tally = Object.entries(result.toolTally)
      .map(([name, n]) => `${name}×${n}`)
      .join(', ');
    const roleTag = result.role ?? role;
    const header = `[delegated/${roleTag}: ${result.stepCount} tool call(s)${tally ? ` — ${tally}` : ''}]`;
    const body = result.finalText || '(sub-agent produced no final text)';
    const errNote = result.error ? `\n\nnote: sub-agent ended with an error: ${result.error}` : '';
    return `${header}\n\n${body}${errNote}`;
  }
}

export type ChildProgressEv = {
  phase: 'start' | 'tool' | 'done';
  tool?: string;
  step?: number;
  detail?: string;
};

/** Structured notice for a live ↳ progress line (expandable when done). */
export interface ChildProgressNotice {
  type: 'child-progress';
  /** Stable key so start/tool/done update one transcript row. */
  key: string;
  /** Short label: skill name or role ("recon", "explore"). */
  label: string;
  /** Ordered tool names the child has called so far. */
  tools: string[];
  done: boolean;
}

export type NoticePayload = string | ChildProgressNotice;

/** Human label from wireChildProgress detail (`skill:recon` → `recon`). */
export function childProgressLabel(detail: string): string {
  const raw = detail.trim() || 'agent';
  if (raw.startsWith('skill:')) return raw.slice('skill:'.length) || 'skill';
  return raw;
}

/** One-line collapsed summary (no leading ↳ — prefix is applied by the UI). */
export function formatChildProgressSummary(
  label: string,
  tools: readonly string[],
  done: boolean,
): string {
  const n = tools.length;
  if (!done) return n > 0 ? `${label} · ${n} tools…` : `${label}…`;
  return n > 0 ? `${label} · ${n} tools` : `${label} done`;
}

/** Friendly tool name for progress lists (BashTool → shell, etc.). */
export function friendlyProgressToolName(name: string): string {
  const n = name.trim();
  if (!n) return 'tool';
  if (n === 'BashTool' || n === 'bash') return 'shell';
  if (n === 'FileReadTool') return 'file_read';
  if (n === 'FileWriteTool') return 'file_write';
  if (n === 'FileEditTool') return 'file_edit';
  return n;
}

/**
 * Expanded body under a ↳ line (Grok-style tool list):
 *   recon · 4 tools
 *     1. load_skill
 *     2. todo
 *     …
 */
export function formatChildProgressDetail(label: string, tools: readonly string[]): string {
  const summary = formatChildProgressSummary(label, tools, true);
  if (tools.length === 0) return summary;
  const lines = tools.map((t, i) => `  ${i + 1}. ${friendlyProgressToolName(t)}`);
  return [summary, ...lines].join('\n');
}

/** Build a structured progress notice from a wireChildProgress event + tool list. */
export function childProgressNoticeFromEvent(
  ev: ChildProgressEv,
  tools: readonly string[],
): ChildProgressNotice {
  const detail = (ev.detail ?? 'agent').trim() || 'agent';
  return {
    type: 'child-progress',
    key: detail,
    label: childProgressLabel(detail),
    tools: [...tools],
    done: ev.phase === 'done',
  };
}

/** Helper for runners: map child AgentEvents into progress callbacks. */
export function wireChildProgress(
  role: string,
  onProgress: ((ev: ChildProgressEv) => void) | undefined,
): (e: AgentEvent) => void {
  let step = 0;
  onProgress?.({ phase: 'start', detail: role });
  return (e: AgentEvent) => {
    if (e.type === 'tool-call') {
      step += 1;
      onProgress?.({ phase: 'tool', tool: e.name, step, detail: role });
    } else if (e.type === 'done' || e.type === 'error') {
      onProgress?.({ phase: 'done', step, detail: role });
    }
  };
}

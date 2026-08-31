// background_status tool. Companion to the shell tool's `background: true`
// flag — lets the model check on or kill a detached task it started
// earlier. A completion notice also fires on its own (BackgroundTaskManager
// -> noticeHolder), so checking is optional, not required.

import type { BackgroundTask, BackgroundTaskManager } from '../agent/backgroundTasks.js';
import type { Prompter } from '../permission/permission.js';
import { type Tool, argString } from './types.js';

const ACTIONS = ['list', 'get', 'kill'] as const;
type Action = (typeof ACTIONS)[number];

function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return m > 0 ? `${m}m${String(r).padStart(2, '0')}s` : `${r}s`;
}

/** Human-readable one-liner for a background job (also used by /jobs). */
export function formatJobLine(t: BackgroundTask, now = Date.now()): string {
  const end = t.finishedAt ?? now;
  const elapsed = formatElapsed(end - t.startedAt);
  const exit = t.exitCode !== undefined ? ` exit=${t.exitCode}` : '';
  const outBytes = t.stdout.length + t.stderr.length;
  const size = outBytes > 0 ? ` · ${outBytes}B out` : '';
  return `${t.id}  [${t.status}]  ${elapsed}${exit}  ${t.label}${size}`;
}

export function formatJobsList(tasks: BackgroundTask[], now = Date.now()): string {
  if (tasks.length === 0) return 'no background jobs this session.';
  const running = tasks.filter((t) => t.status === 'running');
  const done = tasks.filter((t) => t.status !== 'running');
  const lines = [
    `jobs: ${running.length} running · ${done.length} finished`,
    ...tasks.map((t) => formatJobLine(t, now)),
  ];
  return lines.join('\n');
}

export class BackgroundStatusTool implements Tool {
  private readonly manager: BackgroundTaskManager;

  constructor(manager: BackgroundTaskManager) {
    this.manager = manager;
  }

  name(): string {
    return 'background_status';
  }

  description(): string {
    return "Check on or kill a background shell job started with shell(background=true). action='list' shows every job; action='get' returns status + output tail; action='kill' stops a running one.";
  }

  schema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: [...ACTIONS],
          description: "'list' all jobs; 'get' one job's status + output; 'kill' a running job.",
        },
        id: {
          type: 'string',
          description:
            "Job id (from the shell tool's 'started as background task <id>' response). Required for get/kill.",
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
    if (action === 'list') {
      return formatJobsList(this.manager.list());
    }
    const id = argString(args, 'id');
    if (!id) return "error: 'id' is required";
    if (action === 'kill') {
      return this.manager.kill(id) ? `killed ${id}.` : `${id}: not found or already finished.`;
    }
    const task = this.manager.get(id);
    if (!task) return `${id}: not found.`;
    const now = Date.now();
    const lines = [formatJobLine(task, now), `started: ${new Date(task.startedAt).toISOString()}`];
    if (task.finishedAt) lines.push(`finished: ${new Date(task.finishedAt).toISOString()}`);
    if (task.exitCode !== undefined) lines.push(`exit: ${task.exitCode}`);
    // Tail only — full dumps blow context; operator can re-read if needed.
    if (task.stdout) {
      const tail = task.stdout.length > 4000 ? task.stdout.slice(-4000) : task.stdout;
      lines.push(`stdout${task.stdout.length > 4000 ? ' (tail)' : ''}:\n${tail}`);
    }
    if (task.stderr) {
      const tail = task.stderr.length > 2000 ? task.stderr.slice(-2000) : task.stderr;
      lines.push(`stderr${task.stderr.length > 2000 ? ' (tail)' : ''}:\n${tail}`);
    }
    return lines.join('\n');
  }
}

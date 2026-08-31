// Background task manager for long-running shell commands (large ffuf/nuclei
// sweeps) that would otherwise block the whole agent loop until they exit.
// Spawns via the same primitive shell.ts's runWithCapture uses (detached
// process group, HeadTailBuffer output cap, timeout-kill) — reused directly,
// not duplicated. On completion, calls the registered `notify` callback,
// which cli/index.ts wires to noticeHolder.publish so the TUI shows a
// completion notice the moment it happens, even mid-conversation on
// something unrelated (the concrete "real async + notify" plumbing this
// feature was chosen for over a simpler poll-only design).

import { type ChildProcess, spawn } from 'node:child_process';
import {
  HeadTailBuffer,
  MAX_OUTPUT_BYTES,
  isWindows,
  killProcessGroup,
  signalToInt,
} from '../tools/shell.js';

export type BackgroundStatus = 'running' | 'done' | 'failed' | 'killed' | 'timeout';

export interface BackgroundTask {
  id: string;
  label: string;
  status: BackgroundStatus;
  startedAt: number;
  finishedAt?: number;
  exitCode?: number;
  stdout: string;
  stderr: string;
}

interface RunningHandle {
  pid: number;
  controller: AbortController;
}

// Cap on retained task history — same idea as coverage/store.ts's
// MAX_ENTRIES: a long session that kicks off many background tasks
// shouldn't grow this map without bound. Only finished tasks are evicted
// (oldest-by-finishedAt first); a still-running task is never dropped.
const MAX_TASKS = 200;

export class BackgroundTaskManager {
  private tasks = new Map<string, BackgroundTask>();
  private running = new Map<string, RunningHandle>();
  private nextID = 1;
  private readonly notify?: (text: string) => void;

  constructor(notify?: (text: string) => void) {
    this.notify = notify;
  }

  start(cmd: string, argv: string[], timeoutMs: number, label: string): { id: string } {
    this.evictOldFinished();
    const id = `bg${this.nextID++}`;
    const task: BackgroundTask = {
      id,
      label,
      status: 'running',
      startedAt: Date.now(),
      stdout: '',
      stderr: '',
    };
    this.tasks.set(id, task);

    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killProcessGroup(handle.pid);
      controller.abort();
    }, timeoutMs);
    timer.unref?.();

    let child: ChildProcess;
    try {
      child = spawn(cmd, argv, { detached: !isWindows(), signal: controller.signal });
    } catch (err) {
      clearTimeout(timer);
      task.status = 'failed';
      task.stderr = err instanceof Error ? err.message : String(err);
      task.finishedAt = Date.now();
      this.announce(task);
      return { id };
    }
    const handle: RunningHandle = { pid: child.pid ?? 0, controller };
    this.running.set(id, handle);

    const stdoutBuf = new HeadTailBuffer(MAX_OUTPUT_BYTES);
    const stderrBuf = new HeadTailBuffer(MAX_OUTPUT_BYTES);
    child.stdout?.on('data', (c: Buffer) => stdoutBuf.push(c));
    child.stderr?.on('data', (c: Buffer) => stderrBuf.push(c));

    // An aborted signal (kill()/timeout) can fire 'error' (AbortError) and/or
    // 'close' depending on Node version and how far the process got — settle
    // exactly once so a kill/timeout status set here can't be clobbered by
    // whichever event fires second, and so notify() never double-announces.
    let settled = false;
    const finish = (
      finalStatus: BackgroundStatus | undefined,
      exitCode: number | undefined,
    ): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      this.running.delete(id);
      task.stdout = stdoutBuf.render();
      task.stderr = stderrBuf.render();
      task.finishedAt = Date.now();
      task.exitCode = exitCode;
      // Priority: an explicit kill()/timeout always wins over whatever the
      // signal-derived exit code would otherwise imply.
      task.status =
        task.status === 'killed' ? 'killed' : timedOut ? 'timeout' : (finalStatus ?? 'failed');
      this.announce(task);
    };

    child.on('close', (code, sig) => {
      const exitCode = code ?? (sig ? 128 + signalToInt(sig) : 0);
      finish(exitCode === 0 ? 'done' : 'failed', exitCode);
    });
    child.on('error', (err) => {
      stderrBuf.push(Buffer.from(err.message));
      finish('failed', undefined);
    });

    return { id };
  }

  get(id: string): BackgroundTask | undefined {
    return this.tasks.get(id);
  }

  list(): BackgroundTask[] {
    return Array.from(this.tasks.values());
  }

  /** Returns false if the task doesn't exist or has already finished. */
  kill(id: string): boolean {
    const task = this.tasks.get(id);
    const handle = this.running.get(id);
    if (!task || !handle || task.status !== 'running') return false;
    task.status = 'killed';
    killProcessGroup(handle.pid);
    handle.controller.abort();
    return true;
  }

  /** Drop the oldest-finished tasks once the map exceeds MAX_TASKS. Running
   *  tasks are never evicted — only finished ones count against the cap. */
  private evictOldFinished(): void {
    if (this.tasks.size < MAX_TASKS) return;
    const finished = Array.from(this.tasks.values())
      .filter((t) => t.status !== 'running')
      .sort((a, b) => (a.finishedAt ?? 0) - (b.finishedAt ?? 0));
    for (const t of finished) {
      if (this.tasks.size < MAX_TASKS) break;
      this.tasks.delete(t.id);
    }
  }

  private announce(task: BackgroundTask): void {
    const bytes = task.stdout.length + task.stderr.length;
    const exitPart = task.exitCode !== undefined ? `, exit ${task.exitCode}` : '';
    this.notify?.(
      `ℹ background task ${task.id} (${task.label}) finished: ${task.status}${exitPart}, ${bytes} bytes output`,
    );
  }
}

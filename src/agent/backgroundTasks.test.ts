import { describe, expect, it } from 'vitest';
import { BackgroundTaskManager } from './backgroundTasks.js';

const node = process.execPath;

function waitFor(fn: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      if (fn()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error('waitFor: timed out'));
      setTimeout(check, 10);
    };
    check();
  });
}

describe('BackgroundTaskManager', () => {
  it('starts a task and returns immediately with an id', () => {
    const mgr = new BackgroundTaskManager();
    const { id } = mgr.start(node, ['-e', 'process.exit(0)'], 5000, 'noop');
    expect(id).toBeTruthy();
    expect(mgr.get(id)?.status).toBe('running');
  });

  it('captures stdout/stderr and marks a successful task done', async () => {
    const mgr = new BackgroundTaskManager();
    const { id } = mgr.start(
      node,
      ['-e', 'process.stdout.write("hello"); process.exit(0)'],
      5000,
      'echo hello',
    );
    await waitFor(() => mgr.get(id)?.status !== 'running');
    const task = mgr.get(id);
    expect(task?.status).toBe('done');
    expect(task?.exitCode).toBe(0);
    expect(task?.stdout).toBe('hello');
  });

  it('marks a non-zero exit as failed', async () => {
    const mgr = new BackgroundTaskManager();
    const { id } = mgr.start(node, ['-e', 'process.exit(3)'], 5000, 'fail');
    await waitFor(() => mgr.get(id)?.status !== 'running');
    const task = mgr.get(id);
    expect(task?.status).toBe('failed');
    expect(task?.exitCode).toBe(3);
  });

  it('calls notify() once the task completes', async () => {
    const notified: string[] = [];
    const mgr = new BackgroundTaskManager((text) => notified.push(text));
    const { id } = mgr.start(node, ['-e', 'process.exit(0)'], 5000, 'noop');
    await waitFor(() => mgr.get(id)?.status !== 'running');
    expect(notified).toHaveLength(1);
    expect(notified[0]).toContain(id);
    expect(notified[0]).toContain('done');
  });

  it('list() returns every started task', () => {
    const mgr = new BackgroundTaskManager();
    const a = mgr.start(node, ['-e', 'process.exit(0)'], 5000, 'a');
    const b = mgr.start(node, ['-e', 'process.exit(0)'], 5000, 'b');
    const ids = mgr.list().map((t) => t.id);
    expect(ids).toEqual(expect.arrayContaining([a.id, b.id]));
  });

  it('kill() stops a running task and marks it killed', async () => {
    const mgr = new BackgroundTaskManager();
    const { id } = mgr.start(node, ['-e', 'setTimeout(() => {}, 60000)'], 60000, 'sleep');
    expect(mgr.kill(id)).toBe(true);
    await waitFor(() => mgr.get(id)?.finishedAt !== undefined);
    expect(mgr.get(id)?.status).toBe('killed');
  });

  it('kill() returns false for an unknown or already-finished task', async () => {
    const mgr = new BackgroundTaskManager();
    expect(mgr.kill('bg-nope')).toBe(false);
    const { id } = mgr.start(node, ['-e', 'process.exit(0)'], 5000, 'noop');
    await waitFor(() => mgr.get(id)?.status !== 'running');
    expect(mgr.kill(id)).toBe(false);
  });

  it('times out a task that outlives its budget', async () => {
    const mgr = new BackgroundTaskManager();
    const { id } = mgr.start(node, ['-e', 'setTimeout(() => {}, 60000)'], 150, 'slow');
    await waitFor(() => mgr.get(id)?.status !== 'running', 5000);
    expect(mgr.get(id)?.status).toBe('timeout');
  });
});

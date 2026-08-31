import { describe, expect, it } from 'vitest';
import { BackgroundTaskManager } from '../agent/backgroundTasks.js';
import type { Prompter } from '../permission/permission.js';
import { BackgroundStatusTool } from './backgroundStatus.js';

const node = process.execPath;

const run = (tool: BackgroundStatusTool, args: Record<string, unknown>) =>
  tool.run(args, new AbortController().signal, {} as Prompter);

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

describe('BackgroundStatusTool', () => {
  it('reports no tasks initially', async () => {
    const tool = new BackgroundStatusTool(new BackgroundTaskManager());
    expect(await run(tool, { action: 'list' })).toBe('no background jobs this session.');
  });

  it('lists a running task, then its finished status', async () => {
    const mgr = new BackgroundTaskManager();
    const { id } = mgr.start(
      node,
      ['-e', 'process.stdout.write("x"); process.exit(0)'],
      5000,
      'echo x',
    );
    const tool = new BackgroundStatusTool(mgr);
    const listed = await run(tool, { action: 'list' });
    expect(listed).toContain(id);
    expect(listed).toContain('[running]');
    expect(listed).toContain('echo x');

    await waitFor(() => mgr.get(id)?.status !== 'running');
    const out = await run(tool, { action: 'get', id });
    expect(out).toContain('[done]');
    expect(out).toContain('exit: 0');
    expect(out).toContain('stdout');
    expect(out).toContain('x');
  });

  it('kills a running task via the tool', async () => {
    const mgr = new BackgroundTaskManager();
    const { id } = mgr.start(node, ['-e', 'setTimeout(() => {}, 60000)'], 60000, 'sleep');
    const tool = new BackgroundStatusTool(mgr);
    expect(await run(tool, { action: 'kill', id })).toBe(`killed ${id}.`);
    expect(await run(tool, { action: 'kill', id: 'nope' })).toBe(
      'nope: not found or already finished.',
    );
  });

  it('rejects an unknown action and a missing id', async () => {
    const tool = new BackgroundStatusTool(new BackgroundTaskManager());
    expect(await run(tool, { action: 'nuke' })).toContain('error: action must be one of');
    expect(await run(tool, { action: 'get' })).toContain("'id' is required");
  });

  it('reports an unknown id', async () => {
    const tool = new BackgroundStatusTool(new BackgroundTaskManager());
    expect(await run(tool, { action: 'get', id: 'bg999' })).toBe('bg999: not found.');
  });
});

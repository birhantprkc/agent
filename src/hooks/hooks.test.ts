import { describe, expect, it } from 'vitest';
import type { HookConfig } from '../config/config.js';
import { runNotifyHooks, runToolHooks } from './hooks.js';

const node = process.execPath;

function hook(overrides: Partial<HookConfig> & { command: string; args: string[] }): HookConfig {
  return { event: 'post-tool-call', args: [], ...overrides };
}

describe('runToolHooks', () => {
  it('does not block on a pre-tool-call hook that exits 0', async () => {
    const h = hook({
      event: 'pre-tool-call',
      command: node,
      args: ['-e', 'process.exit(0)'],
    });
    const result = await runToolHooks(
      'pre-tool-call',
      'shell',
      { EVENT: 'pre-tool-call', TOOL: 'shell', ARGS: '{}' },
      [h],
      new AbortController().signal,
    );
    expect(result.blocked).toBe(false);
  });

  it('blocks the call when a pre-tool-call hook exits non-zero, surfacing stderr', async () => {
    const h = hook({
      event: 'pre-tool-call',
      command: node,
      args: ['-e', 'process.stderr.write("nope"); process.exit(1)'],
    });
    const result = await runToolHooks(
      'pre-tool-call',
      'shell',
      { EVENT: 'pre-tool-call', TOOL: 'shell', ARGS: '{}' },
      [h],
      new AbortController().signal,
    );
    expect(result.blocked).toBe(true);
    expect(result.message).toBe('nope');
  });

  it('does not block on a post-tool-call hook failure (fire-and-forget by design)', async () => {
    const h = hook({
      event: 'post-tool-call',
      command: node,
      args: ['-e', 'process.exit(1)'],
    });
    const result = await runToolHooks(
      'post-tool-call',
      'shell',
      { EVENT: 'post-tool-call', TOOL: 'shell', ARGS: '{}' },
      [h],
      new AbortController().signal,
    );
    expect(result.blocked).toBe(false);
  });

  it('skips a hook whose matcher does not match the tool name', async () => {
    const h = hook({
      event: 'pre-tool-call',
      matcher: 'http',
      command: node,
      args: ['-e', 'process.exit(1)'],
    });
    const result = await runToolHooks(
      'pre-tool-call',
      'shell',
      { EVENT: 'pre-tool-call', TOOL: 'shell', ARGS: '{}' },
      [h],
      new AbortController().signal,
    );
    expect(result.blocked).toBe(false);
  });

  it('runs a hook whose matcher matches the tool name (case-insensitive substring)', async () => {
    const h = hook({
      event: 'pre-tool-call',
      matcher: 'SHE',
      command: node,
      args: ['-e', 'process.stderr.write("blocked"); process.exit(1)'],
    });
    const result = await runToolHooks(
      'pre-tool-call',
      'shell',
      { EVENT: 'pre-tool-call', TOOL: 'shell', ARGS: '{}' },
      [h],
      new AbortController().signal,
    );
    expect(result.blocked).toBe(true);
  });

  it('passes context as PENTESTERFLOW_HOOK_* env vars', async () => {
    const h = hook({
      event: 'pre-tool-call',
      command: node,
      args: [
        '-e',
        'if (process.env.PENTESTERFLOW_HOOK_TOOL !== "shell") { process.exit(1); } process.exit(0);',
      ],
    });
    const result = await runToolHooks(
      'pre-tool-call',
      'shell',
      { EVENT: 'pre-tool-call', TOOL: 'shell', ARGS: '{}' },
      [h],
      new AbortController().signal,
    );
    expect(result.blocked).toBe(false);
  });
});

describe('runNotifyHooks', () => {
  it('routes a hook`s stdout through notify()', async () => {
    const h = hook({
      event: 'session-start',
      command: node,
      args: ['-e', 'process.stdout.write("session started")'],
    });
    const notified: string[] = [];
    await runNotifyHooks('session-start', { EVENT: 'session-start' }, [h], (t) => notified.push(t));
    expect(notified).toEqual(['session started']);
  });

  it('never throws when a hook fails', async () => {
    const h = hook({
      event: 'finding-confirmed',
      command: node,
      args: ['-e', 'process.exit(1)'],
    });
    await expect(
      runNotifyHooks('finding-confirmed', { EVENT: 'finding-confirmed' }, [h], () => undefined),
    ).resolves.toBeUndefined();
  });

  it('never throws when the command does not exist', async () => {
    const h = hook({
      event: 'session-start',
      command: '/no/such/binary-xyz',
      args: [],
    });
    await expect(
      runNotifyHooks('session-start', { EVENT: 'session-start' }, [h], () => undefined),
    ).resolves.toBeUndefined();
  });
});

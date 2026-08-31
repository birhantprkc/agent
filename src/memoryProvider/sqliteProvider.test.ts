import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Prompter } from '../permission/permission.js';
import { createSqliteMemoryProvider } from './sqliteProvider.js';
import type { MemoryProvider } from './types.js';

// node:sqlite requires Node 22.5+; skip this whole suite on older runtimes
// instead of failing — createSqliteMemoryProvider() itself already degrades
// the same way in production. Probed the same way the module itself does
// (require(), not import()) — see sqliteProvider.ts for why.
let sqliteAvailable = true;
try {
  createRequire(import.meta.url)('node:sqlite');
} catch {
  sqliteAvailable = false;
}

let cwd = '';

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'pf-sqlite-provider-'));
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

describe.skipIf(!sqliteAvailable)('createSqliteMemoryProvider', () => {
  it('creates the DB file under .pentesterflow/memory-provider/', async () => {
    const provider = await createSqliteMemoryProvider({ cwd });
    expect(provider).not.toBeNull();
    await provider?.close();
  });

  it('reports no status/context when empty', async () => {
    const provider = (await createSqliteMemoryProvider({ cwd })) as MemoryProvider;
    expect(provider.systemPromptContext()).toBe('');
    expect(await provider.recall('anything')).toBe('');
    await provider.close();
  });

  it('records a turn and recalls it by a matching term', async () => {
    const provider = (await createSqliteMemoryProvider({ cwd })) as MemoryProvider;
    await provider.record({
      role: 'user',
      content: 'we found an IDOR on /api/orders/{id}',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    const result = await provider.recall('idor');
    expect(result).toContain('IDOR');
    expect(result).toContain('/api/orders/{id}');
    await provider.close();
  });

  it('does not match on unrelated terms', async () => {
    const provider = (await createSqliteMemoryProvider({ cwd })) as MemoryProvider;
    await provider.record({
      role: 'assistant',
      content: 'confirmed SSRF via the webhook URL parameter',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    expect(await provider.recall('xxsomethingnotpresentxx')).toBe('');
    await provider.close();
  });

  it('reflects the entry count in systemPromptContext after recording', async () => {
    const provider = (await createSqliteMemoryProvider({ cwd })) as MemoryProvider;
    await provider.record({
      role: 'user',
      content: 'note one',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    expect(provider.systemPromptContext()).toContain('1 past turn');
    await provider.record({
      role: 'assistant',
      content: 'note two',
      createdAt: '2026-01-01T00:00:01.000Z',
    });
    expect(provider.systemPromptContext()).toContain('2 past turns');
    await provider.close();
  });

  it('never throws on a query containing FTS5 special syntax', async () => {
    const provider = (await createSqliteMemoryProvider({ cwd })) as MemoryProvider;
    await provider.record({
      role: 'user',
      content: 'testing weird input handling',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    // Unbalanced quote, boolean operators, wildcard — all invalid/dangerous
    // raw FTS5 syntax if passed through unescaped.
    await expect(provider.recall('"unterminated AND OR NOT * -')).resolves.not.toThrow();
    await provider.close();
  });

  it('ignores an empty/whitespace-only record', async () => {
    const provider = (await createSqliteMemoryProvider({ cwd })) as MemoryProvider;
    await provider.record({ role: 'user', content: '   ', createdAt: '2026-01-01T00:00:00.000Z' });
    expect(provider.systemPromptContext()).toBe('');
    await provider.close();
  });

  it('exposes a search tool that returns matches or "no matches."', async () => {
    const provider = (await createSqliteMemoryProvider({ cwd })) as MemoryProvider;
    await provider.record({
      role: 'user',
      content: 'reflected xss in the search box',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    const tools = provider.tools();
    expect(tools).toHaveLength(1);
    const tool = tools[0];
    if (!tool) throw new Error('expected a tool');
    expect(tool.name()).toBe('memory_provider_search');
    expect(tool.requiresPermission()).toBe(false);

    const hit = await tool.run({ query: 'xss' }, new AbortController().signal, {} as Prompter);
    expect(hit).toContain('reflected xss');

    const miss = await tool.run(
      { query: 'somethingnotindexed' },
      new AbortController().signal,
      {} as Prompter,
    );
    expect(miss).toBe('no matches.');
    await provider.close();
  });

  it('is safe to call recall/record/systemPromptContext after close', async () => {
    const provider = (await createSqliteMemoryProvider({ cwd })) as MemoryProvider;
    await provider.close();
    await expect(provider.close()).resolves.toBeUndefined();
    expect(provider.systemPromptContext()).toBe('');
    expect(await provider.recall('anything')).toBe('');
    await expect(
      provider.record({ role: 'user', content: 'x', createdAt: '2026-01-01T00:00:00.000Z' }),
    ).resolves.toBeUndefined();
  });
});

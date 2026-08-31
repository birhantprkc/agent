import { describe, expect, it } from 'vitest';
import type { Prompter } from '../permission/permission.js';
import { ScopeStore } from '../target/scope.js';
import { ScopeTool } from './scope.js';

const run = (tool: ScopeTool, args: Record<string, unknown>) =>
  tool.run(args, new AbortController().signal, {} as Prompter);

describe('ScopeTool', () => {
  it('reports empty scope by default', async () => {
    const tool = new ScopeTool(new ScopeStore());
    expect(await run(tool, { action: 'list' })).toContain('scope is empty');
  });

  it('adds, lists, and checks a domain', async () => {
    const store = new ScopeStore();
    const tool = new ScopeTool(store);
    expect(await run(tool, { action: 'add', pattern: 'example.com' })).toContain('allowed');
    expect(await run(tool, { action: 'list' })).toContain('allow: example.com');
    expect(await run(tool, { action: 'check', pattern: 'api.example.com' })).toContain('in scope');
    expect(await run(tool, { action: 'check', pattern: 'evil.com' })).toContain('OUT OF SCOPE');
  });

  it('adds a deny entry and reports it distinctly', async () => {
    const tool = new ScopeTool(new ScopeStore());
    expect(await run(tool, { action: 'deny', pattern: 'admin.example.com' })).toContain('denied');
  });

  it('removes an entry', async () => {
    const store = new ScopeStore();
    const tool = new ScopeTool(store);
    await run(tool, { action: 'add', pattern: 'example.com' });
    expect(await run(tool, { action: 'remove', pattern: 'example.com' })).toContain('removed');
    expect(await run(tool, { action: 'remove', pattern: 'example.com' })).toContain(
      'no such entry',
    );
  });

  it('clears the whole scope', async () => {
    const store = new ScopeStore();
    const tool = new ScopeTool(store);
    await run(tool, { action: 'add', pattern: 'example.com' });
    expect(await run(tool, { action: 'clear' })).toContain('cleared');
    expect(store.isEmpty()).toBe(true);
  });

  it('rejects an unknown action and missing required pattern', async () => {
    const tool = new ScopeTool(new ScopeStore());
    expect(await run(tool, { action: 'nuke' })).toContain('error: action must be one of');
    expect(await run(tool, { action: 'add' })).toContain("'pattern' is required");
  });
});

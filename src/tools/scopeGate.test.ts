import { describe, expect, it } from 'vitest';
import type { Decision, Prompter, Request } from '../permission/permission.js';
import { ScopeStore } from '../target/scope.js';
import { gateOutOfScope } from './scopeGate.js';

function mockPrompter(decision: Decision): { prompter: Prompter; asked: Request[] } {
  const asked: Request[] = [];
  return {
    asked,
    prompter: {
      async ask(req: Request) {
        asked.push(req);
        return decision;
      },
    },
  };
}

describe('gateOutOfScope', () => {
  it('no-ops (no prompt) when scope is undefined or empty', async () => {
    const { prompter, asked } = mockPrompter('deny');
    const signal = new AbortController().signal;
    expect(
      await gateOutOfScope(prompter, new URL('https://evil.com'), signal, 'http', undefined),
    ).toBe('');
    expect(
      await gateOutOfScope(prompter, new URL('https://evil.com'), signal, 'http', new ScopeStore()),
    ).toBe('');
    expect(asked).toHaveLength(0);
  });

  it('no-ops (no prompt) for a host that matches an allow entry', async () => {
    const scope = new ScopeStore();
    scope.add('example.com');
    const { prompter, asked } = mockPrompter('deny');
    const result = await gateOutOfScope(
      prompter,
      new URL('https://api.example.com/x'),
      new AbortController().signal,
      'http',
      scope,
    );
    expect(result).toBe('');
    expect(asked).toHaveLength(0);
  });

  it('prompts for an out-of-scope host and allows on approval', async () => {
    const scope = new ScopeStore();
    scope.add('example.com');
    const { prompter, asked } = mockPrompter('allow-once');
    const result = await gateOutOfScope(
      prompter,
      new URL('https://evil.com'),
      new AbortController().signal,
      'http',
      scope,
    );
    expect(result).toContain('does not match');
    expect(asked).toHaveLength(1);
    expect(asked[0]?.noSessionCache).toBe(true);
  });

  it('throws on a denied prompt for an out-of-scope host', async () => {
    const scope = new ScopeStore();
    scope.add('example.com');
    const { prompter } = mockPrompter('deny');
    await expect(
      gateOutOfScope(
        prompter,
        new URL('https://evil.com'),
        new AbortController().signal,
        'http',
        scope,
      ),
    ).rejects.toThrow(/out-of-scope host denied/);
  });

  it('hard-blocks a deny-listed host with no prompt at all, even if the prompter would allow', async () => {
    const scope = new ScopeStore();
    scope.add('admin.example.com', 'deny');
    const { prompter, asked } = mockPrompter('allow-once');
    await expect(
      gateOutOfScope(
        prompter,
        new URL('https://admin.example.com'),
        new AbortController().signal,
        'http',
        scope,
      ),
    ).rejects.toThrow(/request blocked/);
    expect(asked).toHaveLength(0);
  });
});

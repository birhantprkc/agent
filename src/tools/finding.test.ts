import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Finding, Store } from '../findings/store.js';
import type { Prompter } from '../permission/permission.js';
import { ConfirmFindingTool } from './finding.js';

let dir = '';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pf-finding-tool-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const baseArgs = {
  title: 'Reflected XSS in search',
  severity: 'high',
  url: 'https://example.com/search',
  parameter: 'q',
  impact: 'Attacker can execute arbitrary JS in a victim session.',
};

describe('ConfirmFindingTool', () => {
  it('writes a finding and notifies on first confirmation', async () => {
    const store = new Store(dir);
    const notified: Array<{ finding: Finding; path: string }> = [];
    const tool = new ConfirmFindingTool(store, (finding, path) => notified.push({ finding, path }));

    const out = await tool.run(baseArgs, new AbortController().signal, {} as Prompter);

    expect(out).toContain('written to');
    expect(notified).toHaveLength(1);
    expect(notified[0]?.finding.title).toBe('Reflected XSS in search');
  });

  it('skips the notifier and reports a duplicate when re-confirming the same bug', async () => {
    const store = new Store(dir);
    const notified: Array<{ finding: Finding; path: string }> = [];
    const tool = new ConfirmFindingTool(store, (finding, path) => notified.push({ finding, path }));

    await tool.run(baseArgs, new AbortController().signal, {} as Prompter);
    const second = await tool.run(
      { ...baseArgs, payload: 'q=<script>x</script>' },
      new AbortController().signal,
      {} as Prompter,
    );

    expect(second).toContain('already recorded');
    expect(second).toContain('skipped duplicate');
    expect(notified).toHaveLength(1);
  });

  it('rejects a re-scan with a different parameter as a new, non-duplicate finding', async () => {
    const store = new Store(dir);
    const tool = new ConfirmFindingTool(store);

    const first = await tool.run(baseArgs, new AbortController().signal, {} as Prompter);
    const second = await tool.run(
      { ...baseArgs, parameter: 'redirect' },
      new AbortController().signal,
      {} as Prompter,
    );

    expect(first).toContain('written to');
    expect(second).toContain('written to');
    expect(second).not.toContain('already recorded');
  });
});

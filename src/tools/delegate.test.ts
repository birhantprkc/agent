import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '../agent/events.js';
import type { Prompter } from '../permission/permission.js';
import {
  type DelegateResult,
  DelegateTool,
  childProgressLabel,
  childProgressNoticeFromEvent,
  formatChildProgressDetail,
  formatChildProgressSummary,
  friendlyProgressToolName,
  isExploreAllowedTool,
  summarizeDelegateEvents,
} from './delegate.js';

describe('isExploreAllowedTool', () => {
  it('blocks shell and writes', () => {
    expect(isExploreAllowedTool('shell')).toBe(false);
    expect(isExploreAllowedTool('BashTool')).toBe(false);
    expect(isExploreAllowedTool('file_write')).toBe(false);
    expect(isExploreAllowedTool('file_edit')).toBe(false);
  });

  it('allows read/search/http', () => {
    expect(isExploreAllowedTool('file_read')).toBe(true);
    expect(isExploreAllowedTool('grep')).toBe(true);
    expect(isExploreAllowedTool('http')).toBe(true);
    expect(isExploreAllowedTool('coverage')).toBe(true);
  });
});

describe('summarizeDelegateEvents', () => {
  it('takes the last assistant-text as the final answer, ignoring earlier ones', () => {
    const events: AgentEvent[] = [
      { type: 'assistant-text', text: 'thinking...' },
      { type: 'tool-call', id: '1', name: 'http', args: {}, argsJSON: '{}' },
      { type: 'assistant-text', text: 'final answer' },
    ];
    expect(summarizeDelegateEvents(events).finalText).toBe('final answer');
  });

  it('tallies tool calls by name', () => {
    const events: AgentEvent[] = [
      { type: 'tool-call', id: '1', name: 'http', args: {}, argsJSON: '{}' },
      { type: 'tool-call', id: '2', name: 'http', args: {}, argsJSON: '{}' },
      { type: 'tool-call', id: '3', name: 'coverage', args: {}, argsJSON: '{}' },
    ];
    const result = summarizeDelegateEvents(events);
    expect(result.toolTally).toEqual({ http: 2, coverage: 1 });
    expect(result.stepCount).toBe(3);
  });

  it('surfaces a terminal error', () => {
    const events: AgentEvent[] = [{ type: 'error', err: new Error('hit max steps (10)') }];
    expect(summarizeDelegateEvents(events).error).toBe('hit max steps (10)');
  });

  it('returns empty defaults for no events', () => {
    expect(summarizeDelegateEvents([])).toEqual({ finalText: '', toolTally: {}, stepCount: 0 });
  });
});

describe('child progress formatting', () => {
  it('labels skill: keys without the prefix', () => {
    expect(childProgressLabel('skill:recon')).toBe('recon');
    expect(childProgressLabel('explore')).toBe('explore');
  });

  it('summarizes running vs done', () => {
    expect(formatChildProgressSummary('recon', [], false)).toBe('recon…');
    expect(formatChildProgressSummary('recon', ['todo', 'scope'], false)).toBe('recon · 2 tools…');
    expect(formatChildProgressSummary('recon', ['todo', 'scope'], true)).toBe('recon · 2 tools');
  });

  it('builds a Grok-style expandable detail list', () => {
    expect(formatChildProgressDetail('recon', ['load_skill', 'todo', 'scope', 'BashTool'])).toBe(
      ['recon · 4 tools', '  1. load_skill', '  2. todo', '  3. scope', '  4. shell'].join('\n'),
    );
    expect(friendlyProgressToolName('BashTool')).toBe('shell');
  });

  it('builds structured notices from wire events', () => {
    const n = childProgressNoticeFromEvent({ phase: 'done', step: 2, detail: 'skill:recon' }, [
      'todo',
      'scope',
    ]);
    expect(n).toEqual({
      type: 'child-progress',
      key: 'skill:recon',
      label: 'recon',
      tools: ['todo', 'scope'],
      done: true,
    });
  });
});

describe('DelegateTool', () => {
  const run = (tool: DelegateTool, args: Record<string, unknown>) =>
    tool.run(args, new AbortController().signal, {} as Prompter);

  it('requires an objective', async () => {
    const tool = new DelegateTool(async () => ({ finalText: '', toolTally: {}, stepCount: 0 }));
    expect(await run(tool, {})).toContain("'objective' is required");
  });

  it('formats a successful delegation with a tool tally header', async () => {
    const result: DelegateResult = {
      finalText: 'confirmed IDOR on account C',
      toolTally: { http: 3, coverage: 1 },
      stepCount: 4,
      role: 'worker',
    };
    const tool = new DelegateTool(async () => result);
    const out = await run(tool, { objective: 'confirm IDOR on account C' });
    expect(out).toContain('[delegated/worker: 4 tool call(s)');
    expect(out).toContain('http×3');
    expect(out).toContain('confirmed IDOR on account C');
  });

  it('passes objective, skill, and role through to the runner', async () => {
    const calls: Array<{ objective: string; skill?: string; role: string }> = [];
    const tool = new DelegateTool(async (objective, skill, role) => {
      calls.push({ objective, skill, role });
      return { finalText: 'ok', toolTally: {}, stepCount: 0, role };
    });
    await run(tool, { objective: 'enumerate subdomains', skill: 'recon', role: 'explore' });
    expect(calls).toEqual([{ objective: 'enumerate subdomains', skill: 'recon', role: 'explore' }]);
  });

  it('surfaces a sub-agent error alongside whatever text it produced', async () => {
    const tool = new DelegateTool(async () => ({
      finalText: 'partial progress',
      toolTally: {},
      stepCount: 10,
      error: 'hit max steps (10)',
    }));
    const out = await run(tool, { objective: 'do something huge' });
    expect(out).toContain('partial progress');
    expect(out).toContain('sub-agent ended with an error: hit max steps (10)');
  });
});

// Permission tiers: yolo auto-all, auto-safe read-only, ask defers.

import { describe, expect, it } from 'vitest';
import type { Decision, Prompter, Request } from './permission.js';
import {
  TieredPrompter,
  YoloPrompter,
  isAutoSafeTool,
  normalizePermissionMode,
} from './permission.js';

class ScriptedPrompter implements Prompter {
  readonly seen: Request[] = [];
  constructor(private readonly decision: Decision) {}
  async ask(req: Request): Promise<Decision> {
    this.seen.push(req);
    return this.decision;
  }
}

describe('isAutoSafeTool', () => {
  it('allows observational tools', () => {
    expect(isAutoSafeTool('file_read')).toBe(true);
    expect(isAutoSafeTool('FileReadTool')).toBe(true);
    expect(isAutoSafeTool('grep')).toBe(true);
    expect(isAutoSafeTool('coverage')).toBe(true);
    expect(isAutoSafeTool('load_skill')).toBe(true);
  });

  it('denies mutating / high-blast tools', () => {
    expect(isAutoSafeTool('shell')).toBe(false);
    expect(isAutoSafeTool('BashTool')).toBe(false);
    expect(isAutoSafeTool('file_write')).toBe(false);
    expect(isAutoSafeTool('http')).toBe(false);
  });
});

describe('normalizePermissionMode', () => {
  it('maps aliases', () => {
    expect(normalizePermissionMode('yolo')).toBe('yolo');
    expect(normalizePermissionMode('auto-safe')).toBe('auto-safe');
    expect(normalizePermissionMode('safe')).toBe('auto-safe');
    expect(normalizePermissionMode('ask')).toBe('ask');
    expect(normalizePermissionMode('nope')).toBe('ask');
  });
});

describe('TieredPrompter / YoloPrompter', () => {
  it('yolo auto-approves everything without prompting', async () => {
    const inner = new ScriptedPrompter('deny');
    const y = new TieredPrompter(inner, 'yolo');
    expect(await y.ask({ tool: 'shell', summary: 's', detail: 'd' })).toBe('allow-once');
    expect(inner.seen).toHaveLength(0);
  });

  it('auto-safe approves read tools but prompts for shell', async () => {
    const inner = new ScriptedPrompter('deny');
    const p = new TieredPrompter(inner, 'auto-safe');
    expect(await p.ask({ tool: 'file_read', summary: 's', detail: 'd' })).toBe('allow-once');
    expect(inner.seen).toHaveLength(0);
    expect(await p.ask({ tool: 'shell', summary: 's', detail: 'd' })).toBe('deny');
    expect(inner.seen).toHaveLength(1);
  });

  it('ask mode always defers', async () => {
    const inner = new ScriptedPrompter('allow-session');
    const p = new TieredPrompter(inner, 'ask');
    expect(await p.ask({ tool: 'file_read', summary: 's', detail: 'd' })).toBe('allow-session');
    expect(inner.seen).toHaveLength(1);
  });

  it('YoloPrompter alias still works with boolean ctor', async () => {
    const inner = new ScriptedPrompter('deny');
    const y = new YoloPrompter(inner, true);
    expect(y.isYolo()).toBe(true);
    expect(await y.ask({ tool: 'shell', summary: 's', detail: 'd' })).toBe('allow-once');
  });
});

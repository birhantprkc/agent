import { describe, expect, it } from 'vitest';
import type { Prompter } from '../permission/permission.js';
import { UpdateUserProfileTool } from './userProfile.js';

describe('UpdateUserProfileTool', () => {
  it('forwards the note to the handler and confirms the save', async () => {
    const notes: string[] = [];
    const tool = new UpdateUserProfileTool(async (text) => {
      notes.push(text);
    });

    const out = await tool.run(
      { note: 'prefers terse output' },
      new AbortController().signal,
      {} as Prompter,
    );

    expect(notes).toEqual(['prefers terse output']);
    expect(out).toContain('prefers terse output');
  });

  it('rejects an empty note without calling the handler', async () => {
    const notes: string[] = [];
    const tool = new UpdateUserProfileTool(async (text) => {
      notes.push(text);
    });

    await expect(
      tool.run({ note: '   ' }, new AbortController().signal, {} as Prompter),
    ).rejects.toThrow('note is required');
    expect(notes).toEqual([]);
  });

  it('requires no permission gate', () => {
    const tool = new UpdateUserProfileTool(async () => undefined);
    expect(tool.requiresPermission()).toBe(false);
  });
});

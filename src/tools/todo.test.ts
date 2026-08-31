import { describe, expect, it } from 'vitest';
import type { Prompter } from '../permission/permission.js';
import { TodoTool } from './todo.js';

const run = (tool: TodoTool, args: Record<string, unknown>) =>
  tool.run(args, new AbortController().signal, {} as Prompter);

describe('TodoTool', () => {
  it('lists an empty todo list', async () => {
    const tool = new TodoTool();
    expect(await run(tool, { action: 'list' })).toBe('todo list is empty.');
    expect(tool.snapshot()).toEqual([]);
  });

  it('writes a full list and reflects it in snapshot()', async () => {
    const tool = new TodoTool();
    const out = await run(tool, {
      action: 'write',
      items: [
        { text: 'enumerate subdomains', status: 'completed' },
        { text: 'test IDOR on /orders', status: 'in_progress' },
        { text: 'write report', status: 'pending' },
      ],
    });
    expect(out).toContain('[x] enumerate subdomains');
    expect(out).toContain('[~] test IDOR on /orders');
    expect(out).toContain('[ ] write report');
    expect(tool.snapshot()).toHaveLength(3);
    expect(tool.snapshot()[1]?.status).toBe('in_progress');
  });

  it('replaces the whole list on a second write, not append', async () => {
    const tool = new TodoTool();
    await run(tool, { action: 'write', items: [{ text: 'a', status: 'pending' }] });
    await run(tool, { action: 'write', items: [{ text: 'b', status: 'pending' }] });
    expect(tool.snapshot()).toHaveLength(1);
    expect(tool.snapshot()[0]?.text).toBe('b');
  });

  it('rejects more than one in_progress item', async () => {
    const tool = new TodoTool();
    const out = await run(tool, {
      action: 'write',
      items: [
        { text: 'a', status: 'in_progress' },
        { text: 'b', status: 'in_progress' },
      ],
    });
    expect(out).toContain('at most one item may be');
    expect(tool.snapshot()).toEqual([]);
  });

  it('rejects an unknown action', async () => {
    const tool = new TodoTool();
    expect(await run(tool, { action: 'delete' })).toContain('error: action must be one of');
  });

  it('rejects a write with no valid items', async () => {
    const tool = new TodoTool();
    expect(
      await run(tool, { action: 'write', items: [{ text: '', status: 'pending' }] }),
    ).toContain('no valid items');
  });

  it('preserves ids passed back by the model across writes', async () => {
    const tool = new TodoTool();
    await run(tool, { action: 'write', items: [{ text: 'a', status: 'pending' }] });
    const id = tool.snapshot()[0]?.id;
    expect(id).toBeTruthy();
    await run(tool, {
      action: 'write',
      items: [{ id, text: 'a (renamed)', status: 'in_progress' }],
    });
    expect(tool.snapshot()[0]?.id).toBe(id);
    expect(tool.snapshot()[0]?.text).toBe('a (renamed)');
  });
});

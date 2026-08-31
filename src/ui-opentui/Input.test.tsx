/** @jsxImportSource @opentui/react */
import { testRender } from '@opentui/react/test-utils';
import { afterEach, describe, expect, it } from 'vitest';
import { Input } from './Input.js';

let cleanup: (() => void) | undefined;
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
});

async function renderFrame(node: Parameters<typeof testRender>[0]): Promise<string> {
  const setup = await testRender(node, { width: 80, height: 10 });
  cleanup = () => setup.renderer.destroy();
  await setup.renderOnce();
  return setup.captureCharFrame();
}

describe('Input', () => {
  it('renders a quiet frame with friendly placeholder (no keybinding spam)', async () => {
    const frame = await renderFrame(<Input value="" cursor={0} />);
    expect(frame).toMatch(/╭|┌/);
    expect(frame).toMatch(/╰|└/);
    expect(frame).toContain('❯');
    expect(frame).toMatch(/Ask anything|commands/i);
    expect(frame).not.toContain('enter send');
    expect(frame).not.toContain('ctrl+j');
  });

  it('renders typed value with brand cursor chrome', async () => {
    const frame = await renderFrame(<Input value="scan target" cursor={11} />);
    expect(frame).toContain('scan target');
    expect(frame).toContain('❯');
  });

  it('stays a normal prompt while the agent is busy (no planning takeover)', async () => {
    const frame = await renderFrame(
      <Input
        value=""
        cursor={0}
        placeholder="type a prompt · / commands · @ files"
        hint="agent running · esc cancel turn · enter after it finishes"
      />,
    );
    expect(frame).toContain('❯');
    expect(frame).toContain('type a prompt');
    expect(frame).toContain('agent running');
    expect(frame).not.toContain('planning…');
    expect(frame).not.toContain('Esc to cancel');
  });

  it('respects an explicit chat-column width (does not force full terminal width)', async () => {
    const setup = await testRender(<Input value="hi" cursor={2} width={40} />, {
      width: 80,
      height: 10,
    });
    cleanup = () => setup.renderer.destroy();
    await setup.renderOnce();
    const frame = setup.captureCharFrame();
    expect(frame).toContain('hi');
    // Frame borders should not span the full 80-col terminal — a 40-col
    // prompt leaves a large right-side gap of spaces on each content row.
    const line = frame.split('\n').find((l) => l.includes('❯') && l.includes('hi'));
    expect(line).toBeDefined();
    expect((line ?? '').trimEnd().length).toBeLessThan(50);
  });

  it('soft-wraps a long single line inside the frame', async () => {
    const long = 'A'.repeat(60);
    const setup = await testRender(<Input value={long} cursor={60} width={30} />, {
      width: 40,
      height: 12,
    });
    cleanup = () => setup.renderer.destroy();
    await setup.renderOnce();
    const frame = setup.captureCharFrame();
    // Multiple physical rows of A's (wrapped), not one overflowing row.
    const aLines = frame.split('\n').filter((l) => l.includes('A'));
    expect(aLines.length).toBeGreaterThanOrEqual(2);
    // Idle typing has no hint row — keeps the footer quiet.
    expect(frame).not.toContain('enter send');
  });

  it('hang-indents soft-wrapped rows under the prompt (no repeated ❯)', async () => {
    const long = 'B'.repeat(50);
    const setup = await testRender(<Input value={long} cursor={0} width={28} />, {
      width: 40,
      height: 12,
    });
    cleanup = () => setup.renderer.destroy();
    await setup.renderOnce();
    const frame = setup.captureCharFrame();
    // Prompt glyph appears once on the first content row, not on every wrap.
    const promptHits = (frame.match(/❯/g) ?? []).length;
    expect(promptHits).toBe(1);
    const bLines = frame.split('\n').filter((l) => /B{3,}/.test(l));
    expect(bLines.length).toBeGreaterThanOrEqual(2);
  });
});

import { softWrapLine } from './Input.js';

describe('softWrapLine', () => {
  it('chunks text at maxCols', () => {
    expect(softWrapLine('abcdefghij', 4)).toEqual(['abcd', 'efgh', 'ij']);
  });
});

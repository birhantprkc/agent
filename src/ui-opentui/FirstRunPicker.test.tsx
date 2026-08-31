/** @jsxImportSource @opentui/react */
import { testRender } from '@opentui/react/test-utils';
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FirstRunPicker } from './FirstRunPicker.js';

// No original ../ui/FirstRunPicker.test.tsx exists — zero test coverage
// before this port. See PermissionModal.test.tsx for the
// act()/pressEscapeAndWait background on these helpers.
async function pressAndFlush(
  setup: Awaited<ReturnType<typeof testRender>>,
  press: () => void,
): Promise<void> {
  await act(async () => {
    press();
    await setup.renderOnce();
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
}
async function pressEscapeAndWait(setup: Awaited<ReturnType<typeof testRender>>): Promise<void> {
  setup.mockInput.pressEscape();
  await new Promise((resolve) => setTimeout(resolve, 50));
}

let cleanup: (() => void) | undefined;
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
});

async function renderModal(node: Parameters<typeof testRender>[0]) {
  const setup = await testRender(node, { width: 100, height: 30 });
  cleanup = () => setup.renderer.destroy();
  await setup.renderOnce();
  return setup;
}

describe('FirstRunPicker rendering', () => {
  it('renders both tooling profile options with the minimal one selected by default', async () => {
    const setup = await renderModal(<FirstRunPicker onPick={vi.fn()} onCancel={vi.fn()} />);
    const frame = setup.captureCharFrame();
    expect(frame).toContain('PentesterFlow');
    expect(frame).toContain('setup');
    expect(frame).toContain('TOOLING PROFILE');
    expect(frame).toContain('curl + Unix tools only');
    expect(frame).toContain('curl + Unix + specialized scanners');
    expect(frame).toContain('reproducible one-liners');
  });
});

describe('FirstRunPicker key handling', () => {
  it('confirms the default (minimal) selection on Enter', async () => {
    const onPick = vi.fn();
    const setup = await renderModal(<FirstRunPicker onPick={onPick} onCancel={vi.fn()} />);
    await pressAndFlush(setup, () => setup.mockInput.pressEnter());
    expect(onPick).toHaveBeenCalledWith('minimal');
  });

  it('down arrow moves selection to "full", helper text updates', async () => {
    const onPick = vi.fn();
    const setup = await renderModal(<FirstRunPicker onPick={onPick} onCancel={vi.fn()} />);
    await pressAndFlush(setup, () => setup.mockInput.pressArrow('down'));
    const frame = setup.captureCharFrame();
    expect(frame).toContain('may pick a specialized scanner');
    await pressAndFlush(setup, () => setup.mockInput.pressEnter());
    expect(onPick).toHaveBeenCalledWith('full');
  });

  it('wraps selection from the last option back to the first', async () => {
    const onPick = vi.fn();
    const setup = await renderModal(<FirstRunPicker onPick={onPick} onCancel={vi.fn()} />);
    await pressAndFlush(setup, () => setup.mockInput.pressArrow('down'));
    await pressAndFlush(setup, () => setup.mockInput.pressArrow('down'));
    await pressAndFlush(setup, () => setup.mockInput.pressEnter());
    expect(onPick).toHaveBeenCalledWith('minimal');
  });

  it('cancels on Escape', async () => {
    const onCancel = vi.fn();
    const setup = await renderModal(<FirstRunPicker onPick={vi.fn()} onCancel={onCancel} />);
    await pressEscapeAndWait(setup);
    expect(onCancel).toHaveBeenCalled();
  });
});

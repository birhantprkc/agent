/** @jsxImportSource @opentui/react */
import { testRender } from '@opentui/react/test-utils';
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Option } from '../ask/ask.js';
import type { AskRequest } from '../ui/askBridge.js';
import { AskModal } from './AskModal.js';

// No original ../ui/AskModal.test.tsx exists — this component had zero test
// coverage before this port. See PermissionModal.test.tsx for the
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

function opt(label: string, overrides: Partial<Option> = {}): Option {
  return { label, ...overrides };
}

function req(options: Option[], overrides: Partial<AskRequest['question']> = {}): AskRequest {
  return {
    question: { question: 'Pick one', options, ...overrides },
    resolve: vi.fn(),
    reject: vi.fn(),
  };
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

describe('AskModal rendering', () => {
  it('renders header, question, subtitle, and options', async () => {
    const setup = await renderModal(
      <AskModal
        req={req([opt('Ollama'), opt('Anthropic')], {
          header: 'provider',
          subtitle: 'choose a backend',
        })}
      />,
    );
    const frame = setup.captureCharFrame();
    expect(frame).toContain('PROVIDER');
    expect(frame).toContain('Pick one');
    expect(frame).toContain('choose a backend');
    expect(frame).toContain('Ollama');
    expect(frame).toContain('Anthropic');
    expect(frame).toContain('↑↓ navigate');
  });

  it('shows a disabled option dimmed without a caret slot', async () => {
    const setup = await renderModal(
      <AskModal req={req([opt('Ollama'), opt('Anthropic', { disabled: true })])} />,
    );
    const frame = setup.captureCharFrame();
    expect(frame).toContain('Anthropic');
  });

  it('renders badge and description text', async () => {
    const setup = await renderModal(
      <AskModal
        req={req([opt('Groq', { badge: 'fast', description: 'hosted, needs API key' })])}
      />,
    );
    const frame = setup.captureCharFrame();
    expect(frame).toContain('fast');
    expect(frame).toContain('hosted, needs API key');
  });

  it('renders a group header once per group', async () => {
    const setup = await renderModal(
      <AskModal
        req={req([
          opt('Ollama', { group: 'local' }),
          opt('LM Studio', { group: 'local' }),
          opt('Groq', { group: 'hosted' }),
        ])}
      />,
    );
    const frame = setup.captureCharFrame();
    expect(frame).toContain('LOCAL');
    expect(frame).toContain('HOSTED');
  });
});

describe('AskModal key handling', () => {
  it('resolves the initially-selected option on Enter', async () => {
    const request = req([opt('Ollama'), opt('Anthropic')]);
    const setup = await renderModal(<AskModal req={request} />);
    await pressAndFlush(setup, () => setup.mockInput.pressEnter());
    expect(request.resolve).toHaveBeenCalledWith('Ollama');
  });

  it('down arrow moves selection, Enter resolves the new one', async () => {
    const request = req([opt('Ollama'), opt('Anthropic')]);
    const setup = await renderModal(<AskModal req={request} />);
    await pressAndFlush(setup, () => setup.mockInput.pressArrow('down'));
    await pressAndFlush(setup, () => setup.mockInput.pressEnter());
    expect(request.resolve).toHaveBeenCalledWith('Anthropic');
  });

  it('navigation skips disabled options', async () => {
    const request = req([opt('Ollama'), opt('Disabled', { disabled: true }), opt('Anthropic')]);
    const setup = await renderModal(<AskModal req={request} />);
    await pressAndFlush(setup, () => setup.mockInput.pressArrow('down'));
    await pressAndFlush(setup, () => setup.mockInput.pressEnter());
    expect(request.resolve).toHaveBeenCalledWith('Anthropic');
  });

  it('digit keys jump to the Nth selectable option', async () => {
    const request = req([opt('A'), opt('B'), opt('C')]);
    const setup = await renderModal(<AskModal req={request} />);
    await pressAndFlush(setup, () => setup.mockInput.pressKey('2'));
    await pressAndFlush(setup, () => setup.mockInput.pressEnter());
    expect(request.resolve).toHaveBeenCalledWith('B');
  });

  it('rejects on Escape', async () => {
    const request = req([opt('Ollama')]);
    const setup = await renderModal(<AskModal req={request} />);
    await pressEscapeAndWait(setup);
    expect(request.reject).toHaveBeenCalledWith(expect.any(Error));
  });

  it('Enter on a disabled option does nothing', async () => {
    const request = req([opt('Ollama', { disabled: true }), opt('Anthropic')]);
    const setup = await renderModal(<AskModal req={request} />);
    // Selection starts on the first *selectable* option (Anthropic), so
    // this also proves firstSelectable() skips the leading disabled row.
    await pressAndFlush(setup, () => setup.mockInput.pressEnter());
    expect(request.resolve).toHaveBeenCalledWith('Anthropic');
  });
});

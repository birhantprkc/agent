/** @jsxImportSource @opentui/react */
import { testRender } from '@opentui/react/test-utils';
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SecretInputModal, type SecretInputRequest, maskSecret } from './SecretInputModal.js';

function req(overrides: Partial<SecretInputRequest> = {}): SecretInputRequest {
  return {
    header: 'Gemini API',
    question: 'Enter your API key',
    resolve: vi.fn(),
    reject: vi.fn(),
    ...overrides,
  };
}

let cleanup: (() => void) | undefined;
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
});

async function renderModal(node: Parameters<typeof testRender>[0]) {
  const setup = await testRender(node, { width: 100, height: 20 });
  cleanup = () => setup.renderer.destroy();
  await setup.renderOnce();
  return setup;
}

// mockInput presses that drive a React state update (typing, backspace,
// paste) need act() to flush before assertions run — see
// PermissionModal.test.tsx's pressAndFlush doc comment for why. Escape is
// the one exception: act() suppresses its dispatch entirely, so it gets a
// plain real-timer wait instead (also documented there).
async function pressAndFlush(
  setup: Awaited<ReturnType<typeof testRender>>,
  press: () => void,
): Promise<void> {
  await act(async () => {
    press();
    await setup.renderOnce();
  });
  // A rapid back-to-back sequence of pressAndFlush calls silently drops the
  // last press without this — the internal key-processing pipeline needs a
  // real tick to fully settle beyond what a single renderOnce() covers
  // (confirmed empirically: without it, an a/b/c sequence only registers
  // a/b, and an a/b/backspace sequence only registers a/b).
  await new Promise((resolve) => setTimeout(resolve, 10));
}
async function pressEscapeAndWait(setup: Awaited<ReturnType<typeof testRender>>): Promise<void> {
  setup.mockInput.pressEscape();
  await new Promise((resolve) => setTimeout(resolve, 50));
}

describe('maskSecret', () => {
  it('fully masks short secrets', () => {
    expect(maskSecret('abcd')).toBe('••••');
    expect(maskSecret('12345678')).toBe('••••••••');
  });

  it('keeps the last 4 chars once long enough', () => {
    const masked = maskSecret('AIzaSyAbcdefghijklmnop');
    expect(masked.endsWith('mnop')).toBe(true);
    expect(masked.startsWith('•')).toBe(true);
    expect(masked).not.toContain('AIza');
  });
});

describe('SecretInputModal rendering', () => {
  it('renders professional chrome matching the provider menu language', async () => {
    const setup = await renderModal(
      <SecretInputModal
        req={req({
          subtitle: 'Env  GEMINI_API_KEY',
          placeholder: 'AIza…',
        })}
      />,
    );
    const frame = setup.captureCharFrame();
    expect(frame).toContain('GEMINI API');
    expect(frame).not.toContain('[Gemini');
    expect(frame).toContain('Enter your API key');
    expect(frame).toContain('Env  GEMINI_API_KEY');
    expect(frame).toContain('AIza…');
    expect(frame).toContain('Enter confirm');
    expect(frame).not.toContain('Enter test');
    expect(frame).toContain('Esc cancel');
  });
});

describe('SecretInputModal key handling', () => {
  it('types characters and masks them in the display', async () => {
    const setup = await renderModal(<SecretInputModal req={req()} />);
    await pressAndFlush(setup, () => setup.mockInput.pressKey('a'));
    await pressAndFlush(setup, () => setup.mockInput.pressKey('b'));
    await pressAndFlush(setup, () => setup.mockInput.pressKey('c'));
    const frame = setup.captureCharFrame();
    expect(frame).toContain('•••');
    expect(frame).not.toContain('abc');
  });

  it('backspace removes the last character', async () => {
    const setup = await renderModal(<SecretInputModal req={req()} />);
    await pressAndFlush(setup, () => setup.mockInput.pressKey('a'));
    await pressAndFlush(setup, () => setup.mockInput.pressKey('b'));
    await pressAndFlush(setup, () => setup.mockInput.pressBackspace());
    const frame = setup.captureCharFrame();
    expect(frame).toContain('•');
    expect(frame).not.toContain('••');
  });

  it('resolves the trimmed value on Enter', async () => {
    const request = req();
    const setup = await renderModal(<SecretInputModal req={request} />);
    await pressAndFlush(setup, () => setup.mockInput.pressKey('x'));
    await pressAndFlush(setup, () => setup.mockInput.pressKey('y'));
    await pressAndFlush(setup, () => setup.mockInput.pressKey('z'));
    await pressAndFlush(setup, () => setup.mockInput.pressEnter());
    expect(request.resolve).toHaveBeenCalledWith('xyz');
  });

  it('rejects on Escape', async () => {
    const request = req();
    const setup = await renderModal(<SecretInputModal req={request} />);
    await pressEscapeAndWait(setup);
    expect(request.reject).toHaveBeenCalledWith(expect.any(Error));
  });

  it('accepts a pasted key', async () => {
    const request = req();
    const setup = await renderModal(<SecretInputModal req={request} />);
    await act(async () => {
      await setup.mockInput.pasteBracketedText('AIzaSyPasted1234');
      await setup.renderOnce();
    });
    await pressAndFlush(setup, () => setup.mockInput.pressEnter());
    expect(request.resolve).toHaveBeenCalledWith('AIzaSyPasted1234');
  });
});

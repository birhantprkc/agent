/** @jsxImportSource @opentui/react */
import { testRender } from '@opentui/react/test-utils';
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PermissionRequest } from '../ui/permBridge.js';
import {
  PermissionModal,
  computePermissionBudget,
  formatDetail,
  isCommandTool,
} from './PermissionModal.js';

/**
 * mockInput presses that drive a React state update need act() to flush
 * before assertions run — confirmed empirically against SecretInputModal
 * (setValue silently never took effect without it). Works for pressKey()
 * and every named helper EXCEPT pressEscape(): act() suppresses Escape's
 * dispatch entirely (confirmed via a raw useKeyboard probe — the event
 * never fires inside act(), only outside it). Escape uses a separate
 * plain-wait helper below for that reason, not out of inconsistency.
 */
async function pressAndFlush(
  setup: Awaited<ReturnType<typeof testRender>>,
  press: () => void,
): Promise<void> {
  await act(async () => {
    press();
    await setup.renderOnce();
  });
  // See SecretInputModal.test.tsx's identical helper: a rapid sequence of
  // these calls silently drops the last press without a real settle tick.
  await new Promise((resolve) => setTimeout(resolve, 10));
}

/** Escape-only: see pressAndFlush's doc comment — act() suppresses Escape's
 *  dispatch, so this waits on a real timer tick outside of it instead. */
async function pressEscapeAndWait(setup: Awaited<ReturnType<typeof testRender>>): Promise<void> {
  setup.mockInput.pressEscape();
  await new Promise((resolve) => setTimeout(resolve, 50));
}

function req(overrides: Partial<PermissionRequest>): PermissionRequest {
  return {
    tool: 'shell',
    summary: 'shell: curl …',
    detail: '',
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

async function renderModal(node: Parameters<typeof testRender>[0], height = 30) {
  const setup = await testRender(node, { width: 100, height });
  cleanup = () => setup.renderer.destroy();
  await setup.renderOnce();
  return setup;
}

describe('isCommandTool', () => {
  it('flags command/payload tools and ignores others', () => {
    for (const t of ['shell', 'bash', 'BashTool', 'http', 'file_write', 'file_edit']) {
      expect(isCommandTool(t)).toBe(true);
    }
    for (const t of ['web_fetch', 'ask_user', 'coverage', 'confirm_finding']) {
      expect(isCommandTool(t)).toBe(false);
    }
  });
});

describe('computePermissionBudget', () => {
  it('keeps banner + chat min + footer ≤ terminal rows (incl. short windows)', () => {
    for (const rows of [10, 14, 16, 24, 40, 60]) {
      const bannerHeight = 4;
      const chatMin = 3;
      const { footerHeight, maxDetailLines } = computePermissionBudget({
        terminalRows: rows,
        bannerHeight,
        chatMinHeight: chatMin,
      });
      expect(bannerHeight + chatMin + footerHeight).toBeLessThanOrEqual(rows);
      expect(maxDetailLines).toBeGreaterThanOrEqual(0);
      expect(footerHeight).toBeLessThanOrEqual(Math.max(0, rows - bannerHeight - chatMin));
    }
  });

  it('shrinks the command body on short terminals', () => {
    const short = computePermissionBudget({
      terminalRows: 16,
      bannerHeight: 4,
      chatMinHeight: 3,
    });
    const tall = computePermissionBudget({
      terminalRows: 50,
      bannerHeight: 4,
      chatMinHeight: 3,
    });
    expect(short.maxDetailLines).toBeLessThanOrEqual(tall.maxDetailLines);
    expect(short.footerHeight).toBeLessThanOrEqual(tall.footerHeight);
    // 16 rows / banner 4 / chat 3 → available 9 → chrome 8 + 1 detail
    expect(short.maxDetailLines).toBe(1);
    expect(short.footerHeight).toBe(9);
  });
});

describe('formatDetail', () => {
  it('counts the elision cue inside maxLines so body rows never overshoot', () => {
    const raw = Array.from({ length: 20 }, (_, i) => `line-${i}`).join('\n');
    const { lines, elided } = formatDetail(raw, 8000, 4, 80);
    expect(elided).toMatch(/more line/);
    // content lines + elision cue ≤ 4
    expect(lines.length).toBeLessThanOrEqual(3);
    expect(lines.length + (elided ? 1 : 0)).toBeLessThanOrEqual(4);
  });

  it('never paints more than maxLines body rows when maxLines is 1', () => {
    const raw = Array.from({ length: 40 }, (_, i) => `line-${i}`).join('\n');
    const { lines, elided } = formatDetail(raw, 8000, 1, 40);
    // Single slot: truncated head with "…", no separate elision row.
    expect(lines.length + (elided ? 1 : 0)).toBeLessThanOrEqual(1);
    expect(lines.length).toBe(1);
    expect(lines[0]).toMatch(/…$/);
  });

  it('returns chrome-only body when maxLines is 0', () => {
    const raw = Array.from({ length: 5 }, (_, i) => `line-${i}`).join('\n');
    const { lines, elided } = formatDetail(raw, 8000, 0, 40);
    expect(lines).toEqual([]);
    expect(elided).toBeNull();
  });
});

describe('PermissionModal short-terminal budget', () => {
  it('keeps actions + truncation cue visible under a 16-row budget', async () => {
    const budget = computePermissionBudget({
      terminalRows: 16,
      bannerHeight: 4,
      chatMinHeight: 3,
    });
    const longCmd = Array.from({ length: 30 }, (_, i) => `line-${i}`).join('\n');
    const setup = await renderModal(
      <PermissionModal
        req={req({ tool: 'shell', detail: longCmd })}
        maxDetailLines={budget.maxDetailLines}
        maxHeight={budget.footerHeight}
        maxWidth={80}
      />,
      16,
    );
    const frame = setup.captureCharFrame();
    expect(frame).toMatch(/\[y\]/);
    expect(frame).toMatch(/\[n\]/);
    // maxDetailLines=1 folds cue into the head line with "…"
    expect(frame).toMatch(/…|more line|truncated|chars cut/i);
    // Must not dump the whole payload into a 16-row window.
    expect((frame.match(/line-\d+/g) ?? []).length).toBeLessThan(8);
  });
});

describe('PermissionModal rendering', () => {
  it('shows a shell-focused permission card with $ command box', async () => {
    const setup = await renderModal(
      <PermissionModal
        req={req({
          tool: 'shell',
          summary: 'Run curl on this machine',
          detail: "curl -s 'https://target.test/api'",
        })}
      />,
    );
    const frame = setup.captureCharFrame();
    expect(frame).toMatch(/PERMISSION/i);
    expect(frame).toMatch(/Shell command/i);
    expect(frame).toContain('$');
    expect(frame).toContain('curl -s');
    expect(frame).toMatch(/\[y\].*once/i);
    expect(frame).toMatch(/\[a\].*session/i);
    expect(frame).toMatch(/\[n\].*deny/i);
  });

  it('keeps the head of a long command and notes elided lines', async () => {
    const longCmd = `curl -s -X POST 'https://target.test/api/login'\n${'line\n'.repeat(40)}END`;
    expect(longCmd.length).toBeGreaterThan(100);
    const setup = await renderModal(
      <PermissionModal req={req({ tool: 'shell', detail: longCmd })} maxDetailLines={4} />,
      40,
    );
    const frame = setup.captureCharFrame();
    expect(frame).toContain('curl -s -X POST');
    // Height-capped: tail is elided with a "more lines" cue.
    expect(frame).toMatch(/more line/);
  });

  it('respects a tight maxDetailLines so short terminals stay on-screen', async () => {
    const longCmd = Array.from({ length: 30 }, (_, i) => `line-${i}`).join('\n');
    const setup = await renderModal(
      <PermissionModal
        req={req({ tool: 'shell', detail: longCmd })}
        maxDetailLines={2}
        maxWidth={60}
      />,
      20,
    );
    const frame = setup.captureCharFrame();
    expect(frame).toContain('line-0');
    expect(frame).toMatch(/more line/);
    expect(frame).toMatch(/\[y\]/);
    // Body should not dump all 30 lines into a short viewport.
    expect((frame.match(/line-\d+/g) ?? []).length).toBeLessThan(8);
  });

  it('caps a pathologically long command but keeps the head', async () => {
    const huge = `echo ${'A'.repeat(9000)}`;
    const setup = await renderModal(
      <PermissionModal req={req({ tool: 'shell', detail: huge })} />,
      40,
    );
    const frame = setup.captureCharFrame();
    expect(frame).toContain('echo');
    expect(frame).toMatch(/A{20,}/);
    // Char cap and/or line cap leave an elision cue.
    expect(frame).toMatch(/truncated|more line|chars cut/i);
  });
});

// Real key-interaction coverage — this is the actual risk Phase 3 exists to
// de-risk (does useKeyboard's KeyEvent.name comparison correctly replace
// Ink's two-argument (input, key) callback), not just visual rendering.
describe('PermissionModal key handling', () => {
  it('resolves allow-once on "y"', async () => {
    const request = req({});
    const setup = await renderModal(<PermissionModal req={request} />);
    await pressAndFlush(setup, () => setup.mockInput.pressKey('y'));
    expect(request.resolve).toHaveBeenCalledWith('allow-once');
  });

  it('resolves allow-session on "a"', async () => {
    const request = req({});
    const setup = await renderModal(<PermissionModal req={request} />);
    await pressAndFlush(setup, () => setup.mockInput.pressKey('a'));
    expect(request.resolve).toHaveBeenCalledWith('allow-session');
  });

  it('resolves deny on "n"', async () => {
    const request = req({});
    const setup = await renderModal(<PermissionModal req={request} />);
    await pressAndFlush(setup, () => setup.mockInput.pressKey('n'));
    expect(request.resolve).toHaveBeenCalledWith('deny');
  });

  it('resolves deny on Escape', async () => {
    const request = req({});
    const setup = await renderModal(<PermissionModal req={request} />);
    await pressEscapeAndWait(setup);
    expect(request.resolve).toHaveBeenCalledWith('deny');
  });

  it('ignores unrelated keys', async () => {
    const request = req({});
    const setup = await renderModal(<PermissionModal req={request} />);
    setup.mockInput.pressKey('x');
    setup.mockInput.pressArrow('up');
    expect(request.resolve).not.toHaveBeenCalled();
  });
});

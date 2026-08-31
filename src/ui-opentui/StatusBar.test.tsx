/** @jsxImportSource @opentui/react */
import { testRender } from '@opentui/react/test-utils';
import { afterEach, describe, expect, it } from 'vitest';
import type { StatusProps } from '../ui/StatusBar.js';
import { StatusBar, fitSegments } from './StatusBar.js';

const base: StatusProps = {
  busy: false,
  apiReady: true,
  activeSkill: null,
  yolo: false,
  ctxTokens: 0,
  compactThreshold: 16000,
  memoryItems: 0,
  phase: 'idle',
  transcriptFilter: 'all',
  expandHint: false,
};

let cleanup: (() => void) | undefined;
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
});

async function renderFrame(
  props: StatusProps & { maxWidth?: number },
  width = 80,
): Promise<string> {
  const setup = await testRender(<StatusBar {...props} />, { width, height: 5 });
  cleanup = () => setup.renderer.destroy();
  await setup.renderOnce();
  return setup.captureCharFrame();
}

describe('StatusBar', () => {
  it('shows a quiet idle line: Ready · model · target', async () => {
    const frame = await renderFrame({
      ...base,
      model: 'qwen3:14b',
      ctxTokens: 1000, // low — should not show ctx
      target: 'https://example.test/',
    });
    expect(frame).toContain('Ready');
    expect(frame).toContain('qwen3:14b');
    expect(frame).toContain('example.test');
    expect(frame).not.toMatch(/ctx ~/);
    expect(frame).not.toContain('tools ready');
  });

  it('shows Offline when the API is not ready', async () => {
    const frame = await renderFrame({ ...base, apiReady: false });
    expect(frame).toContain('Offline');
  });

  it('names the running tool and elapsed clock while busy (no Esc spam)', async () => {
    const frame = await renderFrame({
      ...base,
      busy: true,
      phase: 'running-tool',
      runningTool: 'shell',
      elapsedSeconds: 65,
    });
    expect(frame).toContain('shell');
    expect(frame).toContain('1:05');
    expect(frame).not.toContain('Esc to cancel');
  });

  it('shows the YOLO badge pinned right when on', async () => {
    const on = await renderFrame({ ...base, yolo: true });
    expect(on).toContain('YOLO');
    const off = await renderFrame({ ...base, yolo: false });
    expect(off).not.toContain('YOLO');
  });

  it('surfaces no-tools warning but hides tools-ok noise', async () => {
    const yes = await renderFrame({ ...base, toolSupport: 'yes' });
    expect(yes).not.toContain('tools ready');
    const no = await renderFrame({ ...base, toolSupport: 'no' });
    expect(no).toMatch(/[Nn]o tools/);
  });

  it('shows ctx only when the window is getting full', async () => {
    const frame = await renderFrame({
      ...base,
      ctxTokens: 14000,
      compactThreshold: 16000,
    });
    expect(frame).toMatch(/ctx/);
  });
});

describe('fitSegments', () => {
  it('keeps priority-0 and drops the highest priority numbers first', () => {
    const kept = fitSegments(
      [
        { text: 'ready', color: 'green', priority: 0 },
        { text: ' · model', color: 'gray', priority: 3 },
        { text: ' · noise', color: 'gray', priority: 6 },
      ],
      12,
    );
    const joined = kept.map((s) => s.text).join('');
    expect(joined).toContain('ready');
    expect(joined).not.toContain('noise');
  });
});

/** @jsxImportSource @opentui/react */
import { testRender } from '@opentui/react/test-utils';
import { afterEach, describe, expect, it } from 'vitest';
import { type BannerData, compactPath, ellipsize, packMetaLine } from '../ui/Banner.js';
import { Banner } from './Banner.js';

const base: BannerData = {
  provider: 'ollama',
  state: 'local',
  model: 'qwen2.5-coder:14b',
  cwd: '~/Research/target',
  version: '0.1.0-dev',
};

describe('Banner helpers (re-exported from ../ui/Banner.js)', () => {
  it('packs provider · ctx · tools without a model name', () => {
    const line = packMetaLine({
      provider: 'ollama (local)',
      ctx: '32.8k',
      pill: 'tools ready',
      budget: 60,
    });
    expect(line).toContain('ollama (local)');
    expect(line).toContain('tools ready');
  });
  it('ellipsize + compactPath still work', () => {
    expect(ellipsize('abcdefghij', 5)).toContain('…');
    expect(compactPath('~/Research/pentesterflow-ink', 20)).toBe('…/pentesterflow-ink');
  });
});

let cleanup: (() => void) | undefined;
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
});

async function renderFrame(node: Parameters<typeof testRender>[0], width = 80): Promise<string> {
  const setup = await testRender(node, { width, height: 10 });
  cleanup = () => setup.renderer.destroy();
  await setup.renderOnce();
  return setup.captureCharFrame();
}

describe('Banner', () => {
  it('renders a small mini PF monogram plus meta', async () => {
    const frame = await renderFrame(<Banner data={base} width={80} />, 80);
    expect(frame).toContain('█▀█');
    expect(frame).toContain('PentesterFlow');
    expect(frame).toContain('v0.1.0-dev');
    expect(frame).toContain('ollama');
    expect(frame).toContain('~/Research/target');
    expect(frame).not.toContain('qwen2.5-coder:14b');
    expect(frame).not.toContain('╭');
  });

  it('compact mode stays a single quiet line', async () => {
    const frame = await renderFrame(<Banner data={base} width={80} compact />, 80);
    expect(frame).toContain('PF');
    expect(frame).toContain('v0.1.0-dev');
  });

  it('only shows tools status when it is a problem', async () => {
    const ok = await renderFrame(<Banner data={{ ...base, toolSupport: 'yes' }} width={80} />, 80);
    expect(ok).not.toContain('tools ready');

    const bad = await renderFrame(<Banner data={{ ...base, toolSupport: 'no' }} width={80} />, 80);
    expect(bad).toContain('NO TOOLS');
  });

  it('does not surface endpoint or session status', async () => {
    const frame = await renderFrame(
      <Banner
        data={{
          ...base,
          endpoint: 'https://example.proxy.runpod.net',
          status: 'Session abc123 — type /help to begin',
        }}
        width={80}
      />,
      80,
    );
    expect(frame).not.toContain('Endpoint');
    expect(frame).not.toContain('runpod');
    expect(frame).not.toContain('Session');
  });
});

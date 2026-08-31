/** @jsxImportSource @opentui/react */
import { testRender } from '@opentui/react/test-utils';
import { afterEach, describe, expect, it } from 'vitest';
import type { BannerData } from '../ui/Banner.js';
import type { TranscriptEntry } from '../ui/state.js';
import { ChatPane } from './ChatPane.js';

const banner: BannerData = {
  provider: 'Ollama',
  model: 'qwen3',
  state: 'local',
  cwd: '/tmp/target',
  version: '0.1.0-dev',
};

function entry(text: string): TranscriptEntry {
  return { kind: 'system', text };
}

let cleanup: (() => void) | undefined;
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
});

async function renderFrame(props: Partial<Parameters<typeof ChatPane>[0]> = {}): Promise<string> {
  const setup = await testRender(
    <ChatPane
      committed={[]}
      liveEntry={undefined}
      bannerData={banner}
      compactMode={true}
      width={60}
      height={8}
      scrollOffset={0}
      {...props}
    />,
    { width: 60, height: 15 },
  );
  cleanup = () => setup.renderer.destroy();
  await setup.renderOnce();
  return setup.captureCharFrame();
}

describe('ChatPane', () => {
  it('keeps the empty chat pane free of a personalized greeting', async () => {
    const text = await renderFrame({ committed: [] });
    expect(text).toContain('PF');
    expect(text).not.toContain('Hello ');
    expect(text).not.toContain('The World');
    expect(text).not.toContain('🧑‍💻');
  });

  it('shows the banner once above the scrollable log', async () => {
    const text = await renderFrame({ committed: [entry('first entry')] });
    expect(text).toContain('PF');
    expect(text).toContain('first entry');
  });

  it('windows to only the tail when content exceeds the viewport', async () => {
    const committed = Array.from({ length: 30 }, (_, i) => entry(`line ${i}`));
    const text = await renderFrame({ committed, height: 8 });
    expect(text).toContain('line 29');
    expect(text).not.toContain('line 0\n');
  });

  it('reveals earlier rows when scrollOffset increases, clamped to available history', async () => {
    const committed = Array.from({ length: 30 }, (_, i) => entry(`line ${i}`));
    // maxOffset ≈ 30 rows - (8 viewport - 1 scroll cue); an oversized request
    // (e.g. Home) clamps there instead of going out of bounds.
    const text = await renderFrame({ committed, height: 8, scrollOffset: 999 });
    expect(text).not.toContain('line 29');
    expect(text).toContain('line 0');
    expect(text).toMatch(/↑|PgUp|more above|latest/i);
  });

  it('wraps a long logical line into multiple physical viewport rows', async () => {
    const long = 'W'.repeat(80);
    const committed = [entry(long)];
    // width 60 in renderFrame → wrap budget 59; one 80-char line becomes 2 rows.
    const text = await renderFrame({ committed, height: 8, width: 40 });
    expect(text).toContain('WWWW');
    // Both halves of the wrapped run should be visible in a tall enough pane.
    expect((text.match(/W/g) ?? []).length).toBeGreaterThanOrEqual(80);
  });

  it('shows the live streaming entry appended after committed rows', async () => {
    const text = await renderFrame({
      committed: [entry('done already')],
      liveEntry: { kind: 'assistant', text: 'partial answer', streaming: true },
      height: 8,
    });
    expect(text).toContain('done already');
    expect(text).toContain('partial answer');
  });

  it('renders markdown code fences without raw backticks or escape garbage', async () => {
    const md = [
      '## Finding',
      '',
      'Use `curl` against the API:',
      '',
      '```js',
      'const x = 1;',
      'console.log(x);',
      '```',
    ].join('\n');
    const text = await renderFrame({
      committed: [{ kind: 'assistant', text: md }],
      height: 20,
      width: 60,
    });
    expect(text).toContain('Finding');
    expect(text).toContain('curl');
    expect(text).toContain('const x = 1');
    expect(text).toContain('1│');
    expect(text).not.toContain('```');
    // No leaked SGR digits from undecoded ANSI.
    expect(text).not.toMatch(/\[1m|\[22m|\[36m/);
  });
});

import { hangIndentForPlain } from './ChatPane.js';

describe('hangIndentForPlain', () => {
  it('hangs under a code gutter after NN│', () => {
    expect(hangIndentForPlain('  1│ const x', 2)).toBe('  1│ '.length);
    expect(hangIndentForPlain(' 12│ body', 2)).toBe(' 12│ '.length);
  });

  it('falls back to the role indent width', () => {
    expect(hangIndentForPlain('  hello', 2)).toBe(2);
  });
});

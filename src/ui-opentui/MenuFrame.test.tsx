/** @jsxImportSource @opentui/react */
import { testRender } from '@opentui/react/test-utils';
import { afterEach, describe, expect, it } from 'vitest';
import type { SlashItem } from '../ui/slashItems.js';
import { MentionMenu } from './MentionMenu.js';
import { SlashMenu } from './SlashMenu.js';

const items: SlashItem[] = [
  { name: '/help', description: 'show keybindings' },
  { name: '/provider', description: 'pick backend' },
  { name: '/model', args: '<id>', description: 'switch model' },
];

let cleanup: (() => void) | undefined;
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
});

async function renderFrame(node: Parameters<typeof testRender>[0]): Promise<string> {
  const setup = await testRender(node, { width: 80, height: 20 });
  cleanup = () => setup.renderer.destroy();
  await setup.renderOnce();
  return setup.captureCharFrame();
}

describe('SlashMenu', () => {
  it('renders framed chrome with caret on the selected row', async () => {
    const frame = await renderFrame(<SlashMenu items={items} selected={1} />);
    expect(frame).toContain('COMMANDS');
    expect(frame).toContain('/help');
    expect(frame).toContain('/provider');
    expect(frame).toContain('pick backend');
    expect(frame).toContain('›');
    expect(frame).toMatch(/↑↓|Enter|Esc/);
  });

  it('aligns secondary descriptions on a shared column', async () => {
    const frame = await renderFrame(<SlashMenu items={items} selected={0} />);
    // Descriptions should appear; padded primary column keeps them column-aligned.
    const lines = frame.split('\n').filter((l) => l.includes('/help') || l.includes('/model'));
    expect(lines.length).toBeGreaterThanOrEqual(2);
    const helpIdx = lines[0]?.indexOf('show keybindings') ?? -1;
    const modelIdx = lines.find((l) => l.includes('/model'))?.indexOf('switch model') ?? -1;
    // Same column (or very close — trailing padding can absorb glyph width).
    if (helpIdx >= 0 && modelIdx >= 0) {
      expect(Math.abs(helpIdx - modelIdx)).toBeLessThanOrEqual(2);
    }
  });

  it('renders nothing for an empty list', async () => {
    const frame = await renderFrame(<SlashMenu items={[]} selected={0} />);
    expect(frame.trim()).toBe('');
  });
});

describe('MentionMenu', () => {
  it('renders framed file picker with path subtitle', async () => {
    const frame = await renderFrame(
      <MentionMenu
        cwd="src/ui"
        selected={0}
        candidates={[
          { display: 'components/', insert: 'components/', isDir: true },
          { display: 'Banner.tsx', insert: 'Banner.tsx', isDir: false },
        ]}
      />,
    );
    expect(frame).toContain('FILES');
    expect(frame).toContain('@ src/ui');
    expect(frame).toContain('components/');
    expect(frame).toContain('Banner.tsx');
    expect(frame).toContain('›');
  });
});

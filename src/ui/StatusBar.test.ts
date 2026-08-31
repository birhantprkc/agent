import { describe, expect, it } from 'vitest';
import {
  compactModelName,
  formatCtxLabel,
  formatElapsed,
  formatTokenCount,
  phaseLabel,
} from './StatusBar.js';

describe('formatElapsed', () => {
  it('formats seconds as m:ss', () => {
    expect(formatElapsed(0)).toBe('0:00');
    expect(formatElapsed(42)).toBe('0:42');
    expect(formatElapsed(125)).toBe('2:05');
    expect(formatElapsed(3700)).toBe('61:40');
  });
});

describe('formatTokenCount / formatCtxLabel', () => {
  it('compacts token counts', () => {
    expect(formatTokenCount(512)).toBe('512');
    expect(formatTokenCount(16000)).toBe('16k');
  });
  it('formats ctx vs compact threshold', () => {
    expect(formatCtxLabel(9400, 16000)).toBe('ctx ~9.4k/16k');
    expect(formatCtxLabel(0, 16000)).toBeNull();
  });
});

describe('compactModelName / phaseLabel', () => {
  it('shortens long model ids', () => {
    const long = 'org/really-long-model-name-with-quant:Q4_K_M';
    const out = compactModelName(long);
    expect(out.length).toBeLessThanOrEqual(28);
    expect(out).toContain('…');
  });
  it('uses production phase labels', () => {
    expect(phaseLabel('planning')).toBe('Thinking');
    expect(phaseLabel('running-tool')).toBe('Running tool');
    expect(phaseLabel('answering')).toBe('Writing');
    expect(phaseLabel('idle')).toBe('Ready');
  });
});

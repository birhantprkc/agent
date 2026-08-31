import { describe, expect, it } from 'vitest';
import { wrapRowToWidth, wrapRowsToWidth } from './wrapRows.js';

describe('wrapRowToWidth', () => {
  it('leaves short rows alone', () => {
    const row = {
      key: 'r0',
      spans: [{ text: 'hello' }],
      baseColor: 'white',
      baseDim: false,
    };
    expect(wrapRowToWidth(row, 20)).toEqual([row]);
  });

  it('splits a long plain row into physical chunks', () => {
    const row = {
      key: 'r0',
      spans: [{ text: 'abcdefghij' }],
      baseColor: 'white',
      baseDim: false,
    };
    const parts = wrapRowToWidth(row, 4);
    expect(parts.map((p) => p.spans.map((s) => s.text).join(''))).toEqual(['abcd', 'efgh', 'ij']);
    expect(parts.every((p) => p.baseColor === 'white')).toBe(true);
  });

  it('preserves span styling across a wrap boundary', () => {
    const row = {
      key: 'r0',
      spans: [
        { text: 'ab', bold: true as const },
        { text: 'cdef', fg: 'cyan' },
      ],
      baseColor: 'white',
      baseDim: false,
    };
    const parts = wrapRowToWidth(row, 4);
    expect(parts).toHaveLength(2);
    expect(parts[0]?.spans).toEqual([
      { text: 'ab', bold: true },
      { text: 'cd', fg: 'cyan' },
    ]);
    expect(parts[1]?.spans).toEqual([{ text: 'ef', fg: 'cyan' }]);
  });

  it('treats embedded newlines as hard breaks', () => {
    const row = {
      key: 'r0',
      spans: [{ text: 'aa\nbbb' }],
      baseColor: 'white',
      baseDim: false,
    };
    const parts = wrapRowToWidth(row, 10);
    expect(parts.map((p) => p.spans.map((s) => s.text).join(''))).toEqual(['aa', 'bbb']);
  });

  it('keeps empty rows as a single blank physical line', () => {
    const row = {
      key: 'blank',
      spans: [{ text: '' }],
      baseColor: 'gray',
      baseDim: true,
    };
    expect(wrapRowToWidth(row, 40)).toEqual([row]);
  });

  it('hang-indents continuation physical lines under the role prefix', () => {
    // "⏺ " (2 cells) + body; wrap at 8 so body continues on next line.
    const row = {
      key: 'tool',
      spans: [{ text: '⏺ abcdefghij' }],
      baseColor: 'white',
      baseDim: false,
      hangIndent: 2,
    };
    const parts = wrapRowToWidth(row, 8);
    const texts = parts.map((p) => p.spans.map((s) => s.text).join(''));
    // First physical line fills 8 cells; next lines start with 2 spaces.
    expect(texts[0]).toBe('⏺ abcdef');
    expect(texts[1]?.startsWith('  ')).toBe(true);
    expect(texts.join('').replace(/ /g, '')).toContain('abcdefghij'.replace(/ /g, ''));
  });
});

describe('wrapRowsToWidth', () => {
  it('expands a mix of short and long rows', () => {
    const rows = [
      { key: 'a', spans: [{ text: 'ok' }], baseColor: 'white', baseDim: false },
      { key: 'b', spans: [{ text: '12345678' }], baseColor: 'white', baseDim: false },
    ];
    const out = wrapRowsToWidth(rows, 4);
    expect(out).toHaveLength(3);
    expect(out.map((r) => r.spans.map((s) => s.text).join(''))).toEqual(['ok', '1234', '5678']);
  });
});

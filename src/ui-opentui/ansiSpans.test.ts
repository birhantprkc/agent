import { describe, expect, it } from 'vitest';
import { ansiToSpans, stripAnsi, xterm256ToColor } from './ansiSpans.js';

const ESC = String.fromCharCode(27);
const bold = (s: string) => `${ESC}[1m${s}${ESC}[22m`;
const cyan = (s: string) => `${ESC}[36m${s}${ESC}[39m`;
const dim = (s: string) => `${ESC}[2m${s}${ESC}[22m`;

describe('ansiToSpans', () => {
  it('returns a single unstyled segment for plain text', () => {
    expect(ansiToSpans('hello world')).toEqual([{ text: 'hello world' }]);
  });

  it('returns nothing for an empty string', () => {
    expect(ansiToSpans('')).toEqual([]);
  });

  it('decodes bold', () => {
    const spans = ansiToSpans(`before ${bold('BOLD')} after`);
    expect(spans).toEqual([{ text: 'before ' }, { text: 'BOLD', bold: true }, { text: ' after' }]);
  });

  it('decodes a basic named fg color', () => {
    const spans = ansiToSpans(cyan('code'));
    expect(spans).toEqual([{ text: 'code', fg: 'cyan' }]);
  });

  it('decodes dim', () => {
    const spans = ansiToSpans(dim('muted'));
    expect(spans).toEqual([{ text: 'muted', dim: true }]);
  });

  it('decodes 38;2 truecolor as a hex fg', () => {
    const spans = ansiToSpans(`${ESC}[38;2;217;119;87mcoral${ESC}[39m`);
    expect(spans).toEqual([{ text: 'coral', fg: '#d97757' }]);
  });

  it('decodes 38;5 256-color fg', () => {
    const spans = ansiToSpans(`${ESC}[38;5;196mhot${ESC}[39m`);
    expect(spans).toHaveLength(1);
    expect(spans[0]?.text).toBe('hot');
    expect(spans[0]?.fg).toBeTruthy();
  });

  it('resets all attributes on code 0', () => {
    const spans = ansiToSpans(`${ESC}[1;36mstyled${ESC}[0mplain`);
    expect(spans).toEqual([{ text: 'styled', bold: true, fg: 'cyan' }, { text: 'plain' }]);
  });

  it('round-trips synthetic markdown-like SGR without escape garbage', () => {
    const rendered = `This is ${bold('bold')} and ${cyan('code')}.`;
    const spans = ansiToSpans(rendered);
    const joined = spans.map((s) => s.text).join('');
    expect(joined).toBe('This is bold and code.');
    expect(joined).not.toContain(ESC);
    expect(spans.some((s) => s.bold)).toBe(true);
    expect(spans.some((s) => s.fg === 'cyan')).toBe(true);
  });

  it('decodes a code-gutter + highlighted token line', () => {
    // Mimics renderFencedBlock: dim gutter + colored keyword.
    const line = `${dim('1│')} ${ESC}[34mconst${ESC}[39m x = ${ESC}[32m1${ESC}[39m;`;
    const spans = ansiToSpans(`  ${line}`);
    const joined = spans.map((s) => s.text).join('');
    expect(joined).toBe('  1│ const x = 1;');
    expect(joined).not.toMatch(/\[\d+m/);
    expect(spans.some((s) => s.dim && s.text.includes('│'))).toBe(true);
    expect(spans.some((s) => s.fg === 'blue' && s.text === 'const')).toBe(true);
    expect(spans.some((s) => s.fg === 'green' && s.text === '1')).toBe(true);
  });
});

describe('xterm256ToColor', () => {
  it('maps the basic 16 and a cube entry', () => {
    expect(xterm256ToColor(1)).toBe('red');
    expect(xterm256ToColor(196)).toMatch(/^#/);
    expect(xterm256ToColor(255)).toMatch(/^#/);
  });
});

describe('stripAnsi', () => {
  it('removes SGR sequences', () => {
    expect(stripAnsi(`${bold('x')}${cyan('y')}`)).toBe('xy');
  });
});

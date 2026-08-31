// ANSI SGR escape codes → styled segments, for rendering strings that came
// through chalk (../ui/markdown.ts, ../ui/toolResultFormat.ts, cli-highlight
// inside markdown.ts's fenced code blocks — all Ink-era, all assume the
// receiving <Text> passes embedded ANSI straight through to the real
// terminal, same as Ink's own <Text> does).
//
// OpenTUI's <text>/<span> do NOT interpret embedded ANSI — it's a character-
// grid compositor, not a raw-byte terminal passthrough, so a chalk string
// fed directly into <text> renders the escape bytes as literal garbage
// (confirmed: "\x1b[1mbold\x1b[22m" showed up on-screen as literal
// "[1mbold[22m"). This module decodes the same SGR codes chalk / highlight.js
// emit (bold/dim/italic/underline/reset, basic 16-color, 256-color 38;5/48;5,
// and 38;2/48;2 truecolor) back into {text, fg, bg, bold, dim, italic,
// underline} segments that ChatPane.tsx renders as sibling <span>s.

export interface AnsiSpan {
  text: string;
  fg?: string;
  bg?: string;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
}

const ESC = String.fromCharCode(27);
const SGR_RE = new RegExp(`${ESC}\\[([0-9;]*)m`, 'g');

const BASIC_FG: Record<number, string> = {
  30: 'black',
  31: 'red',
  32: 'green',
  33: 'yellow',
  34: 'blue',
  35: 'magenta',
  36: 'cyan',
  37: 'white',
  90: 'gray',
  91: 'red',
  92: 'green',
  93: 'yellow',
  94: 'blue',
  95: 'magenta',
  96: 'cyan',
  97: 'white',
};

const BASIC_BG: Record<number, string> = {
  40: 'black',
  41: 'red',
  42: 'green',
  43: 'yellow',
  44: 'blue',
  45: 'magenta',
  46: 'cyan',
  47: 'white',
  100: 'gray',
  101: 'red',
  102: 'green',
  103: 'yellow',
  104: 'blue',
  105: 'magenta',
  106: 'cyan',
  107: 'white',
};

/** xterm 256-color index 0–15 → named/basic colors. */
const XTERM16: string[] = [
  'black',
  'red',
  'green',
  'yellow',
  'blue',
  'magenta',
  'cyan',
  'white',
  'gray',
  'red',
  'green',
  'yellow',
  'blue',
  'magenta',
  'cyan',
  'white',
];

interface RunState {
  fg?: string;
  bg?: string;
  bold: boolean;
  dim: boolean;
  italic: boolean;
  underline: boolean;
}

function freshState(): RunState {
  return { bold: false, dim: false, italic: false, underline: false };
}

function clampByte(n: number): number {
  return Math.max(0, Math.min(255, Math.round(n)));
}

function rgbHex(r: number, g: number, b: number): string {
  const h = (n: number) => clampByte(n).toString(16).padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}`;
}

/** Map an xterm 256-color palette index to a CSS/OpenTUI color string. */
export function xterm256ToColor(index: number): string {
  const i = Math.max(0, Math.min(255, Math.floor(index)));
  if (i < 16) return XTERM16[i] ?? 'white';
  if (i >= 232) {
    // Grayscale ramp 232–255 → 0..255
    const level = 8 + (i - 232) * 10;
    return rgbHex(level, level, level);
  }
  // 6×6×6 color cube 16–231
  const c = i - 16;
  const r = Math.floor(c / 36);
  const g = Math.floor((c % 36) / 6);
  const b = c % 6;
  const to = (v: number) => (v === 0 ? 0 : 55 + v * 40);
  return rgbHex(to(r), to(g), to(b));
}

/** Visible width of a string after ANSI SGR escapes are stripped. */
export function stripAnsi(s: string): string {
  return s.replace(SGR_RE, '');
}

/** Decode a chalk/cli-highlight string into styled segments. Safe on plain
 *  text with no ANSI at all — returns a single unstyled segment. */
export function ansiToSpans(s: string): AnsiSpan[] {
  if (!s) return [];
  const spans: AnsiSpan[] = [];
  let state = freshState();
  let lastIndex = 0;
  SGR_RE.lastIndex = 0;

  const flush = (text: string) => {
    if (!text) return;
    spans.push({
      text,
      fg: state.fg,
      bg: state.bg,
      bold: state.bold || undefined,
      dim: state.dim || undefined,
      italic: state.italic || undefined,
      underline: state.underline || undefined,
    });
  };

  let match: RegExpExecArray | null = SGR_RE.exec(s);
  while (match !== null) {
    if (match.index > lastIndex) flush(s.slice(lastIndex, match.index));
    const codes = (match[1] ?? '')
      .split(';')
      .filter((c) => c.length > 0)
      .map(Number);
    if (codes.length === 0) codes.push(0);

    for (let i = 0; i < codes.length; i += 1) {
      const code = codes[i];
      if (code === 0) state = freshState();
      else if (code === 1) state.bold = true;
      else if (code === 2) state.dim = true;
      else if (code === 3) state.italic = true;
      else if (code === 4) state.underline = true;
      else if (code === 22) {
        state.bold = false;
        state.dim = false;
      } else if (code === 23) state.italic = false;
      else if (code === 24) state.underline = false;
      else if (code === 39) state.fg = undefined;
      else if (code === 49) state.bg = undefined;
      else if (code === 38 && codes[i + 1] === 2) {
        // 38;2;r;g;b truecolor
        state.fg = rgbHex(codes[i + 2] ?? 0, codes[i + 3] ?? 0, codes[i + 4] ?? 0);
        i += 4;
      } else if (code === 48 && codes[i + 1] === 2) {
        state.bg = rgbHex(codes[i + 2] ?? 0, codes[i + 3] ?? 0, codes[i + 4] ?? 0);
        i += 4;
      } else if (code === 38 && codes[i + 1] === 5) {
        // 38;5;n 256-color fg (cli-highlight / some chalk themes)
        state.fg = xterm256ToColor(codes[i + 2] ?? 0);
        i += 2;
      } else if (code === 48 && codes[i + 1] === 5) {
        state.bg = xterm256ToColor(codes[i + 2] ?? 0);
        i += 2;
      } else if (code !== undefined && BASIC_FG[code]) state.fg = BASIC_FG[code];
      else if (code !== undefined && BASIC_BG[code]) state.bg = BASIC_BG[code];
    }
    lastIndex = SGR_RE.lastIndex;
    match = SGR_RE.exec(s);
  }
  if (lastIndex < s.length) flush(s.slice(lastIndex));
  return spans;
}

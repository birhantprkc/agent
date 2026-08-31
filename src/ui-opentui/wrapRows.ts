// Expand logical chat rows into physical terminal rows by wrapping at
// `width` cells. ChatPane used to count one logical line as one viewport
// slot while OpenTUI's text compositor still soft-wrapped long lines to
// multiple physical rows — that desynced the scroll window from what the
// user actually saw. Wrapping here means the JS slice and the paint agree.
//
// Hang indent: when a row wraps, continuation physical lines are padded
// with `hangIndent` spaces so prose/tool bodies stay column-aligned under
// the role prefix (› / ⏺ / ⎿ / │), not flush-left under the glyph.
//
// Measurement is character-count (not east-asian fullwidth / emoji width):
// tool output and assistant prose are overwhelmingly ASCII.

import { cellWidth, graphemes } from '../ui/terminalWidth.js';
import type { AnsiSpan } from './ansiSpans.js';

export interface WrappableRow {
  key: string;
  spans: AnsiSpan[];
  baseColor: string;
  baseDim: boolean;
  /** Spaces to prepend on every physical line after the first (prefix width). */
  hangIndent?: number;
  /** Optional payload preserved across wrap (e.g. click-to-expand source). */
  sourceEntry?: unknown;
}

/** Split one logical row into one-or-more physical rows of at most `width`. */
export function wrapRowToWidth(row: WrappableRow, width: number): WrappableRow[] {
  const w = Math.max(1, width);
  const hang = Math.max(0, Math.min(row.hangIndent ?? 0, w - 1));
  const plain = row.spans.map((s) => s.text).join('');
  if (plain.length === 0) return [row];
  if (!plain.includes('\n') && cellWidth(plain) <= w) return [row];

  const out: WrappableRow[] = [];
  let lineSpans: AnsiSpan[] = [];
  let lineLen = 0;
  let part = 0;
  let isFirstPhys = true;

  const lineBudget = () => (isFirstPhys ? w : Math.max(1, w - hang));

  const flush = () => {
    let spans = lineSpans.length > 0 ? lineSpans : [{ text: '' }];
    // Hang-indent every physical line after the first so wrapped content
    // lines up under the role prefix, not under the left margin.
    if (!isFirstPhys && hang > 0) {
      const pad = ' '.repeat(hang);
      spans = [{ text: pad }, ...spans];
    }
    out.push({
      key: `${row.key}-w${part}`,
      spans,
      baseColor: row.baseColor,
      baseDim: row.baseDim,
      hangIndent: row.hangIndent,
      // Only the first physical line of a collapsible entry is clickable.
      sourceEntry: isFirstPhys ? row.sourceEntry : undefined,
    });
    part += 1;
    lineSpans = [];
    lineLen = 0;
    isFirstPhys = false;
  };

  for (const span of row.spans) {
    let i = 0;
    const text = span.text;
    while (i < text.length) {
      const ch = text[i] ?? '';
      if (ch === '\n') {
        flush();
        i += 1;
        continue;
      }
      const budget = lineBudget();
      if (lineLen >= budget) flush();
      const room = lineBudget() - lineLen;
      let take = 0;
      let consumed = 0;
      for (const grapheme of graphemes(text.slice(i))) {
        if (grapheme === '\n' || take + cellWidth(grapheme) > room) break;
        take += cellWidth(grapheme);
        consumed += grapheme.length;
      }
      if (take === 0) {
        const first = graphemes(text.slice(i))[0];
        if (!first) break;
        consumed = first.length;
        take = Math.max(1, cellWidth(first));
      }
      const piece = text.slice(i, i + consumed);
      lineSpans.push({
        text: piece,
        fg: span.fg,
        bg: span.bg,
        bold: span.bold,
        dim: span.dim,
        italic: span.italic,
        underline: span.underline,
      });
      lineLen += take;
      i += consumed;
    }
  }
  if (lineSpans.length > 0 || out.length === 0) flush();
  return out;
}

/** Expand every logical row; total length is the physical viewport budget. */
export function wrapRowsToWidth(rows: WrappableRow[], width: number): WrappableRow[] {
  const out: WrappableRow[] = [];
  for (const row of rows) {
    out.push(...wrapRowToWidth(row, width));
  }
  return out;
}

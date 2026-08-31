const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

export function graphemes(value: string): string[] {
  return Array.from(segmenter.segment(value), (part) => part.segment);
}

export function cellWidth(value: string): number {
  let width = 0;
  for (const grapheme of graphemes(value)) {
    const first = grapheme.codePointAt(0) ?? 0;
    if (first < 0x20 || (first >= 0x7f && first < 0xa0)) continue;
    if (isCombining(first)) continue;
    width += isWide(first) ? 2 : 1;
  }
  return width;
}

export function sliceToCells(value: string, maxCells: number, suffix = ''): string {
  const limit = Math.max(0, maxCells);
  if (cellWidth(value) <= limit) return value;
  const suffixWidth = cellWidth(suffix);
  const bodyLimit = Math.max(0, limit - suffixWidth);
  let out = '';
  for (const grapheme of graphemes(value)) {
    if (cellWidth(out + grapheme) > bodyLimit) break;
    out += grapheme;
  }
  return out + suffix;
}

function isCombining(codePoint: number): boolean {
  return (
    (codePoint >= 0x300 && codePoint <= 0x36f) ||
    (codePoint >= 0x1ab0 && codePoint <= 0x1aff) ||
    (codePoint >= 0x1dc0 && codePoint <= 0x1dff) ||
    (codePoint >= 0x20d0 && codePoint <= 0x20ff) ||
    (codePoint >= 0xfe20 && codePoint <= 0xfe2f)
  );
}

function isWide(codePoint: number): boolean {
  return (
    (codePoint >= 0x1100 && codePoint <= 0x115f) ||
    (codePoint >= 0x2329 && codePoint <= 0x232a) ||
    (codePoint >= 0x2e80 && codePoint <= 0xa4cf) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
    (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
    (codePoint >= 0xff00 && codePoint <= 0xff60) ||
    (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
    (codePoint >= 0x1f300 && codePoint <= 0x1faff)
  );
}

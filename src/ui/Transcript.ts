// Transcript row helpers shared by the OpenTUI ChatPane.
// Pure (no React) — prefixes, wrap rows, markdown for assistant text.

import { renderMarkdown } from './markdown.js';
import type { TranscriptEntry } from './state.js';
import { theme } from './theme.js';

// Claude-Code-style bullets: ⏺ tool call, ⎿ result, › user.
export const ROLE_STYLES: Record<TranscriptEntry['kind'], { color: string; prefix: string }> = {
  user: { color: theme.brand, prefix: '› ' },
  assistant: { color: 'white', prefix: '  ' },
  'tool-call': { color: theme.brand, prefix: '⏺ ' },
  'tool-result': { color: 'gray', prefix: '  ' },
  system: { color: 'gray', prefix: '  ' },
  error: { color: 'red', prefix: '! ' },
  finding: { color: 'yellow', prefix: '★ ' },
  decision: { color: theme.muted, prefix: '  ' },
  todo: { color: 'white', prefix: '  ' },
};

const PLAIN_CONTINUATION = '  ';
const ACCENT_CONTINUATION = '│ ';
const ACCENT_KINDS = new Set<TranscriptEntry['kind']>([
  'tool-call',
  'tool-result',
  'finding',
  'error',
]);

export function continuationIndent(kind: TranscriptEntry['kind']): string {
  return ACCENT_KINDS.has(kind) ? ACCENT_CONTINUATION : PLAIN_CONTINUATION;
}

const MARKDOWN_KINDS = new Set<TranscriptEntry['kind']>(['assistant', 'finding']);

export interface Row {
  kind: TranscriptEntry['kind'];
  text: string;
  isFirst: boolean;
}

const rowCache = new WeakMap<TranscriptEntry, Row[]>();
const rowCacheCompact = new WeakMap<TranscriptEntry, Row[]>();

/** Body text for an entry: expanded collapsible rows show fullText (↳ tool list). */
export function entryDisplayText(entry: TranscriptEntry): string {
  if (entry.expanded && entry.fullText) return entry.fullText;
  return entry.text;
}

export function rowsForEntry(entry: TranscriptEntry, compact: boolean): Row[] {
  const cache = compact ? rowCacheCompact : rowCache;
  const cached = cache.get(entry);
  if (cached) return cached;
  const raw = entryDisplayText(entry);
  const text = MARKDOWN_KINDS.has(entry.kind) ? renderMarkdown(raw) : raw;
  const lines = text.split('\n');
  const out: Row[] = lines.map((line, j) => ({
    kind: entry.kind,
    text: line,
    isFirst: j === 0,
  }));
  if (!compact) out.push({ kind: entry.kind, text: '', isFirst: false });
  cache.set(entry, out);
  return out;
}

/** Lightweight rows for the actively-streaming entry (skip markdown). */
export function plainRowsForEntry(entry: TranscriptEntry, compact: boolean): Row[] {
  const lines = entryDisplayText(entry).split('\n');
  const out: Row[] = lines.map((line, j) => ({
    kind: entry.kind,
    text: line,
    isFirst: j === 0,
  }));
  if (!compact) out.push({ kind: entry.kind, text: '', isFirst: false });
  return out;
}

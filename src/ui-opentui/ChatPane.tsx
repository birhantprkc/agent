/** @jsxImportSource @opentui/react */
// Bounded, app-owned chat viewport. Physical-row windowing via wrapRows.ts;
// mouse wheel via onMouseScroll; scroll cue when history is above the
// viewport; empty-state guidance when the log is empty.

import { userInfo } from 'node:os';
import { TextAttributes } from '@opentui/core';
import { useMemo } from 'react';
import {
  ROLE_STYLES,
  continuationIndent,
  plainRowsForEntry,
  rowsForEntry,
} from '../ui/Transcript.js';
import type { TranscriptEntry } from '../ui/state.js';
import { theme } from '../ui/theme.js';
import { Banner, type BannerData } from './Banner.js';
import { type AnsiSpan, ansiToSpans, stripAnsi } from './ansiSpans.js';
import { wrapRowsToWidth } from './wrapRows.js';

/** Local login name for the empty-state greeting (macOS/Linux USER). */
function machineUsername(): string {
  try {
    const n = userInfo().username?.trim();
    if (n) return n;
  } catch {
    /* restricted environments */
  }
  return process.env.USER?.trim() || process.env.LOGNAME?.trim() || 'Hacker';
}

export interface ChatPaneProps {
  committed: TranscriptEntry[];
  liveEntry: TranscriptEntry | undefined;
  bannerData: BannerData;
  compactMode: boolean;
  width: number;
  /** Explicit height in rows for the scrollable region BELOW the banner. */
  height: number;
  /**
   * Outer box height (banner + scroll region). When set, the pane takes a
   * fixed row count so a tall footer/modal never pushes past the terminal.
   */
  totalHeight?: number;
  /** Rows scrolled up from the bottom (0 = pinned to latest). */
  scrollOffset: number;
  /** Positive delta scrolls toward older history; negative toward latest. */
  onScrollBy?: (delta: number) => void;
  /** True when new transcript content arrived while the user is scrolled up. */
  unseenBelow?: boolean;
  /** Click a collapsible row (↳ progress / truncated tool output) to expand. */
  onToggleExpand?: (entry: TranscriptEntry) => void;
}

interface DisplayRow {
  key: string;
  spans: AnsiSpan[];
  baseColor: string;
  baseDim: boolean;
  /** Hang-indent for soft-wrap continuations (= role prefix / code gutter). */
  hangIndent: number;
  /** Source transcript entry when this row can be click-expanded. */
  sourceEntry?: TranscriptEntry;
  // satisfies WrappableRow.sourceEntry (unknown) while staying typed here
}

/**
 * Hang-indent width so soft-wrapped lines stay column-aligned under the
 * content body:
 *   - code gutter rows (`  12│ body…`) hang under the body after `NN│ `
 *   - role-prefixed rows hang under the 2-cell glyph (`› `/`⏺ `/`│ `)
 */
export function hangIndentForPlain(plain: string, roleIndentLen: number): number {
  // Match role indent + optional line-number gutter from renderFencedBlock.
  // e.g. "  1│ ", " 12│ ", "  │ " (blockquote already has │ in continuation).
  const gutter = plain.match(/^(\s*\d+│\s)/);
  if (gutter?.[1]) return gutter[1].length;
  return roleIndentLen;
}

function buildDisplayRows(
  entries: TranscriptEntry[],
  compactMode: boolean,
  streaming: boolean,
  keyPrefix: string,
): DisplayRow[] {
  const out: DisplayRow[] = [];
  entries.forEach((entry, ei) => {
    const s = ROLE_STYLES[entry.kind];
    const rows = streaming
      ? plainRowsForEntry(entry, compactMode)
      : rowsForEntry(entry, compactMode);
    const dim = entry.collapsible === true && !entry.expanded;
    // Any collapsible entry is clickable (assistant prose, tool output, ↳ progress).
    const clickable = entry.collapsible === true && Boolean(entry.fullText);
    rows.forEach((row, ri) => {
      const indent = row.isFirst ? (entry.prefix ?? s.prefix) : continuationIndent(entry.kind);
      const rawText = row.text ? `${indent}${row.text}` : '';
      const spans = ansiToSpans(rawText);
      // Fallback if a pathological all-ANSI line produced no spans.
      const safeSpans = spans.length > 0 ? spans : [{ text: stripAnsi(rawText) || rawText }];
      out.push({
        key: `${keyPrefix}${ei}-${ri}`,
        spans: safeSpans,
        baseColor: entry.color ?? s.color,
        baseDim: dim,
        hangIndent: hangIndentForPlain(stripAnsi(rawText), indent.length),
        // Whole block is clickable so users can hit any line of a collapsed reply.
        sourceEntry: clickable ? entry : undefined,
      });
    });
  });
  return out;
}

function spanAttributes(span: AnsiSpan, baseDim: boolean): number | undefined {
  let attrs = 0;
  if (span.bold) attrs |= TextAttributes.BOLD;
  if (span.dim || baseDim) attrs |= TextAttributes.DIM;
  if (span.italic) attrs |= TextAttributes.ITALIC;
  if (span.underline) attrs |= TextAttributes.UNDERLINE;
  return attrs || undefined;
}

const EMPTY_GREETING = () => `🧑‍💻 Hello ${machineUsername()}, Let's Pwn The World`;

export function ChatPane({
  committed,
  liveEntry,
  bannerData,
  compactMode,
  width,
  height,
  totalHeight,
  scrollOffset,
  onScrollBy,
  unseenBelow = false,
  onToggleExpand,
}: ChatPaneProps) {
  const allRows = useMemo(() => {
    const committedRows = buildDisplayRows(committed, compactMode, false, 'c');
    const logical = liveEntry
      ? [...committedRows, ...buildDisplayRows([liveEntry], compactMode, true, 'l')]
      : committedRows;
    return wrapRowsToWidth(logical, Math.max(1, width - 1));
  }, [committed, liveEntry, compactMode, width]);

  const isEmpty = allRows.length === 0;
  const fullViewport = Math.max(1, height);
  const maxWithoutCue = Math.max(0, allRows.length - fullViewport);
  const showScrollCue = scrollOffset > 0 && maxWithoutCue > 0;
  // Reserve rows for top cue and optional bottom "new output" strip.
  const cueRows = (showScrollCue ? 1 : 0) + (unseenBelow && showScrollCue ? 1 : 0);
  const viewportHeight = Math.max(1, height - cueRows);
  const maxOffset = Math.max(0, allRows.length - viewportHeight);
  const clampedOffset = Math.min(Math.max(0, scrollOffset), maxOffset);
  const end = allRows.length - clampedOffset;
  const start = Math.max(0, end - viewportHeight);
  const visible = allRows.slice(start, end);
  const hiddenAbove = start;

  return (
    <box
      style={{
        flexDirection: 'column',
        // Prefer a fixed outer height from App so chat + footer never sum
        // past the terminal. Fall back to flexGrow when totalHeight omitted.
        ...(totalHeight != null
          ? { height: totalHeight, flexGrow: 0, flexShrink: 0 }
          : { flexGrow: 1, flexShrink: 1, minHeight: 0 }),
        width,
        overflow: 'hidden',
      }}
      onMouseScroll={(e) => {
        if (!onScrollBy || !e.scroll) return;
        const step = Math.max(1, e.scroll.delta ?? 1) * 3;
        if (e.scroll.direction === 'up') onScrollBy(step);
        else if (e.scroll.direction === 'down') onScrollBy(-step);
      }}
    >
      <Banner data={bannerData} width={width} compact={compactMode} />
      <box
        style={{
          flexDirection: 'column',
          flexGrow: 1,
          flexShrink: 1,
          minHeight: 0,
          overflow: 'hidden',
        }}
      >
        {showScrollCue ? (
          <box style={{ flexDirection: 'row' }}>
            <text fg={theme.muted} attributes={TextAttributes.DIM}>
              ↑ {hiddenAbove > 0 ? hiddenAbove : ''}
            </text>
          </box>
        ) : null}
        {isEmpty ? (
          <box style={{ flexDirection: 'row', marginTop: 1 }}>
            <text fg={theme.text} attributes={TextAttributes.BOLD}>
              {EMPTY_GREETING()}
            </text>
          </box>
        ) : (
          visible.map((row) => {
            const line = (
              <text>
                {row.spans.map((span, i) => (
                  <span
                    // biome-ignore lint/suspicious/noArrayIndexKey: spans derived fresh each render
                    key={i}
                    fg={span.fg ?? row.baseColor}
                    bg={span.bg}
                    attributes={spanAttributes(span, row.baseDim)}
                  >
                    {span.text}
                  </span>
                ))}
              </text>
            );
            // Clickable ↳ progress / collapsible tool rows (Grok-style expand).
            const source = row.sourceEntry as TranscriptEntry | undefined;
            if (source && onToggleExpand) {
              return (
                <box
                  key={row.key}
                  style={{ flexDirection: 'row' }}
                  onMouseDown={() => onToggleExpand(source)}
                >
                  {line}
                </box>
              );
            }
            return (
              <box key={row.key} style={{ flexDirection: 'row' }}>
                {line}
              </box>
            );
          })
        )}
        {unseenBelow && showScrollCue ? (
          <box style={{ flexDirection: 'row' }}>
            <text fg={theme.focus} attributes={TextAttributes.BOLD}>
              ↓ new
            </text>
          </box>
        ) : null}
      </box>
    </box>
  );
}

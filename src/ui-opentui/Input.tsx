/** @jsxImportSource @opentui/react */
// OpenTUI port of ../ui/Input.tsx.
//
// Soft-wrap: long logical lines are split into physical rows of at most
// (inner width − prefix) cells so the cursor never paints past the frame.
// Continuation physical rows hang-indent under the prompt glyph (spaces of
// the same width) — they do NOT re-stamp ❯ on every wrapped row.
//
// Width: prefer an explicit `width` from the parent so the prompt frame
// matches the full chat column.

import { TextAttributes } from '@opentui/core';
import { useTerminalDimensions } from '@opentui/react';
import type { ReactNode } from 'react';
import { cellWidth, graphemes, sliceToCells } from '../ui/terminalWidth.js';
import { theme } from '../ui/theme.js';
import { positionOf } from '../ui/useTextField.js';

export interface InputProps {
  prompt?: string;
  placeholder?: string;
  value: string;
  cursor: number;
  disabled?: boolean;
  hint?: string;
  /** Column width of the chat pane. */
  width?: number;
}

const CONTINUATION_INDENT = '  ';
const DEFAULT_PROMPT = `${theme.glyphs.prompt} `;
// Short, friendly — no keybinding laundry list in the empty box.
const DEFAULT_PLACEHOLDER = 'Ask anything…  (/ commands · @ files)';
// Hints only when App passes one (e.g. agent running). Keeps the idle UI quiet.
const DEFAULT_HINT: string | undefined = undefined;

/** Split a single logical line into physical chunks of at most `maxCols`. */
export function softWrapLine(text: string, maxCols: number): string[] {
  return wrapLine(text, maxCols).map((chunk) => chunk.text);
}

function wrapLine(
  text: string,
  maxCols: number,
): Array<{ text: string; start: number; startCol: number; endCol: number }> {
  const w = Math.max(1, maxCols);
  if (text.length === 0) return [{ text: '', start: 0, startCol: 0, endCol: 0 }];
  const out: Array<{ text: string; start: number; startCol: number; endCol: number }> = [];
  let row = '';
  let start = 0;
  let startCol = 0;
  let rowCol = 0;
  for (const grapheme of graphemes(text)) {
    if (row && cellWidth(row + grapheme) > w) {
      out.push({ text: row, start, startCol, endCol: startCol + rowCol });
      start += row.length;
      startCol += rowCol;
      row = '';
      rowCol = 0;
    }
    row += grapheme;
    rowCol += cellWidth(grapheme);
  }
  if (row) out.push({ text: row, start, startCol, endCol: startCol + rowCol });
  return out.length > 0 ? out : [{ text: '', start: 0, startCol: 0, endCol: 0 }];
}

/** Pad string to `n` cells with trailing spaces (for column alignment). */
export function padEndCells(s: string, n: number): string {
  if (s.length >= n) return s;
  return s + ' '.repeat(n - s.length);
}

export function Input(props: InputProps) {
  const { width: columns } = useTerminalDimensions();
  const width = Math.max(20, props.width ?? columns);
  // border (2) + paddingX (2) = 4 cells of chrome around the content.
  const innerWidth = Math.max(8, width - 4);
  const isEmpty = props.value.length === 0;
  const promptText = props.prompt ?? DEFAULT_PROMPT;
  const borderColor = props.disabled ? theme.border.idle : theme.border.brand;
  const hint = props.hint !== undefined ? props.hint : DEFAULT_HINT;
  const placeholderText = props.placeholder ?? DEFAULT_PLACEHOLDER;
  const showCursor = true;
  // Hang-indent width matches the first-line prompt so wrapped body text
  // starts in the same column as the first character after ❯.
  const hangPad = ' '.repeat(cellWidth(promptText));

  if (isEmpty) {
    return (
      <box style={{ flexDirection: 'column', width }}>
        <PromptFrame width={width} borderColor={borderColor}>
          <box style={{ flexDirection: 'row' }}>
            <text fg={theme.brand}>{promptText}</text>
            <text fg={theme.muted} attributes={TextAttributes.DIM}>
              {sliceToCells(
                placeholderText,
                Math.max(1, innerWidth - cellWidth(promptText) - 1),
                '…',
              )}
            </text>
            {showCursor ? <text fg={theme.brand}>{theme.glyphs.cursor}</text> : null}
          </box>
        </PromptFrame>
        {hint ? (
          <box style={{ flexDirection: 'row', paddingX: 1 }}>
            <text fg={theme.muted} attributes={TextAttributes.DIM}>
              {truncateTo(hint, Math.max(8, width - 4))}
            </text>
          </box>
        ) : null}
      </box>
    );
  }

  const lines = props.value.split('\n');
  const { line: cursorLine, col: cursorCol } = positionOf(props.value, props.cursor);

  // Build physical display rows for every logical line.
  // prefix on chunk 0 of line 0 = prompt; chunk 0 of later lines = hard-newline
  // indent; subsequent soft-wrap chunks = hang pad (spaces under the prompt).
  type PhysRow = {
    key: string;
    prefix: string;
    text: string;
    cursorAt: number | null;
  };
  const phys: PhysRow[] = [];
  lines.forEach((lineText, lineIdx) => {
    const firstPrefix = lineIdx === 0 ? promptText : CONTINUATION_INDENT;
    // Content budget is always relative to the first-line prefix width so
    // soft-wrapped rows of multi-line drafts stay the same content width.
    const maxCols = Math.max(1, innerWidth - cellWidth(promptText));
    const chunks = wrapLine(lineText, maxCols);
    const lineStartOffset = lineIdx === 0 ? 0 : lines.slice(0, lineIdx).join('\n').length + 1;
    const cursorOffset = props.cursor - lineStartOffset;
    const isActive = lineIdx === cursorLine;
    chunks.forEach((chunk, ci) => {
      const prefix = ci === 0 ? firstPrefix : hangPad;
      let cursorAt: number | null = null;
      if (isActive && cursorCol >= chunk.startCol && cursorCol <= chunk.endCol) {
        cursorAt = Math.max(0, Math.min(chunk.text.length, cursorOffset - chunk.start));
      }
      phys.push({
        key: `L${lineIdx}-c${ci}`,
        prefix,
        text: chunk.text,
        cursorAt,
      });
    });
  });

  return (
    <box style={{ flexDirection: 'column', width }}>
      <PromptFrame width={width} borderColor={borderColor}>
        <box style={{ flexDirection: 'column' }}>
          {phys.map((row) => {
            if (row.cursorAt === null) {
              return (
                <box key={row.key} style={{ flexDirection: 'row' }}>
                  <text fg={theme.brand}>{row.prefix}</text>
                  <text fg={theme.text}>{row.text}</text>
                </box>
              );
            }
            const head = row.text.slice(0, row.cursorAt);
            const underCursor = row.text.slice(row.cursorAt, row.cursorAt + 1);
            const tail = row.text.slice(row.cursorAt + 1);
            return (
              <box key={row.key} style={{ flexDirection: 'row' }}>
                <text fg={theme.brand}>{row.prefix}</text>
                <text fg={theme.text}>{head}</text>
                {underCursor ? (
                  <text fg="black" bg={theme.brand}>
                    {underCursor}
                  </text>
                ) : (
                  <text fg={theme.brand}>{theme.glyphs.cursor}</text>
                )}
                <text fg={theme.text}>{tail}</text>
              </box>
            );
          })}
        </box>
      </PromptFrame>
      {hint ? (
        <box style={{ flexDirection: 'row', paddingX: 1 }}>
          <text fg={theme.muted} attributes={TextAttributes.DIM}>
            {truncateTo(hint, Math.max(8, width - 4))}
          </text>
        </box>
      ) : null}
    </box>
  );
}

function truncateTo(s: string, n: number): string {
  if (s.length <= n) return s;
  if (n <= 1) return '…';
  return `${s.slice(0, n - 1)}…`;
}

function PromptFrame({
  width,
  borderColor,
  children,
}: {
  width: number;
  borderColor: string;
  children: ReactNode;
}) {
  return (
    <box
      style={{
        border: true,
        borderStyle: 'rounded',
        borderColor,
        flexDirection: 'column',
        width,
        paddingX: 1,
        flexShrink: 0,
      }}
    >
      {children}
    </box>
  );
}

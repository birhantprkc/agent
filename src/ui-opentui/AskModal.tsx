/** @jsxImportSource @opentui/react */
// OpenTUI port of ../ui/AskModal.tsx. Arrow keys navigate (skipping
// disabled rows), Enter picks, Esc cancels, 1-9 jump.
//
// Key-handling notes: key.upArrow/downArrow -> e.name === 'up'/'down';
// key.return -> e.name === 'return'; the 1-9 digit-jump range check uses
// e.sequence (the raw typed char) same as Ink's `input`.
// Every standalone line of text is wrapped in its own <box> (see
// PermissionModal.tsx for why bare sibling <text> elements overlap instead
// of stacking). `bold dimColor` combos become
// `attributes={TextAttributes.BOLD | TextAttributes.DIM}`.

import { TextAttributes } from '@opentui/core';
import { useKeyboard, useTerminalDimensions } from '@opentui/react';
import { useMemo, useState } from 'react';
import type { Option } from '../ask/ask.js';
import type { AskRequest } from '../ui/askBridge.js';
import { theme } from '../ui/theme.js';

const WINDOW = 7;

function firstSelectable(options: Option[]): number {
  const i = options.findIndex((o) => !o.disabled);
  return i >= 0 ? i : 0;
}

function nextSelectable(options: Option[], from: number, dir: 1 | -1): number {
  if (options.length === 0) return 0;
  let i = from;
  for (let n = 0; n < options.length; n += 1) {
    i = (i + dir + options.length) % options.length;
    if (!options[i]?.disabled) return i;
  }
  return from;
}

export function AskModal({ req }: { req: AskRequest }) {
  const { width: columns } = useTerminalDimensions();
  const options = req.question.options;
  const boxWidth = Math.max(20, Math.min(columns - 2, 100));
  const compact = columns < 64;
  const windowSize = compact ? 4 : WINDOW;
  const [idx, setIdx] = useState(() => firstSelectable(options));

  useKeyboard((e) => {
    if (e.name === 'escape') {
      req.reject(new Error('cancelled'));
      return;
    }
    if (e.name === 'up') {
      setIdx((i) => nextSelectable(options, i, -1));
      return;
    }
    if (e.name === 'down') {
      setIdx((i) => nextSelectable(options, i, 1));
      return;
    }
    if (e.name === 'return') {
      const picked = options[idx];
      if (picked && !picked.disabled) req.resolve(picked.label);
      return;
    }
    const input = e.sequence;
    if (input >= '1' && input <= '9') {
      const n = Number.parseInt(input, 10);
      let seen = 0;
      for (let i = 0; i < options.length; i += 1) {
        if (options[i]?.disabled) continue;
        seen += 1;
        if (seen === n) {
          setIdx(i);
          break;
        }
      }
    }
  });

  const windowStart = useMemo(() => {
    if (options.length <= windowSize) return 0;
    const half = Math.floor(windowSize / 2);
    let start = idx - half;
    if (start < 0) start = 0;
    if (start + windowSize > options.length) start = Math.max(0, options.length - windowSize);
    return start;
  }, [idx, options.length, windowSize]);

  const visible = options.slice(windowStart, windowStart + windowSize);
  const hiddenAbove = windowStart;
  const hiddenBelow = Math.max(0, options.length - (windowStart + windowSize));
  const footer = req.question.footer ?? '↑↓ navigate · 1-9 jump · Enter select · Esc cancel';

  const showGroupAt = (globalIndex: number): string | undefined => {
    const o = options[globalIndex];
    if (!o?.group) return undefined;
    if (globalIndex === 0) return o.group;
    const prev = options[globalIndex - 1];
    if (prev?.group !== o.group) return o.group;
    if (globalIndex === windowStart) return o.group;
    return undefined;
  };

  return (
    <box
      style={{
        border: true,
        borderStyle: 'rounded',
        borderColor: theme.border.focus,
        flexDirection: 'column',
        alignSelf: 'center',
        width: boxWidth,
        paddingX: 2,
        paddingY: 1,
      }}
    >
      <box style={{ flexDirection: 'column' }}>
        {req.question.header ? (
          <box style={{ flexDirection: 'row' }}>
            <text fg={theme.focus} attributes={TextAttributes.BOLD}>
              {req.question.header.toUpperCase()}
            </text>
          </box>
        ) : null}
        <box style={{ flexDirection: 'row' }}>
          <text fg={theme.text} attributes={TextAttributes.BOLD} truncate>
            {req.question.question}
          </text>
        </box>
        {req.question.subtitle && !compact ? (
          <box style={{ flexDirection: 'row' }}>
            <text fg={theme.muted} attributes={TextAttributes.DIM} truncate>
              {req.question.subtitle}
            </text>
          </box>
        ) : null}
      </box>

      {hiddenAbove > 0 ? (
        <box style={{ flexDirection: 'row', marginTop: 1 }}>
          <text fg={theme.muted} attributes={TextAttributes.DIM}>
            ··· {hiddenAbove} more above ···
          </text>
        </box>
      ) : (
        <box style={{ marginTop: compact ? 0 : 1 }} />
      )}

      <box style={{ flexDirection: 'column' }}>
        {visible.map((o, vi) => {
          const gi = windowStart + vi;
          const selected = gi === idx;
          const group = showGroupAt(gi);
          return (
            <box key={`${gi}:${o.label}`} style={{ flexDirection: 'column' }}>
              {group ? (
                <box
                  style={{ flexDirection: 'row', marginTop: vi === 0 && hiddenAbove === 0 ? 0 : 1 }}
                >
                  <text fg={theme.brand} attributes={TextAttributes.BOLD | TextAttributes.DIM}>
                    {group.toUpperCase()}
                  </text>
                </box>
              ) : null}
              {o.disabled ? (
                <box style={{ flexDirection: 'row' }}>
                  <text fg={theme.muted} attributes={TextAttributes.DIM} truncate>
                    {o.label}
                  </text>
                </box>
              ) : (
                <box style={{ flexDirection: 'row', width: '100%', overflow: 'hidden' }}>
                  <text
                    fg={selected ? theme.focus : theme.text}
                    attributes={selected ? TextAttributes.BOLD : undefined}
                    truncate={false}
                  >
                    {selected ? ` ${theme.glyphs.caret} ` : '   '}
                    {o.label}
                  </text>
                  {o.badge && !compact ? (
                    <text
                      fg={selected ? theme.focus : theme.muted}
                      attributes={selected ? undefined : TextAttributes.DIM}
                    >
                      {'  '}
                      {o.badge}
                    </text>
                  ) : null}
                  {o.description && !compact ? (
                    <text fg={theme.muted} attributes={TextAttributes.DIM} truncate>
                      {'  '}
                      {o.description}
                    </text>
                  ) : null}
                </box>
              )}
            </box>
          );
        })}
      </box>

      {hiddenBelow > 0 ? (
        <box style={{ flexDirection: 'row', marginTop: 1 }}>
          <text fg={theme.muted} attributes={TextAttributes.DIM}>
            ··· {hiddenBelow} more below ···
          </text>
        </box>
      ) : null}

      <box style={{ flexDirection: 'row', marginTop: compact ? 0 : 1 }}>
        <text fg={theme.muted} attributes={TextAttributes.DIM}>
          {compact ? '↑↓ navigate · Enter select · Esc cancel' : footer}
        </text>
      </box>
    </box>
  );
}

/** @jsxImportSource @opentui/react */
// OpenTUI port of ../ui/MenuFrame.tsx. Shared framed chrome for typeahead
// menus (slash, @file) and compact pickers.
//
// Prop mapping notes:
//   Ink borderStyle="round"      -> OpenTUI border + borderStyle="rounded" (name differs, and `border` must be set explicitly — OpenTUI defaults border to false even with borderStyle set)
//   Ink <Text wrap="truncate">   -> OpenTUI <text truncate>
//   Ink <Box> (no flexDirection) -> OpenTUI <box style={{ flexDirection: 'row' }}> (OpenTUI defaults to column, Ink to row)
//   paddingX/paddingY/paddingTop/paddingBottom/marginTop/minWidth/alignSelf all keep the same names.

import { TextAttributes } from '@opentui/core';
import type { ReactNode } from 'react';
import { theme } from '../ui/theme.js';

export interface MenuFrameProps {
  header: string;
  subtitle?: string;
  hiddenAbove?: number;
  hiddenBelow?: number;
  footer?: string;
  children: ReactNode;
  minWidth?: number;
}

export function MenuFrame({
  header,
  subtitle,
  hiddenAbove = 0,
  hiddenBelow = 0,
  footer = '↑↓  Enter  Esc',
  children,
  minWidth = 48,
}: MenuFrameProps) {
  return (
    <box
      style={{
        flexDirection: 'column',
        border: true,
        borderStyle: 'rounded',
        borderColor: theme.border.focus,
        alignSelf: 'center',
        minWidth,
        paddingX: 1,
        paddingY: 0,
      }}
    >
      <box style={{ flexDirection: 'column', paddingX: 1, paddingTop: 0 }}>
        <text fg={theme.focus} attributes={TextAttributes.BOLD}>
          {header.toUpperCase()}
        </text>
        {subtitle ? (
          <text fg={theme.muted} attributes={TextAttributes.DIM}>
            {subtitle}
          </text>
        ) : null}
      </box>

      {hiddenAbove > 0 ? (
        <box style={{ flexDirection: 'row', paddingX: 1 }}>
          <text fg={theme.muted} attributes={TextAttributes.DIM}>
            ··· {hiddenAbove} more above ···
          </text>
        </box>
      ) : null}

      <box style={{ flexDirection: 'column', paddingX: 0 }}>{children}</box>

      {hiddenBelow > 0 ? (
        <box style={{ flexDirection: 'row', paddingX: 1 }}>
          <text fg={theme.muted} attributes={TextAttributes.DIM}>
            ··· {hiddenBelow} more below ···
          </text>
        </box>
      ) : null}

      {footer ? (
        <box style={{ flexDirection: 'row', paddingX: 1, paddingBottom: 0 }}>
          <text fg={theme.muted} attributes={TextAttributes.DIM}>
            {footer}
          </text>
        </box>
      ) : null}
    </box>
  );
}

/** Fixed width for the primary column so secondary descriptions line up
 *  across slash/@ rows. Only applied when a secondary is present — label-
 *  only rows (e.g. FirstRunPicker) keep their full text. */
const PRIMARY_COL = 22;

/** One selectable row: caret + primary (+ optional padded column) + secondary. */
export function MenuRow({
  selected,
  primary,
  secondary,
  icon,
}: {
  selected: boolean;
  primary: string;
  secondary?: string;
  icon?: string;
}) {
  const caret = selected ? `${theme.glyphs.caret} ` : '  ';
  const iconPart = icon ? `${icon} ` : '';
  const primaryBody = iconPart + primary;
  // Align secondary descriptions on a shared column only when both fields
  // are shown. Without secondary, render the full primary untruncated.
  let primaryCol = primaryBody;
  if (secondary) {
    primaryCol =
      primaryBody.length > PRIMARY_COL
        ? `${primaryBody.slice(0, PRIMARY_COL - 1)}…`
        : primaryBody + ' '.repeat(PRIMARY_COL - primaryBody.length);
  }
  return (
    <box style={{ flexDirection: 'row', paddingX: 1 }}>
      <text
        fg={selected ? theme.focus : theme.text}
        attributes={selected ? TextAttributes.BOLD : TextAttributes.DIM}
        truncate={!secondary}
      >
        {caret}
        {primaryCol}
      </text>
      {secondary ? (
        <text fg={theme.muted} attributes={TextAttributes.DIM} truncate>
          {'  '}
          {secondary}
        </text>
      ) : null}
    </box>
  );
}

/** @jsxImportSource @opentui/react */
// OpenTUI port of ../ui/SecretInputModal.tsx.
//
// Key-handling notes:
//   Ink useInput((input, key)) — input carries both typed chars AND paste
//     content in one string.
//   OpenTUI splits these into two hooks: useKeyboard (single keypresses,
//     e.sequence holds the typed character) and usePaste (bracketed paste,
//     event.text holds the full pasted string) — more explicit than Ink's
//     implicit "input might be multi-char" convention, and correctly
//     handles pasting an API key (the primary real-world use of this modal).

import { TextAttributes } from '@opentui/core';
import { useKeyboard, usePaste } from '@opentui/react';
import { useState } from 'react';
import { decodePasteEvent } from '../ui/clipboard.js';
import type { SecretInputRequest } from '../ui/secretInput.js';
import { theme } from '../ui/theme.js';

export type { SecretInputRequest } from '../ui/secretInput.js';

function stripControlChars(s: string): string {
  return [...s]
    .filter((ch) => {
      const code = ch.charCodeAt(0);
      return code >= 0x20 && code !== 0x7f;
    })
    .join('');
}

export function SecretInputModal({ req }: { req: SecretInputRequest }) {
  const [value, setValue] = useState('');

  useKeyboard((e) => {
    if (e.name === 'escape') {
      req.reject(new Error('cancelled'));
      return;
    }
    if (e.name === 'return') {
      req.resolve(value.trim());
      return;
    }
    if (e.name === 'backspace' || e.name === 'delete') {
      setValue((v) => v.slice(0, -1));
      return;
    }
    if (e.ctrl || e.meta) return;
    const clean = stripControlChars(e.sequence);
    if (clean) setValue((v) => v + clean);
  });

  usePaste((event) => {
    const clean = stripControlChars(decodePasteEvent(event.bytes));
    if (clean) setValue((v) => v + clean);
  });

  const empty = value.length === 0;
  const display = empty ? req.placeholder || '' : maskSecret(value);
  const footer = req.footer ?? 'type key · Enter confirm · Esc cancel';

  return (
    <box
      style={{
        border: true,
        borderStyle: 'rounded',
        borderColor: theme.border.focus,
        flexDirection: 'column',
        alignSelf: 'flex-start',
        minWidth: 48,
        paddingX: 2,
        paddingY: 1,
        marginTop: 1,
      }}
    >
      <box style={{ flexDirection: 'column' }}>
        <text fg={theme.focus} attributes={TextAttributes.BOLD}>
          {req.header.toUpperCase()}
        </text>
        <text fg={theme.text} attributes={TextAttributes.BOLD}>
          {req.question}
        </text>
        {req.subtitle ? (
          <text fg={theme.muted} attributes={TextAttributes.DIM}>
            {req.subtitle}
          </text>
        ) : null}
      </box>

      <box
        style={{
          marginTop: 1,
          border: true,
          borderStyle: 'rounded',
          borderColor: empty ? theme.border.idle : theme.border.focus,
          paddingX: 1,
          minWidth: 40,
          flexDirection: 'row',
        }}
      >
        <text
          fg={empty ? theme.muted : theme.text}
          attributes={empty ? TextAttributes.DIM : undefined}
        >
          {display}
          <span fg={theme.focus}>{empty || value.length > 0 ? theme.glyphs.cursor : ''}</span>
        </text>
      </box>

      <box style={{ marginTop: 1, flexDirection: 'column' }}>
        <text fg={theme.muted} attributes={TextAttributes.DIM}>
          {value.length > 0
            ? `${value.length} character${value.length === 1 ? '' : 's'} · masked`
            : 'key is never echoed in full'}
        </text>
        <text fg={theme.muted} attributes={TextAttributes.DIM}>
          {footer}
        </text>
      </box>
    </box>
  );
}

export function maskSecret(value: string): string {
  if (!value) return '';
  if (value.length <= 8) return '•'.repeat(value.length);
  return `${'•'.repeat(value.length - 4)}${value.slice(-4)}`;
}

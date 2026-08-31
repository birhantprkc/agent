/** @jsxImportSource @opentui/react */
// Header: compact mini "PF" monogram + quiet meta (version · provider · path).

import { TextAttributes } from '@opentui/core';
import {
  type BannerData,
  PF_MINI_LOGO,
  PF_MINI_LOGO_WIDTH,
  compactPath,
  modelPill,
} from '../ui/Banner.js';
import { theme } from '../ui/theme.js';
import { VERSION } from '../version/version.js';

export type { BannerData } from '../ui/Banner.js';

export function Banner({
  data,
  width,
  compact = false,
}: {
  data: BannerData;
  width?: number;
  compact?: boolean;
}) {
  const boxWidth = Math.max(20, width ?? 80);
  const version = data.version ?? VERSION;
  const provider = data.state ? `${data.provider}` : data.provider;
  const pill = modelPill(data.toolSupport);
  const warnPill =
    pill && (data.toolSupport === 'no' || data.toolSupport === 'probing') ? pill : null;
  const textBudget = Math.max(12, boxWidth - PF_MINI_LOGO_WIDTH - 3);
  const path = compactPath(data.cwd, Math.max(12, Math.floor(textBudget * 0.55)));

  // Ultra-compact: single brand glyph + meta.
  if (compact) {
    return (
      <box
        style={{
          flexDirection: 'row',
          width: boxWidth,
          flexShrink: 0,
          marginBottom: 1,
        }}
      >
        <text fg={theme.brand} attributes={TextAttributes.BOLD}>
          PF
        </text>
        <text fg={theme.muted} attributes={TextAttributes.DIM}>
          {' '}
          v{version}
          {' · '}
          {provider}
          {warnPill ? ` · ${warnPill.text}` : ''}
          {' · '}
          {path}
        </text>
      </box>
    );
  }

  const metaLine1 = `v${version} · ${provider}`;
  const metaLine2 = warnPill ? `${warnPill.text} · ${path}` : path;
  const clip = (s: string) => (s.length > textBudget ? `${s.slice(0, textBudget - 1)}…` : s);

  return (
    <box
      style={{
        flexDirection: 'row',
        width: boxWidth,
        flexShrink: 0,
        marginBottom: 1,
        gap: 1,
      }}
    >
      <box style={{ flexDirection: 'column', flexShrink: 0 }}>
        {PF_MINI_LOGO.map((row) => (
          <text key={row} fg={theme.brand} attributes={TextAttributes.BOLD}>
            {row}
          </text>
        ))}
      </box>
      <box style={{ flexDirection: 'column', flexGrow: 1, minWidth: 0 }}>
        <text fg={theme.text} attributes={TextAttributes.BOLD}>
          PentesterFlow
        </text>
        <text fg={theme.muted} attributes={TextAttributes.DIM}>
          {clip(metaLine1)}
        </text>
        <text
          fg={warnPill ? warnPill.color : theme.muted}
          attributes={warnPill ? undefined : TextAttributes.DIM}
        >
          {clip(metaLine2)}
        </text>
      </box>
    </box>
  );
}

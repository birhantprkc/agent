/** @jsxImportSource @opentui/react */
// Quiet status line: only what helps the operator act next.
// Idle:  ready · model · target   (+ rare warnings)
// Busy:  ⠋ tool · 0:42

import { TextAttributes } from '@opentui/core';
import { useEffect, useState } from 'react';
import type { ToolSupportPill } from '../ui/Banner.js';
import {
  type StatusProps,
  compactModelName,
  ctxFillPercent,
  formatCtxLabel,
  formatElapsed,
  phaseLabel,
} from '../ui/StatusBar.js';
import { theme } from '../ui/theme.js';

export type { StatusProps } from '../ui/StatusBar.js';

const DOTS_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const DOTS_INTERVAL_MS = 80;

function useDotsSpinner(active: boolean): string {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setFrame((f) => (f + 1) % DOTS_FRAMES.length), DOTS_INTERVAL_MS);
    return () => clearInterval(id);
  }, [active]);
  return DOTS_FRAMES[frame] ?? DOTS_FRAMES[0] ?? '';
}

function compactTarget(target: string): string {
  return target.replace(/^https?:\/\//, '').replace(/\/$/, '');
}

export interface OpenTuiStatusProps extends StatusProps {
  maxWidth?: number;
}

export function StatusBar(props: OpenTuiStatusProps) {
  const maxWidth = props.maxWidth ?? 200;
  return (
    <box style={{ flexDirection: 'row', width: '100%', justifyContent: 'space-between' }}>
      {props.busy ? (
        <BusyLine {...props} maxWidth={maxWidth} />
      ) : (
        <IdleLine {...props} maxWidth={maxWidth} />
      )}
      {props.yolo ? (
        <text fg={theme.superMode} attributes={TextAttributes.BOLD}>
          YOLO
        </text>
      ) : null}
    </box>
  );
}

function BusyLine(props: OpenTuiStatusProps) {
  const spin = useDotsSpinner(true);
  const phaseText = phaseLabel(props.phase);
  // Tool name when running a tool; otherwise phase (Writing / Thinking / …).
  const primary =
    props.phase === 'running-tool' && props.runningTool ? props.runningTool : phaseText;
  const clock = props.elapsedSeconds ? ` ${formatElapsed(props.elapsedSeconds)}` : '';
  const budget = Math.max(12, (props.maxWidth ?? 200) - (props.yolo ? 6 : 0));
  let body = ` ${primary}${clock}`;
  if (body.length > budget - 1) body = `${body.slice(0, Math.max(0, budget - 2))}…`;
  return (
    <box style={{ flexDirection: 'row' }}>
      <text fg={theme.brand}>{spin}</text>
      <text fg={theme.text} attributes={TextAttributes.BOLD}>
        {body}
      </text>
    </box>
  );
}

interface Seg {
  text: string;
  color: string;
  bold?: boolean;
  priority: number;
}

function IdleLine(props: OpenTuiStatusProps) {
  const draft = props.draftTokens ?? 0;
  const ctxLabel = formatCtxLabel(props.ctxTokens, props.compactThreshold, draft);
  const ctxPct = ctxFillPercent(props.ctxTokens + draft, props.compactThreshold);
  const budget = Math.max(12, (props.maxWidth ?? 200) - (props.yolo ? 6 : 0));

  // Keep the bar short. Only add fields that change what the user should do.
  const segs: Seg[] = [
    {
      text: props.apiReady ? 'Ready' : 'Offline',
      color: props.apiReady ? theme.success : theme.error,
      bold: true,
      priority: 0,
    },
  ];
  if (props.model) {
    segs.push({ text: ` · ${compactModelName(props.model)}`, color: theme.muted, priority: 2 });
  }
  if (props.target) {
    segs.push({
      text: ` · ${compactTarget(props.target)}`,
      color: theme.muted,
      priority: 3,
    });
  }
  // Warnings only — hide "tools ✓" noise.
  if (props.toolSupport === 'no') {
    segs.push({ text: ' · No tools', color: theme.error, priority: 1 });
  } else if (props.toolSupport === 'probing') {
    segs.push({ text: ' · Checking tools…', color: theme.warning, priority: 1 });
  }
  if (props.expandHint) {
    segs.push({ text: ' · Expand available', color: theme.focus, priority: 2 });
  }
  if (props.transcriptFilter !== 'all') {
    segs.push({
      text: ` · ${props.transcriptFilter}`,
      color: theme.focus,
      priority: 2,
    });
  }
  // Context only when getting full (actionable).
  if (ctxLabel && ctxPct >= 75) {
    segs.push({
      text: ` · ${ctxLabel}`,
      color: ctxPct >= 90 ? theme.warning : theme.muted,
      priority: 2,
    });
  }
  if (props.findingsCount && props.findingsCount > 0) {
    segs.push({
      text: ` · ${props.findingsCount}★`,
      color: theme.warning,
      priority: 3,
    });
  }

  const kept = fitSegments(segs, budget);

  return (
    <box style={{ flexDirection: 'row' }}>
      {kept.map((s, i) => (
        <text
          // biome-ignore lint/suspicious/noArrayIndexKey: short fixed status segments
          key={i}
          fg={s.color}
          attributes={s.bold ? TextAttributes.BOLD : undefined}
        >
          {s.text}
        </text>
      ))}
    </box>
  );
}

export function fitSegments(segs: Seg[], budget: number): Seg[] {
  let kept = [...segs];
  const totalLen = () => kept.reduce((n, s) => n + s.text.length, 0);
  while (totalLen() > budget) {
    let dropAt = -1;
    let dropPri = -1;
    for (let i = kept.length - 1; i >= 0; i -= 1) {
      const p = kept[i]?.priority ?? 0;
      if (p > dropPri) {
        dropPri = p;
        dropAt = i;
      }
    }
    if (dropAt < 0 || dropPri <= 0) break;
    kept = kept.filter((_, i) => i !== dropAt);
  }
  if (totalLen() > budget && kept.length > 0) {
    const last = kept[kept.length - 1];
    if (last) {
      const others = totalLen() - last.text.length;
      const room = Math.max(1, budget - others);
      kept = [
        ...kept.slice(0, -1),
        {
          ...last,
          text:
            last.text.length > room ? `${last.text.slice(0, Math.max(0, room - 1))}…` : last.text,
        },
      ];
    }
  }
  return kept;
}

// Silence unused import when tree-shaken types-only consumers expect it.
export type { ToolSupportPill };

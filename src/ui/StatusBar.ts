// Status-bar pure helpers + prop types. Rendering lives in ui-opentui/StatusBar.tsx.

import type { ToolSupportPill } from './Banner.js';
import type { TranscriptFilter, UiPhase } from './state.js';

export interface StatusProps {
  busy: boolean;
  apiReady: boolean;
  activeSkill: string | null;
  yolo: boolean;
  ctxTokens: number;
  compactThreshold: number;
  memoryItems: number;
  model?: string;
  toolSupport?: ToolSupportPill;
  phase: UiPhase;
  transcriptFilter: TranscriptFilter;
  target?: string;
  /** True when a collapsible tool-result or progress line can expand. */
  expandHint: boolean;
  runningTool?: string | null;
  lastTool?: string | null;
  findingsCount?: number;
  usage?: { inputTokens: number; outputTokens: number; cachedInputTokens: number };
  elapsedSeconds?: number;
  draftTokens?: number;
}

/** mm:ss elapsed clock. 42 → "0:42", 125 → "2:05". */
export function formatElapsed(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const mins = Math.floor(s / 60);
  const secs = s % 60;
  return `${mins}:${String(secs).padStart(2, '0')}`;
}

/** Compact token count: 12345 → "12.3k", 16000 → "16k". */
export function formatTokenCount(n: number): string {
  if (n < 1000) return String(Math.max(0, Math.floor(n)));
  const k = n / 1000;
  return Number.isInteger(k) ? `${k}k` : `${k.toFixed(1)}k`;
}

/**
 * Context readout vs auto-compact threshold.
 *   ~9400 / 16000 → "ctx ~9.4k/16k"
 */
export function formatCtxLabel(tokens: number, threshold: number, draftTokens = 0): string | null {
  if (threshold <= 0 || tokens <= 0) return null;
  const draft = draftTokens >= 200 ? `+${formatTokenCount(draftTokens)}` : '';
  return `ctx ~${formatTokenCount(tokens)}${draft}/${formatTokenCount(threshold)}`;
}

/** 0–999 percent of compact threshold filled (for color urgency only). */
export function ctxFillPercent(tokens: number, threshold: number): number {
  if (threshold <= 0 || tokens <= 0) return 0;
  return Math.min(999, Math.round((tokens / threshold) * 100));
}

const MODEL_NAME_CAP = 28;
export function compactModelName(name: string): string {
  if (name.length <= MODEL_NAME_CAP) return name;
  const head = Math.ceil((MODEL_NAME_CAP - 1) * 0.6);
  const tail = MODEL_NAME_CAP - 1 - head;
  return `${name.slice(0, head)}…${name.slice(-tail)}`;
}

/** Quiet phase labels for the busy status line. */
export function phaseLabel(phase: UiPhase): string {
  switch (phase) {
    case 'planning':
      return 'Thinking';
    case 'running-tool':
      return 'Running tool';
    case 'answering':
      return 'Writing';
    case 'waiting-approval':
      return 'Needs approval';
    case 'waiting-user':
      return 'Waiting for you';
    case 'skills':
      return 'Skills';
    case 'idle':
      return 'Ready';
  }
}

// Offload huge tool-result bodies out of the LLM history onto disk.
// The model still sees a short preview + a path it can re-read with
// file_read if needed; full fidelity stays available for the operator
// (Ctrl-O path in the TUI still has the full string via the event stream).

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { redact } from '../redact/index.js';

/** Results longer than this are written to disk and replaced in history. */
export const OFFLOAD_CHAR_THRESHOLD = 4_000;
/** Preview kept in the LLM-facing tool message. */
export const OFFLOAD_PREVIEW_CHARS = 1_200;

export interface OffloadResult {
  /** What goes into history / the next LLM turn. */
  forHistory: string;
  /** Full body (same as input). */
  full: string;
  offloaded: boolean;
  path?: string;
}

/**
 * If `result` is large, write it under `dir/tool-results/<id>.txt` (redacted)
 * and return a short pointer for the model. Small results pass through.
 */
export function maybeOffloadToolResult(
  dir: string | null | undefined,
  toolCallId: string,
  toolName: string,
  result: string,
): OffloadResult {
  if (!dir || result.length <= OFFLOAD_CHAR_THRESHOLD) {
    return { forHistory: result, full: result, offloaded: false };
  }
  const safeId = toolCallId.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 64) || 'tool';
  const outDir = join(dir, 'tool-results');
  mkdirSync(outDir, { recursive: true });
  const path = join(outDir, `${Date.now()}-${safeId}.txt`);
  // Redact before disk so session dirs don't accumulate live secrets.
  const redacted = redact.apply(result);
  writeFileSync(path, redacted, { encoding: 'utf8', mode: 0o600 });

  const preview = result.slice(0, OFFLOAD_PREVIEW_CHARS);
  const forHistory = [
    `[tool output offloaded — ${result.length} chars from ${toolName}]`,
    `full path: ${path}`,
    'preview:',
    preview,
    result.length > OFFLOAD_PREVIEW_CHARS ? '…' : '',
    '(use file_read on the path above if you need more of the body)',
  ]
    .filter(Boolean)
    .join('\n');

  return { forHistory, full: result, offloaded: true, path };
}

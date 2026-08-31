/** @jsxImportSource @opentui/react */
// Permission gate modal. Sized to stay fully on-screen: App passes
// maxDetailLines / maxWidth / maxHeight from the terminal so long shell
// payloads never push the box below the last row.

import { TextAttributes } from '@opentui/core';
import { useKeyboard } from '@opentui/react';
import { displayToolName } from '../tools/toolDisplay.js';
import { isCommandTool } from '../ui/PermissionModal.js';
import type { PermissionRequest } from '../ui/permBridge.js';
import { theme } from '../ui/theme.js';

export { isCommandTool } from '../ui/PermissionModal.js';

const COMMAND_DETAIL_CAP = 8000;
const PROSE_DETAIL_CAP = 1200;
/** Default max body lines (content + elision cue) when App does not pass a tighter cap. */
export const DETAIL_MAX_LINES = 5;
const DETAIL_LINE_COLS = 88;

/**
 * Fixed rows around the command body that the card always paints:
 * outer border(2) + header(1) + risk(1) + inner border(2) + "$ command"(1)
 * + actions(1). Elision cue is counted inside maxDetailLines (not chrome).
 */
export const PERMISSION_CHROME_ROWS = 8;

/**
 * Compute a footer height + detail-line budget that always fits in the
 * terminal: banner + chat min + footer ≤ rows (no soft floor that overshoots).
 */
export function computePermissionBudget(opts: {
  terminalRows: number;
  bannerHeight: number;
  chatMinHeight: number;
}): { footerHeight: number; maxDetailLines: number } {
  const { terminalRows, bannerHeight, chatMinHeight } = opts;
  // Room left after banner + a thin chat strip. Never invent rows past the
  // terminal (old Math.max(8, …) floor could allocate footer > available).
  const available = Math.max(0, terminalRows - bannerHeight - chatMinHeight);
  const maxDetail = Math.max(0, Math.min(DETAIL_MAX_LINES, available - PERMISSION_CHROME_ROWS));
  const footerHeight = Math.min(available, PERMISSION_CHROME_ROWS + maxDetail);
  return { footerHeight, maxDetailLines: maxDetail };
}

function isShellTool(name: string): boolean {
  const n = name.trim().toLowerCase();
  return n === 'shell' || n === 'bash' || n === 'bashtool';
}

/** Human title for the permission card. */
export function permissionTitle(tool: string): string {
  if (isShellTool(tool)) return 'Shell command';
  if (tool === 'http') return 'HTTP request';
  if (tool === 'file_write' || tool === 'FileWriteTool') return 'Write file';
  if (tool === 'file_edit' || tool === 'FileEditTool') return 'Edit file';
  return displayToolName(tool);
}

export interface PermissionModalProps {
  req: PermissionRequest;
  /** Terminal width — caps the box and soft-wrap. */
  maxWidth?: number;
  /** Max physical lines of command/payload body including elision cue. */
  maxDetailLines?: number;
  /** Hard cap on the whole card (rows). Clips if content still overshoots. */
  maxHeight?: number;
}

export function PermissionModal({
  req,
  maxWidth = 100,
  maxDetailLines = DETAIL_MAX_LINES,
  maxHeight,
}: PermissionModalProps) {
  useKeyboard((e) => {
    if (e.name === 'escape') {
      req.resolve('deny');
      return;
    }
    if (e.name === 'y') req.resolve('allow-once');
    else if (e.name === 'a') req.resolve('allow-session');
    else if (e.name === 'n') req.resolve('deny');
  });

  const shell = isShellTool(req.tool);
  const asCommand = isCommandTool(req.tool);
  const boxWidth = Math.max(20, Math.min(maxWidth, 100));
  const lineCols = Math.max(8, boxWidth - 8);

  const commandBody = asCommand
    ? req.detail?.trim() || req.summary || ''
    : req.detail && req.detail !== req.summary
      ? req.detail
      : '';
  const showCommandBox = asCommand && commandBody.length > 0;
  const showProseDetail =
    !asCommand && Boolean(req.detail && req.detail !== req.summary && req.detail.trim());

  const detailCap = asCommand ? COMMAND_DETAIL_CAP : PROSE_DETAIL_CAP;
  const detailView = showCommandBox
    ? formatDetail(commandBody, detailCap, maxDetailLines, lineCols)
    : showProseDetail
      ? formatDetail(req.detail, PROSE_DETAIL_CAP, maxDetailLines, lineCols)
      : null;

  const headline = permissionTitle(req.tool);
  const riskLine = shell
    ? 'Runs on this machine. Review before allowing.'
    : req.summary && req.summary !== commandBody
      ? req.summary
      : null;

  return (
    <box
      style={{
        border: true,
        borderStyle: 'rounded',
        borderColor: shell ? theme.warning : theme.border.brand,
        flexDirection: 'column',
        alignSelf: 'stretch',
        width: boxWidth,
        // Cap only — natural height for short payloads, hard ceiling so a
        // long command never paints past the footer strip App reserved.
        flexShrink: 0,
        ...(maxHeight != null ? { maxHeight } : {}),
        paddingX: 1,
        paddingY: 0,
        marginTop: 0,
        overflow: 'hidden',
      }}
    >
      <box style={{ flexDirection: 'row' }}>
        <text fg={shell ? theme.warning : theme.brand} attributes={TextAttributes.BOLD}>
          {shell ? '⚠ ' : ''}
          PERMISSION
        </text>
        <text fg={theme.muted} attributes={TextAttributes.DIM}>
          {'  ·  '}
          {headline}
        </text>
      </box>

      {riskLine ? (
        <box style={{ flexDirection: 'row' }}>
          <text fg={theme.muted} attributes={TextAttributes.DIM}>
            {riskLine.length > boxWidth - 4 ? `${riskLine.slice(0, boxWidth - 5)}…` : riskLine}
          </text>
        </box>
      ) : null}

      {detailView && showCommandBox ? (
        <box
          style={{
            flexDirection: 'column',
            border: true,
            borderStyle: 'rounded',
            borderColor: theme.border.idle,
            paddingX: 1,
            overflow: 'hidden',
          }}
        >
          <box style={{ flexDirection: 'row' }}>
            <text fg={theme.muted} attributes={TextAttributes.DIM}>
              {shell ? '$ command' : 'payload'}
            </text>
          </box>
          {detailView.lines.map((line, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: frozen request snapshot
            <box key={i} style={{ flexDirection: 'row' }}>
              {i === 0 && shell ? (
                <text fg={theme.brand} attributes={TextAttributes.BOLD}>
                  ${' '}
                </text>
              ) : shell ? (
                <text fg={theme.muted}>{'  '}</text>
              ) : null}
              <text fg={theme.text}>{line || ' '}</text>
            </box>
          ))}
          {detailView.elided ? (
            <box style={{ flexDirection: 'row' }}>
              <text fg={theme.muted} attributes={TextAttributes.DIM}>
                {detailView.elided}
              </text>
            </box>
          ) : null}
        </box>
      ) : null}

      {detailView && showProseDetail ? (
        <box style={{ flexDirection: 'column', overflow: 'hidden' }}>
          {detailView.lines.map((line, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: frozen request snapshot
            <box key={i} style={{ flexDirection: 'row' }}>
              <text fg={theme.muted}>{line || ' '}</text>
            </box>
          ))}
          {detailView.elided ? (
            <box style={{ flexDirection: 'row' }}>
              <text fg={theme.muted} attributes={TextAttributes.DIM}>
                {detailView.elided}
              </text>
            </box>
          ) : null}
        </box>
      ) : null}

      <box style={{ flexDirection: 'row' }}>
        <text fg={theme.muted}>
          <span fg={theme.success} attributes={TextAttributes.BOLD}>
            [y]
          </span>
          <span fg={theme.text}> once</span>
          <span fg={theme.muted}>{'  '}</span>
          <span fg={theme.success} attributes={TextAttributes.BOLD}>
            [a]
          </span>
          <span fg={theme.text}> session</span>
          <span fg={theme.muted}>{'  '}</span>
          <span fg={theme.error} attributes={TextAttributes.BOLD}>
            [n]
          </span>
          <span fg={theme.text}> deny</span>
          <span fg={theme.muted} attributes={TextAttributes.DIM}>
            {'  ·  Esc'}
          </span>
        </text>
      </box>
    </box>
  );
}

export function formatDetail(
  raw: string,
  charCap: number,
  maxLines: number = DETAIL_MAX_LINES,
  lineCols: number = DETAIL_LINE_COLS,
): { lines: string[]; elided: string | null } {
  let s = raw;
  let charElided = 0;
  if (s.length > charCap) {
    charElided = s.length - charCap;
    s = s.slice(0, charCap);
  }
  const cols = Math.max(16, lineCols);
  const physical: string[] = [];
  for (const hard of s.replace(/\r\n/g, '\n').split('\n')) {
    if (hard.length === 0) {
      physical.push('');
      continue;
    }
    for (let i = 0; i < hard.length; i += cols) {
      physical.push(hard.slice(i, i + cols));
    }
  }

  // maxLines is a hard ceiling on painted body rows (content + optional
  // elision cue). 0 = no body at all (chrome-only card on tiny terminals).
  const limit = Math.max(0, maxLines);
  if (limit === 0) {
    return { lines: [], elided: null };
  }

  const fits = physical.length <= limit && charElided === 0;
  if (fits) {
    return { lines: physical, elided: null };
  }

  // Need an elision cue. Reserve one of the `limit` slots for it so
  // content.length + (elided ? 1 : 0) ≤ limit. When limit === 1, fold the
  // cue into the single content line (suffix "…") so we never paint 2 rows.
  if (limit === 1) {
    const head = physical[0] ?? '';
    const clipped = head.length > cols - 1 ? head.slice(0, cols - 1) : head;
    return { lines: [`${clipped}…`], elided: null };
  }

  const contentLimit = limit - 1; // ≥ 1 because limit ≥ 2 here
  const kept = physical.slice(0, contentLimit);
  const lineElided = Math.max(0, physical.length - contentLimit);
  const parts: string[] = [];
  if (lineElided > 0) parts.push(`… ${lineElided} more line${lineElided === 1 ? '' : 's'}`);
  if (charElided > 0) {
    parts.push(lineElided > 0 ? `${charElided} chars cut` : `… truncated ${charElided} chars`);
  }
  return { lines: kept, elided: parts.join(' · ') || null };
}

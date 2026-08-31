// Clipboard helpers for the TUI.
//
// macOS Terminal.app does NOT honor OSC 52 clipboard writes. Mouse tracking
// also steals native selection, so Cmd+C can't copy the OS way. On desktop
// we prefer host tools (pbcopy/pbpaste) and treat OSC 52 as a best-effort
// extra for iTerm2/tmux/SSH.

import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { apply as redact } from '../redact/redact.js';
import type { TranscriptEntry } from './state.js';
import { stripControlSequences } from './toolResultFormat.js';
import { normalizePastedText, stripPasteMarkers } from './useTextField.js';

const execFileAsync = promisify(execFile);

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);

/** Build the OSC 52 "set clipboard" escape sequence for `text`. */
export function osc52(text: string): string {
  const b64 = Buffer.from(text, 'utf8').toString('base64');
  return `${ESC}]52;c;${b64}${BEL}`;
}

/** Decode paste event bytes (UTF-8 + strip leaked bracketed-paste markers). */
export function decodePasteEvent(bytes: Uint8Array): string {
  const raw = new TextDecoder().decode(bytes);
  return normalizePastedText(stripPasteMarkers(raw));
}

/** Optional OpenTUI renderer surface for OSC 52. */
export interface ClipboardRenderer {
  copyToClipboardOSC52?: (text: string) => boolean;
  isOsc52Supported?: () => boolean;
}

/** True when a host clipboard CLI is the reliable path (macOS Terminal, etc.). */
export function preferHostClipboard(): boolean {
  if (process.platform === 'darwin') return true;
  if (process.platform === 'win32') return true;
  // Local Linux desktop sessions.
  if (process.env.WAYLAND_DISPLAY || process.env.DISPLAY) return true;
  return false;
}

/**
 * Copy `text` to the system clipboard.
 * Host tools first on macOS/Windows/desktop Linux (Terminal.app needs pbcopy).
 * OSC 52 is still attempted for terminals/SSH that support it.
 */
export async function copyText(
  text: string,
  renderer?: ClipboardRenderer | null,
): Promise<boolean> {
  if (!text) return false;

  let hostOk = false;
  let oscOk = false;

  if (preferHostClipboard()) {
    hostOk = await writeSystemClipboard(text);
  }

  // OSC 52 — useful over SSH / iTerm; Terminal.app ignores it.
  try {
    if (renderer?.copyToClipboardOSC52) {
      // Only claim success when the runtime thinks OSC 52 is supported.
      if (!renderer.isOsc52Supported || renderer.isOsc52Supported()) {
        oscOk = Boolean(renderer.copyToClipboardOSC52(text));
      }
    }
  } catch {
    /* fall through */
  }
  if (!oscOk) {
    try {
      process.stdout.write(osc52(text));
      // Don't treat write as success — many terminals ignore OSC 52.
    } catch {
      /* ignore */
    }
  }

  if (!hostOk && !preferHostClipboard()) {
    // Remote/headless: try host tools as last resort (sometimes available).
    hostOk = await writeSystemClipboard(text);
  }

  return hostOk || oscOk;
}

/** Read the host clipboard (Cmd/Ctrl+V fallback when bracketed paste fails). */
export async function readSystemClipboard(): Promise<string | null> {
  const attempts: Array<{ cmd: string; args: string[] }> = [];
  if (process.platform === 'darwin') {
    attempts.push({ cmd: 'pbpaste', args: [] });
  } else if (process.platform === 'win32') {
    attempts.push({
      cmd: 'powershell',
      args: ['-NoProfile', '-Command', 'Get-Clipboard -Raw'],
    });
  } else {
    attempts.push({ cmd: 'wl-paste', args: ['-n'] });
    attempts.push({ cmd: 'xclip', args: ['-selection', 'clipboard', '-o'] });
    attempts.push({ cmd: 'xsel', args: ['--clipboard', '--output'] });
  }

  for (const a of attempts) {
    try {
      const { stdout } = await execFileAsync(a.cmd, a.args, {
        encoding: 'utf8',
        timeout: 2000,
        maxBuffer: 4 * 1024 * 1024,
      });
      if (typeof stdout === 'string' && stdout.length > 0) {
        return normalizePastedText(stripPasteMarkers(stdout));
      }
    } catch {
      /* try next */
    }
  }
  return null;
}

function writeViaStdin(cmd: string, args: string[], text: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ['pipe', 'ignore', 'ignore'] });
    let settled = false;
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
      done(false);
    }, 2000);
    child.on('error', () => {
      clearTimeout(timer);
      done(false);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      done(code === 0);
    });
    child.stdin?.on('error', () => {
      clearTimeout(timer);
      done(false);
    });
    try {
      child.stdin?.end(text, 'utf8');
    } catch {
      clearTimeout(timer);
      done(false);
    }
  });
}

export async function writeSystemClipboard(text: string): Promise<boolean> {
  const attempts: Array<{ cmd: string; args: string[] }> = [];
  if (process.platform === 'darwin') {
    attempts.push({ cmd: 'pbcopy', args: [] });
  } else if (process.platform === 'win32') {
    attempts.push({
      cmd: 'powershell',
      args: ['-NoProfile', '-Command', 'Set-Clipboard -Value $input'],
    });
  } else {
    attempts.push({ cmd: 'wl-copy', args: [] });
    attempts.push({ cmd: 'xclip', args: ['-selection', 'clipboard'] });
    attempts.push({ cmd: 'xsel', args: ['--clipboard', '--input'] });
  }

  for (const a of attempts) {
    if (await writeViaStdin(a.cmd, a.args, text)) return true;
  }
  return false;
}

/** Most recent tool-result (full body if truncated) or finding card. */
export function lastCopyableOutput(entries: TranscriptEntry[]): string | null {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const e = entries[i];
    if (!e) continue;
    if (e.kind === 'tool-result') return redact(stripControlSequences(e.fullText ?? e.text));
    if (e.kind === 'finding') return redact(stripControlSequences(e.text));
  }
  return null;
}

import { describe, expect, it, vi } from 'vitest';
import {
  copyText,
  decodePasteEvent,
  lastCopyableOutput,
  osc52,
  readSystemClipboard,
} from './clipboard.js';
import type { TranscriptEntry } from './state.js';

describe('osc52', () => {
  it('wraps base64 of the text in an OSC 52 set-clipboard sequence', () => {
    const seq = osc52('hello');
    // ESC ] 52 ; c ; aGVsbG8= BEL
    expect(seq).toBe(`${String.fromCharCode(27)}]52;c;aGVsbG8=${String.fromCharCode(7)}`);
  });

  it('round-trips utf8 through base64', () => {
    const seq = osc52('café');
    const b64 = seq.slice(seq.indexOf(';c;') + 3, -1);
    expect(Buffer.from(b64, 'base64').toString('utf8')).toBe('café');
  });
});

describe('decodePasteEvent', () => {
  it('decodes utf8 paste bytes', () => {
    expect(decodePasteEvent(new TextEncoder().encode('hello world'))).toBe('hello world');
  });

  it('normalizes CRLF and strips bracketed-paste markers', () => {
    const raw = '\x1b[200~line1\r\nline2\x1b[201~';
    expect(decodePasteEvent(new TextEncoder().encode(raw))).toBe('line1\nline2');
  });
});

describe('copyText', () => {
  it('returns false for empty text', async () => {
    await expect(copyText('')).resolves.toBe(false);
  });

  it('uses host clipboard on macOS (pbcopy) — Terminal.app ignores OSC 52', async () => {
    if (process.platform !== 'darwin') return;
    const marker = `pf-copy-host-${Date.now()}`;
    const osc = vi.fn(() => true); // pretend OSC 52 "worked"
    const ok = await copyText(marker, {
      copyToClipboardOSC52: osc,
      isOsc52Supported: () => true,
    });
    expect(ok).toBe(true);
    // Host write is ground truth even if OSC claims success.
    await new Promise((r) => setTimeout(r, 40));
    const got = await readSystemClipboard();
    expect(got).toContain(marker);
  });
});

describe('host clipboard (optional)', () => {
  it('round-trips via the platform clipboard tool when available', async () => {
    const marker = `pentesterflow-clipboard-test-${Date.now()}`;
    // Force host path: renderer reports unsupported, stdout is a no-op.
    const writeSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const ok = await copyText(marker, { copyToClipboardOSC52: () => false });
    writeSpy.mockRestore();
    if (!ok) return; // no host tool (CI without clipboard) — skip assert
    // Brief settle for pbcopy/wl-copy.
    await new Promise((r) => setTimeout(r, 50));
    const got = await readSystemClipboard();
    if (got === null) return; // clipboard read unavailable
    expect(got).toContain(marker);
  }, 10_000);
});

describe('lastCopyableOutput', () => {
  const entry = (kind: TranscriptEntry['kind'], text: string, fullText?: string): TranscriptEntry =>
    ({ kind, text, fullText }) as TranscriptEntry;

  it('returns null when there is nothing copyable', () => {
    expect(lastCopyableOutput([])).toBeNull();
    expect(lastCopyableOutput([entry('user', 'hi'), entry('assistant', 'yo')])).toBeNull();
  });

  it('prefers the full body of a truncated tool-result', () => {
    const entries = [entry('tool-result', 'preview…', 'FULL BODY')];
    expect(lastCopyableOutput(entries)).toBe('FULL BODY');
  });

  it('falls back to text when there is no full body', () => {
    expect(lastCopyableOutput([entry('tool-result', 'short')])).toBe('short');
  });

  it('walks from the tail to copy the most recent output', () => {
    const entries = [
      entry('tool-result', 'old'),
      entry('assistant', 'chatter'),
      entry('tool-result', 'new'),
    ];
    expect(lastCopyableOutput(entries)).toBe('new');
  });

  it('copies a finding card when it is the latest copyable entry', () => {
    expect(lastCopyableOutput([entry('finding', 'HIGH · SQLi')])).toBe('HIGH · SQLi');
  });
});

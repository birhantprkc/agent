import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { OFFLOAD_CHAR_THRESHOLD, maybeOffloadToolResult } from './toolResultStore.js';

let dir: string | undefined;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

describe('maybeOffloadToolResult', () => {
  it('passes small results through unchanged', () => {
    const out = maybeOffloadToolResult('/tmp', 'id1', 'shell', 'short ok');
    expect(out.offloaded).toBe(false);
    expect(out.forHistory).toBe('short ok');
    expect(out.full).toBe('short ok');
  });

  it('writes large results to disk and returns a pointer', () => {
    dir = mkdtempSync(join(tmpdir(), 'pf-offload-'));
    const body = 'Z'.repeat(OFFLOAD_CHAR_THRESHOLD + 100);
    const out = maybeOffloadToolResult(dir, 'call-abc', 'http', body);
    expect(out.offloaded).toBe(true);
    expect(out.path).toBeTruthy();
    expect(out.forHistory).toContain('tool output offloaded');
    expect(out.forHistory).toContain(out.path ?? '');
    expect(out.forHistory.length).toBeLessThan(body.length);
    expect(out.full).toBe(body);
    const disk = readFileSync(out.path ?? '', 'utf8');
    expect(disk.length).toBe(body.length);
  });

  it('skips offload when no session dir', () => {
    const body = 'Z'.repeat(OFFLOAD_CHAR_THRESHOLD + 50);
    const out = maybeOffloadToolResult(null, 'id', 'shell', body);
    expect(out.offloaded).toBe(false);
    expect(out.forHistory).toBe(body);
  });
});

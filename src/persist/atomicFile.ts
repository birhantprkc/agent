// Shared crash-safe file write: stage in a sibling `.tmp.<rand>`, then
// atomic rename onto the real path. Used by every store that persists a
// full-snapshot JSON/JSONL file (session, coverage, memory, intelligence)
// so the crash-safety behavior lives in one place instead of N copies.

import { randomBytes } from 'node:crypto';
import { closeSync, fsyncSync, openSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { chmod, open, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';

const DEFAULT_MODE = 0o600;

function tmpPath(path: string): string {
  return `${path}.tmp.${randomBytes(3).toString('hex')}`;
}

// The rename-onto-target pattern above prevents truncation/corruption, but
// doesn't by itself guarantee the write survives a crash: (1) writeFileSync
// only hands bytes to the OS page cache, not disk, unless fsynced; (2) even
// with the file itself fsynced, the directory-entry update the rename just
// performed is a separate piece of metadata that can itself be lost on crash
// — a well-known POSIX gotcha — reverting the path to its pre-write state
// despite the caller having observed a successful write. Best-effort: some
// filesystems/platforms don't support fsyncing a directory handle, so this
// never throws past a best-effort attempt.
function fsyncDirBestEffort(path: string): void {
  try {
    const fd = openSync(dirname(path), 'r');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch {
    /* best-effort — not all filesystems support fsyncing a directory */
  }
}

async function fsyncDirBestEffortAsync(path: string): Promise<void> {
  let fh: Awaited<ReturnType<typeof open>> | undefined;
  try {
    fh = await open(dirname(path), 'r');
    await fh.sync();
  } catch {
    /* best-effort — not all filesystems support fsyncing a directory */
  } finally {
    await fh?.close().catch(() => undefined);
  }
}

/** Crash-safe synchronous write: stage in a sibling tmp, fsync, atomic
 *  rename, then fsync the containing directory so the rename itself survives
 *  a crash. */
export function atomicWriteFileSync(path: string, content: string, mode = DEFAULT_MODE): void {
  const tmp = tmpPath(path);
  try {
    writeFileSync(tmp, content, { mode });
    const fd = openSync(tmp, 'r');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, path);
    fsyncDirBestEffort(path);
  } catch (err) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      /* ignore */
    }
    throw err;
  }
}

/**
 * Crash-safe async write: stage in a sibling tmp, optionally fsync before
 * close, then atomic rename onto the real path. Best-effort chmod after
 * rename since some filesystems/umasks don't honor the open mode.
 */
export async function atomicWriteFile(
  path: string,
  content: string,
  opts: { mode?: number; fsync?: boolean } = {},
): Promise<void> {
  const mode = opts.mode ?? DEFAULT_MODE;
  const tmp = tmpPath(path);
  let fh: Awaited<ReturnType<typeof open>> | undefined;
  try {
    fh = await open(tmp, 'wx', mode);
    await fh.writeFile(content);
    if (opts.fsync) await fh.sync();
    await fh.close();
    fh = undefined;
    await rename(tmp, path);
    // Directory fsync is independent of the file-level `fsync` opt above
    // (which callers throttle for perf on hot paths, e.g. session saves) —
    // the rename's directory-entry update needs its own fsync to survive a
    // crash regardless, and it's cheap enough to always do.
    await fsyncDirBestEffortAsync(path);
    await chmod(path, mode).catch(() => undefined);
  } catch (err) {
    if (fh) {
      try {
        await fh.close();
      } catch {
        /* ignore */
      }
    }
    try {
      await unlink(tmp);
    } catch {
      /* ignore */
    }
    throw err;
  }
}

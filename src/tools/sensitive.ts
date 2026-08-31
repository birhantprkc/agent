// Sensitive-path gating. Returns true when the absolute path lies inside
// a directory or matches a filename that conventionally holds credentials,
// private keys, or other secrets the model should not read without an
// explicit user prompt.

import { homedir } from 'node:os';
import { basename, resolve, sep } from 'node:path';

// macOS canonicalizes /etc -> /private/etc, so denylist both spellings: a
// file_read of /private/etc/sudoers (or a realpath that lands there) must be
// caught even though the lexical /etc/... form is what users usually type.
const SYSTEM_PATHS = [
  '/etc/shadow',
  '/etc/sudoers',
  '/etc/master.passwd',
  '/etc/passwd',
  '/private/etc/shadow',
  '/private/etc/sudoers',
  '/private/etc/master.passwd',
  '/private/etc/passwd',
];

const HOME_RELATIVE = [
  '.ssh',
  '.aws',
  '.azure',
  '.gnupg',
  '.gcloud',
  '.kube',
  '.docker',
  '.config/gcloud',
  '.config/op',
  '.config/gh',
  '.pentesterflow',
  '.netrc',
  '.pgpass',
  '.npmrc',
  '.pypirc',
  '.git-credentials',
  '.bash_history',
  '.zsh_history',
  '.python_history',
  '.mysql_history',
  '.psql_history',
  // Browser cookie/session-token stores — reading these is effectively
  // session hijacking against every site the operator is logged into.
  'Library/Application Support/Google/Chrome',
  'Library/Application Support/BraveSoftware/Brave-Browser',
  'Library/Application Support/Firefox',
  'Library/Cookies',
  '.config/google-chrome',
  '.config/BraveSoftware/Brave-Browser',
  '.mozilla/firefox',
];

// Matched by filename wherever it occurs, not just under $HOME — .env files
// conventionally live at a project root, which can be anywhere on disk.
// Case-insensitive; matches .env, .env.local, .env.production, etc. — but
// anchored so it doesn't false-positive on an unrelated name that merely
// starts with those letters (e.g. `.environment`).
const SENSITIVE_BASENAME_RE = /^\.env(\..*)?$/i;

/**
 * Returns true when `abs` (an absolute path) matches a known-sensitive
 * file or sits under a known-sensitive directory. Uses exact match or
 * directory prefix match — `.ssh_other` does NOT match `.ssh`.
 */
export function isSensitivePath(abs: string): boolean {
  const cleaned = resolve(abs);

  for (const p of SYSTEM_PATHS) {
    if (matchesPath(cleaned, p)) return true;
  }

  if (SENSITIVE_BASENAME_RE.test(basename(cleaned))) return true;

  const home = homedir();
  if (!home) return false;

  for (const rel of HOME_RELATIVE) {
    if (matchesPath(cleaned, resolve(home, rel))) return true;
  }
  return false;
}

// Exact-or-directory-prefix match. Case-insensitive so the gate still fires on
// case-insensitive filesystems (default APFS/HFS+ on macOS, NTFS on Windows),
// where `/ETC/SUDOERS` and `~/.SSH/id_rsa` open the same file as the lowercase
// form. On case-sensitive Linux this can only over-prompt for an unrelated file
// that differs solely by case — harmless, since the gate is a prompt the
// operator can allow, never a hard block.
function matchesPath(candidate: string, target: string): boolean {
  const c = candidate.toLowerCase();
  const t = target.toLowerCase();
  return c === t || c.startsWith(t + sep);
}

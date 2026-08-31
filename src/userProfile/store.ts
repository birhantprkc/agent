// User profile — a single flat, personal-scope markdown file capturing what
// the agent has learned about the OPERATOR specifically: communication
// style, standing preferences, expectations. Distinct from MemoryStore
// (per-fact target/technique/reference notes about the engagement) and
// EngagementStore (scope/rules-of-engagement, hand-authored): this file is
// about the human across every project, and — unlike MemoryStore — the
// agent can append to it autonomously via the update_user_profile tool, not
// just on explicit user request.
//
// Lives at ~/.pentesterflow/USER.md only (no project scope: communication
// style doesn't reset per engagement). Always injected into the system
// prompt, like engagement.md.

import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { atomicWriteFile } from '../persist/atomicFile.js';
import { apply as redact } from '../redact/index.js';

// Hard cap so autonomous appends can't grow this file without bound. When an
// append would exceed it, the OLDEST lines are dropped first — the most
// recently learned understanding of the user is what's worth keeping.
export const USER_PROFILE_CHAR_LIMIT = 4000;

export interface UserProfileStoreOptions {
  home?: string;
}

export class UserProfileStore {
  readonly path: string;

  constructor(opts: UserProfileStoreOptions = {}) {
    const home = opts.home ?? homedir();
    this.path = join(home, '.pentesterflow', 'USER.md');
  }

  /** Read the file, trimmed. Returns '' when missing or unreadable. */
  load(): string {
    if (!existsSync(this.path)) return '';
    try {
      return readFileSync(this.path, 'utf8').trim();
    } catch {
      return '';
    }
  }

  /**
   * Append one distilled note (redacted first — this file is never a place
   * for live secrets to land). No-op on empty/whitespace-only text. Caps
   * total size by dropping the oldest lines first.
   */
  async append(text: string): Promise<void> {
    const clean = redact(text.trim());
    if (!clean) return;
    const existing = this.load();
    const combined = existing ? `${existing}\n- ${clean}` : `- ${clean}`;
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    await atomicWriteFile(this.path, `${capToLimit(combined)}\n`, { mode: 0o600 });
  }

  /** Wipe the file entirely (the /user clear escape hatch). */
  async clear(): Promise<void> {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    await atomicWriteFile(this.path, '', { mode: 0o600 });
  }
}

/** Drop the oldest lines until the text fits USER_PROFILE_CHAR_LIMIT. */
function capToLimit(text: string): string {
  if (text.length <= USER_PROFILE_CHAR_LIMIT) return text;
  const lines = text.split('\n');
  while (lines.length > 1 && lines.join('\n').length > USER_PROFILE_CHAR_LIMIT) {
    lines.shift();
  }
  return lines.join('\n');
}

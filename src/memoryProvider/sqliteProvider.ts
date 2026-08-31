// Local SQLite FTS5 memory provider — the free, no-external-service,
// no-API-key option (mirrors "Holographic" in the memory-providers pattern
// this feature is modeled on). Records every turn into a full-text index and
// recalls the best-matching prior turns for the current message.
//
// Uses node:sqlite (built into Node — no new dependency, matching this
// project's hand-rolled-over-SDK philosophy). That module needs Node 22.5+;
// on older Node (this project supports >=20) createSqliteMemoryProvider()
// returns null and the caller runs with no external provider, same as if
// the user had left memory_provider: 'off'.

import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import type { Tool } from '../tools/types.js';
import { createMemoryProviderSearchTool } from './searchTool.js';
import type { MemoryProvider, MemoryProviderEntry } from './types.js';

// Cheap subset of the node:sqlite surface this file actually uses, so the
// rest of the module can be typed without depending on @types/node having
// caught up with an experimental core module.
interface SqliteStatement {
  run(...params: unknown[]): unknown;
  all(...params: unknown[]): Array<Record<string, unknown>>;
  get(...params: unknown[]): Record<string, unknown> | undefined;
}
interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}

const DEFAULT_RECALL_LIMIT = 5;
// Hard cap on stored entries so an unbounded session can't grow the DB file
// without limit — oldest entries are pruned first.
const MAX_ENTRIES = 20_000;

export interface SqliteMemoryProviderOptions {
  cwd?: string;
}

/**
 * Attempt to construct the SQLite provider. Returns null (never throws) when
 * node:sqlite isn't available in this Node build — callers treat that
 * exactly like memory_provider: 'off'.
 */
export async function createSqliteMemoryProvider(
  opts: SqliteMemoryProviderOptions = {},
): Promise<MemoryProvider | null> {
  let DatabaseSync: new (path: string) => SqliteDatabase;
  try {
    // CJS require (via createRequire), not `import('node:sqlite')`: Vite/
    // vite-node — which the test suite runs under — mishandles a dynamic
    // ESM import of this specific built-in (strips the `node:` prefix and
    // tries to resolve a bare "sqlite" package, which doesn't exist). A
    // plain require() bypasses Vite's import resolution entirely and works
    // identically under real Node (tsx, the built dist/cli.js) and Vitest.
    const req = createRequire(import.meta.url);
    ({ DatabaseSync } = req('node:sqlite') as {
      DatabaseSync: new (path: string) => SqliteDatabase;
    });
  } catch {
    return null;
  }

  const cwd = resolve(opts.cwd ?? process.cwd());
  const dbPath = join(cwd, '.pentesterflow', 'memory-provider', 'store.db');
  mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 });

  let db: SqliteDatabase;
  try {
    db = new DatabaseSync(dbPath);
    db.exec(
      'CREATE VIRTUAL TABLE IF NOT EXISTS entries USING fts5(role UNINDEXED, content, created_at UNINDEXED)',
    );
  } catch {
    return null;
  }

  return new SqliteMemoryProvider(db);
}

class SqliteMemoryProvider implements MemoryProvider {
  private readonly db: SqliteDatabase;
  private closed = false;

  constructor(db: SqliteDatabase) {
    this.db = db;
  }

  name(): string {
    return 'sqlite';
  }

  systemPromptContext(): string {
    if (this.closed) return '';
    try {
      const row = this.db.prepare('SELECT count(*) AS n FROM entries').get();
      const n = typeof row?.n === 'number' ? row.n : 0;
      if (n === 0) return '';
      return `Local SQLite memory provider active — ${n} past turn${n === 1 ? '' : 's'} indexed and searchable via memory_provider_search.`;
    } catch {
      return '';
    }
  }

  async recall(query: string, limit = DEFAULT_RECALL_LIMIT): Promise<string> {
    if (this.closed) return '';
    const match = toMatchExpression(query);
    if (!match) return '';
    try {
      const rows = this.db
        .prepare(
          'SELECT role, content, created_at FROM entries WHERE entries MATCH ? ORDER BY rank LIMIT ?',
        )
        .all(match, Math.max(1, Math.floor(limit)));
      if (rows.length === 0) return '';
      const lines = rows.map(
        (r) => `- [${String(r.role)} @ ${String(r.created_at)}] ${String(r.content)}`,
      );
      return `Relevant prior turns (local SQLite memory provider):\n${lines.join('\n')}`;
    } catch {
      return '';
    }
  }

  async record(entry: MemoryProviderEntry): Promise<void> {
    if (this.closed) return;
    const content = entry.content.trim();
    if (!content) return;
    try {
      this.db
        .prepare('INSERT INTO entries(role, content, created_at) VALUES (?, ?, ?)')
        .run(entry.role, content, entry.createdAt);
      this.prune();
    } catch {
      /* best-effort — a provider write failure must never break the turn */
    }
  }

  tools(): Tool[] {
    return [createMemoryProviderSearchTool(this)];
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      this.db.close();
    } catch {
      /* best-effort */
    }
  }

  /** Cap total rows: drop the oldest beyond MAX_ENTRIES. Cheap check first
   *  (count) so the common case doesn't do a needless delete every insert. */
  private prune(): void {
    const row = this.db.prepare('SELECT count(*) AS n FROM entries').get();
    const n = typeof row?.n === 'number' ? row.n : 0;
    if (n <= MAX_ENTRIES) return;
    const excess = n - MAX_ENTRIES;
    this.db
      .prepare(
        'DELETE FROM entries WHERE rowid IN (SELECT rowid FROM entries ORDER BY created_at ASC LIMIT ?)',
      )
      .run(excess);
  }
}

/**
 * Build a safe FTS5 MATCH expression from free-text `query`: tokenize and
 * quote each token, joined with OR, so arbitrary user text (which may
 * contain FTS5 operators like *, -, "", AND/OR/NOT) can't produce a syntax
 * error or unintended boolean query — it's always treated as literal terms.
 */
function toMatchExpression(query: string): string {
  const tokens = query
    .toLowerCase()
    .match(/[a-z0-9_.-]{2,}/g)
    ?.slice(0, 32);
  if (!tokens || tokens.length === 0) return '';
  return tokens.map((t) => `"${t.replace(/"/g, '""')}"`).join(' OR ');
}

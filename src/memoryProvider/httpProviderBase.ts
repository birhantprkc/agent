// Generic HTTP-backed MemoryProvider. mem0/honcho/hindsight/retaindb/
// supermemory/openviking all share the exact same shape — recall via one
// POST, record via another POST, extract text rows from a JSON response,
// report a one-line status once something's been recorded — so instead of
// six near-identical classes, each provider file now only supplies the bits
// that actually differ: URLs, request bodies, auth headers, and response
// parsing. Provider-specific statefulness (e.g. Honcho's lazy session
// creation) stays in the provider file as a closure passed into
// `recordRequest` — this base doesn't need to know about it.

import type { Tool } from '../tools/types.js';
import { postJSON } from './httpUtil.js';
import { createMemoryProviderSearchTool } from './searchTool.js';
import type { MemoryProvider, MemoryProviderEntry } from './types.js';

export interface HttpRequestSpec {
  url: string;
  body: unknown;
}

export interface HttpMemoryProviderConfig {
  /** Machine name, e.g. 'mem0'. Returned by MemoryProvider.name(). */
  name: string;
  /** Human label used in status text and the recall preamble, e.g. 'Mem0'. */
  label: string;
  /** The scope/host detail shown in the status line, e.g. a workspace id or the base URL. */
  statusDetail: string;
  /** Auth headers for every request (empty object when no key configured). */
  headers(): Record<string, string>;
  /** Default `limit` passed to recall() when the caller doesn't specify one. */
  recallLimitDefault?: number;
  recallRequest(query: string, limit: number): HttpRequestSpec;
  /**
   * Build the record request for a (non-empty-content) entry. Returning null
   * skips the request entirely (e.g. Honcho when session bootstrap failed).
   */
  recordRequest(entry: MemoryProviderEntry): Promise<HttpRequestSpec | null>;
  extractRows(json: unknown): unknown[];
  rowText(row: unknown): string | undefined;
}

export function createHttpMemoryProvider(cfg: HttpMemoryProviderConfig): MemoryProvider {
  return new HttpMemoryProvider(cfg);
}

class HttpMemoryProvider implements MemoryProvider {
  private entryCount = 0;

  constructor(private readonly cfg: HttpMemoryProviderConfig) {}

  name(): string {
    return this.cfg.name;
  }

  systemPromptContext(): string {
    if (this.entryCount === 0) return '';
    return `${this.cfg.label} memory provider active (${this.cfg.statusDetail}) — ${this.entryCount} turn${this.entryCount === 1 ? '' : 's'} sent this session.`;
  }

  async recall(query: string, limit = this.cfg.recallLimitDefault ?? 5): Promise<string> {
    const { url, body } = this.cfg.recallRequest(query, limit);
    const result = await postJSON(url, this.cfg.headers(), body);
    if (!result || !result.ok) return '';
    const rows = this.cfg.extractRows(result.json);
    if (rows.length === 0) return '';
    const lines = rows
      .map((r) => this.cfg.rowText(r) ?? '')
      .filter(Boolean)
      .map((text) => `- ${text}`);
    if (lines.length === 0) return '';
    return `Relevant prior turns (${this.cfg.label}):\n${lines.join('\n')}`;
  }

  async record(entry: MemoryProviderEntry): Promise<void> {
    const content = entry.content.trim();
    if (!content) return;
    const req = await this.cfg.recordRequest({ ...entry, content });
    if (!req) return;
    const result = await postJSON(req.url, this.cfg.headers(), req.body);
    if (result?.ok) this.entryCount += 1;
  }

  tools(): Tool[] {
    return [createMemoryProviderSearchTool(this)];
  }

  async close(): Promise<void> {
    /* no persistent connection to release */
  }
}

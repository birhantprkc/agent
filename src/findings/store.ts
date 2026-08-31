// Findings store. Confirmed vulnerabilities are written to
// ./findings/<slug>.md so different engagements stay separate (per cwd)
// without configuration. Mirrors internal/findings/findings.go shape.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { atomicWriteFile } from '../persist/atomicFile.js';
import { renderMarkdownReport, renderSarifReport } from './report.js';

export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info';

export interface Finding {
  title: string;
  severity: Severity;
  url: string;
  parameter?: string;
  payload?: string;
  method?: string;
  responseExcerpt?: string;
  impact: string;
  curl?: string;
  remediation?: string;
  createdAt: string; // ISO timestamp
  slug: string;
}

export interface SaveResult {
  path: string;
  /** True when an identical (title+url+parameter) finding was already recorded and no new file was written. */
  duplicate: boolean;
}

export type ReportFormat = 'markdown' | 'sarif';

interface IndexEntry {
  path: string;
  finding: Finding;
}

export class Store {
  readonly dir: string;

  // Serializes save() calls so a read-modify-write on the dedupe index can't
  // race with a concurrent save from another in-flight tool call.
  private queue: Promise<unknown> = Promise.resolve();

  constructor(dir = 'findings') {
    this.dir = resolve(dir);
  }

  /**
   * Render the finding as markdown and persist it, unless an earlier finding
   * with the same title+url+parameter was already recorded — re-running a
   * scan against the same endpoint/param then returns the existing path
   * instead of writing a duplicate file.
   */
  async save(finding: Finding): Promise<SaveResult> {
    const result = this.queue.then(() => this.saveLocked(finding));
    this.queue = result.catch(() => undefined);
    return result;
  }

  private async saveLocked(finding: Finding): Promise<SaveResult> {
    if (!existsSync(this.dir)) {
      mkdirSync(this.dir, { recursive: true });
    }

    const key = dedupeKey(finding);
    const index = await this.loadIndex();
    const existing = index[key];
    if (existing && existsSync(existing.path)) {
      return { path: existing.path, duplicate: true };
    }

    const content = render(finding);
    let path = '';
    // Atomic create-exclusive (O_EXCL via flag 'wx'): the write fails if the
    // path already exists, so two same-slug saves racing between an existence
    // check and the write can't both resolve to one path and clobber each other
    // (M12). On collision, bump the suffix and retry.
    for (let i = 1; ; i += 1) {
      const candidate = join(this.dir, i === 1 ? `${finding.slug}.md` : `${finding.slug}-${i}.md`);
      try {
        await writeFile(candidate, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
        path = candidate;
        break;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'EEXIST') continue;
        throw err;
      }
    }

    // Re-read the index immediately before writing rather than reusing the
    // copy loaded at the top of this call: `this.queue` only serializes
    // saves within THIS process. Two separate pentesterflow processes
    // pointed at the same findings/ dir (e.g. sharded scan agents) can both
    // load the same index before either writes it back — the second
    // saveIndex() would otherwise silently overwrite the first process's
    // addition, dropping a confirmed finding from /findings list and the
    // report even though its .md file is safely on disk. Re-reading here
    // doesn't fully close the race (no cross-process file lock) but shrinks
    // the window from "the whole .md render + write" down to just this
    // merge, and a real collision only loses a duplicate-detection index
    // entry, never the finding file itself.
    const freshIndex = await this.loadIndex();
    freshIndex[key] = { path, finding };
    await this.saveIndex(freshIndex);
    return { path, duplicate: false };
  }

  /** All recorded findings whose file still exists on disk, oldest first. */
  async list(): Promise<Finding[]> {
    const index = await this.loadIndex();
    return Object.values(index)
      .filter((e) => existsSync(e.path))
      .map((e) => e.finding)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  /** Renders every recorded finding into one report file and returns its path + finding count. */
  async writeReport(format: ReportFormat = 'markdown'): Promise<{ path: string; count: number }> {
    const findings = await this.list();
    const content =
      format === 'sarif' ? renderSarifReport(findings) : renderMarkdownReport(findings);
    const path = join(this.dir, format === 'sarif' ? 'report.sarif.json' : 'report.md');
    await atomicWriteFile(path, content, { mode: 0o600 });
    return { path, count: findings.length };
  }

  private indexPath(): string {
    return join(this.dir, '.dedupe.json');
  }

  private async loadIndex(): Promise<Record<string, IndexEntry>> {
    try {
      const raw = await readFile(this.indexPath(), 'utf8');
      return JSON.parse(raw) as Record<string, IndexEntry>;
    } catch {
      return {};
    }
  }

  private async saveIndex(index: Record<string, IndexEntry>): Promise<void> {
    await atomicWriteFile(this.indexPath(), JSON.stringify(index, null, 2));
  }
}

/** Hashes the normalized title+url+parameter so re-scans of the same bug don't produce duplicate finding files. */
function dedupeKey(f: Pick<Finding, 'title' | 'url' | 'parameter'>): string {
  const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');
  const raw = `${norm(f.title)}|${norm(f.url)}|${norm(f.parameter ?? '')}`;
  return createHash('sha256').update(raw).digest('hex').slice(0, 16);
}

export function slugify(title: string): string {
  return title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-+|-+$)/g, '')
    .slice(0, 64);
}

export function render(f: Finding): string {
  const lines: string[] = [];
  lines.push(`# ${f.title}`, '');
  lines.push(`- **Severity:** ${f.severity}`);
  lines.push(`- **URL:** ${f.url}`);
  if (f.method) lines.push(`- **Method:** ${f.method}`);
  if (f.parameter) lines.push(`- **Parameter:** ${f.parameter}`);
  lines.push(`- **Reported at:** ${f.createdAt}`);
  lines.push('', '## Impact', '', f.impact, '');
  if (f.payload) {
    lines.push('## Payload', '', '```', f.payload, '```', '');
  }
  if (f.responseExcerpt) {
    lines.push('## Response excerpt', '', '```', f.responseExcerpt, '```', '');
  }
  if (f.curl) {
    lines.push('## Reproduce', '', '```sh', f.curl, '```', '');
  }
  if (f.remediation) {
    lines.push('## Remediation', '', f.remediation, '');
  }
  return lines.join('\n');
}

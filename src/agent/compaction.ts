// Compaction & session-memory helpers, extracted out of agent.ts so the
// Agent class's own file only has to hold the plan/act/observe loop. Pure
// functions — the Agent still owns *when* to call these and where the
// resulting SessionMemory is stored.

import type { Message } from '../llm/types.js';
import { redact } from '../redact/index.js';
import type { SessionMemory } from '../session/store.js';
import { normalizeHeading, splitMarkdownSections } from '../shared/markdownSections.js';

/** Cap on findings/credentials lists — these two are allowed to grow past
 *  the default 24-item cap since dropping a finding or credential silently
 *  is worse than a long list. */
export const MAX_MEMORY_LIST = 200;

/** Compaction input is truncated to this many characters (tail-biased) so
 *  the summarization prompt itself doesn't blow the context budget. */
export const COMPACTION_INPUT_CHAR_LIMIT = 22_000;

export function buildTurnLearningText(userMsg: string, assistantMsg: string): string {
  return [
    '## User preferences and working style',
    userMsg,
    '',
    '## Task outcome',
    assistantMsg,
  ].join('\n');
}

export function emptyMemory(): SessionMemory {
  const now = new Date().toISOString();
  return {
    version: 1,
    updatedAt: now,
    compactions: 0,
    objectives: [],
    plan: [],
    completed: [],
    findings: [],
    tested: [],
    files: [],
    commands: [],
    credentials: [],
    todos: [],
  };
}

export function mergeMemory(prev: SessionMemory | null, summary: string): SessionMemory {
  const now = new Date().toISOString();
  const parsed = parseCompactionSummary(summary);
  return {
    ...(prev ?? emptyMemory()),
    updatedAt: now,
    lastCompactedAt: now,
    lastSummary: summary,
    compactions: (prev?.compactions ?? 0) + 1,
    objectives: mergeList(prev?.objectives, parsed.objectives),
    plan: mergeList(prev?.plan, parsed.plan),
    completed: mergeList(prev?.completed, parsed.completed),
    findings: mergeList(prev?.findings, parsed.findings, MAX_MEMORY_LIST),
    tested: mergeList(prev?.tested, parsed.tested),
    files: mergeList(prev?.files, parsed.files),
    commands: mergeList(prev?.commands, parsed.commands),
    credentials: mergeList(prev?.credentials, parsed.credentials, MAX_MEMORY_LIST),
    todos: mergeList(prev?.todos, parsed.todos),
  };
}

export function parseCompactionSummary(
  summary: string,
): Omit<
  SessionMemory,
  'version' | 'updatedAt' | 'compactions' | 'lastCompactedAt' | 'lastSummary'
> {
  const sections = splitMarkdownSections(summary);
  return {
    objectives: sectionItems(sections, ['current objective', 'target and scope']),
    plan: sectionItems(sections, ['plan']),
    completed: sectionItems(sections, ['completed tasks']),
    findings: sectionItems(sections, ['findings and evidence']),
    tested: sectionItems(sections, ['tested surface', 'decisions and assumptions']),
    files: sectionItems(sections, ['files and commands']).filter((s) =>
      /(?:^|[\s/])[\w.-]+\.\w+|\/|\\/.test(s),
    ),
    commands: sectionItems(sections, ['files and commands']).filter((s) =>
      /`[^`]+`|\b(?:curl|npm|git|rg|python|node|ffuf|nuclei|sqlmap|httpx)\b/.test(s),
    ),
    credentials: sectionItems(sections, ['credentials and placeholders']),
    todos: sectionItems(sections, ['open todos', 'next best actions']),
  };
}

function sectionItems(sections: Map<string, string[]>, names: string[]): string[] {
  const out: string[] = [];
  for (const name of names.map(normalizeHeading)) {
    for (const line of sections.get(name) ?? []) {
      const item = line.replace(/^\s*(?:[-*]|\d+[.)])\s+/, '').trim();
      if (!item || /^none\b|^n\/a$/i.test(item)) continue;
      out.push(item);
    }
  }
  return out;
}

export function mergeList(prev: string[] | undefined, next: string[], cap = 24): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of [...(prev ?? []), ...next]) {
    const clean = item.replace(/\s+/g, ' ').trim();
    if (!clean) continue;
    const key = clean.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(clean.length > 240 ? `${clean.slice(0, 239)}…` : clean);
  }
  return Number.isFinite(cap) ? out.slice(-cap) : out;
}

export function countMemoryItems(memory: SessionMemory | null): number {
  if (!memory) return 0;
  return (
    memory.objectives.length +
    memory.plan.length +
    memory.completed.length +
    memory.findings.length +
    memory.tested.length +
    memory.files.length +
    memory.commands.length +
    memory.credentials.length +
    memory.todos.length
  );
}

export function appendMemorySection(out: string[], title: string, items: string[]): void {
  if (items.length === 0) return;
  out.push('');
  out.push(title);
  for (const item of items.slice(-8)) out.push(`- ${item}`);
}

export function formatHistoryForCompaction(messages: Message[]): string {
  const lines: string[] = [];
  for (const m of messages) {
    if (!m.content && (!m.toolCalls || m.toolCalls.length === 0)) continue;
    lines.push(`\n[${m.role}${m.name ? `:${m.name}` : ''}]`);
    if (m.content) {
      // Scrub credentials before they're sent back to the LLM as a
      // summarization prompt. Tool output captured during the session
      // frequently echoes bearer tokens / cloud keys.
      lines.push(redact.apply(m.content));
    }
    for (const tc of m.toolCalls ?? []) {
      lines.push(`tool_call ${tc.id} ${tc.function.name} ${redact.apply(tc.function.arguments)}`);
    }
  }
  return lines.join('\n');
}

export function boundedHistoryForCompaction(messages: Message[]): string {
  // Microcompact tool bodies first so the LLM summarizer sees structure,
  // not megabytes of HTTP/shell spam (Claude Code-style staged compact).
  const micro = microcompactMessages(messages, {
    keepRecentToolResults: MICROCOMPACT_KEEP_RECENT,
    maxToolResultChars: MICROCOMPACT_MAX_TOOL_CHARS,
  });
  const full = formatHistoryForCompaction(micro.messages);
  if (full.length <= COMPACTION_INPUT_CHAR_LIMIT) return full;
  const tail = full.slice(-COMPACTION_INPUT_CHAR_LIMIT);
  const boundary = tail.indexOf('\n[');
  const trimmed = boundary > 0 ? tail.slice(boundary) : tail;
  return [
    `[system]\nOlder conversation text was omitted because the compaction input exceeded ${COMPACTION_INPUT_CHAR_LIMIT} characters. Preserve continuity from persistent memory and the newest visible context below.`,
    trimmed,
  ].join('\n');
}

// ---------- Microcompact (tool-result elision before full LLM compact) ----------

/** Keep this many most-recent tool results at full size. */
export const MICROCOMPACT_KEEP_RECENT = 4;
/** Soft cap per older tool-result body (chars) when microcompacting. */
export const MICROCOMPACT_MAX_TOOL_CHARS = 800;
export const MICROCOMPACT_PREFIX = '[tool output microcompacted';

export interface MicrocompactOptions {
  keepRecentToolResults?: number;
  maxToolResultChars?: number;
  /** When true, only return copies for oversized tool messages; leave
   *  short ones as the same object reference (cheap path for mid-turn). */
  shareSmall?: boolean;
}

export interface MicrocompactResult {
  messages: Message[];
  /** Total bytes removed from tool-result bodies. */
  droppedBytes: number;
  /** How many tool messages were truncated. */
  truncatedCount: number;
}

/**
 * Shrink bulky tool-result messages, oldest first, keeping the newest
 * `keepRecentToolResults` intact. Pure: never mutates input messages.
 * Used both for mid-turn working copies and as a pre-pass before the
 * LLM compaction prompt so summarization stays focused on outcomes.
 */
export function microcompactMessages(
  messages: Message[],
  opts: MicrocompactOptions = {},
): MicrocompactResult {
  const keepRecent = opts.keepRecentToolResults ?? MICROCOMPACT_KEEP_RECENT;
  const maxChars = opts.maxToolResultChars ?? MICROCOMPACT_MAX_TOOL_CHARS;
  const toolIdx: number[] = [];
  for (let i = 0; i < messages.length; i += 1) {
    if (messages[i]?.role === 'tool') toolIdx.push(i);
  }
  const protect = new Set(toolIdx.slice(-Math.max(0, keepRecent)));
  let droppedBytes = 0;
  let truncatedCount = 0;
  const out = messages.map((m, i) => {
    if (m.role !== 'tool' || protect.has(i)) return m;
    if (m.content.startsWith(MICROCOMPACT_PREFIX) || m.content.startsWith('[tool output elided')) {
      return m;
    }
    if (m.content.length <= maxChars) return m;
    const bytes = m.content.length;
    const head = m.content.slice(0, Math.max(0, maxChars - 80));
    truncatedCount += 1;
    droppedBytes += bytes - head.length;
    return {
      ...m,
      content: `${MICROCOMPACT_PREFIX}: kept ${head.length}/${bytes} chars]\n${head}\n…`,
    };
  });
  return { messages: out, droppedBytes, truncatedCount };
}

/**
 * Format the durable session-memory block that must survive compaction.
 * Always includes objectives/plan/findings/todos even when empty labels
 * are omitted — empty sections are skipped to save tokens.
 */
export function formatPinnedMemory(memory: SessionMemory | null): string {
  if (!memory) return '';
  const out: string[] = ['## Pinned session state (do not discard)'];
  appendMemorySection(out, '### Objectives', memory.objectives);
  appendMemorySection(out, '### Plan', memory.plan);
  appendMemorySection(out, '### Findings', memory.findings);
  appendMemorySection(out, '### Open todos', memory.todos);
  appendMemorySection(out, '### Completed', memory.completed);
  appendMemorySection(out, '### Tested surface', memory.tested);
  if (out.length === 1) return '';
  return out.join('\n');
}

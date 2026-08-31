// App-wide TUI state. Kept as a useReducer-friendly shape so each
// component subscribes to only the slice it needs. The agent loop runs
// outside React and pushes events via dispatch().

import type { AgentEvent, TodoItem } from '../agent/events.js';
import { formatUserError } from '../llm/errors.js';
import { apply as redact } from '../redact/redact.js';
import { formatChildProgressDetail, formatChildProgressSummary } from '../tools/delegate.js';
import { displayToolName, formatToolResult, primaryToolArg } from '../tools/toolDisplay.js';
import type { BannerData } from './Banner.js';
import type { AskRequest } from './askBridge.js';
import type { PermissionRequest } from './permBridge.js';
import {
  buildToolResultView,
  shellResultExitStatus,
  stripControlSequences,
} from './toolResultFormat.js';

export interface TranscriptEntry {
  kind:
    | 'user'
    | 'assistant'
    | 'tool-call'
    | 'tool-result'
    | 'system'
    | 'error'
    | 'finding'
    | 'decision'
    | 'todo';
  text: string;
  /** Set on streaming assistant text so deltas can append in place. While
   *  true and at the tail, this entry renders in the live frame rather
   *  than the committed scrollback log. */
  streaming?: boolean;
  /** Tool-results whose body was truncated keep the full text so Ctrl-O
   *  can reprint it as a NEW log entry — committed scrollback output can't
   *  be toggled in place. `text` always holds the short preview. */
  collapsible?: boolean;
  fullText?: string;
  /** Set once the full body has been reprinted so Ctrl-O won't duplicate it.
   *  For child-progress lines, toggles in-place expand (Grok-style ↳ list). */
  expanded?: boolean;
  /** Optional display prefix override for entries with custom transcript chrome. */
  prefix?: string;
  /** Optional display color override for entries that need semantic emphasis. */
  color?: string;
  /** Live child-agent progress row key (`skill:recon`, `explore`, …). */
  progressKey?: string;
  /** Ordered tools for a live ↳ progress row (used while updating). */
  progressTools?: string[];
}

export type UiPhase =
  | 'idle'
  | 'planning'
  | 'running-tool'
  | 'answering'
  | 'waiting-approval'
  | 'waiting-user'
  | 'skills';

export type TranscriptFilter = 'all' | 'compact' | 'findings' | 'errors' | 'current';

export interface AppState {
  banner: string;
  bannerData: BannerData;
  transcript: TranscriptEntry[];
  busy: boolean;
  /** Bumped by `clear` so the Static scrollback log remounts and stops
   *  reprinting the old (now-cleared) items. */
  clearGen: number;
  apiReady: boolean;
  activeSkill: string | null;
  pendingPerm: PermissionRequest | null;
  pendingAsk: AskRequest | null;
  /** When true, the interactive /skills picker is mounted. The picker
   *  reads live registry state on every render, so we don't keep any
   *  snapshot in this slot — a boolean is enough. */
  pendingSkills: boolean;
  yolo: boolean;
  phase: UiPhase;
  transcriptFilter: TranscriptFilter;
  /** Display name of the tool currently executing, shown in the busy status
   *  line while phase === 'running-tool'. Set on tool-call, cleared on done. */
  runningTool: string | null;
  /** Display name of the last tool that finished. Unlike runningTool it
   *  persists into the idle status line so the user can see what just ran. */
  lastTool: string | null;
  /** Count of confirmed findings this session — surfaced in the status line
   *  so the headline output of an engagement is always visible. Survives
   *  /clear (which only wipes the on-screen transcript). */
  findingsCount: number;
  /** Tighter density: drops the blank spacer row between transcript entries
   *  and shrinks the banner's padding. Session-scoped only (like --minimal in
   *  other agent TUIs) — not persisted to config. Toggled by /compact-mode. */
  compactMode: boolean;
}

export function initialState(banner: string, bannerData: BannerData): AppState {
  return {
    banner,
    bannerData,
    transcript: [],
    busy: false,
    clearGen: 0,
    apiReady: true,
    activeSkill: null,
    pendingPerm: null,
    pendingAsk: null,
    pendingSkills: false,
    yolo: false,
    phase: 'idle',
    transcriptFilter: 'all',
    runningTool: null,
    lastTool: null,
    findingsCount: 0,
    compactMode: false,
  };
}

export type Action =
  | { type: 'set-banner'; banner: string }
  | { type: 'merge-banner-data'; patch: Partial<BannerData> }
  | { type: 'append'; entry: TranscriptEntry }
  | { type: 'append-delta'; text: string }
  | { type: 'set-busy'; busy: boolean }
  | { type: 'set-api-ready'; ready: boolean }
  | { type: 'set-active-skill'; name: string | null }
  | { type: 'set-yolo'; on: boolean }
  | { type: 'set-compact-mode'; on: boolean }
  | { type: 'set-perm'; req: PermissionRequest | null }
  | { type: 'set-ask'; req: AskRequest | null }
  | { type: 'set-skills-picker'; open: boolean }
  | { type: 'cycle-transcript-filter' }
  | { type: 'expand-tool-output' }
  /** In-place expand/collapse for collapsible rows (click ↳ progress). */
  | { type: 'toggle-expand'; index?: number; progressKey?: string; fullText?: string }
  /** Live ↳ child progress: upsert one row, expandable when done. */
  | {
      type: 'child-progress';
      key: string;
      label: string;
      tools: string[];
      done: boolean;
    }
  | { type: 'clear' }
  | { type: 'agent-event'; event: AgentEvent };

export function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case 'set-banner':
      return { ...state, banner: action.banner };
    case 'merge-banner-data':
      return { ...state, bannerData: { ...state.bannerData, ...action.patch } };
    case 'append':
      return { ...state, transcript: [...state.transcript, action.entry] };
    case 'append-delta': {
      // A streamed delta means the model is producing output — leave the
      // 'planning' phase so the status line stops claiming we're still
      // thinking. Without this, a long streamed answer shows "planning" for
      // its entire duration and looks hung.
      const phase: UiPhase = state.busy ? 'answering' : state.phase;
      const last = state.transcript[state.transcript.length - 1];
      if (last && last.kind === 'assistant' && last.streaming) {
        // Fresh entry object per token so the live frame sees the new text.
        // Use slice()+assign to avoid extra intermediate arrays on every token.
        const updated = { ...last, text: last.text + action.text };
        const transcript = state.transcript.slice();
        transcript[transcript.length - 1] = updated;
        return { ...state, phase, transcript };
      }
      return {
        ...state,
        phase,
        transcript: [
          ...state.transcript,
          { kind: 'assistant', text: action.text, streaming: true },
        ],
      };
    }
    case 'set-busy':
      return { ...state, busy: action.busy, phase: action.busy ? 'planning' : 'idle' };
    case 'set-api-ready':
      return { ...state, apiReady: action.ready };
    case 'set-active-skill':
      return { ...state, activeSkill: action.name };
    case 'set-yolo':
      return { ...state, yolo: action.on };
    case 'set-compact-mode':
      return { ...state, compactMode: action.on };
    case 'set-perm':
      return {
        ...state,
        pendingPerm: action.req,
        phase: action.req ? 'waiting-approval' : state.busy ? 'running-tool' : 'idle',
      };
    case 'set-ask':
      return {
        ...state,
        pendingAsk: action.req,
        phase: action.req ? 'waiting-user' : state.busy ? 'answering' : 'idle',
      };
    case 'set-skills-picker':
      return { ...state, pendingSkills: action.open, phase: action.open ? 'skills' : 'idle' };
    case 'cycle-transcript-filter':
      return { ...state, transcriptFilter: nextTranscriptFilter(state.transcriptFilter) };
    case 'expand-tool-output': {
      // Walk from the tail so Ctrl-O acts on "the thing I just ran".
      // OpenTUI re-renders in place (assistant prose, tool output, ↳ progress).
      let idx = -1;
      for (let i = state.transcript.length - 1; i >= 0; i -= 1) {
        const e = state.transcript[i];
        if (e?.collapsible && !e.expanded) {
          idx = i;
          break;
        }
      }
      if (idx === -1) return state;
      const entry = state.transcript[idx];
      if (!entry) return state;
      const transcript = [...state.transcript];
      transcript[idx] = { ...entry, expanded: true };
      return { ...state, transcript };
    }
    case 'toggle-expand': {
      let idx = action.index ?? -1;
      if (idx < 0 && action.progressKey) {
        for (let i = state.transcript.length - 1; i >= 0; i -= 1) {
          if (state.transcript[i]?.progressKey === action.progressKey) {
            idx = i;
            break;
          }
        }
      }
      if (idx < 0 && action.fullText) {
        for (let i = state.transcript.length - 1; i >= 0; i -= 1) {
          const e = state.transcript[i];
          if (e?.collapsible && e.fullText === action.fullText) {
            idx = i;
            break;
          }
        }
      }
      if (idx < 0) {
        // Fallback: last collapsible entry.
        for (let i = state.transcript.length - 1; i >= 0; i -= 1) {
          if (state.transcript[i]?.collapsible) {
            idx = i;
            break;
          }
        }
      }
      const entry = idx >= 0 ? state.transcript[idx] : undefined;
      if (!entry?.collapsible || !entry.fullText) return state;
      const transcript = [...state.transcript];
      transcript[idx] = { ...entry, expanded: !entry.expanded };
      return { ...state, transcript };
    }
    case 'child-progress': {
      const { key, label, tools, done } = action;
      const summary = formatChildProgressSummary(label, tools, done);
      const collapsible = done && tools.length > 0;
      // Always keep full tool list for expand (even mid-run if user could expand later).
      const fullText =
        tools.length > 0
          ? formatChildProgressDetail(label, tools)
          : formatChildProgressSummary(label, tools, done);
      // Collapsed: one line + click cue once finished with tools.
      const text = collapsible ? `${summary}  · expand` : summary;
      let idx = -1;
      for (let i = state.transcript.length - 1; i >= 0; i -= 1) {
        if (state.transcript[i]?.progressKey === key) {
          idx = i;
          break;
        }
      }
      const prev = idx >= 0 ? state.transcript[idx] : undefined;
      const expanded = Boolean(prev?.expanded && collapsible);
      const nextEntry: TranscriptEntry = {
        kind: 'system',
        prefix: '↳ ',
        text,
        fullText: tools.length > 0 ? fullText : undefined,
        collapsible: collapsible || undefined,
        expanded: expanded || undefined,
        progressKey: key,
        progressTools: tools.length > 0 ? [...tools] : undefined,
      };
      if (idx >= 0) {
        const transcript = [...state.transcript];
        transcript[idx] = nextEntry;
        return { ...state, transcript };
      }
      return { ...state, transcript: [...state.transcript, nextEntry] };
    }
    case 'clear':
      // Reset the log and bump clearGen so the Static viewport remounts and
      // stops reprinting the cleared items. Prior output stays in the
      // terminal's native scrollback, like a real shell.
      return { ...state, transcript: [], clearGen: state.clearGen + 1 };
    case 'agent-event': {
      const next = applyAgentEvent(state, action.event);
      // Persist "what just ran" + a running findings tally outside the per-event
      // logic, so the many tool-result return paths don't each need to thread it.
      const ev = action.event;
      if (ev.type === 'tool-result') {
        // Roll back the optimistic tool-call-time count below when the store
        // actually rejected the finding (bad/duplicate args) — without this
        // the "Findings: N" tally in the status bar stays inflated forever
        // for this tool's headline deliverable.
        if (ev.name === 'confirm_finding' && ev.err) {
          return {
            ...next,
            lastTool: displayToolName(ev.name),
            findingsCount: Math.max(0, next.findingsCount - 1),
          };
        }
        return { ...next, lastTool: displayToolName(ev.name) };
      }
      // Count a finding once, when its card is first emitted (tool-call), so a
      // retried/failed save doesn't double-count. Rolled back above if the
      // matching tool-result comes back with an error.
      if (ev.type === 'tool-call' && ev.name === 'confirm_finding') {
        return { ...next, findingsCount: next.findingsCount + 1 };
      }
      return next;
    }
    default: {
      const _exhaustive: never = action;
      void _exhaustive;
      return state;
    }
  }
}

const TRANSCRIPT_FILTERS: TranscriptFilter[] = ['all', 'compact', 'findings', 'errors', 'current'];

function nextTranscriptFilter(current: TranscriptFilter): TranscriptFilter {
  const idx = TRANSCRIPT_FILTERS.indexOf(current);
  return TRANSCRIPT_FILTERS[(idx + 1) % TRANSCRIPT_FILTERS.length] ?? 'all';
}

const TOOL_CALL_PREVIEW_CAP = 120;
const SHELL_TITLE_CAP = 72;
const SHELL_BLOCK_COMMAND_THRESHOLD = 88;

/**
 * Collapse a tool-call's raw JSON args into a single-line preview for
 * the transcript: convert escaped \n / \t (from the LLM's JSON
 * encoding) and any raw control chars to single spaces, collapse runs,
 * truncate to TOOL_CALL_PREVIEW_CAP. Full args still go to the log.
 *
 * Without this, multi-line heredocs (`{"command":"python3 -c \"\nports = [\n  80,..."}`)
 * spill across the transcript with awkward terminal wrapping.
 */
function previewArgs(raw: string): string {
  const oneLine = stripControlSequences(raw)
    .replace(/\\[nrt]/g, ' ')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (oneLine.length <= TOOL_CALL_PREVIEW_CAP) return oneLine;
  return `${oneLine.slice(0, TOOL_CALL_PREVIEW_CAP)}…`;
}

function isShellTool(name: string): boolean {
  return name === 'shell' || name === 'bash' || name === 'BashTool';
}

function toolCallColor(name: string): string | undefined {
  return name === 'confirm_finding' ? 'red' : undefined;
}

/** Ink text color for a finding severity. The severity is also spelled out in
 *  the card text, so color is reinforcement, not the sole signal (keeps it
 *  legible for color-blind users / NO_COLOR). */
function severityColor(severity: string): string {
  switch (severity) {
    case 'critical':
      return 'magenta';
    case 'high':
      return 'red';
    case 'medium':
      return 'yellow';
    case 'low':
      return 'cyan';
    case 'info':
      return 'gray';
    default:
      return 'yellow';
  }
}

/**
 * Build a severity-colored finding card from a confirm_finding tool call's
 * args. Returns null when the args don't parse or lack a title, so the caller
 * can fall back to the normal tool-call rendering.
 */
function formatFindingCard(argsJSON: string): { text: string; color: string } | null {
  let a: Record<string, unknown>;
  try {
    a = JSON.parse(argsJSON) as Record<string, unknown>;
  } catch {
    return null;
  }
  const str = (k: string): string =>
    typeof a[k] === 'string' ? redact(stripControlSequences(a[k] as string)) : '';
  const title = str('title');
  if (!title) return null;
  const severity = str('severity').toLowerCase();
  const method = str('method');
  const url = str('url');
  const parameter = str('parameter');
  const impact = str('impact');

  const lines = [`${severity ? severity.toUpperCase() : 'FINDING'} · ${title}`];
  if (url) {
    const loc = `${method ? `${method} ` : ''}${url}${parameter ? `  (param: ${parameter})` : ''}`;
    lines.push(`  ${loc}`);
  }
  if (impact) lines.push(`  impact: ${impact}`);
  return { text: lines.join('\n'), color: severityColor(severity) };
}

function capText(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}…`;
}

function cleanShellComment(line: string): string {
  return line
    .replace(/^#\s*/, '')
    .replace(/\s+-\s+.+$/, '')
    .trim();
}

function isShellAssignment(line: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(line);
}

function shellActionFromCommand(command: string): { title: string; command: string } | null {
  const lines = command
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const commentIdx = lines.findIndex((line) => line.startsWith('#'));
  if (commentIdx === -1) return null;
  if (commentIdx > 0 && lines.slice(0, commentIdx).some((line) => !isShellAssignment(line))) {
    return null;
  }

  const comment = lines[commentIdx] ?? '';
  const runnable = lines.filter((line) => !line.startsWith('#'));

  if (lines.length > 1) {
    return {
      title: capText(cleanShellComment(comment), SHELL_TITLE_CAP),
      command: previewArgs(runnable.join(' && ')),
    };
  }

  const curlIdx = comment.indexOf(' curl ');
  if (curlIdx !== -1) {
    return {
      title: capText(cleanShellComment(comment.slice(0, curlIdx)), SHELL_TITLE_CAP),
      command: previewArgs(comment.slice(curlIdx + 1)),
    };
  }

  return {
    title: capText(cleanShellComment(comment), SHELL_TITLE_CAP),
    command: previewArgs(command),
  };
}

function shellLongCommandBlock(command: string): { title: string; command: string } | null {
  const preview = previewArgs(command);
  const isStructured =
    command.includes('\n') ||
    command.includes(' && ') ||
    command.includes(' || ') ||
    command.includes(';');
  if (preview.length < SHELL_BLOCK_COMMAND_THRESHOLD && !preview.endsWith('…') && !isStructured) {
    return null;
  }

  return { title: shellTitleFromPreview(preview), command: preview };
}

function shellTitleFromPreview(preview: string): string {
  const firstWord = firstShellWord(preview);
  switch (firstWord) {
    case 'curl':
    case 'http':
    case 'wget':
      return 'HTTP request';
    case 'for':
    case 'while':
    case 'until':
      return 'Run loop';
    case 'mkdir':
      return 'Create directory';
    case 'grep':
    case 'rg':
      return 'Search files';
    case 'find':
      return 'Find files';
    case 'cat':
    case 'head':
    case 'tail':
      return 'Read output';
    case 'awk':
    case 'jq':
    case 'sed':
      return 'Process text';
    case 'python':
    case 'python3':
    case 'node':
    case 'tsx':
      return 'Run script';
    case 'npm':
    case 'pnpm':
    case 'yarn':
    case 'bun':
      return 'Run package task';
    case 'git':
      return 'Git command';
    case 'openssl':
      return 'OpenSSL';
    case 'echo':
    case 'printf':
      return 'Print text';
    default:
      return `Run ${firstWord}`;
  }
}

function firstShellWord(preview: string): string {
  const withoutAssignments = preview.replace(
    /^(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S+)\s+)+/,
    '',
  );
  return withoutAssignments.match(/^[A-Za-z0-9_.:/-]+/)?.[0] ?? 'command';
}

function parseToolArgs(argsJSON: string): Record<string, unknown> {
  try {
    return JSON.parse(argsJSON) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function safeToolArgsJSON(argsJSON: string): string {
  try {
    const value: unknown = JSON.parse(argsJSON);
    const sanitize = (item: unknown): unknown => {
      if (typeof item === 'string') return redact(stripControlSequences(item));
      if (Array.isArray(item)) return item.map(sanitize);
      if (item && typeof item === 'object') {
        return Object.fromEntries(
          Object.entries(item).map(([key, child]) => [key, sanitize(child)]),
        );
      }
      return item;
    };
    return JSON.stringify(sanitize(value));
  } catch {
    return redact(stripControlSequences(argsJSON));
  }
}

function argStr(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  return typeof v === 'string' ? v.trim() : '';
}

/** Short display name for the ⏺ line (Grok-style Title Case). */
function compactToolLabel(name: string): string {
  const map: Record<string, string> = {
    shell: 'Shell',
    bash: 'Bash',
    BashTool: 'Bash',
    scope: 'Scope',
    http: 'HTTP',
    file_read: 'Read',
    FileReadTool: 'Read',
    file_write: 'Write',
    FileWriteTool: 'Write',
    file_edit: 'Edit',
    FileEditTool: 'Edit',
    glob: 'Glob',
    grep: 'Grep',
    web_fetch: 'Fetch',
    web_search: 'Search',
    load_skill: 'Skill',
    ask_user: 'Ask User',
    todo: 'Todo',
    coverage: 'Coverage',
    confirm_finding: 'Finding',
    delegate_task: 'Delegate',
    background_status: 'Jobs',
  };
  if (map[name]) return map[name];
  if (name.startsWith('mcp_browser_browser_')) return 'Browser';
  const d = displayToolName(name);
  return d.charAt(0).toUpperCase() + d.slice(1);
}

/**
 * Grok-style compact tool call:
 *   Scope · add
 *   │ testaspnet.vulnweb.com
 *   Shell · HTTP request
 *   $ curl -sS …
 */
function compactToolParts(
  name: string,
  args: Record<string, unknown>,
  argsJSON: string,
): { action: string; detail?: string; detailPrefix?: string } {
  if (isShellTool(name)) {
    const command = argStr(args, 'command');
    if (!command) return { action: 'command' };
    const action = shellActionFromCommand(command) ??
      shellLongCommandBlock(command) ?? {
        title: shellTitleFromPreview(previewArgs(command)),
        command: previewArgs(command),
      };
    return { action: action.title, detail: action.command, detailPrefix: '$ ' };
  }

  const key = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '');

  if (key === 'scope') {
    const action = argStr(args, 'action') || 'list';
    const pattern = argStr(args, 'pattern');
    return { action, detail: pattern ? previewArgs(pattern) : undefined };
  }
  if (key === 'http') {
    const method = (argStr(args, 'method') || 'GET').toUpperCase();
    const url = argStr(args, 'url');
    return { action: method, detail: url ? previewArgs(url) : undefined };
  }
  if (key === 'file_read' || key === 'filereadtool') {
    return {
      action: 'file',
      detail: previewArgs(argStr(args, 'path') || argStr(args, 'file') || ''),
    };
  }
  if (key === 'file_write' || key === 'filewritetool') {
    return {
      action: 'write',
      detail: previewArgs(argStr(args, 'path') || argStr(args, 'file') || ''),
    };
  }
  if (key === 'file_edit' || key === 'fileedittool') {
    return {
      action: 'edit',
      detail: previewArgs(argStr(args, 'path') || argStr(args, 'file') || ''),
    };
  }
  if (key === 'glob') {
    return {
      action: 'match',
      detail: previewArgs(argStr(args, 'pattern') || argStr(args, 'glob') || ''),
    };
  }
  if (key === 'grep') {
    return {
      action: 'search',
      detail: previewArgs(argStr(args, 'pattern') || argStr(args, 'query') || ''),
    };
  }
  if (key === 'web_fetch' || key === 'webfetch') {
    return { action: 'url', detail: previewArgs(argStr(args, 'url') || '') };
  }
  if (key === 'web_search' || key === 'websearch') {
    return {
      action: 'query',
      detail: previewArgs(argStr(args, 'query') || argStr(args, 'q') || ''),
    };
  }
  if (key === 'load_skill' || key === 'loadskill') {
    const skill = argStr(args, 'name') || 'skill';
    return { action: args.fork === true ? `${skill} · forked` : skill };
  }
  if (key === 'todo') {
    return { action: argStr(args, 'action') || 'list' };
  }
  if (key === 'coverage') {
    const action = argStr(args, 'action') || 'coverage';
    const ep = argStr(args, 'endpoint') || argStr(args, 'url');
    return { action, detail: ep ? previewArgs(ep) : undefined };
  }
  if (key === 'delegate_task' || key === 'delegatetask') {
    return {
      action: argStr(args, 'role') || 'worker',
      detail: previewArgs(argStr(args, 'objective') || ''),
    };
  }
  if (key === 'background_status' || key === 'backgroundstatus') {
    const action = argStr(args, 'action') || 'list';
    const id = argStr(args, 'id');
    return { action, detail: id ? previewArgs(id) : undefined };
  }
  if (key === 'ask_user' || key === 'askuser' || key === 'ask') {
    const p = primaryToolArg(name, args);
    return { action: p ? previewArgs(p) : 'ask' };
  }
  if (name.startsWith('mcp_browser_browser_')) {
    const act = name.replace(/^mcp_browser_browser_/, '').replace(/_/g, ' ');
    const url = argStr(args, 'url');
    return { action: act, detail: url ? previewArgs(url) : undefined };
  }

  const primary = primaryToolArg(name, args);
  if (primary) return { action: previewArgs(primary) };

  for (const k of ['action', 'name', 'path', 'url', 'query', 'pattern', 'id', 'command']) {
    const v = argStr(args, k);
    if (!v) continue;
    if (k === 'action') return { action: v };
    return { action: k, detail: previewArgs(v) };
  }

  const raw = previewArgs(argsJSON);
  return raw && raw !== '{}' ? { action: raw } : { action: 'run' };
}

function formatToolCallText(name: string, argsJSON: string): string {
  const label = compactToolLabel(name);
  const args = parseToolArgs(argsJSON);
  const { action, detail, detailPrefix } = compactToolParts(name, args, argsJSON);
  const head = action ? `${label} · ${action}` : label;
  if (detail) {
    const prefix = detailPrefix ?? '│ ';
    return `${head}\n${prefix}${detail}`;
  }
  return head;
}

/** Short label for the busy status line. */
function runningToolLabel(name: string, argsJSON: string): string {
  const label = compactToolLabel(name);
  const args = parseToolArgs(argsJSON);
  const { action } = compactToolParts(name, args, argsJSON);
  return action ? `${label} · ${action}` : label;
}

function isSuccessfulEmptyShellResult(result: string): boolean {
  const plain = result.replace(/\r\n/g, '\n').trimEnd();
  return plain === 'exit: 0\nstdout:';
}

function isEmptyShellExit(result: string, exit: string): boolean {
  const plain = result.replace(/\r\n/g, '\n').trimEnd();
  return plain === `exit: ${exit}\nstdout:`;
}

function previousShellCallWasSearch(transcript: TranscriptEntry[]): boolean {
  const prev = transcript.at(-1);
  if (!prev || prev.kind !== 'tool-call') return false;
  return /(^|\s|\||\$ )(grep|rg)(\s|$)/.test(prev.text);
}

function toolResultPrefix(
  name: string,
  err: string,
  result: string,
  durationMs: number,
  transcript: TranscriptEntry[],
): string {
  if (err) return `[error] ${displayToolName(name)}: ${err}`;
  if (isShellTool(name)) {
    const exit = shellResultExitStatus(result);
    if (exit && exit !== '0') {
      if (
        exit === '1' &&
        isEmptyShellExit(result, exit) &&
        previousShellCallWasSearch(transcript)
      ) {
        return `[no match] ${displayToolName(name)} (${durationMs}ms)`;
      }
      const label = exit.startsWith('timeout') ? 'timeout' : `exit ${exit}`;
      return `[${label}] ${displayToolName(name)} (${durationMs}ms)`;
    }
  }
  return `[ok] ${displayToolName(name)} (${durationMs}ms)`;
}

/** Render a todo-tool write as a compact checklist for the transcript. */
export function formatTodoTranscript(items: TodoItem[]): string {
  if (items.length === 0) return 'todo list cleared';
  const glyph = (s: TodoItem['status']): string =>
    s === 'completed' ? '☑' : s === 'in_progress' ? '▶' : '☐';
  return items.map((i) => `${glyph(i.status)} ${i.text}`).join('\n');
}

/**
 * Quiet decision / context-guard lines for the transcript.
 * Legacy long "decision planner: selected skill: …" strings are collapsed.
 */
export function formatDecisionTranscript(summary: string): string {
  const s = (summary ?? '').trim();
  if (!s) return 'plan';
  if (s.startsWith('context guard:')) {
    return s.replace(/^context guard:\s*/i, 'context · ');
  }
  // Already short (new agent format).
  if (/^plan · /i.test(s)) return s;
  const skill = s.match(/selected skill:\s*([^·]+)/i)?.[1]?.trim();
  const risk = s.match(/risk:\s*(\w+)/i)?.[1]?.toLowerCase();
  if (skill) {
    return risk === 'high' ? `plan · ${skill} · high risk` : `plan · ${skill}`;
  }
  if (s.length <= 64) return s;
  return `${s.slice(0, 61)}…`;
}

/**
 * Claude/Grok-style compact notice: one quiet system line.
 * Never dump "triggered…", the LLM summary body, or a second meta line.
 */
export function formatCompactEvent(ev: Extract<AgentEvent, { type: 'compact' }>): string {
  const s = (ev.summary ?? '').trim();
  if (!s || /^nothing to compact$/i.test(s)) return 'Nothing to compact';

  const parts: string[] = [];
  if (typeof ev.tokensBefore === 'number' && typeof ev.tokensAfter === 'number') {
    parts.push(`~${ev.tokensBefore} → ~${ev.tokensAfter} tokens`);
  }
  // Skip "0 memory items" noise.
  if (typeof ev.memoryItems === 'number' && ev.memoryItems > 0) {
    parts.push(`${ev.memoryItems} memory`);
  }

  // Operational auto-compact / short labels from the agent.
  if (
    /^context compacted$/i.test(s) ||
    /^auto-compact/i.test(s) ||
    /^compacted:/i.test(s) ||
    s.length <= 64
  ) {
    return parts.length > 0 ? `Context compacted · ${parts.join(' · ')}` : 'Context compacted';
  }

  // Legacy: a long summary string used to be the LLM body — keep the UI short.
  return parts.length > 0 ? `Context compacted · ${parts.join(' · ')}` : 'Context compacted';
}

/**
 * Collapse long assistant prose (Grok-style): short head stays visible,
 * full body is behind click / Ctrl-O expand. Short replies pass through.
 */
export function collapseAssistantProse(text: string): {
  preview: string;
  full: string;
  collapsible: boolean;
} {
  const full = stripControlSequences(text).replace(/\r\n/g, '\n').trimEnd();
  if (!full) return { preview: full, full, collapsible: false };
  const lines = full.split('\n');
  const HEAD = 5;
  const LINE_THRESHOLD = 7;
  const CHAR_THRESHOLD = 480;
  if (lines.length <= LINE_THRESHOLD && full.length <= CHAR_THRESHOLD) {
    return { preview: full, full, collapsible: false };
  }
  let head = lines.slice(0, HEAD).join('\n');
  if (head.length > CHAR_THRESHOLD) head = `${head.slice(0, CHAR_THRESHOLD)}…`;
  const shown = head.split('\n').length;
  const hidden = Math.max(0, lines.length - shown);
  const cue =
    hidden > 0
      ? `… ${hidden} more line${hidden === 1 ? '' : 's'} · click to expand`
      : '… · click to expand';
  return { preview: `${head}\n${cue}`, full, collapsible: true };
}

function finalizeAssistantEntry(entry: TranscriptEntry): TranscriptEntry {
  const body = entry.text ?? '';
  const c = collapseAssistantProse(body);
  if (!c.collapsible) return { ...entry, streaming: false };
  return {
    ...entry,
    streaming: false,
    text: c.preview,
    fullText: c.full,
    collapsible: true,
    expanded: false,
  };
}

function applyAgentEvent(state: AppState, ev: AgentEvent): AppState {
  switch (ev.type) {
    case 'assistant-text': {
      // Finalize any active stream entry, or append a fresh one.
      const last = state.transcript[state.transcript.length - 1];
      if (last && last.kind === 'assistant' && last.streaming) {
        // Prefer the completed event body when present (non-stream path);
        // otherwise collapse whatever streamed into `last`.
        const base: TranscriptEntry =
          ev.text && ev.text.length > 0 ? { ...last, text: ev.text } : last;
        const finalized = finalizeAssistantEntry(base);
        return {
          ...state,
          phase: 'answering',
          transcript: [...state.transcript.slice(0, -1), finalized],
        };
      }
      return {
        ...state,
        phase: 'answering',
        transcript: [
          ...state.transcript,
          finalizeAssistantEntry({ kind: 'assistant', text: ev.text }),
        ],
      };
    }
    case 'assistant-delta':
      return reducer(state, { type: 'append-delta', text: ev.text });
    case 'tool-call': {
      const safeArgsJSON = safeToolArgsJSON(ev.argsJSON);
      // confirm_finding gets a first-class, severity-colored finding card
      // instead of a generic tool-call line — the headline output of an
      // engagement should stand out, not read like any other tool call.
      if (ev.name === 'confirm_finding') {
        const card = formatFindingCard(safeArgsJSON);
        if (card) {
          return {
            ...state,
            transcript: [
              ...state.transcript,
              { kind: 'finding', text: card.text, color: card.color, prefix: '★ ' },
            ],
            phase: 'running-tool',
            runningTool: runningToolLabel(ev.name, safeArgsJSON),
          };
        }
      }
      return {
        ...state,
        transcript: [
          ...state.transcript,
          {
            kind: 'tool-call',
            text: formatToolCallText(ev.name, safeArgsJSON),
            // ROLE_STYLES already uses ⏺ for tool-call; keep explicit for clarity.
            prefix: '⏺ ',
            color: toolCallColor(ev.name),
          },
        ],
        phase: 'running-tool',
        runningTool: runningToolLabel(ev.name, safeArgsJSON),
      };
    }
    case 'tool-result': {
      // The finding card (rendered at tool-call) is the headline; the result
      // just confirms where it was saved. Show that as a quiet note, not a
      // generic "[ok] confirm_finding" line.
      if (!ev.err && ev.name === 'confirm_finding') {
        return {
          ...state,
          phase: 'answering',
          transcript: [
            ...state.transcript,
            { kind: 'tool-result', text: redact(stripControlSequences(ev.result)) },
          ],
        };
      }

      if (!ev.err && isShellTool(ev.name) && isSuccessfulEmptyShellResult(ev.result)) {
        return {
          ...state,
          phase: 'answering',
          transcript: [...state.transcript, { kind: 'tool-result', text: 'Done', prefix: '  ⎿ ' }],
        };
      }

      const prefix = toolResultPrefix(ev.name, ev.err, ev.result, ev.durationMs, state.transcript);
      if (
        !ev.err &&
        isShellTool(ev.name) &&
        shellResultExitStatus(ev.result) === '1' &&
        isEmptyShellExit(ev.result, '1') &&
        previousShellCallWasSearch(state.transcript)
      ) {
        return {
          ...state,
          phase: 'answering',
          transcript: [
            ...state.transcript,
            { kind: 'tool-result', text: `${prefix}\n(no matches)` },
          ],
        };
      }
      // Some tools have a compact one-line display form for their JSON
      // result (e.g. browser_capture_status). Use it when present; the
      // model still receives the raw JSON via the tool message.
      if (!ev.err) {
        const friendly = formatToolResult(ev.name, ev.result);
        if (friendly !== null) {
          return {
            ...state,
            phase: 'answering',
            transcript: [
              ...state.transcript,
              {
                kind: 'tool-result',
                text: `${prefix}\n${redact(stripControlSequences(friendly))}`,
              },
            ],
          };
        }
      }
      // buildToolResultView pulls readable text out of MCP JSON envelopes,
      // colorizes shell-shaped output, and — for anything long — returns a
      // head-only preview plus the full body. Short results show a single
      // view (not collapsible). Collapsible ones keep `fullText` so Ctrl-O
      // can reprint the full body as a new log entry ('expand-tool-output').
      const view = buildToolResultView(ev.result);
      const collapsedText = `${prefix}\n${view.preview}`;
      if (!view.collapsible) {
        return {
          ...state,
          phase: 'answering',
          transcript: [...state.transcript, { kind: 'tool-result', text: collapsedText }],
        };
      }
      return {
        ...state,
        phase: 'answering',
        transcript: [
          ...state.transcript,
          {
            kind: 'tool-result',
            text: collapsedText,
            collapsible: true,
            fullText: `${prefix}\n${view.full}`,
          },
        ],
      };
    }
    case 'error':
      return {
        ...state,
        phase: state.busy ? 'answering' : state.phase,
        transcript: [
          ...state.transcript,
          {
            kind: 'error',
            // Friendly multi-line copy for BackendError (ollama 404, down, …).
            text: stripControlSequences(formatUserError(ev.err)),
          },
        ],
      };
    case 'compact':
      return {
        ...state,
        phase: 'planning',
        transcript: [...state.transcript, { kind: 'system', text: formatCompactEvent(ev) }],
      };
    case 'decision':
      return {
        ...state,
        phase: 'planning',
        // Keep mid-turn context-guard notices; planner lines are already short.
        transcript: [
          ...state.transcript,
          { kind: 'decision', text: formatDecisionTranscript(ev.summary) },
        ],
      };
    case 'todo':
      return {
        ...state,
        transcript: [...state.transcript, { kind: 'todo', text: formatTodoTranscript(ev.items) }],
      };
    case 'skill-active':
      return { ...state, activeSkill: ev.name };
    case 'memory-recall':
      return {
        ...state,
        transcript: [
          ...state.transcript,
          { kind: 'system', text: `recalled memory: ${ev.names.join(', ')}` },
        ],
      };
    case 'retry':
      return {
        ...state,
        transcript: [
          ...state.transcript,
          {
            kind: 'system',
            text: `⟳ ${ev.message} — retrying in ${(ev.delayMs / 1000).toFixed(1)}s (attempt ${ev.attempt})`,
          },
        ],
      };
    case 'subagent-progress': {
      // Upsert expandable ↳ progress (accumulate tools on the existing row).
      const key = ev.role;
      let tools: string[] = [];
      for (let i = state.transcript.length - 1; i >= 0; i -= 1) {
        const e = state.transcript[i];
        if (e?.progressKey === key) {
          tools = e.progressTools ? [...e.progressTools] : [];
          break;
        }
      }
      if (ev.phase === 'tool' && ev.tool) tools.push(ev.tool);
      const label = key.startsWith('skill:') ? key.slice('skill:'.length) || 'skill' : key;
      return reducer(state, {
        type: 'child-progress',
        key,
        label,
        tools,
        done: ev.phase === 'done',
      });
    }
    case 'done': {
      // End of turn: finalize a trailing streaming assistant entry so it
      // moves out of the live frame and into the committed scrollback log.
      // Long replies collapse for Grok-style click-to-expand.
      const last = state.transcript[state.transcript.length - 1];
      if (last && last.kind === 'assistant' && last.streaming) {
        const finalized = finalizeAssistantEntry(last);
        return {
          ...state,
          busy: false,
          phase: 'idle',
          runningTool: null,
          transcript: [...state.transcript.slice(0, -1), finalized],
        };
      }
      return { ...state, busy: false, phase: 'idle', runningTool: null };
    }
    default: {
      const _exhaustive: never = ev;
      void _exhaustive;
      return state;
    }
  }
}

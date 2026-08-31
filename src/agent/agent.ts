// Agent: chat ↔ tool loop. The TUI
// invokes run() / compact() with an AbortSignal; the agent emits events
// via the provided sink (a callback or async-iterator adapter). emit()
// honors the signal so a wedged TUI can't keep the agent stuck.

import { dirname } from 'node:path';
import type { HookConfig } from '../config/config.js';
import {
  type AddMemoryInput,
  type MemoryFact,
  type MemoryStore,
  formatMemoryRecall,
} from '../curatedMemory/store.js';
import { runToolHooks } from '../hooks/hooks.js';
import { type IntelligenceStore, formatIntelligenceContext } from '../intelligence/store.js';
import type { Client, StreamingClient } from '../llm/client.js';
import { isStreaming } from '../llm/client.js';
import type { RetryInfo } from '../llm/retry.js';
import type { ChatRequest, Message, ToolCall } from '../llm/types.js';
import { parsedArgs } from '../llm/types.js';
import { error as logError } from '../logger/logger.js';
import type { MemoryProvider } from '../memoryProvider/types.js';
import type { Prompter } from '../permission/permission.js';
import { apply as redact } from '../redact/redact.js';
import type { SessionMemory, Store } from '../session/store.js';
import { type Registry as SkillRegistry, materializeSkillBody } from '../skills/registry.js';
import type { Target } from '../target/target.js';
import { canonicalToolName } from '../tools/aliases.js';
import { isExploreAllowedTool } from '../tools/delegate.js';
import type { Registry as ToolRegistry } from '../tools/registry.js';
import type { UserProfileStore } from '../userProfile/store.js';
import {
  appendMemorySection,
  boundedHistoryForCompaction,
  buildTurnLearningText,
  countMemoryItems,
  formatHistoryForCompaction,
  formatPinnedMemory,
  mergeMemory,
} from './compaction.js';
import type { AgentEvent, TodoItem } from './events.js';
import { MaxStepsError } from './events.js';
import { expandFileMentions } from './mentions.js';
import { ThinkingStreamFilter, stripThinkingTags } from './sanitize.js';
import { buildObserveNote, routeSkill } from './skillRouter.js';
import { type PromptProfile, type ToolingProfile, buildSystemPrompt } from './systemPrompt.js';
import { TokenAccountant } from './tokenAccountant.js';
import { maybeOffloadToolResult } from './toolResultStore.js';

export type EventSink = (e: AgentEvent) => void;

export interface AgentRunOptions {
  /** When false, omit tool definitions and block any tool calls returned anyway. */
  tools?: boolean;
  /** When false, skip @file-mention auto-expansion. `expandFileMentions`
   *  inlines local file contents with no permission prompt (unlike file_read),
   *  which is fine for text the user actually typed but not for
   *  internally-built prompts that splice in model-authored text (e.g. /next
   *  folding a coverage note into the turn) — an indirect prompt injection
   *  there could plant an @-token that gets silently expanded into context.
   *  Defaults to true so ordinary user turns are unaffected. */
  expandMentions?: boolean;
}

export interface AgentOptions {
  client: Client;
  tools: ToolRegistry;
  skills: SkillRegistry;
  prompter: Prompter;
  store: Store | null;
  target: Target;
  thinkingEnabled?: boolean;
  maxSteps?: number;
  /** When approxTokens() exceeds this number, the agent compacts before
   *  its next turn. 0 disables auto-compaction (manual /compact still
   *  works). Defaults to 16000 tokens. */
  autoCompactThreshold?: number;
  /** First-run picker choice. 'minimal' (default) keeps the curl-first
   *  ban on scanners; 'full' authorises ffuf/nuclei/sqlmap/etc. */
  toolingProfile?: ToolingProfile;
  /** Compact prompt profile for providers with small request/TPM caps. */
  promptProfile?: PromptProfile;
  /** When false, the agent calls `client.chat()` instead of
   *  `chatStream()`. Useful for backends/models where streaming is
   *  flaky (e.g. tool calls vanish from SSE deltas). Default: true. */
  streamingEnabled?: boolean;
  /** Local scan-intelligence dataset used to improve coverage across sessions. */
  intelligence?: IntelligenceStore | null;
  /** Curated, human-editable memory (Claude-Code-style facts). Its catalog is
   *  pinned into the system prompt and matching facts are recalled each turn. */
  memoryStore?: MemoryStore | null;
  /** Operator-authored engagement notes (from .pentesterflow/engagement.md),
   *  always injected into the system prompt. Loaded once at startup. */
  engagement?: string;
  /** What the agent has learned about the operator (~/.pentesterflow/USER.md).
   *  Always injected into the system prompt; the agent can append to it
   *  autonomously (update_user_profile tool) as well as via /user add. */
  userProfileStore?: UserProfileStore | null;
  /** Optional external memory provider (e.g. local SQLite FTS5), active
   *  alongside — never instead of — the stores above. null/undefined when
   *  disabled or unavailable on this Node runtime. */
  memoryProvider?: MemoryProvider | null;
  /** Automation hooks (pre/post-tool-call, session-start, finding-confirmed).
   *  Defaults to none. Deliberately NOT inherited by delegate_task's
   *  sub-agent (it's built without this option) — hook side effects stay
   *  scoped to the top-level session. */
  hooks?: HookConfig[];
}

/** How many consecutive auto-compaction failures we tolerate before
 *  giving up for the rest of the session. A circuit-breaker: if compaction itself is broken, we don't
 *  want to retry it on every turn. */
const MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3;
// When the model emits several independent tool calls in one step, run them
// concurrently up to this fan-out instead of strictly one-at-a-time — recon
// fan-outs (multiple curl/grep probes) finish in ~max(latency) rather than the
// sum (E1). The permission prompter serializes its modal internally, so
// approvals still appear one at a time.
const MAX_PARALLEL_TOOL_CALLS = 4;
// Tools whose execution mutates state a later call in the SAME step can
// observe or race against — either agent-internal state (load_skill changes
// the active-skill allowlist used by the allowed-tools gate) or shared
// on-disk resources with no locking of their own (two concurrent file_write/
// file_edit calls to the same path, two concurrent coverage marks, or two
// concurrent confirm_finding calls can interleave last-writer-wins against
// the same file). A step containing one of these falls back to sequential
// execution so ordering stays deterministic. Canonical names — checked
// against canonicalToolName() below so the PascalCase aliases models also
// call (FileWriteTool, etc.) are covered too.
const STATEFUL_TOOLS = new Set([
  'load_skill',
  'file_write',
  'file_edit',
  'coverage',
  'confirm_finding',
  // Concurrent ask_user calls clobber the single ask modal (askBridge has no
  // queue unless serialized). Force sequential so two questions in one step
  // never hang the turn waiting on a superseded promise.
  'ask_user',
  // In-memory checklist held on a single TodoTool instance — two concurrent
  // writes (e.g. the parent and a delegated sub-agent, see delegate_task
  // below) would last-writer-wins clobber each other's list.
  'todo',
  // Runs a full sub-agent that can itself call coverage/confirm_finding/
  // file_write/todo — those Tool instances are shared by reference with the
  // parent (see cli/index.ts's childTools construction), so delegate_task
  // must not run concurrently with the parent's own calls into the same set.
  'delegate_task',
]);
// Marker that replaces a tool result's body when the mid-turn context guard
// elides it to keep `working` under the context window. The prefix is matched
// to skip already-elided results on a later pass within the same turn.
const MIDTURN_ELISION_PREFIX = '[tool output elided mid-turn to fit context';
// Never elide the freshest tool results — they're what the model is actively
// reasoning over. The guard only touches results older than this many.
const MIDTURN_ELISION_KEEP_RECENT = 4;

interface ParsedToolCall {
  args: Record<string, unknown>;
  argsJSON: string;
  parseErr?: Error;
}

interface ToolCallResult {
  result: string;
  errStr: string;
  durationMs: number;
}

/**
 * Map `items` through `fn` with at most `limit` running at once, returning
 * results in input order. `fn` is expected not to reject (callers fold errors
 * into their result value); an unexpected rejection still propagates.
 */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (true) {
      const i = next;
      next += 1;
      if (i >= items.length) return;
      const item = items[i];
      if (item === undefined) continue;
      results[i] = await fn(item, i);
    }
  };
  const pool = Array.from({ length: Math.min(limit, items.length) }, worker);
  await Promise.all(pool);
  return results;
}
const COMPACTION_SYSTEM_PROMPT =
  'Create a compact continuation memory for the same pentesting/coding session. Use concise Markdown with exactly these headings: Current objective, Plan, Completed tasks, Target and scope, Decisions and assumptions, Tested surface, Findings and evidence, Files and commands, Credentials and placeholders, Open TODOs, Next best actions. Preserve exact endpoints, params, IDs, files, commands, tool results that matter, confirmed negatives, and reproduction evidence. Redact secrets but keep stable placeholders. Omit chatter and failed dead ends unless they prevent repeat work.';

export class Agent {
  client: Client;
  readonly tools: ToolRegistry;
  readonly skills: SkillRegistry;
  readonly prompter: Prompter;
  readonly store: Store | null;
  readonly target: Target;
  readonly intelligence: IntelligenceStore | null;
  readonly memoryStore: MemoryStore | null;
  readonly userProfileStore: UserProfileStore | null;
  readonly memoryProvider: MemoryProvider | null;

  private thinking: boolean;
  private maxSteps: number;
  private sysPrompt: string;
  private history: Message[];
  private memory: SessionMemory | null = null;
  // Operator-authored engagement notes (scope/rules/creds), loaded once at
  // startup from .pentesterflow/engagement.md. Always injected into the system
  // prompt — transcript-independent, so it survives compaction unconditionally.
  private engagement: string;
  private autoCompactThreshold: number;
  private consecutiveCompactFailures = 0;
  private toolingProfile: ToolingProfile;
  private promptProfile: PromptProfile;
  private streamingEnabled: boolean;
  /** plan = read-only-ish turn (no mutating tools); act = normal. */
  private planMode = false;
  // True while run() or compact() is mid-execution. Used to refuse a
  // client swap mid-turn — otherwise the in-flight chat continues against
  // the old client while subsequent loop iterations hit the new one.
  private running = false;
  // Skills loaded during the current turn (via load_skill OR /<name>
  // direct invoke). Used to compute the allowed-tools union; reset at
  // the start of each run() so old skill restrictions don't bleed into
  // a fresh user prompt.
  private activeSkills: Set<string> = new Set();
  // Skills explicitly invoked from slash commands before a turn starts.
  // These become active at the start of the next run, then are cleared.
  private pendingSkills: Set<string> = new Set();
  // Incremental token estimate for history + cumulative real backend usage
  // (see tokenAccountant.ts for why these are split out of Agent itself).
  private readonly tokens = new TokenAccountant();
  // True once the current runInner turn has executed at least one successful
  // tool call. Gates end-of-turn intelligence learning so clarifying questions
  // and chit-chat don't pollute the cross-session KB. Reset each runInner.
  private turnExecutedTool = false;
  // Deliberately not passed to delegate_task's sub-agent (see AgentOptions.hooks) —
  // hook side effects stay scoped to the top-level session.
  private readonly hookConfig: HookConfig[];

  constructor(opts: AgentOptions) {
    this.client = opts.client;
    this.tools = opts.tools;
    this.skills = opts.skills;
    this.prompter = opts.prompter;
    this.store = opts.store ?? null;
    this.intelligence = opts.intelligence ?? null;
    this.memoryStore = opts.memoryStore ?? null;
    this.userProfileStore = opts.userProfileStore ?? null;
    this.memoryProvider = opts.memoryProvider ?? null;
    this.hookConfig = opts.hooks ?? [];
    this.target = opts.target;
    this.thinking = opts.thinkingEnabled ?? false;
    this.maxSteps = opts.maxSteps && opts.maxSteps > 0 ? opts.maxSteps : 20;
    this.autoCompactThreshold = opts.autoCompactThreshold ?? 16000;
    this.toolingProfile = opts.toolingProfile ?? 'minimal';
    this.promptProfile = opts.promptProfile ?? 'full';
    this.streamingEnabled = opts.streamingEnabled ?? true;
    this.engagement = opts.engagement ?? '';
    this.sysPrompt = buildSystemPrompt({
      skills: this.skills,
      thinkingEnabled: this.thinking,
      target: this.target,
      toolingProfile: this.toolingProfile,
      promptProfile: this.promptProfile,
      memory: this.memory,
      engagement: this.engagement,
      curatedMemory: this.memoryStore?.index() ?? '',
      userProfile: this.userProfileStore?.load() ?? '',
    });
    this.history = [{ role: 'system', content: this.sysPrompt }];
    this.tokens.recompute(this.history);
  }

  // ---------- accessors ----------

  getHistory(): Message[] {
    return this.history.map((m) => ({ ...m }));
  }

  getMaxSteps(): number {
    return this.maxSteps;
  }

  setMaxSteps(n: number): void {
    if (n >= 1) this.maxSteps = n;
  }

  getAutoCompactThreshold(): number {
    return this.autoCompactThreshold;
  }

  getMemoryStats(): { compactions: number; items: number; lastCompactedAt?: string } {
    return {
      compactions: this.memory?.compactions ?? 0,
      items: countMemoryItems(this.memory),
      lastCompactedAt: this.memory?.lastCompactedAt,
    };
  }

  /** Live TODO list snapshot, straight from the todo tool's in-memory state. */
  getTodos(): TodoItem[] {
    const tool = this.tools.get('todo') as { snapshot?: () => TodoItem[] } | undefined;
    return tool?.snapshot?.() ?? [];
  }

  /** Clear learned background intelligence (the .pentesterflow/intelligence/scenarios.jsonl files).
   *  Complements the automatic prune (MAX 5000 most recent per scope).
   *  This provides user-visible control over the M13 historical growth concern.
   */
  async clearIntelligence(scope: 'project' | 'personal' | 'all' = 'all'): Promise<void> {
    if (this.intelligence) {
      await this.intelligence.clear(scope);
    }
  }

  getIntelligenceStats(): { project: number; personal: number } {
    return this.intelligence ? this.intelligence.getStats() : { project: 0, personal: 0 };
  }

  /** Name of the active external memory provider, or null if none is configured. */
  getMemoryProviderName(): string | null {
    return this.memoryProvider?.name() ?? null;
  }

  formatMemory(): string {
    if (!this.memory || countMemoryItems(this.memory) === 0) {
      return 'session memory is empty — run /compact after useful work accumulates.';
    }
    const m = this.memory;
    const out: string[] = [];
    out.push(`Session memory · ${m.compactions} compaction${m.compactions === 1 ? '' : 's'}`);
    if (m.lastCompactedAt) out.push(`Last compacted: ${m.lastCompactedAt}`);
    // Pinned block first — these fields must survive compact/resume.
    const pinned = formatPinnedMemory(m);
    if (pinned) out.push(pinned);
    appendMemorySection(out, 'Files', m.files);
    appendMemorySection(out, 'Commands', m.commands);
    appendMemorySection(out, 'Credentials / placeholders', m.credentials);
    return out.join('\n');
  }

  isPlanMode(): boolean {
    return this.planMode;
  }

  setPlanMode(on: boolean): void {
    this.planMode = on;
  }

  /** Current contents of ~/.pentesterflow/USER.md, or '' if none/not configured. */
  getUserProfile(): string {
    return this.userProfileStore?.load() ?? '';
  }

  /**
   * Append one distilled note about the operator — communication style, a
   * standing preference, an expectation. Called by /user add (explicit) and
   * by the update_user_profile tool (the agent's own autonomous writes). A
   * no-op if no store is configured for this session.
   */
  // NOTE: deliberately no `this.running` guard here, unlike the sibling
  // methods below. update_user_profile (tools/userProfile.ts) calls this
  // mid-turn as its designed, primary use case — every such call happens
  // while this.running is true by definition, so that guard would reject
  // 100% of autonomous writes instead of just the rare /user-add-while-
  // something-else-is-running race. The race this method is still exposed
  // to (a concurrent /compact replacing history right after this appends)
  // is guarded one level up, at the /user add command handler, which only
  // fires for the user-typed path.
  async addUserProfileNote(text: string): Promise<void> {
    if (!this.userProfileStore) return;
    await this.userProfileStore.append(text);
    this._lastRebuildKey = '';
    this.rebuildSystemPrompt();
    this.history = ensureSystemPrompt(this.history, this.sysPrompt);
    this.tokens.recompute(this.history);
    await this.save();
  }

  /** Wipe ~/.pentesterflow/USER.md (the /user clear escape hatch). */
  async clearUserProfile(): Promise<void> {
    if (this.running) {
      throw new Error(
        'cannot clear user profile while a turn is in flight — cancel first with Esc',
      );
    }
    if (!this.userProfileStore) return;
    await this.userProfileStore.clear();
    this._lastRebuildKey = '';
    this.rebuildSystemPrompt();
    this.history = ensureSystemPrompt(this.history, this.sysPrompt);
    this.tokens.recompute(this.history);
    await this.save();
  }

  /**
   * Wipe the auto-generated session memory. The escape hatch for when a bad
   * compaction summary poisoned the carried state — the next /compact rebuilds
   * it from scratch. Operator-authored engagement notes are untouched (they
   * live in a file, not here).
   */
  async clearMemory(): Promise<void> {
    if (this.running) {
      throw new Error('cannot clear memory while a turn is in flight — cancel first with Esc');
    }
    if (!this.memory || countMemoryItems(this.memory) === 0) return;
    this.memory = null;
    this._lastRebuildKey = '';
    this.rebuildSystemPrompt();
    this.history = ensureSystemPrompt(this.history, this.sysPrompt);
    this.tokens.recompute(this.history);
    await this.save();
  }

  /**
   * Remove memory whose text contains `query` (case-insensitive) — both durable
   * curated facts and individual session-checkpoint items — so a single wrong
   * line can be dropped without nuking everything. Returns the removed entries.
   */
  async forgetMemory(query: string): Promise<string[]> {
    if (this.running) {
      throw new Error('cannot forget memory while a turn is in flight — cancel first with Esc');
    }
    const needle = query.trim().toLowerCase();
    if (!needle) return [];
    const removed: string[] = [];
    // Durable curated facts (deletes the backing files + rebuilds the index).
    if (this.memoryStore) removed.push(...this.memoryStore.forget(query));
    // Session checkpoint items.
    if (this.memory) {
      const prune = (items: string[]): string[] =>
        items.filter((item) => {
          if (item.toLowerCase().includes(needle)) {
            removed.push(item);
            return false;
          }
          return true;
        });
      this.memory = {
        ...this.memory,
        objectives: prune(this.memory.objectives),
        plan: prune(this.memory.plan),
        completed: prune(this.memory.completed),
        findings: prune(this.memory.findings),
        tested: prune(this.memory.tested),
        files: prune(this.memory.files),
        commands: prune(this.memory.commands),
        credentials: prune(this.memory.credentials),
        todos: prune(this.memory.todos),
      };
    }
    if (removed.length === 0) return [];
    this._lastRebuildKey = ''; // memory contents changed; force rebuild of carried state
    this.rebuildSystemPrompt();
    this.history = ensureSystemPrompt(this.history, this.sysPrompt);
    this.tokens.recompute(this.history);
    await this.save();
    return removed;
  }

  async saveContextSnapshot(reason = 'periodic'): Promise<string> {
    if (!this.store) return '';
    const out: string[] = [];
    out.push('# PentesterFlow Session Context');
    out.push('');
    out.push(`Updated: ${new Date().toISOString()}`);
    out.push(`Reason: ${reason}`);
    out.push(`Provider: ${this.client.name()}`);
    out.push(`Model: ${this.client.model()}`);
    out.push(`Target: ${this.target.baseURL() || this.target.name() || '(none)'}`);
    out.push(`Approx tokens: ${this.approxTokens()}`);
    out.push('');
    out.push('## Persistent Memory');
    out.push('');
    out.push(this.formatMemory());
    out.push('');
    out.push('## Redacted Conversation Context');
    out.push('');
    out.push(formatHistoryForCompaction(this.history.slice(1)));
    return this.store.saveContextSnapshot(out.join('\n'));
  }

  async coverageContext(signal: AbortSignal): Promise<string> {
    if (!this.tools.get('coverage')) return 'Coverage tool is not available in this session.';
    const summary = await this.tools
      .execute('coverage', { action: 'summary' }, signal, this.prompter)
      .catch((err: unknown) => `error: ${errMessage(err)}`);
    const entries = await this.tools
      .execute('coverage', { action: 'list' }, signal, this.prompter)
      .catch((err: unknown) => `error: ${errMessage(err)}`);
    return [
      'Coverage summary:',
      summary,
      '',
      'Coverage entries:',
      entries,
      '',
      'Use this coverage state to choose next tests. Prefer untested endpoint/parameter/vulnerability-class combinations. Do not repeat entries already marked passed, failed, skipped, waf-blocked, or tried unless the objective explicitly asks for retesting.',
    ].join('\n');
  }

  /** Cumulative token usage across every chat/compact call this Agent instance
   *  has made, as reported by the backend. Returns a fresh copy each call. */
  getUsage(): {
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens: number;
    calls: number;
  } {
    return this.tokens.getUsage();
  }

  /** Set the auto-compact threshold (in approxTokens). 0 disables. */
  setAutoCompactThreshold(n: number): void {
    this.autoCompactThreshold = Math.max(0, Math.floor(n));
  }

  setPromptProfile(profile: PromptProfile): void {
    if (this.promptProfile === profile) return;
    this.promptProfile = profile;
    this.rebuildSystemPrompt();
    this.history = ensureSystemPrompt(this.history, this.sysPrompt);
    this.tokens.recompute(this.history);
  }

  thinkingIsEnabled(): boolean {
    return this.thinking;
  }

  async setThinkingEnabled(on: boolean): Promise<void> {
    this.thinking = on;
    this.rebuildSystemPrompt();
    // Match every other system-prompt mutator: reseed history[0] so the live
    // model actually sees the new thinking directive. Without this, /thinking
    // only updated sysPrompt + disk while the in-memory system message (and
    // thus the next chat request) stayed stale.
    this.history = ensureSystemPrompt(this.history, this.sysPrompt);
    this.tokens.recompute(this.history);
    await this.save();
  }

  /**
   * Toggle a skill's enabled state on the shared registry, then rebuild
   * the system prompt so the change takes effect on the next turn.
   * Returns whether the state actually changed (false if it was already
   * in the requested state, or if the skill doesn't exist).
   *
   * Persisting to ~/.pentesterflow/config.json is the caller's job —
   * the agent only knows about its in-memory state.
   */
  async setSkillEnabled(name: string, enabled: boolean): Promise<boolean> {
    if (this.running) {
      throw new Error('cannot toggle skills while a turn is in flight — cancel first with Esc');
    }
    if (!this.skills.has(name)) return false;
    const changed = this.skills.setDisabled(name, !enabled);
    if (!changed) return false;
    this.rebuildSystemPrompt();
    this.history = ensureSystemPrompt(this.history, this.sysPrompt);
    this.tokens.recompute(this.history);
    await this.save();
    return true;
  }

  /**
   * Swap the active LLM client. Throws if a turn is in flight — callers
   * (e.g. /provider, /model) must wait for the current run to settle before
   * switching, otherwise the in-flight chat would continue against the old
   * client while subsequent iterations hit the new one (and usePing would
   * see the new readiness state mid-turn).
   */
  setClient(client: Client): void {
    if (this.running) {
      throw new Error(
        'cannot switch model/provider while a turn is in flight — cancel first with Esc',
      );
    }
    this.client = client;
  }

  /** True while run() or compact() is executing. */
  isRunning(): boolean {
    return this.running;
  }

  /**
   * Re-derive the system prompt from the current state of the shared
   * skill registry. Called by the live-reload watcher in CLI after the
   * registry has been reloaded from disk — without this, edits to a
   * skill file wouldn't reach the model until restart. Safe to call
   * during a turn (we just update the system message in history; the
   * in-flight chat already has its messages serialized).
   */
  rebuildFromSkills(): void {
    this._lastRebuildKey = ''; // force because skills list changed externally
    this.rebuildSystemPrompt();
    this.history = ensureSystemPrompt(this.history, this.sysPrompt);
    this.tokens.recompute(this.history);
  }

  /**
   * Inject a skill's body into the session history as a synthetic
   * system note, the way a `/<skill-name>` direct invoke
   * works. The next user turn sees the skill content as if the model
   * had loaded it via load_skill. Throws if the skill is missing,
   * disabled, or a turn is in flight. Returns the skill name on success.
   *
   * Direct-invoke deliberately bypasses the `disable-model-invocation`
   * flag — that flag is about hiding skills from the model's automatic
   * decision-making, not about blocking the user from running them.
   */
  async injectSkill(name: string): Promise<string> {
    if (this.running) {
      throw new Error('cannot load a skill while a turn is in flight — cancel first with Esc');
    }
    const s = this.skills.get(name);
    if (!s) throw new Error(`unknown skill "${name}"`);
    if (this.skills.isDisabled(name)) {
      throw new Error(`skill "${name}" is disabled — enable it from /skills first`);
    }
    const body = materializeSkillBody(s);
    // role: 'user', not 'system' — this is appended into `this.history`
    // permanently (unlike the per-turn context folded into the system
    // message in runInner), and some locally-served models' chat templates
    // hard-error on any system-role message that isn't the very first one.
    const skillNote = {
      role: 'user' as const,
      content: `[/${name} invoked] Apply this skill to the next request:\n\n${body}`,
    };
    this.history.push(skillNote);
    this.tokens.accountForPush(skillNote);
    // Track as active so the allowed-tools enforcer treats this skill as
    // loaded for the upcoming turn.
    this.pendingSkills.add(name);
    await this.save();
    return name;
  }

  /**
   * Check whether a tool call is permitted given the currently-active
   * skills' allowed-tools lists. Policy:
   *
   *   1. No active skills → no restriction (backward-compatible).
   *   2. Tool doesn't require permission → always allowed (load_skill,
   *      read_payloads, read_skill_file, coverage, ask, confirm_finding,
   *      file_read, glob, grep, web_fetch, web_search). These are
   *      workflow / observational and shouldn't be skill-gated.
   *   3. ALL active skills OMIT allowed-tools → no restriction. By
   *      convention, an empty allowed-tools means "inherit all tools" for
   *      that skill — but this must not let one unrestricted skill erase a
   *      DIFFERENT active skill's declared sandbox. If any active skill
   *      declares an allowed-tools list, that restriction still binds:
   *      a narrowly-scoped skill (allowed-tools: [http]) stays scoped even
   *      when a second, unrestricted skill is active alongside it, so
   *      loading a second skill can't be used to bypass the first one's
   *      allowlist (including a skill suggested via prompt injection).
   *   4. Any active skill lists the tool in its `allowed-tools` →
   *      allowed. (Union semantics: loading multiple *restricted* skills
   *      broadens what's allowed among their declared lists.)
   *   5. Else → blocked, with a message naming the active skills and the
   *      tools each allows, so the model knows what to do (load a
   *      different skill, or give up on the disallowed action).
   */
  private isToolAllowed(toolName: string): { ok: boolean; reason?: string } {
    // Plan mode: read-only / observational tools only (Claude Code plan-mode style).
    if (this.planMode && !isExploreAllowedTool(toolName)) {
      const t = this.tools.get(toolName);
      // Still allow no-permission workflow tools (todo, load_skill, ask, …).
      if (t?.requiresPermission()) {
        return {
          ok: false,
          reason: `tool "${toolName}" is blocked in plan mode. Exit plan mode with /plan off (or /act) before using mutating tools.`,
        };
      }
    }
    if (this.activeSkills.size === 0) return { ok: true };
    const t = this.tools.get(toolName);
    if (!t) return { ok: true }; // unknown tool — let downstream fail with a clearer error
    if (!t.requiresPermission()) return { ok: true }; // workflow primitive
    const activeSkills = [...this.activeSkills]
      .map((n) => this.skills.get(n))
      .filter((s): s is NonNullable<typeof s> => s !== undefined);
    // No resolvable active skill, or EVERY active skill omits allowed-tools
    // (none of them declared a sandbox) → unrestricted.
    if (activeSkills.length === 0) return { ok: true };
    if (activeSkills.every((s) => s.tools.length === 0)) return { ok: true };
    // pentesterflow registers tools under two names (Unix and
    // PascalCase — `shell` AND `BashTool`, `file_write` AND
    // `FileWriteTool`, etc.) so models trained against either corpus
    // can call them. The skill author writes the canonical Unix name
    // in `allowed-tools`; canonicalize both sides before comparing so
    // calling `BashTool` under a skill that allows `shell` succeeds.
    const wantedCanonical = canonicalToolName(toolName);
    const allowedBy = activeSkills.filter((s) =>
      s.tools.map((n) => canonicalToolName(n)).includes(wantedCanonical),
    );
    if (allowedBy.length > 0) return { ok: true };
    const summary = [...this.activeSkills]
      .map((n) => {
        const sk = this.skills.get(n);
        const list = sk && sk.tools.length > 0 ? sk.tools.join(', ') : '(none)';
        return `${n} (allows: ${list})`;
      })
      .join('; ');
    return {
      ok: false,
      reason: `tool "${toolName}" is not in any active skill's allowed-tools list. Active skills: ${summary}. To use this tool, either load a skill that allows it (try \`load_skill name=...\`), /reset to clear active-skill restrictions, or choose a different approach.`,
    };
  }

  approxTokens(): number {
    return this.tokens.approxTokens();
  }

  /** History + tool-schema estimate — the same baseline the auto-compact
   *  gate checks against (gate adds the incoming message on top; that part
   *  is turn-specific and unknown at rest). Callers displaying "how full is
   *  context" (StatusBar) must use this, not approxTokens() alone, or the
   *  bar reads "room left" while the next turn already crosses the gate. */
  contextTokens(): number {
    return this.tokens.approxTokens() + this.tokens.toolsTokenEstimate(this.tools);
  }

  // ---------- session lifecycle ----------

  async reset(): Promise<void> {
    if (this.running) {
      throw new Error('cannot reset while a turn is in flight — cancel first with Esc');
    }
    this.history = [{ role: 'system', content: this.sysPrompt }];
    this.tokens.recompute(this.history);
    this.memory = null;
    // A reset wipes the conversation; allowed-tools restrictions from
    // previously-loaded skills should go too, otherwise the user is
    // stuck with a stale allowlist on a fresh session.
    this.activeSkills.clear();
    this.pendingSkills.clear();
    // Clear the auto-compact circuit breaker so a fresh session isn't born with
    // compaction already disabled from a previous session's failures (M4).
    this.consecutiveCompactFailures = 0;
    if (this.store) await this.store.clear();
  }

  hasSavedSession(): boolean {
    if (!this.store) return false;
    try {
      const loaded = this.store.load();
      return loaded.messages.length > 1;
    } catch {
      return false;
    }
  }

  resumeSaved(): void {
    if (!this.store) return;
    const loaded = this.store.load();
    if (loaded.target) this.target.copyFrom(loaded.target);
    this.memory = loaded.memory;
    this._lastRebuildKey = '';
    this.rebuildSystemPrompt();
    if (loaded.messages.length === 0) {
      this.history = [{ role: 'system', content: this.sysPrompt }];
      // rebuildSystemPrompt() just above can change this.sysPrompt's size
      // (loaded target/memory affect it) — without recomputing here, the
      // status bar and auto-compact gate keep sizing against the
      // pre-resume prompt until the next turn happens to trigger a recompute.
      this.tokens.recompute(this.history);
      return;
    }
    // Repair any dangling tool_calls a prior session aborted mid-loop, else
    // the first resumed request 400s on an unanswered call (H6).
    this.history = reconcileToolCalls(ensureSystemPrompt(loaded.messages, this.sysPrompt));
    this.tokens.recompute(this.history);
  }

  async setTargetBaseURL(u: string): Promise<void> {
    if (this.running) {
      throw new Error('cannot change target while a turn is in flight — cancel first with Esc');
    }
    this.target.setBaseURL(u);
    this.rebuildSystemPrompt();
    this.history = ensureSystemPrompt(this.history, this.sysPrompt);
    this.tokens.recompute(this.history);
    await this.save();
  }

  async clearTarget(): Promise<void> {
    if (this.running) {
      throw new Error('cannot clear target while a turn is in flight — cancel first with Esc');
    }
    this.target.clear();
    this.rebuildSystemPrompt();
    this.history = ensureSystemPrompt(this.history, this.sysPrompt);
    this.tokens.recompute(this.history);
    await this.save();
  }

  // ---------- main loop ----------

  async run(
    userMsg: string,
    signal: AbortSignal,
    emit: EventSink,
    opts?: AgentRunOptions,
  ): Promise<void> {
    const safeEmit = makeSafeEmit(signal, emit);
    this.running = true;
    try {
      await this.runInner(userMsg, signal, safeEmit, opts);
    } catch (err) {
      if (signal.aborted || isAbortLikeError(err)) {
        safeEmit({ type: 'error', err: new Error('turn cancelled') });
        return;
      }
      logError('agent: panic in Run', { err: errMessage(err) });
      safeEmit({ type: 'error', err: err instanceof Error ? err : new Error(String(err)) });
    } finally {
      this.running = false;
      safeEmit({ type: 'done' });
    }
  }

  async compact(signal: AbortSignal, emit: EventSink): Promise<void> {
    const safeEmit = makeSafeEmit(signal, emit);
    this.running = true;
    try {
      const historySnap = this.history.slice();
      if (historySnap.length <= 1) {
        safeEmit({ type: 'compact', summary: 'nothing to compact' });
        return;
      }
      const req: ChatRequest = {
        model: this.client.model(),
        messages: [
          {
            role: 'system',
            content: COMPACTION_SYSTEM_PROMPT,
          },
          {
            role: 'user',
            content: boundedHistoryForCompaction(historySnap.slice(1)),
          },
        ],
      };
      const resp = await this.client.chat(req, signal, this.onRetryHook(safeEmit));
      this.tokens.accountUsage(resp.usage);
      const summary = stripThinkingTags(resp.message.content);
      if (!summary) {
        safeEmit({
          type: 'error',
          err: new Error(
            'compact produced an empty summary (the model may have spent the whole reply on thinking) — try /compact again or /clear to reset context',
          ),
        });
        return;
      }
      this.memory = mergeMemory(this.memory, summary);
      // Fold the freshly merged checkpoint into the system prompt before it is
      // seeded into the reset history below, so accumulated state survives this
      // compaction (and every restart) instead of only the latest summary.
      this.rebuildSystemPrompt();
      // A successful manual /compact proves compaction works again, so clear
      // the auto-compact circuit breaker that prior auto failures may have
      // tripped — otherwise it stays disabled for the whole process (M4).
      this.consecutiveCompactFailures = 0;
      await this.learnIntelligence(summary);
      const pinned = formatPinnedMemory(this.memory);
      this.history = [
        { role: 'system', content: this.sysPrompt },
        {
          role: 'user',
          content: [
            'Session context was compacted (tool spam microcompacted, then summarized).',
            'Continue from pinned state + summary.',
            pinned ? `\n${pinned}\n` : '',
            `\n## Compact summary\n\n${summary}`,
          ].join('\n'),
        },
      ];
      this.tokens.recompute(this.history);
      await this.save().catch((err) =>
        safeEmit({ type: 'error', err: new Error(`save compacted session: ${errMessage(err)}`) }),
      );
      await this.saveContextSnapshot('manual compact').catch((err) =>
        safeEmit({ type: 'error', err: new Error(`save context snapshot: ${errMessage(err)}`) }),
      );
      // UI gets a short notice only — the full summary lives in history for
      // the model, not as a wall of system text in the transcript.
      safeEmit({
        type: 'compact',
        summary: 'Context compacted',
        memoryItems: countMemoryItems(this.memory),
      });
    } catch (err) {
      logError('agent: panic in Compact', { err: errMessage(err) });
      safeEmit({ type: 'error', err: err instanceof Error ? err : new Error(String(err)) });
    } finally {
      this.running = false;
      safeEmit({ type: 'done' });
    }
  }

  private async runInner(
    userMsg: string,
    signal: AbortSignal,
    emit: EventSink,
    opts?: AgentRunOptions,
  ): Promise<void> {
    this.activeSkills = new Set(this.pendingSkills);
    this.pendingSkills.clear();
    // Reset per-turn tracking: end-of-turn learning only fires when this turn
    // actually executed a successful tool call (M — gate learnIntelligence).
    this.turnExecutedTool = false;

    // Repair any dangling assistant tool_calls left by a previously aborted
    // turn before this turn's user message is appended, so the request we send
    // (and the next save) can't carry an unanswered tool call into a provider
    // 400 (H6).
    this.history = reconcileToolCalls(this.history);
    this.tokens.recompute(this.history);

    // Expand @file mentions once. The expanded text is both what we size this
    // turn against for the auto-compact gate (M5 — a large @file attachment
    // must count toward the threshold) and the content actually sent below.
    const expandedUserMsg = opts?.expandMentions === false ? userMsg : expandFileMentions(userMsg);
    // content.length/4 (UTF-16 units) to match approxTokens()'s estimator — the
    // two are summed in the gate below, so they must use the same unit.
    const incomingTokens = Math.floor(expandedUserMsg.length / 4);

    // Auto-compact gate. Run BEFORE we add the new user message so the
    // compaction summary doesn't include this turn's question — the
    // user expects their prompt to be answered, not summarized away.
    // baseline is contextTokens() (history + tool-schema estimate — the same
    // number StatusBar displays) plus the incoming (post-expansion) message
    // size, so a near-threshold turn plus a large attachment can't blow past
    // the context window with no compaction (M5). Circuit breaker: stop
    // retrying if we've failed N times in a row; the user can still call
    // /compact manually to investigate.
    const baseline = opts?.tools === false ? this.approxTokens() : this.contextTokens();
    if (
      this.autoCompactThreshold > 0 &&
      this.consecutiveCompactFailures < MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES &&
      baseline + incomingTokens >= this.autoCompactThreshold
    ) {
      await this.autoCompact(signal, emit);
    }

    // Persist the raw user message (un-expanded mentions) so the on-disk
    // session doesn't leak file contents the user inlined via @path.
    const userMsgObj = { role: 'user' as const, content: userMsg };
    this.history.push(userMsgObj);
    this.tokens.accountForPush(userMsgObj);
    // Best-effort — a provider write failure must never break the turn.
    // Redact before handing content to external memory providers (mem0,
    // honcho, etc.) — unlike the local stores (intelligence/curatedMemory/
    // userProfile), these ship the raw text over the network to a
    // third-party service, so a live secret the agent echoes mid-engagement
    // must never reach record() unredacted.
    void this.memoryProvider
      ?.record({ role: 'user', content: redact(userMsg), createdAt: new Date().toISOString() })
      .catch(() => undefined);
    const working = this.history.map((m) => ({ ...m }));
    await this.save().catch((err) =>
      emit({
        type: 'error',
        err: new Error(
          `⚠ failed to save session — progress may be lost on restart: ${errMessage(err)}`,
        ),
      }),
    );

    const last = working[working.length - 1];
    // Fold per-turn context (skill route, learned-scenario recall, curated-memory
    // recall) into the existing system message at index 0 rather than splicing
    // extra role:'system' entries mid-transcript. Some locally-served models
    // (Ollama, LM Studio, vLLM) apply the GGUF's own Jinja chat template, and
    // templates that enforce "system message must be first" hard-error on a
    // second system-role message appearing later in the array — this keeps
    // exactly one system message, always first, on every backend.
    const extraSystemContext: string[] = [];
    if (opts?.tools !== false) {
      const route = routeSkill(userMsg, this.skills.listEnabled(), this.target);
      if (route) {
        emit({ type: 'decision', summary: route.summary });
        extraSystemContext.push(route.guidance);
      }
    }
    const intelligenceContext = this.buildIntelligenceContext(userMsg);
    if (intelligenceContext) extraSystemContext.push(intelligenceContext);
    // Recall the durable curated facts most relevant to this turn so they
    // stay in context even after a compaction has scrubbed the transcript
    // (the catalog of names is already pinned in the system prompt; this
    // brings in the bodies).
    const recall = this.recallCuratedMemory(userMsg, emit);
    if (recall) extraSystemContext.push(recall);
    if (this.memoryProvider) {
      const status = this.memoryProvider.systemPromptContext();
      if (status) extraSystemContext.push(status);
      const providerRecall = await this.memoryProvider.recall(userMsg).catch(() => '');
      if (providerRecall) extraSystemContext.push(providerRecall);
    }
    const system = working[0];
    if (extraSystemContext.length > 0 && system) {
      working[0] = { ...system, content: [system.content, ...extraSystemContext].join('\n\n') };
    }
    if (last) last.content = expandedUserMsg;

    const maxSteps = this.maxSteps;
    for (let step = 0; step < maxSteps; step += 1) {
      if (signal.aborted) throw new Error('aborted');

      // Mid-turn context guard: a single tool-heavy step can resend a `working`
      // transcript that overflows the window long before the between-turns
      // auto-compact gate runs again. Elide the oldest large tool results in
      // the working copy if we've grown past the threshold (M2).
      if (this.autoCompactThreshold > 0) this.guardWorkingContext(working, emit, opts);

      const req: ChatRequest = {
        model: this.client.model(),
        messages: working,
      };
      if (opts?.tools !== false) req.tools = this.tools.asLLMTools();
      const { resp, streamed } = await this.chat(req, signal, emit);
      resp.message.content = stripThinkingTags(resp.message.content);
      const toolCalls = resp.message.toolCalls ?? [];
      const hasToolCalls = toolCalls.length > 0;

      if (opts?.tools === false && hasToolCalls) {
        if (resp.message.content && !streamed) {
          emit({ type: 'assistant-text', text: resp.message.content });
        }
        emit({ type: 'error', err: new Error('plan-only mode blocked tool calls') });
        return;
      }

      this.history.push(resp.message);
      this.tokens.accountForPush(resp.message);
      working.push(resp.message);
      void this.memoryProvider
        ?.record({
          role: 'assistant',
          content: redact(resp.message.content),
          createdAt: new Date().toISOString(),
        })
        .catch(() => undefined);
      await this.save().catch((err) =>
        emit({ type: 'error', err: new Error(`save session: ${errMessage(err)}`) }),
      );

      if (resp.message.content && !streamed) {
        emit({ type: 'assistant-text', text: resp.message.content });
      }
      if (!hasToolCalls) {
        // Only learn from turns that did substantive work (≥1 successful tool
        // call) — clarifying questions and chit-chat would otherwise pollute
        // the cross-session KB. Fire-and-forget so it never blocks the hot path
        // (learnIntelligence has its own catch/logError).
        if (this.turnExecutedTool) {
          void this.learnIntelligence(buildTurnLearningText(userMsg, resp.message.content));
        }
        return;
      }

      const toolOutcomes = await this.executeToolCalls(toolCalls, signal, emit, working);
      // Lightweight OBSERVE: when tools failed (or many succeeded), fold a
      // short note into the system message so the next step doesn't blindly
      // repeat the same call — especially important for small local models.
      const observe = buildObserveNote(toolOutcomes);
      if (observe && working[0]) {
        working[0] = {
          ...working[0],
          content: `${working[0].content}\n\n${observe}`,
        };
      }
    }
    emit({ type: 'error', err: new MaxStepsError(maxSteps) });
  }

  /**
   * Mid-turn context guard (M2). When the `working` transcript we resend each
   * step — plus the tool schemas attached to every request — crosses the
   * auto-compact threshold, elide the OLDEST large tool-result messages,
   * replacing their body with a short marker, oldest-first, until we're back
   * under the threshold or only the most recent few tool results remain. Only
   * the `working` COPIES are touched (the array slot is swapped for a fresh
   * object); `this.history` keeps full fidelity for the session save and the
   * next compaction. Emits an informational event so the user sees it happened.
   */
  private guardWorkingContext(working: Message[], emit: EventSink, opts?: AgentRunOptions): void {
    const toolsTokens = opts?.tools === false ? 0 : this.tokens.toolsTokenEstimate(this.tools);
    const size = (): number => {
      let total = toolsTokens;
      for (const m of working) {
        total += Math.floor(m.content.length / 4);
        for (const tc of m.toolCalls ?? []) {
          total += Math.floor((tc.function.name.length + tc.function.arguments.length) / 4);
        }
      }
      return total;
    };
    if (size() < this.autoCompactThreshold) return;

    // Tool-result message indices, oldest first, excluding the most recent few
    // (never elide the freshest results — they're what the model is reasoning
    // over right now).
    const toolIdx: number[] = [];
    for (let i = 0; i < working.length; i += 1) {
      if (working[i]?.role === 'tool') toolIdx.push(i);
    }
    const elidable = toolIdx.slice(0, Math.max(0, toolIdx.length - MIDTURN_ELISION_KEEP_RECENT));

    let dropped = 0;
    for (const i of elidable) {
      if (size() < this.autoCompactThreshold) break;
      const msg = working[i];
      if (!msg || msg.content.startsWith(MIDTURN_ELISION_PREFIX)) continue;
      const bytes = msg.content.length;
      // Swap the slot for a fresh object so the shared history message keeps its
      // full content (working and history share tool-message references).
      working[i] = { ...msg, content: `${MIDTURN_ELISION_PREFIX} — ${bytes} bytes dropped]` };
      dropped += bytes;
    }

    if (dropped > 0) {
      emit({
        type: 'decision',
        summary: `context · elided ${dropped} bytes of older tool output mid-turn`,
      });
    }
  }

  /**
   * Run the step's tool calls. Returns per-tool outcomes for the observe step.
   * A single call, or any step containing a state-mutating tool (load_skill),
   * runs sequentially; independent calls run with bounded concurrency (E1).
   */
  private async executeToolCalls(
    toolCalls: ToolCall[],
    signal: AbortSignal,
    emit: EventSink,
    working: Message[],
  ): Promise<Array<{ name: string; err: string; result: string }>> {
    const outcomes: Array<{ name: string; err: string; result: string }> = [];
    const sequential =
      toolCalls.length <= 1 ||
      toolCalls.some((tc) => STATEFUL_TOOLS.has(canonicalToolName(tc.function.name)));

    if (sequential) {
      // Track which calls already got a tool message so an abort mid-batch can
      // synthesize ERROR results for the rest (keeps history valid for the next
      // chat/resume without waiting for reconcileToolCalls on the next run).
      const answered = new Set<string>();
      const started = new Set<string>();
      let aborted = false;
      try {
        for (const tc of toolCalls) {
          if (signal.aborted) {
            aborted = true;
            break;
          }
          const parsed = this.parseToolCall(tc);
          emit({
            type: 'tool-call',
            id: tc.id,
            name: tc.function.name,
            args: parsed.args,
            argsJSON: parsed.argsJSON,
          });
          started.add(tc.id ?? '');
          const res = await this.runParsedToolCall(tc, parsed, signal);
          this.recordToolResult(tc, parsed, res, emit, working);
          outcomes.push({ name: tc.function.name, err: res.errStr, result: res.result });
          answered.add(tc.id ?? '');
          if (signal.aborted) {
            aborted = true;
            break;
          }
        }
      } finally {
        // Fill unanswered slots so assistant tool_calls never dangle on disk.
        this.synthesizeUnansweredToolResults(toolCalls, answered, started, emit, working);
      }
      // One save after the loop — matches the parallel branch and avoids a
      // full-session write after every tool result. Always save after synth so
      // an aborted batch is durable before we rethrow.
      await this.save().catch((err) =>
        emit({ type: 'error', err: new Error(`save session: ${errMessage(err)}`) }),
      );
      if (aborted) throw new Error('aborted');
      return outcomes;
    }

    const parsedAll = toolCalls.map((tc) => this.parseToolCall(tc));
    toolCalls.forEach((tc, i) => {
      const parsed = parsedAll[i];
      if (parsed) {
        emit({
          type: 'tool-call',
          id: tc.id,
          name: tc.function.name,
          args: parsed.args,
          argsJSON: parsed.argsJSON,
        });
      }
    });
    const results = await mapWithConcurrency(toolCalls, MAX_PARALLEL_TOOL_CALLS, (tc, i) =>
      this.runParsedToolCall(tc, parsedAll[i] ?? this.parseToolCall(tc), signal),
    );
    toolCalls.forEach((tc, i) => {
      const parsed = parsedAll[i];
      const res = results[i];
      if (parsed && res) {
        this.recordToolResult(tc, parsed, res, emit, working);
        outcomes.push({ name: tc.function.name, err: res.errStr, result: res.result });
      }
    });
    // One save covers the whole batch — every tool message is appended above.
    await this.save().catch((err) =>
      emit({
        type: 'error',
        err: new Error(
          `⚠ failed to save session — progress may be lost on restart: ${errMessage(err)}`,
        ),
      }),
    );
    if (signal.aborted) throw new Error('aborted');
    return outcomes;
  }

  /**
   * Append ERROR tool results for any tool_call ids not yet answered. Used when
   * a sequential batch is aborted mid-loop so history stays valid immediately
   * (not only after the next runInner reconcile).
   */
  private synthesizeUnansweredToolResults(
    toolCalls: ToolCall[],
    answered: Set<string>,
    started: Set<string>,
    emit: EventSink,
    working: Message[],
  ): void {
    for (const tc of toolCalls) {
      const id = tc.id ?? '';
      if (answered.has(id)) continue;
      const parsed = this.parseToolCall(tc);
      const res: ToolCallResult = {
        result:
          'ERROR: tool call did not complete (the turn was interrupted before this tool produced a result).',
        errStr: 'aborted',
        durationMs: 0,
      };
      // Only emit tool-call if we never started this call (avoid double UI rows
      // when abort hit mid-run after the call was already shown).
      if (!started.has(id)) {
        emit({
          type: 'tool-call',
          id: tc.id,
          name: tc.function.name,
          args: parsed.args,
          argsJSON: parsed.argsJSON,
        });
      }
      this.recordToolResult(tc, parsed, res, emit, working);
      answered.add(id);
    }
  }

  /** Parse a tool call's JSON arguments, capturing (not throwing) a parse error
   *  so the model sees it as a tool result and can self-correct. */
  private parseToolCall(tc: ToolCall): ParsedToolCall {
    let args: Record<string, unknown> = {};
    let parseErr: Error | undefined;
    try {
      args = parsedArgs(tc.function);
    } catch (err) {
      parseErr = err instanceof Error ? err : new Error(String(err));
    }
    return { args, argsJSON: tc.function.arguments, parseErr };
  }

  /** Dispatch one parsed tool call (allowed-tools gate + permission-gated
   *  execute). Never throws — failures come back as an error result string so
   *  the call can run inside a concurrency pool without rejecting its peers. */
  private async runParsedToolCall(
    tc: ToolCall,
    parsed: ParsedToolCall,
    signal: AbortSignal,
  ): Promise<ToolCallResult> {
    if (signal.aborted) return { result: 'ERROR: aborted', errStr: 'aborted', durationMs: 0 };
    const start = Date.now();
    let result = '';
    let runErr: Error | undefined;
    // Only true once this.tools.execute() actually ran — a parse error, an
    // allowed-tools block, or a pre-tool-call veto never reach it, so
    // post-tool-call hooks (which fire below) skip those cases.
    let executed = false;
    if (parsed.parseErr) {
      // Cap the echoed raw JSON so a huge malformed args blob doesn't flood the
      // transcript / model context; the message is just a self-correct hint.
      const rawPreview =
        parsed.argsJSON.length > 200 ? `${parsed.argsJSON.slice(0, 200)}…` : parsed.argsJSON;
      runErr = new Error(
        `could not parse arguments: ${parsed.parseErr.message} (raw: ${rawPreview})`,
      );
    } else {
      // Enforce the active skills' allowed-tools union before dispatch.
      // Soft-fail (set runErr) instead of throwing so the model sees the error
      // as a tool result and can self-correct — usually by loading a different
      // skill or giving up on the disallowed action. Workflow tools
      // (load_skill, coverage, read_*, ask, finding, browser_capture_*) are
      // always allowed regardless of which skill is active.
      const allowed = this.isToolAllowed(tc.function.name);
      if (!allowed.ok) {
        runErr = new Error(allowed.reason ?? 'tool blocked by active skills');
      } else {
        const veto =
          this.hookConfig.length > 0
            ? await runToolHooks(
                'pre-tool-call',
                tc.function.name,
                { EVENT: 'pre-tool-call', TOOL: tc.function.name, ARGS: parsed.argsJSON },
                this.hookConfig,
                signal,
              )
            : { blocked: false };
        if (veto.blocked) {
          runErr = new Error(veto.message ?? 'blocked by pre-tool-call hook');
        } else {
          executed = true;
          try {
            result = await this.tools.execute(tc.function.name, parsed.args, signal, this.prompter);
          } catch (err) {
            runErr = err instanceof Error ? err : new Error(String(err));
          }
        }
      }
    }
    const durationMs = Date.now() - start;
    let errStr = '';
    if (runErr) {
      errStr = runErr.message;
      result = `ERROR: ${errStr}`;
      logError('agent: tool failed', {
        tool: tc.function.name,
        duration_ms: durationMs,
        err: errStr,
      });
    }
    // Fire-and-forget: post-tool-call hooks never block the turn or fail the
    // call. Skips the pre-tool-call-veto/allowed-tools-block cases since
    // those never actually invoked the tool (executed stays false).
    if (this.hookConfig.length > 0 && executed) {
      void runToolHooks(
        'post-tool-call',
        tc.function.name,
        {
          EVENT: 'post-tool-call',
          TOOL: tc.function.name,
          ARGS: parsed.argsJSON,
          RESULT: result.length > 2000 ? `${result.slice(0, 2000)}…` : result,
          ERROR: errStr,
        },
        this.hookConfig,
        signal,
      );
    }
    return { result, errStr, durationMs };
  }

  /** Emit a tool result, apply any active-skill activation (load_skill), and
   *  append the tool message to both history and the working transcript. */
  private recordToolResult(
    tc: ToolCall,
    parsed: ParsedToolCall,
    res: ToolCallResult,
    emit: EventSink,
    working: Message[],
  ): void {
    // UI / transcript get the full body (collapse handled in the TUI).
    emit({
      type: 'tool-result',
      id: tc.id,
      name: tc.function.name,
      result: res.result,
      err: res.errStr,
      durationMs: res.durationMs,
    });

    // A successful tool call marks this turn as substantive, which gates the
    // end-of-turn intelligence learning (M — gate learnIntelligence).
    if (!res.errStr) this.turnExecutedTool = true;

    if (tc.function.name === 'load_skill' && !res.errStr) {
      const nm = typeof parsed.args.name === 'string' ? parsed.args.name : '';
      // Forked skill runs already applied the playbook in the child — only
      // activate allowlists when we actually injected the skill body here.
      const forked = parsed.args.fork === true;
      if (nm && !forked) {
        this.activeSkills.add(nm);
        emit({ type: 'skill-active', name: nm });
      }
    }

    if (tc.function.name === 'todo' && !res.errStr) {
      emit({ type: 'todo', items: this.getTodos() });
    }

    // LLM history gets a short preview when the body is huge; full text is
    // written under the session dir (tool-results/) for file_read if needed.
    const sessionDir = this.store?.path ? dirname(this.store.path) : null;
    const off = maybeOffloadToolResult(sessionDir, tc.id, tc.function.name, res.result);
    if (off.offloaded) {
      emit({
        type: 'decision',
        summary: `context · offloaded ${res.result.length} chars of ${tc.function.name} output to disk`,
      });
    }

    const toolMsg: Message = {
      role: 'tool',
      content: off.forHistory,
      toolCallID: tc.id,
      name: tc.function.name,
    };
    this.history.push(toolMsg);
    this.tokens.accountForPush(toolMsg);
    working.push(toolMsg);
  }

  /**
   * Surfaces the backend's own retry-on-rate-limit/5xx backoff to the user
   * instead of it being a silent multi-second pause — same idea as Claude
   * Code / Codex showing "retrying…" rather than looking hung or just
   * barreling on. The client still owns whether/how many times it retries;
   * this only makes an already-happening wait visible. Shared by every
   * client.chat()/chatStream() call site (the turn loop, /compact, and
   * auto-compact) so none of them silently swallow a retry.
   */
  private onRetryHook(emit: EventSink): (info: RetryInfo) => void {
    return (info) => {
      emit({
        type: 'retry',
        attempt: info.attempt,
        delayMs: info.delayMs,
        message: errMessage(info.err),
      });
    };
  }

  private async chat(
    req: ChatRequest,
    signal: AbortSignal,
    emit: EventSink,
  ): Promise<{ resp: Awaited<ReturnType<Client['chat']>>; streamed: boolean }> {
    const onRetry = this.onRetryHook(emit);
    if (this.streamingEnabled && isStreaming(this.client)) {
      const c: StreamingClient = this.client;
      // Strip thinking-block content from the live stream so a local model's
      // <think>…</think> reasoning never reaches the UI (H — streamed think-tag
      // leak). The filter holds back tags split across chunk boundaries; flush()
      // releases any safe tail at stream end. The final resp.message.content is
      // still run through stripThinkingTags by the caller for the history copy.
      const filter = new ThinkingStreamFilter();
      const resp = await c.chatStream(
        { ...req, stream: true },
        (delta) => {
          const visible = filter.push(delta);
          if (visible) emit({ type: 'assistant-delta', text: visible });
        },
        signal,
        onRetry,
      );
      const tail = filter.flush();
      if (tail) emit({ type: 'assistant-delta', text: tail });
      this.tokens.accountUsage(resp.usage);
      return { resp, streamed: true };
    }
    const resp = await this.client.chat(req, signal, onRetry);
    this.tokens.accountUsage(resp.usage);
    return { resp, streamed: false };
  }

  // ---------- internals ----------

  /**
   * Compact the history before the user's next message lands. The
   * autoCompact gating emits a system event so the user
   * sees what's happening, track consecutive failures so we don't loop
   * forever if compaction itself is broken. The user's pending message
   * is NOT included in the compaction prompt — runInner adds it after
   * we return.
   */
  private async autoCompact(signal: AbortSignal, emit: EventSink): Promise<void> {
    // Claude/Grok-style: one quiet success notice after the work, no
    // "triggered…" progress line that doubles the transcript noise.
    const tokensBefore = this.approxTokens();

    let compactionSucceeded = false;
    try {
      await this.compactInPlace(signal, emit);
      compactionSucceeded = true;
    } catch (err) {
      // A user cancellation (Esc) mid-compact throws the same AbortError
      // shape as a genuine compaction bug — without this check it counted
      // toward the same circuit breaker, so three legitimate cancellations
      // in a row could permanently disable auto-compact for the rest of the
      // session even though nothing about compaction itself is broken.
      if (signal.aborted || isAbortLikeError(err)) throw err;
      this.consecutiveCompactFailures += 1;
      logError('agent: auto-compact failed', {
        err: errMessage(err),
        consecutive: this.consecutiveCompactFailures,
      });
      const disabled =
        this.consecutiveCompactFailures >= MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES
          ? ' — auto-compact now DISABLED for this session; context may overflow. Use /clear or /compact to recover.'
          : '';
      emit({
        type: 'error',
        err: new Error(
          `auto-compact failed (${this.consecutiveCompactFailures}/${MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES}): ${errMessage(err)}${disabled}`,
        ),
      });
    }

    if (compactionSucceeded) {
      this.consecutiveCompactFailures = 0;
      const tokensAfter = this.approxTokens();
      emit({
        type: 'compact',
        summary: 'Context compacted',
        tokensBefore,
        tokensAfter,
        memoryItems: countMemoryItems(this.memory),
      });
    }
  }

  /**
   * The core compaction work without the event-emission ceremony that
   * the public compact() does. Sends the current history to the model
   * with a summarize-prompt, replaces history with [system, summary]
   * on success. Throws on any error so autoCompact can update the
   * failure counter. `emit`, when given, still surfaces a mid-wait retry
   * notice (see onRetryHook) — "no ceremony" means no progress narration,
   * not that a stalled network retry stays invisible.
   */
  private async compactInPlace(signal: AbortSignal, emit?: EventSink): Promise<void> {
    const historySnap = this.history.slice();
    if (historySnap.length <= 1) return;
    const req: ChatRequest = {
      model: this.client.model(),
      messages: [
        {
          role: 'system',
          content: COMPACTION_SYSTEM_PROMPT,
        },
        {
          role: 'user',
          content: boundedHistoryForCompaction(historySnap.slice(1)),
        },
      ],
    };
    const resp = await this.client.chat(req, signal, emit ? this.onRetryHook(emit) : undefined);
    this.tokens.accountUsage(resp.usage);
    const summary = stripThinkingTags(resp.message.content);
    if (!summary) {
      throw new Error(
        'compact produced an empty summary (the model may have spent the whole reply on thinking)',
      );
    }
    this.memory = mergeMemory(this.memory, summary);
    // Fold the merged checkpoint into the system prompt before seeding the
    // reset history, so cumulative state (not just this summary) rides forward.
    this.rebuildSystemPrompt();
    await this.learnIntelligence(summary);
    const pinned = formatPinnedMemory(this.memory);
    this.history = [
      { role: 'system', content: this.sysPrompt },
      {
        role: 'user',
        content: [
          'Session context was compacted (tool spam microcompacted, then summarized).',
          'Continue from pinned state + summary.',
          pinned ? `\n${pinned}\n` : '',
          `\n## Compact summary\n\n${summary}`,
        ].join('\n'),
      },
    ];
    this.tokens.recompute(this.history);
    await this.save();
    await this.saveContextSnapshot('auto compact');
  }

  // Last seen values to avoid pointless rebuilds of (potentially large) system prompt string.
  private _lastRebuildKey = '';

  private rebuildSystemPrompt(): void {
    const curated = this.memoryStore?.index() ?? '';
    const userProfile = this.userProfileStore?.load() ?? '';
    // Include enabled skill names so skill enable/disable forces a rebuild of
    // the advertised skills section.
    const skillNames = this.skills
      .listEnabled()
      .map((s) => s.name)
      .join(',');
    // Cheap key: changes to these drive visible prompt differences.
    const key = [
      this.thinking ? 't1' : 't0',
      this.toolingProfile,
      this.promptProfile,
      this.target.baseURL() || '',
      this.target.name() || '',
      this.engagement || '',
      curated,
      userProfile,
      this.memory ? `${this.memory.compactions}:${this.memory.updatedAt}` : 'nomem',
      skillNames,
    ].join('|');
    if (key === this._lastRebuildKey) return;
    this._lastRebuildKey = key;
    this.sysPrompt = buildSystemPrompt({
      skills: this.skills,
      thinkingEnabled: this.thinking,
      target: this.target,
      toolingProfile: this.toolingProfile,
      promptProfile: this.promptProfile,
      memory: this.memory,
      engagement: this.engagement,
      curatedMemory: curated,
      userProfile,
    });
  }

  private async save(): Promise<void> {
    if (!this.store) return;
    await this.store.save(this.history, this.target, this.memory);
  }

  /**
   * Save a durable curated-memory fact (the `#` quick-add / `/memory add`
   * backend). Rebuilds the system prompt and reseeds it into history so the new
   * fact's catalog entry is in context on the very next turn, then persists.
   * Returns the stored fact, or null when there's no store or the text is empty.
   */
  async addMemory(input: AddMemoryInput): Promise<MemoryFact | null> {
    if (this.running) {
      throw new Error('cannot save memory while a turn is in flight — cancel first with Esc');
    }
    if (!this.memoryStore) return null;
    const fact = this.memoryStore.add(input);
    if (!fact) return null;
    this.rebuildSystemPrompt();
    this.history = ensureSystemPrompt(this.history, this.sysPrompt);
    this.tokens.recompute(this.history);
    await this.save();
    return fact;
  }

  /** All curated memory facts (for /memory listing). */
  listCuratedMemory(): MemoryFact[] {
    return this.memoryStore?.list() ?? [];
  }

  /** Recall the curated facts relevant to this turn; emit a transparency note
   *  naming what was pulled in (mirrors how Claude Code surfaces recalled
   *  memories). Returns the prompt stanza, or '' when nothing matched. */
  private recallCuratedMemory(userMsg: string, emit: EventSink): string {
    if (!this.memoryStore) return '';
    const query = [userMsg, this.target.baseURL(), this.target.name()].join('\n');
    const facts = this.memoryStore.search(query, 5);
    if (facts.length === 0) return '';
    emit({ type: 'memory-recall', names: facts.map((f) => f.name) });
    return formatMemoryRecall(facts);
  }

  private buildIntelligenceContext(userMsg: string): string {
    if (!this.intelligence) return '';
    const query = [
      userMsg,
      this.target.baseURL(),
      this.target.name(),
      this.memory?.lastSummary ?? '',
      ...(this.memory?.objectives ?? []),
      ...(this.memory?.tested ?? []),
      ...(this.memory?.files ?? []),
      ...(this.memory?.todos ?? []),
    ].join('\n');
    const results = this.intelligence.search(query, 5).filter((r) => r.score >= 6);
    return formatIntelligenceContext(results);
  }

  private async learnIntelligence(summary: string): Promise<void> {
    if (!this.intelligence) return;
    const sourceSessionId = this.store?.id || undefined;
    try {
      await this.intelligence.learnFromText(summary, sourceSessionId);
    } catch (err) {
      logError('agent: intelligence learning failed', { err: errMessage(err) });
    }
  }
}

// ---------- helpers ----------

function ensureSystemPrompt(messages: Message[], prompt: string): Message[] {
  if (messages.length === 0 || messages[0]?.role !== 'system') {
    return [{ role: 'system', content: prompt }, ...messages];
  }
  if (messages[0].content === prompt) return messages;
  return [{ role: 'system', content: prompt }, ...messages.slice(1)];
}

/**
 * Repair dangling tool calls. The OpenAI/Kimi/etc. wire format requires every
 * assistant `tool_calls` entry to be answered by a following `role:'tool'`
 * message with the matching id before the next user/assistant turn. A turn
 * aborted (Esc) between emitting the assistant tool_calls and recording the
 * tool results leaves an unanswered call on disk; replaying it provokes a hard
 * 400 that wedges the session until /reset. This synthesizes a result for any
 * unanswered call so the history is always valid to resend. Returns a repaired
 * copy (the input is not mutated); a no-op when nothing is dangling.
 */
export function reconcileToolCalls(messages: Message[]): Message[] {
  const out: Message[] = [];
  for (let i = 0; i < messages.length; i += 1) {
    const m = messages[i];
    if (!m) continue;
    out.push(m);
    if (m.role !== 'assistant' || !m.toolCalls || m.toolCalls.length === 0) continue;

    // Consume the tool results that immediately follow this assistant message.
    const answered = new Set<string>();
    let j = i + 1;
    for (; j < messages.length; j += 1) {
      const next = messages[j];
      if (!next || next.role !== 'tool') break;
      if (next.toolCallID) answered.add(next.toolCallID);
      out.push(next);
    }
    // Synthesize a result for any call the aborted turn never answered. Also
    // repairs a call with a missing/empty id (some providers can emit this on
    // malformed output) — the `tc.id &&` guard this used to have meant exactly
    // that case, the one this function exists to fix, fell straight through
    // unrepaired and still provoked the H6 400 on the next resumed request.
    for (const tc of m.toolCalls) {
      if (!answered.has(tc.id ?? '')) {
        out.push({
          role: 'tool',
          content:
            'ERROR: tool call did not complete (the turn was interrupted before this tool produced a result).',
          toolCallID: tc.id,
          name: tc.function?.name,
        });
      }
    }
    i = j - 1;
  }
  return out;
}

/** Wrap the user-supplied event sink so signal-cancel never wedges callers. */
function makeSafeEmit(signal: AbortSignal, emit: EventSink): EventSink {
  return (e: AgentEvent) => {
    if (signal.aborted && e.type !== 'done' && e.type !== 'error') return;
    try {
      emit(e);
    } catch {
      // Swallow — the agent never depends on the UI keeping up.
    }
  };
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isAbortLikeError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  return err.name === 'AbortError' || msg === 'aborted' || msg.includes('operation was aborted');
}

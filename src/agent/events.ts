// Event types the agent emits during a run / compact. The TUI subscribes to the event stream
// and renders each one into the transcript.

export interface AssistantTextEvent {
  type: 'assistant-text';
  text: string;
}
export interface AssistantDeltaEvent {
  type: 'assistant-delta';
  text: string;
}
export interface ToolCallEvent {
  type: 'tool-call';
  id: string;
  name: string;
  args: Record<string, unknown>;
  argsJSON: string;
}
export interface ToolResultEvent {
  type: 'tool-result';
  id: string;
  name: string;
  result: string;
  err: string;
  durationMs: number;
}
export interface ErrorEvent {
  type: 'error';
  err: Error;
}
export interface CompactEvent {
  type: 'compact';
  summary: string;
  tokensBefore?: number;
  tokensAfter?: number;
  memoryItems?: number;
}
export interface DecisionEvent {
  type: 'decision';
  summary: string;
}
export interface SkillActiveEvent {
  type: 'skill-active';
  name: string;
}
export interface TodoItem {
  id: string;
  text: string;
  status: 'pending' | 'in_progress' | 'completed';
}
export interface TodoEvent {
  type: 'todo';
  items: TodoItem[];
}
export interface MemoryRecallEvent {
  type: 'memory-recall';
  names: string[];
}
export interface DoneEvent {
  type: 'done';
}
/**
 * Fired before the LLM client backs off and retries a transient failure
 * (rate limit, 5xx). Without this the retry wait (up to a few seconds,
 * doubling per attempt) is invisible — the turn just looks stalled. The TUI
 * surfaces it as a transcript notice so a slow turn reads as "backend is
 * rate-limiting, retrying" instead of "the agent silently hung/kept going".
 */
export interface RetryEvent {
  type: 'retry';
  attempt: number;
  delayMs: number;
  message: string;
}

/** Progress from a forked child agent (delegate_task / skill fork). */
export interface SubagentProgressEvent {
  type: 'subagent-progress';
  role: string;
  phase: 'start' | 'tool' | 'done';
  /** Tool name when phase === 'tool'. */
  tool?: string;
  step?: number;
  detail?: string;
}

export type AgentEvent =
  | AssistantTextEvent
  | AssistantDeltaEvent
  | ToolCallEvent
  | ToolResultEvent
  | ErrorEvent
  | CompactEvent
  | DecisionEvent
  | SkillActiveEvent
  | TodoEvent
  | MemoryRecallEvent
  | RetryEvent
  | SubagentProgressEvent
  | DoneEvent;

/** MaxStepsError is raised when the tool loop hits the per-turn budget.
 *  The TUI auto-continues quietly (Claude Code / Grok style) — no modal. */
export class MaxStepsError extends Error {
  readonly steps: number;
  constructor(steps: number) {
    super(`hit max steps (${steps}) without finishing`);
    this.name = 'MaxStepsError';
    this.steps = steps;
  }
}

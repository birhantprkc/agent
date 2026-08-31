// Memory Provider abstraction — an OPTIONAL external memory backend active
// alongside (never instead of) the built-in MEMORY.md / USER.md / curated-
// facts stack, modeled on the "one external provider at a time" pattern
// documented by other agentic CLIs (e.g. Hermes Agent's memory-providers
// feature). A provider gets to:
//   1. contribute a short status blurb to the system prompt,
//   2. prefetch relevant context for the user's message each turn,
//   3. record each turn for later recall,
//   4. expose its own tool(s) for agent-controlled search/store.
// All operations are best-effort: a provider must never throw out of
// recall()/record() in a way that breaks the turn — callers wrap both in a
// try/catch regardless, but a well-behaved provider degrades internally too.

import type { Tool } from '../tools/types.js';

export interface MemoryProviderEntry {
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
}

export interface MemoryProvider {
  name(): string;
  /** Short status text for the system prompt (e.g. entry count). '' for none. */
  systemPromptContext(): string;
  /** Relevant prior context for `query`, rendered as prompt text. '' if nothing matches. */
  recall(query: string, limit?: number): Promise<string>;
  /** Store one turn for later recall. Best-effort — errors are the caller's problem to catch. */
  record(entry: MemoryProviderEntry): Promise<void>;
  /** Tool(s) this provider exposes directly to the model (explicit search/store). */
  tools(): Tool[];
  /** Release any held resources (DB handles, etc.). Safe to call more than once. */
  close(): Promise<void>;
}

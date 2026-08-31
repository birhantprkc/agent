// Token bookkeeping, split out of the Agent class. Two independent things
// live here: an incremental /4-char *estimate* of history size (used for the
// StatusBar and the auto-compact gate — never sent anywhere), and the
// cumulative *actual* usage the backend reports per call (never estimated).
// Agent still owns *when* these are updated (every history push/replace,
// every chat response); this class only owns the numbers themselves.

import type { Message, Usage } from '../llm/types.js';
import type { Registry as ToolRegistry } from '../tools/registry.js';

export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  calls: number;
}

export class TokenAccountant {
  private tokenCount = 0;
  // Lazily-cached token estimate for the tool JSON schemas we send on every
  // request (req.tools). Keyed on the tool count so a registry change
  // recomputes it cheaply; -1 means "not yet computed".
  private toolsTokensCache = 0;
  private toolsTokensKey = -1;
  private usageTotals: UsageTotals = {
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    calls: 0,
  };

  /** Incremental estimate of the current history's token size. */
  approxTokens(): number {
    return this.tokenCount;
  }

  /** Cumulative token usage across every chat/compact call, as reported by
   *  the backend. Returns a fresh copy each call. */
  getUsage(): UsageTotals {
    return { ...this.usageTotals };
  }

  accountUsage(usage: Usage | undefined): void {
    if (!usage) return;
    this.usageTotals.inputTokens += usage.inputTokens;
    this.usageTotals.outputTokens += usage.outputTokens;
    this.usageTotals.cachedInputTokens += usage.cachedInputTokens ?? 0;
    this.usageTotals.calls += 1;
  }

  /** Recompute full token count from current history (used after bulk replaces). */
  recompute(history: readonly Message[]): void {
    this.tokenCount = 0;
    for (const m of history) this.tokenCount += this.msgTokens(m);
  }

  /** Incrementally add tokens for a newly appended message. */
  accountForPush(m: Message): void {
    this.tokenCount += this.msgTokens(m);
  }

  /**
   * Token estimate for the tool JSON schemas attached to every tool-enabled
   * request (req.tools). approxTokens() deliberately counts only history so
   * the StatusBar reading stays stable, but the auto-compact gate must
   * include this (~2-5k tokens) or it under-counts the real request size and
   * lets the window overflow. Cached and recomputed only when the tool count
   * changes.
   */
  toolsTokenEstimate(tools: ToolRegistry): number {
    const count = tools.names().length;
    if (count !== this.toolsTokensKey) {
      this.toolsTokensCache = Math.floor(JSON.stringify(tools.asLLMTools()).length / 4);
      this.toolsTokensKey = count;
    }
    return this.toolsTokensCache;
  }

  /** Size contribution of one message to the /4 token estimate. */
  private msgTokens(m: Message): number {
    let t = Math.floor(m.content.length / 4);
    for (const tc of m.toolCalls ?? []) {
      t += Math.floor((tc.function.name.length + tc.function.arguments.length) / 4);
    }
    return t;
  }
}

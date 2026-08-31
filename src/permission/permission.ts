// Permission prompter. The TUI implements a Prompter that pops a modal
// asking "allow once / allow session / deny" for each tool call that
// requires permission. Tools call `prompter.ask(...)` and wait for a Decision.
//
// Permission tiers (Claude Code-inspired spectrum, not just YOLO vs ask):
//   ask       — every requires-permission tool prompts (default)
//   auto-safe — auto-allow tools classified as read-only / observational;
//               still prompts for shell, writes, http mutations, scanners
//   yolo      — auto-allow everything (lab only); shell denylist still hard-blocks

export type Decision = 'allow-once' | 'allow-session' | 'deny';

/** Operator-facing permission mode. */
export type PermissionMode = 'ask' | 'auto-safe' | 'yolo';

export interface Request {
  tool: string;
  summary: string;
  detail: string;
  /** When true, an "allow session" decision is honored once but NOT cached. */
  noSessionCache?: boolean;
  /** Session-cache identity for (tool, cacheKey) approvals. */
  cacheKey?: string;
}

export interface Prompter {
  ask(req: Request, signal?: AbortSignal): Promise<Decision>;
}

/**
 * Tools treated as safe under `auto-safe` mode — observational / workflow
 * primitives that cannot mutate the operator machine or fire scanners.
 * Canonical Unix names; callers should pass canonicalToolName() results
 * when available. Also matches common PascalCase aliases.
 */
const AUTO_SAFE_TOOLS = new Set([
  'file_read',
  'filereadtool',
  'glob',
  'grep',
  'web_fetch',
  'web_search',
  'coverage',
  'load_skill',
  'read_payloads',
  'read_skill_file',
  'ask_user',
  'ask',
  'todo',
  'confirm_finding',
  'scope',
  'background_status',
  'update_user_profile',
  'memory_search',
  'browser_capture_status',
  'browser_capture_list',
  'browser_capture_get',
  'browser_capture_search',
  'browser_capture_cookies',
  'browser_capture_storage',
  'browser_capture_summary',
]);

/** True when this tool name is auto-approved under auto-safe mode. */
export function isAutoSafeTool(toolName: string): boolean {
  const key = toolName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '');
  if (AUTO_SAFE_TOOLS.has(key)) return true;
  // http GET-only is NOT inferred here — http tool does all methods; keep prompting.
  return false;
}

export function normalizePermissionMode(raw: string | undefined | null): PermissionMode {
  const v = (raw ?? '').trim().toLowerCase().replace(/_/g, '-');
  if (v === 'yolo' || v === 'dangerously-skip-permissions' || v === 'bypass') return 'yolo';
  if (v === 'auto-safe' || v === 'autosafe' || v === 'safe' || v === 'auto') return 'auto-safe';
  return 'ask';
}

/**
 * Wraps a Prompter with tiered auto-approval. Replaces the old YOLO-only
 * wrapper; yolo mode preserves --dangerously-skip-permissions behavior.
 */
export class TieredPrompter implements Prompter {
  private inner: Prompter;
  private mode: PermissionMode;

  constructor(inner: Prompter, initial: PermissionMode | boolean = 'ask') {
    this.inner = inner;
    // boolean kept for call-site compatibility with old `new YoloPrompter(p, true)`.
    this.mode = typeof initial === 'boolean' ? (initial ? 'yolo' : 'ask') : initial;
  }

  setMode(mode: PermissionMode): void {
    this.mode = mode;
  }

  getMode(): PermissionMode {
    return this.mode;
  }

  /** @deprecated use setMode('yolo' | 'ask' | 'auto-safe') */
  setYolo(on: boolean): void {
    this.mode = on ? 'yolo' : 'ask';
  }

  isYolo(): boolean {
    return this.mode === 'yolo';
  }

  async ask(req: Request, signal?: AbortSignal): Promise<Decision> {
    if (this.mode === 'yolo') return 'allow-once';
    if (this.mode === 'auto-safe' && isAutoSafeTool(req.tool)) return 'allow-once';
    return this.inner.ask(req, signal);
  }
}

/** @deprecated alias — prefer TieredPrompter */
export const YoloPrompter = TieredPrompter;

/** AlwaysAllow is for headless / test contexts. Production must use a real prompter. */
export class AlwaysAllow implements Prompter {
  async ask(_req: Request): Promise<Decision> {
    return 'allow-once';
  }
}

/** AlwaysDeny is for hermetic tests that should never trigger a tool run. */
export class AlwaysDeny implements Prompter {
  async ask(_req: Request): Promise<Decision> {
    return 'deny';
  }
}

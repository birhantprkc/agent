// Automation hooks. Config-driven (see config.ts's HookConfig) — a hook
// spawns `command` (argv-style, same no-shell-metachar safety as
// PluginConfig) with context passed as PENTESTERFLOW_HOOK_* env vars.
//
// pre-tool-call hooks can veto: a non-zero exit blocks the tool call and its
// stderr becomes the tool's error result, same shape as a denied permission
// today. Every other event (post-tool-call, session-start, finding-confirmed)
// is fire-and-forget from the caller's perspective — logged on failure,
// never blocks or fails the turn. Spawn primitive mirrors plugin.ts's
// runPlugin (argv array, no shell, bounded output, timeout-kill).

import { spawn } from 'node:child_process';
import type { HookConfig, HookEvent } from '../config/config.js';
import { warn } from '../logger/logger.js';
import { canonicalToolName } from '../tools/aliases.js';

const HOOK_TIMEOUT_MS = 5000;
const MAX_OUTPUT_BYTES = 16 * 1024;
const ENV_PREFIX = 'PENTESTERFLOW_HOOK_';

export interface HookVeto {
  blocked: boolean;
  message?: string;
}

/** Substring match against the CANONICAL tool name (not regex, so a bad
 *  matcher in config.json can't become a redos vector), so `matcher: "shell"`
 *  fires regardless of whether the model called it as `shell`, `bash`, or
 *  the PascalCase alias `BashTool` — same canonicalization the allowed-tools
 *  enforcer already applies (tools/aliases.ts). Absent matcher = fires
 *  always. */
function matchesHook(hook: HookConfig, toolName: string): boolean {
  if (!hook.matcher) return true;
  return canonicalToolName(toolName).toLowerCase().includes(hook.matcher.toLowerCase());
}

/**
 * Run every pre-tool-call/post-tool-call hook matching `toolName`. Awaited
 * synchronously by the caller (agent.ts) — a pre-tool-call veto must block
 * the actual tool execution, so this can't be fire-and-forget for that event.
 * post-tool-call hooks still run to completion here (deterministic), but the
 * caller is expected to invoke this via `void` for that event so a slow/failing
 * post hook can't delay the turn.
 */
export async function runToolHooks(
  event: Extract<HookEvent, 'pre-tool-call' | 'post-tool-call'>,
  toolName: string,
  ctx: Record<string, string>,
  hooks: readonly HookConfig[],
  signal: AbortSignal,
): Promise<HookVeto> {
  const matching = hooks.filter((h) => h.event === event && matchesHook(h, toolName));
  for (const hook of matching) {
    const { code, stderr } = await runHookCommand(hook, ctx, signal);
    if (code === 0) continue;
    if (event === 'pre-tool-call') {
      return {
        blocked: true,
        message: stderr.trim() || `hook '${hook.command}' blocked this call (exit ${code})`,
      };
    }
    warn('hook: post-tool-call hook failed', {
      command: hook.command,
      code,
      stderr: stderr.trim(),
    });
  }
  return { blocked: false };
}

/** session-start / finding-confirmed hooks: no veto, output routed through
 *  `notify` (the caller wires this to noticeHolder.publish) instead of
 *  blocking anything. */
export async function runNotifyHooks(
  event: Extract<HookEvent, 'session-start' | 'finding-confirmed'>,
  ctx: Record<string, string>,
  hooks: readonly HookConfig[],
  notify?: (text: string) => void,
): Promise<void> {
  const matching = hooks.filter((h) => h.event === event);
  const signal = new AbortController().signal;
  for (const hook of matching) {
    try {
      const { code, stdout, stderr } = await runHookCommand(hook, ctx, signal);
      if (code !== 0) {
        warn('hook: failed', { command: hook.command, code, stderr: stderr.trim() });
      } else if (stdout.trim()) {
        notify?.(stdout.trim());
      }
    } catch (err) {
      warn('hook: error', {
        command: hook.command,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

function runHookCommand(
  hook: HookConfig,
  ctx: Record<string, string>,
  parentSignal: AbortSignal,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const controller = new AbortController();
    const onParentAbort = () => controller.abort();
    if (parentSignal.aborted) controller.abort();
    else parentSignal.addEventListener('abort', onParentAbort, { once: true });

    const timer = setTimeout(() => controller.abort(), HOOK_TIMEOUT_MS);
    timer.unref?.();

    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const [k, v] of Object.entries(ctx)) env[`${ENV_PREFIX}${k}`] = v;

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(hook.command, hook.args, { signal: controller.signal, env });
    } catch (err) {
      clearTimeout(timer);
      parentSignal.removeEventListener('abort', onParentAbort);
      resolve({ code: 1, stdout: '', stderr: err instanceof Error ? err.message : String(err) });
      return;
    }

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutLen = 0;
    let stderrLen = 0;
    child.stdout?.on('data', (c: Buffer) => {
      if (stdoutLen < MAX_OUTPUT_BYTES) {
        stdoutChunks.push(c);
        stdoutLen += c.length;
      }
    });
    child.stderr?.on('data', (c: Buffer) => {
      if (stderrLen < MAX_OUTPUT_BYTES) {
        stderrChunks.push(c);
        stderrLen += c.length;
      }
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      parentSignal.removeEventListener('abort', onParentAbort);
      resolve({
        code: code ?? 1,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
      });
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      parentSignal.removeEventListener('abort', onParentAbort);
      resolve({ code: 1, stdout: '', stderr: err.message });
    });
  });
}

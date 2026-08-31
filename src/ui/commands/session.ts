// /exit, /quit, /yolo, /clear, /reset, /help — session lifecycle and the
// sectioned reference card.

import { Chalk } from 'chalk';
import type { Agent } from '../../agent/agent.js';
import type { Backend } from '../../config/config.js';
import { chalkLevel } from '../colorLevel.js';
import { SLASH_ITEMS } from '../slashItems.js';
import type { SlashContext } from './context.js';

export function handleExit(ctx: SlashContext): void {
  ctx.exit();
}

export function handleYolo(ctx: SlashContext): void {
  // `/yolo` toggles; `/yolo on|off` sets explicitly. Flips the gate and the
  // pill together via applyYolo. Prefer `/mode yolo|ask|auto-safe` for tiers.
  const arg = ctx.rest[0]?.toLowerCase();
  const next = arg === 'on' ? true : arg === 'off' ? false : !ctx.yolo;
  ctx.applyYolo(next);
  ctx.dispatch({
    type: 'append',
    entry: {
      kind: 'system',
      text: next
        ? 'YOLO on — every tool call will auto-approve. Authorized / lab targets only. (Use /mode auto-safe for read-only auto-approve.)'
        : 'YOLO off — tool calls will prompt again. (/mode ask|auto-safe|yolo)',
    },
  });
}

/** `/mode ask|auto-safe|yolo` — permission tiers. `/mode plan|act` — plan mode. */
export function handleMode(ctx: SlashContext): void {
  const arg = (ctx.rest[0] ?? '').toLowerCase();
  if (!arg || arg === 'show' || arg === 'status') {
    const plan = ctx.agent.isPlanMode() ? 'plan' : 'act';
    const perm = ctx.yolo ? 'yolo' : 'ask'; // full tier lives on prompter; UI tracks yolo
    ctx.dispatch({
      type: 'append',
      entry: {
        kind: 'system',
        text: `mode: work=${plan} · permissions=${perm} (set with /mode ask|auto-safe|yolo|plan|act)`,
      },
    });
    return;
  }
  if (arg === 'plan') {
    ctx.agent.setPlanMode(true);
    ctx.dispatch({
      type: 'append',
      entry: {
        kind: 'system',
        text: 'Plan mode ON — mutating tools blocked. Explore/read tools only. /mode act to leave.',
      },
    });
    return;
  }
  if (arg === 'act' || arg === 'work') {
    ctx.agent.setPlanMode(false);
    ctx.dispatch({
      type: 'append',
      entry: {
        kind: 'system',
        text: 'Plan mode OFF — full tools available again (subject to permissions).',
      },
    });
    return;
  }
  if (
    arg === 'yolo' ||
    arg === 'ask' ||
    arg === 'auto-safe' ||
    arg === 'autosafe' ||
    arg === 'safe'
  ) {
    const mode = arg === 'yolo' ? 'yolo' : arg === 'ask' ? 'ask' : 'auto-safe';
    ctx.applyPermissionMode?.(mode);
    ctx.dispatch({
      type: 'append',
      entry: {
        kind: 'system',
        text:
          mode === 'yolo'
            ? 'Permissions: YOLO — auto-approve all tools (lab only).'
            : mode === 'auto-safe'
              ? 'Permissions: auto-safe — read/observe tools auto-approve; shell/writes still prompt.'
              : 'Permissions: ask — prompt on every sensitive tool.',
      },
    });
    return;
  }
  ctx.dispatch({
    type: 'append',
    entry: {
      kind: 'error',
      text: 'usage: /mode ask|auto-safe|yolo|plan|act  (or /mode show)',
    },
  });
}

export function handleClear(ctx: SlashContext): void {
  ctx.clearScreen();
  ctx.dispatch({ type: 'clear' });
}

export function handleReset(ctx: SlashContext): void {
  // Check isRunning() up front rather than racing agent.reset()'s own guard —
  // clearScreen()/dispatch('clear') below are irreversible on-screen actions
  // that must not fire before we know the reset itself will actually happen.
  if (ctx.agent.isRunning()) {
    ctx.dispatch({
      type: 'append',
      entry: { kind: 'error', text: 'reset: a turn is already running — cancel it with Esc first' },
    });
    return;
  }
  void ctx.agent.reset();
  ctx.clearScreen();
  ctx.dispatch({ type: 'clear' });
  ctx.dispatch({ type: 'append', entry: { kind: 'system', text: 'conversation reset' } });
}

export function handleHelp(ctx: SlashContext): void {
  ctx.dispatch({
    type: 'append',
    entry: { kind: 'system', text: buildHelpText(ctx.agent, ctx.readConfig) },
  });
}

// ---------- /help — sectioned reference card ----------

// Standalone chalk instance pinned to truecolor so the help panel renders
// consistently regardless of the parent component's color inference. The
// transcript's role-color wrapper doesn't strip embedded ANSI, so accents
// survive into render.
const helpChalk = new Chalk({ level: chalkLevel() });

const KEYBINDINGS: Array<{ keys: string; desc: string }> = [
  { keys: '@<file>', desc: 'inline a file into the next turn (Tab opens a picker)' },
  {
    keys: '#<text>',
    desc: 'remember a durable fact (#!<text> = personal); recalled automatically',
  },
  { keys: '/', desc: 'open the slash-command menu' },
  { keys: '↑ / ↓', desc: 'walk session prompt history (on first / last line of input)' },
  { keys: 'Ctrl-N / Ctrl-J', desc: 'insert a newline inside the input' },
  { keys: 'Ctrl-A / Ctrl-E', desc: 'jump to start / end of the current line' },
  {
    keys: 'Home / End',
    desc: 'line start/end when typing; chat oldest/latest when input is empty',
  },
  { keys: 'PgUp / PgDn', desc: 'page the chat history (OpenTUI app viewport)' },
  {
    keys: 'mouse wheel',
    desc: 'scroll the chat (OpenTUI; Ink uses terminal scrollback)',
  },
  { keys: 'Ctrl-O', desc: 'reprint the latest truncated tool output in full' },
  { keys: 'Ctrl-Y', desc: 'copy the latest tool output / finding to the clipboard' },
  { keys: 'Ctrl-F', desc: 'cycle the transcript filter (all→compact→findings→errors→current)' },
  { keys: 'Esc', desc: 'cancel an in-flight turn / clear the input draft' },
  { keys: 'Ctrl-C', desc: 'quit pentesterflow' },
];

const TIPS: string[] = [
  'browser_capture_* tools surface live request / cookie / storage data once Burp/browser traffic is forwarding to a --burp bridge.',
  'coverage(action="untested", candidates=[...], vuln_classes=[...]) returns the (endpoint, param, class) tuples you have NOT tested yet — drive the next pass off of it.',
  'read_payloads(skill="<name>") pulls curated wordlists from disk. Skills like ssti / jwt ship pre-canned payload files in their payloads/ directory.',
  "Disabled skills are hidden from the agent's system prompt entirely. Use /skills to flip a skill back on without restarting.",
  '/model list opens an interactive backend model picker; /model <id> validates against the live catalog and suggests the closest match on typo.',
  '/memory intel stats shows learned background scenarios count; /memory intel clear wipes them (project/personal/all). Intelligence is auto-pruned but grows to the cap on long engagements.',
];

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

function buildHelpText(
  agent: Agent,
  readConfig: () => {
    backend: Backend;
    baseURL: string;
    apiKey: string;
    model: string;
    customModels?: string[];
  },
): string {
  const c = helpChalk;
  const cfg = readConfig();
  const enabled = agent.skills.listEnabled().length;
  const total = agent.skills.list().length;
  const target = agent.target.baseURL() || '(none — engagement unset)';
  const provider = cfg.backend || 'ollama';
  const model = cfg.model || agent.client.model() || '(unset)';
  const memory = agent.getMemoryStats();

  const out: string[] = [];

  out.push(c.bold.cyan('PentesterFlow') + c.gray(' — quick reference'));
  out.push(c.gray('─'.repeat(60)));
  out.push('');

  // Session ----------------------------------------------------------
  out.push(c.bold.white('Session'));
  out.push(`  ${c.gray('provider')}   ${c.white(provider)}`);
  out.push(`  ${c.gray('model')}      ${c.white(model)}`);
  out.push(`  ${c.gray('target')}     ${c.white(target)}`);
  out.push(
    `  ${c.gray('limits')}     max-steps ${c.white(String(agent.getMaxSteps()))}` +
      `  ·  auto-compact ${c.white(String(agent.getAutoCompactThreshold()))} tok` +
      `  ·  thinking ${c.white(agent.thinkingIsEnabled() ? 'on' : 'off')}`,
  );
  out.push(`  ${c.gray('skills')}     ${c.white(`${enabled}/${total}`)} enabled`);
  out.push(
    `  ${c.gray('memory')}     ${c.white(`${memory.items} items`)}` +
      `  ·  compactions ${c.white(String(memory.compactions))}`,
  );
  out.push('');

  // Slash commands ---------------------------------------------------
  out.push(c.bold.white('Slash commands'));
  // Width of "name args" column for alignment.
  const namelines = SLASH_ITEMS.map((s) => (s.args ? `${s.name} ${s.args}` : s.name));
  const w = Math.min(36, Math.max(...namelines.map((n) => n.length)) + 2);
  SLASH_ITEMS.forEach((s, i) => {
    const left = pad(namelines[i] ?? '', w);
    out.push(`  ${c.cyan(left)}${c.gray(s.description)}`);
  });
  out.push('');

  // Keybindings ------------------------------------------------------
  out.push(c.bold.white('Input & navigation'));
  const kw = Math.max(...KEYBINDINGS.map((k) => k.keys.length)) + 2;
  for (const k of KEYBINDINGS) {
    out.push(`  ${c.cyan(pad(k.keys, kw))}${c.gray(k.desc)}`);
  }
  out.push('');

  // Tips -------------------------------------------------------------
  out.push(c.bold.white('Tips'));
  for (const t of TIPS) {
    // Wrap each tip to ~88 cols, manually so we don't blow the terminal
    // layout. Words only.
    const words = t.split(' ');
    let line = '  • ';
    for (const w of words) {
      if (line.length + w.length + 1 > 88) {
        out.push(c.gray(line));
        line = '    ';
      }
      line += `${w} `;
    }
    if (line.trim().length > 0) out.push(c.gray(line.trimEnd()));
  }
  out.push('');
  out.push(c.gray('Type ') + c.cyan('/') + c.gray(' for the live command menu.'));

  return out.join('\n');
}

// Slash-command catalog. Single source of truth for the menu, the
// completion logic, and the dispatcher in App.tsx.

export interface SlashItem {
  name: string; // includes leading slash, e.g. "/help"
  args?: string; // arg hint shown next to the name
  description: string;
}

export const SLASH_ITEMS: SlashItem[] = [
  { name: '/help', description: 'show keybindings + slash commands' },
  {
    name: '/provider',
    description: 'interactive picker: select LLM backend, then a model from its catalog',
  },
  {
    name: '/model',
    args: '<id|list|custom>',
    description: 'switch model (any custom id OK), list catalog, or enter a custom id',
  },
  {
    name: '/config',
    args: '[show|path|example]',
    description: 'show path + readable config.json (redacted), or print an annotated example',
  },
  { name: '/plan', args: '[objective]', description: 'plan-only mode without tools' },
  { name: '/next', args: '[objective]', description: 'coverage-driven next test suggestions' },
  { name: '/compact', description: 'summarize conversation into persistent session memory' },
  {
    name: '/memory',
    args: '[add <text>|list|forget <text>|clear|provider]',
    description:
      'saved + session memory; add/list curated facts (or #<text>), forget/clear/provider',
  },
  { name: '/snapshot', description: 'write the current redacted context snapshot now' },
  {
    name: '/user',
    args: '[add <text>|clear]',
    description: 'view/add/clear what the agent has learned about you (~/.pentesterflow/USER.md)',
  },
  {
    name: '/report',
    args: '[markdown|sarif]',
    description: 'export all confirmed findings to one report file (default markdown)',
  },
  { name: '/burp', args: '[port]', description: 'start the local Burp/PentesterFlow listener' },
  { name: '/jobs', description: 'list background shell jobs (running / finished)' },
  { name: '/clear', description: 'clear the on-screen transcript only' },
  { name: '/reset', description: 'clear conversation + saved session' },
  {
    name: '/target',
    args: '<url>',
    description: 'pin an engagement base URL; http tool defaults to it (no arg clears)',
  },
  {
    name: '/scope',
    args: '[add|deny|remove|list|clear] <pattern>',
    description:
      'engagement host allowlist for http/web_fetch; empty scope enforces nothing (default)',
  },
  {
    name: '/skills',
    args: '[enable|disable|new <name>]',
    description: 'list/toggle skills, or scaffold a new one (/skills new <name>)',
  },
  {
    name: '/maxsteps',
    args: '<n>',
    description: 'per-turn tool budget before auto-continue (default 20)',
  },
  { name: '/thinking', args: 'on|off', description: 'toggle the show-thinking system directive' },
  { name: '/update', args: '[version]', description: 'fetch GitHub release updates and install' },
  { name: '/yolo', args: '[on|off]', description: 'toggle YOLO auto-approve (lab only)' },
  {
    name: '/mode',
    args: 'ask|auto-safe|yolo|plan|act',
    description: 'permission tier (ask/auto-safe/yolo) or plan/act work mode',
  },
  { name: '/act', description: 'exit plan mode (alias for /mode act)' },
  {
    name: '/compact-mode',
    args: '[on|off]',
    description: 'toggle tighter transcript spacing (no blank lines between entries)',
  },
  { name: '/exit', description: 'quit pentesterflow' },
];

/**
 * Filter a catalog by what the user has typed so far. Empty input
 * returns the full list; `/he` returns `/help`; partial commands match
 * by prefix on the command name (case-insensitive). `extras` is appended
 * to SLASH_ITEMS so callers can splice in dynamic items (e.g. one
 * `/<skill-name>` entry per loaded skill) without mutating the static
 * catalog.
 *
 * Matching is prefix-first: `/he` → `/help`. When NOTHING prefix-matches we
 * fall back to a fuzzy subsequence match on the chars after the slash, so a
 * typo or a match-anywhere query still finds the command (`/povider` →
 * `/provider`, `/grql` → a `/graphql` skill) instead of an empty menu.
 */
export function filterSlash(input: string, extras: SlashItem[] = []): SlashItem[] {
  const trimmed = input.trim();
  if (!trimmed.startsWith('/')) return [];
  // If the user already finished a slash command and is typing args
  // (whitespace after the command), suppress the menu.
  if (/\s/.test(trimmed.slice(1))) return [];
  const all = extras.length > 0 ? [...SLASH_ITEMS, ...extras] : SLASH_ITEMS;
  const needle = trimmed.toLowerCase();
  if (needle === '/') return all;
  const prefix = all.filter((s) => s.name.toLowerCase().startsWith(needle));
  if (prefix.length > 0) return prefix;
  // Fuzzy fallback: subsequence of the typed chars (sans leading slash)
  // anywhere in the command name.
  const chars = needle.slice(1);
  if (!chars) return [];
  return all.filter((s) => isSubsequence(chars, s.name.toLowerCase().slice(1)));
}

/** True if every char of `needle` appears in `hay` in order (not necessarily
 *  contiguous) — the classic fuzzy-finder subsequence test. */
function isSubsequence(needle: string, hay: string): boolean {
  let i = 0;
  for (let j = 0; j < hay.length && i < needle.length; j += 1) {
    if (hay[j] === needle[i]) i += 1;
  }
  return i === needle.length;
}

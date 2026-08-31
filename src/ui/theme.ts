// Claude Code–style design tokens for the PentesterFlow TUI.
//
// Palette intent (mirrors the Claude Code CLI's own theme): one unified
// coral/terracotta accent (Anthropic's brand color, #D97757) for BOTH brand
// identity and focus/selection — Claude Code doesn't split those into two
// hues the way the previous GrokNight-inspired palette did (magenta brand +
// cyan focus).
//   brand/focus (coral) — product identity, user prompt, selection, active
//                          menus, modal borders, primary chrome
//   muted       (gray)  — secondary text, footers, idle borders
//
// Keep this module free of React so tests and non-UI code can import tokens.

const CLAUDE_CORAL = '#D97757';

export const theme = {
  /** Product / user accent — Anthropic's Claude brand coral. */
  brand: CLAUDE_CORAL,
  /** Focus / selection — active menus, modal frames. Same hue as brand. */
  focus: CLAUDE_CORAL,
  /** Primary readable text. */
  text: 'white' as const,
  /** Secondary / dim copy. */
  muted: 'gray' as const,
  success: 'green' as const,
  warning: 'yellow' as const,
  error: 'red' as const,
  /** YOLO / SuperMode badge (amber, degrades under 16-color). */
  superMode: '#ff8700',

  border: {
    brand: CLAUDE_CORAL,
    focus: CLAUDE_CORAL,
    idle: 'gray' as const,
  },

  glyphs: {
    /** Brand mark on the home banner (Grok uses diamond-ish marks). */
    brand: '◆',
    /** Selected row caret in menus. */
    caret: '›',
    /** User prompt prefix. */
    prompt: '❯',
    /** End-of-line cursor. */
    cursor: '▌',
    /** Directory in @file picker. */
    dir: '▸',
    /** File in @file picker. */
    file: '·',
    /** Tool call bullet (transcript). */
    tool: '◆',
    /** Tool result rail. */
    result: '⎿',
  },
} as const;

export type Theme = typeof theme;

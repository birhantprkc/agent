// /target, /scope, /maxsteps, /thinking, /config — small in-memory
// agent-state toggles and config-file helpers.

import {
  EXAMPLE_CONFIG_JSON,
  configPath,
  defaultConfig,
  formatConfig,
  load,
} from '../../config/config.js';
import { apply as redact } from '../../redact/redact.js';
import type { SlashContext } from './context.js';

export function handleTarget(ctx: SlashContext): void {
  const { agent, rest, dispatch } = ctx;
  const u = rest.join(' ').trim();
  if (!u) {
    void agent
      .clearTarget()
      .then(() => dispatch({ type: 'append', entry: { kind: 'system', text: 'target cleared' } }))
      .catch((err: unknown) =>
        dispatch({ type: 'append', entry: { kind: 'error', text: `/target: ${String(err)}` } }),
      );
  } else {
    void agent
      .setTargetBaseURL(u)
      .then(() =>
        dispatch({ type: 'append', entry: { kind: 'system', text: `target set to ${u}` } }),
      )
      .catch((err: unknown) =>
        dispatch({ type: 'append', entry: { kind: 'error', text: `/target: ${String(err)}` } }),
      );
  }
}

// Delegates to the `scope` tool directly (agent.tools.execute) rather than
// duplicating ScopeStore access here — same tool the model calls, so the
// operator and the model always see the exact same scope state.
export function handleScope(ctx: SlashContext): void {
  const { agent, rest, dispatch } = ctx;
  const [actionArg, ...patternParts] = rest;
  const action = actionArg || 'list';
  const pattern = patternParts.join(' ').trim();
  void agent.tools
    .execute('scope', { action, pattern }, new AbortController().signal, agent.prompter)
    .then((out) => dispatch({ type: 'append', entry: { kind: 'system', text: out } }))
    .catch((err: unknown) =>
      dispatch({ type: 'append', entry: { kind: 'error', text: `/scope: ${String(err)}` } }),
    );
}

export function handleMaxSteps(ctx: SlashContext): void {
  const { agent, rest, dispatch } = ctx;
  const n = Number.parseInt(rest[0] ?? '', 10);
  if (Number.isFinite(n) && n > 0) {
    agent.setMaxSteps(n);
    dispatch({ type: 'append', entry: { kind: 'system', text: `max steps set to ${n}` } });
  } else {
    dispatch({ type: 'append', entry: { kind: 'error', text: 'usage: /maxsteps <n>' } });
  }
}

export function handleCompactModeToggle(ctx: SlashContext): void {
  const { rest, dispatch, compactMode, applyCompactMode } = ctx;
  const arg = rest[0]?.toLowerCase();
  const next = arg === 'on' ? true : arg === 'off' ? false : !compactMode;
  applyCompactMode(next);
  dispatch({
    type: 'append',
    entry: {
      kind: 'system',
      text: next
        ? 'compact mode on — no blank line between transcript entries.'
        : 'compact mode off — back to the default spacing.',
    },
  });
}

export function handleThinking(ctx: SlashContext): void {
  const { agent, rest, dispatch } = ctx;
  const v = (rest[0] ?? '').toLowerCase();
  if (v !== 'on' && v !== 'off') {
    dispatch({ type: 'append', entry: { kind: 'error', text: 'usage: /thinking on|off' } });
    return;
  }
  void agent.setThinkingEnabled(v === 'on');
  dispatch({ type: 'append', entry: { kind: 'system', text: `thinking ${v}` } });
}

/**
 * /config [path|show|example]
 *   (none)/show — print the on-disk path + a redacted, compact JSON view
 *   path        — path only
 *   example     — annotated skeleton operators can copy
 */
export function handleConfig(ctx: SlashContext): void {
  const { rest, dispatch, readConfig } = ctx;
  const sub = (rest[0] ?? 'show').toLowerCase();
  const path = configPath();

  if (sub === 'path') {
    dispatch({ type: 'append', entry: { kind: 'system', text: `config file: ${path}` } });
    return;
  }
  if (sub === 'example') {
    dispatch({
      type: 'append',
      entry: {
        kind: 'system',
        text: [
          'Example ~/.pentesterflow/config.json (JSONC comments OK on load):',
          '',
          EXAMPLE_CONFIG_JSON.trimEnd(),
        ].join('\n'),
      },
    });
    return;
  }
  if (sub !== 'show' && sub !== '') {
    dispatch({
      type: 'append',
      entry: { kind: 'error', text: 'usage: /config [show|path|example]' },
    });
    return;
  }

  // Prefer the live in-memory view (what /provider just set) over a re-read
  // that could race a concurrent save. Merge into a full Config for formatting.
  const live = readConfig();
  let diskNote = '';
  try {
    load(); // validates the file is still parseable
  } catch (err) {
    diskNote = `\n(on-disk file has a problem: ${(err as Error).message})`;
  }
  const full = defaultConfig();
  full.backend = live.backend;
  full.model = live.model;
  full.base_url = redact(live.baseURL);
  full.api_key = live.apiKey;
  if (live.customModels) full.custom_models = [...live.customModels];

  const redacted = { ...full, api_key: full.api_key ? '***' : '' };
  const body = formatConfig(redacted).trimEnd();
  dispatch({
    type: 'append',
    entry: {
      kind: 'system',
      text: [
        `config file: ${path}`,
        'edit with any editor; JSONC comments (// …) are accepted on load.',
        'empty defaults are omitted when pentesterflow saves.',
        '',
        body,
        diskNote,
      ]
        .filter(Boolean)
        .join('\n'),
    },
  });
}

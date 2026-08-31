// /memory [add|list|forget|intel|provider|clear] and /user [add|clear] —
// read/mutate the agent's curated-memory, session-memory, intelligence, and
// user-profile stores.

import type { SlashContext } from './context.js';

export function handleMemory(ctx: SlashContext): void {
  const { agent, rest, dispatch } = ctx;
  const sub = (rest[0] ?? '').toLowerCase();
  if (sub === 'clear') {
    void agent
      .clearMemory()
      .then(() =>
        dispatch({ type: 'append', entry: { kind: 'system', text: 'session memory cleared' } }),
      )
      .catch((err: unknown) =>
        dispatch({
          type: 'append',
          entry: { kind: 'error', text: `/memory clear: ${String(err)}` },
        }),
      );
    return;
  }
  if (sub === 'forget') {
    const query = rest.slice(1).join(' ').trim();
    if (!query) {
      dispatch({ type: 'append', entry: { kind: 'error', text: 'usage: /memory forget <text>' } });
      return;
    }
    void agent
      .forgetMemory(query)
      .then((removed) =>
        dispatch({
          type: 'append',
          entry: {
            kind: 'system',
            text: removed.length
              ? `forgot ${removed.length} item${removed.length === 1 ? '' : 's'}:\n${removed.map((r) => `- ${r}`).join('\n')}`
              : `no memory items matched "${query}"`,
          },
        }),
      )
      .catch((err: unknown) =>
        dispatch({
          type: 'append',
          entry: { kind: 'error', text: `/memory forget: ${String(err)}` },
        }),
      );
    return;
  }
  if (sub === 'add') {
    const text = rest.slice(1).join(' ').trim();
    if (!text) {
      dispatch({
        type: 'append',
        entry: { kind: 'error', text: 'usage: /memory add <text>  (or use #<text>)' },
      });
      return;
    }
    void agent
      .addMemory({ text })
      .then((fact) =>
        dispatch({
          type: 'append',
          entry: fact
            ? { kind: 'system', text: `remembered (${fact.scope}/${fact.type}): ${fact.name}` }
            : { kind: 'error', text: 'memory not saved' },
        }),
      )
      .catch((err: unknown) =>
        dispatch({
          type: 'append',
          entry: { kind: 'error', text: `memory save failed: ${String(err)}` },
        }),
      );
    return;
  }
  if (sub === 'list') {
    const facts = agent.listCuratedMemory();
    dispatch({
      type: 'append',
      entry: {
        kind: 'system',
        text: facts.length
          ? `Saved memory (${facts.length}):\n${facts.map((f) => `- [${f.type}] ${f.name} — ${f.description}`).join('\n')}`
          : 'no saved memory yet — add one with #<text> or /memory add <text>',
      },
    });
    return;
  }
  if (sub === 'intel') {
    const action = (rest[1] ?? 'stats').toLowerCase();
    if (action === 'clear') {
      const rawScope = (rest[2] ?? 'all').toLowerCase();
      // clearIntelligence falls through any unrecognized scope string to the
      // personal store (`t === 'project' ? projectPath : personalPath`) — a
      // typo like "personel" or "proj" used to silently wipe the personal
      // store instead of erroring. Validate against the exact allowed set.
      if (rawScope !== 'project' && rawScope !== 'personal' && rawScope !== 'all') {
        dispatch({
          type: 'append',
          entry: {
            kind: 'error',
            text: `unknown scope "${rawScope}" — use /memory intel clear [project|personal|all]`,
          },
        });
        return;
      }
      const which = rawScope as 'project' | 'personal' | 'all';
      void agent.clearIntelligence(which).then(() =>
        dispatch({
          type: 'append',
          entry: { kind: 'system', text: `intelligence cleared (${which})` },
        }),
      );
      return;
    }
    if (action === 'stats' || action === 'list') {
      const s = agent.getIntelligenceStats();
      dispatch({
        type: 'append',
        entry: {
          kind: 'system',
          text: `Intelligence (learned scenarios) — project: ${s.project} · personal: ${s.personal}\n(auto-capped + pruned to most recent per scope; use /memory intel clear [project|personal|all] to wipe)`,
        },
      });
      return;
    }
    dispatch({
      type: 'append',
      entry: { kind: 'error', text: 'usage: /memory intel [stats|clear [project|personal|all]]' },
    });
    return;
  }
  if (sub === 'provider') {
    const providerName = agent.getMemoryProviderName();
    dispatch({
      type: 'append',
      entry: {
        kind: 'system',
        text: providerName
          ? `External memory provider: ${providerName} (active alongside built-in memory)`
          : 'No external memory provider active. Set memory_provider in ~/.pentesterflow/config.json (currently: "sqlite" or "off").',
      },
    });
    return;
  }
  // Default view: durable curated facts first, then the session checkpoint.
  const facts = agent.listCuratedMemory();
  const curated = facts.length
    ? `Saved memory (${facts.length}):\n${facts.map((f) => `- [${f.type}] ${f.name} — ${f.description}`).join('\n')}`
    : 'No saved memory yet. Add one with #<text> or /memory add <text>.';
  dispatch({
    type: 'append',
    entry: { kind: 'system', text: `${curated}\n\n${agent.formatMemory()}` },
  });
}

export function handleUser(ctx: SlashContext): void {
  const { agent, rest, dispatch } = ctx;
  const sub = (rest[0] ?? '').toLowerCase();
  if (sub === 'clear') {
    void agent
      .clearUserProfile()
      .then(() =>
        dispatch({ type: 'append', entry: { kind: 'system', text: 'user profile cleared' } }),
      )
      .catch((err: unknown) =>
        dispatch({ type: 'append', entry: { kind: 'error', text: `/user clear: ${String(err)}` } }),
      );
    return;
  }
  if (sub === 'add') {
    const text = rest.slice(1).join(' ').trim();
    if (!text) {
      dispatch({ type: 'append', entry: { kind: 'error', text: 'usage: /user add <text>' } });
      return;
    }
    // addUserProfileNote() itself has no isRunning guard (the
    // update_user_profile tool calls it mid-turn by design), so the
    // user-typed path checks here instead of racing a concurrent
    // /compact or turn that could replace history right after this appends.
    if (agent.isRunning()) {
      dispatch({
        type: 'append',
        entry: { kind: 'error', text: '/user add: a turn is already running — try again after' },
      });
      return;
    }
    void agent
      .addUserProfileNote(text)
      .then(() =>
        dispatch({
          type: 'append',
          entry: { kind: 'system', text: `saved to user profile: ${text}` },
        }),
      )
      .catch((err: unknown) =>
        dispatch({ type: 'append', entry: { kind: 'error', text: `/user add: ${String(err)}` } }),
      );
    return;
  }
  const profile = agent.getUserProfile();
  dispatch({
    type: 'append',
    entry: {
      kind: 'system',
      text: profile
        ? `What the agent has learned about you:\n${profile}`
        : 'Nothing saved yet — the agent learns this over time, or add one now with /user add <text>.',
    },
  });
}

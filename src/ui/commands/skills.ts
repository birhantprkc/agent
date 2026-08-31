// /skills [enable|disable|new <name>] and the `/<skill-name>` direct-invoke
// fallback (any unrecognized `/word` that matches a loaded skill name).

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { renderSkillTemplate } from '../../skills/template.js';
import type { SlashContext } from './context.js';

/**
 * /skills — list / enable / disable. Without args, prints the loaded
 * skills with their on/off state. `/skills <name>` toggles. Explicit
 * `/skills enable <name>` and `/skills disable <name>` are also accepted.
 * Persistence to ~/.pentesterflow/config.json is delegated to the
 * persistDisabledSkills callback wired by the CLI.
 */
export function handleSkills(ctx: SlashContext): void {
  const { agent, rest, dispatch, persistDisabledSkills, onSkillCreated } = ctx;
  const all = agent.skills.list();
  if (all.length === 0) {
    dispatch({ type: 'append', entry: { kind: 'system', text: '/skills: no skills are loaded' } });
    return;
  }

  // No args → open the interactive picker. SkillsModal reads the live
  // registry and dispatches its own toggles through agent.setSkillEnabled
  // + persistDisabledSkills.
  if (rest.length === 0) {
    dispatch({ type: 'set-skills-picker', open: true });
    return;
  }

  // /skills new <name> — scaffold a skill under
  // ./.pentesterflow/skills/<name>/SKILL.md (an auto-discovered dir), then
  // hot-load it so it's usable immediately via /<name>.
  if (rest[0] === 'new') {
    const name = (rest[1] ?? '').trim();
    if (!/^[a-z0-9-]+$/.test(name)) {
      dispatch({
        type: 'append',
        entry: {
          kind: 'error',
          text: 'usage: /skills new <name>  (lowercase, letters/digits/hyphens)',
        },
      });
      return;
    }
    const skillsRoot = resolve(process.cwd(), '.pentesterflow', 'skills');
    const dir = join(skillsRoot, name);
    const file = join(dir, 'SKILL.md');
    if (existsSync(file)) {
      dispatch({
        type: 'append',
        entry: { kind: 'error', text: `/skills new: a skill already exists at ${file}` },
      });
      return;
    }
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(file, renderSkillTemplate(name), 'utf8');
      // Load it now so the user doesn't have to restart; future edits
      // hot-reload via the dir watcher.
      agent.skills.loadDir(skillsRoot);
      agent.rebuildFromSkills();
      // Tell the CLI to start watching this dir so future edits hot-reload
      // even if .pentesterflow/skills didn't exist at startup.
      onSkillCreated?.(skillsRoot);
      dispatch({
        type: 'append',
        entry: {
          kind: 'system',
          text: `created skill "${name}" at ${file}\nedit it (hot-reloads on save), then invoke with /${name}.`,
        },
      });
    } catch (err) {
      dispatch({
        type: 'append',
        entry: { kind: 'error', text: `/skills new: ${(err as Error).message}` },
      });
    }
    return;
  }

  // Parse explicit/implicit verb.
  let verb: 'enable' | 'disable' | 'toggle';
  let name: string;
  if (rest[0] === 'enable' || rest[0] === 'disable') {
    verb = rest[0];
    name = rest.slice(1).join(' ').trim();
  } else {
    verb = 'toggle';
    name = rest.join(' ').trim();
  }
  if (!name) {
    dispatch({
      type: 'append',
      entry: { kind: 'error', text: 'usage: /skills <name>  ·  /skills enable|disable <name>' },
    });
    return;
  }
  if (!agent.skills.has(name)) {
    dispatch({
      type: 'append',
      entry: {
        kind: 'error',
        text: `/skills: unknown skill "${name}". Run /skills to list available skills.`,
      },
    });
    return;
  }
  const targetEnabled =
    verb === 'enable' ? true : verb === 'disable' ? false : agent.skills.isDisabled(name); // toggle → enable if disabled
  void agent
    .setSkillEnabled(name, targetEnabled)
    .then(async (changed) => {
      if (!changed) {
        dispatch({
          type: 'append',
          entry: {
            kind: 'system',
            text: `/skills: ${name} already ${targetEnabled ? 'enabled' : 'disabled'}`,
          },
        });
        return;
      }
      // Persist the new disabled set across restarts.
      if (persistDisabledSkills) {
        try {
          await persistDisabledSkills(agent.skills.disabledNames());
        } catch (err) {
          dispatch({
            type: 'append',
            entry: {
              kind: 'error',
              text: `/skills: state changed but could not persist: ${(err as Error).message}`,
            },
          });
          return;
        }
      }
      dispatch({
        type: 'append',
        entry: {
          kind: 'system',
          text: `/skills: ${name} ${targetEnabled ? 'enabled' : 'disabled'}`,
        },
      });
    })
    .catch((err: unknown) => {
      dispatch({
        type: 'append',
        entry: { kind: 'error', text: `/skills: ${(err as Error).message}` },
      });
    });
}

/**
 * Fallback for any `/word` that didn't match a known command: shorthand for
 * "load this skill explicitly, the next turn applies it." Returns false
 * (unhandled) when `word` isn't a loaded skill name, so the caller can fall
 * through to "unknown command".
 */
export function handleSkillDirectInvoke(ctx: SlashContext, cmd: string | undefined): boolean {
  const { agent, dispatch } = ctx;
  const skillName = cmd?.slice(1) ?? '';
  if (!skillName || !agent.skills.has(skillName)) return false;
  void agent
    .injectSkill(skillName)
    .then((n) =>
      dispatch({
        type: 'append',
        entry: { kind: 'system', text: `loaded /${n} — it'll apply to your next prompt.` },
      }),
    )
    .catch((err: unknown) =>
      dispatch({
        type: 'append',
        entry: { kind: 'error', text: `/${skillName}: ${(err as Error).message}` },
      }),
    );
  return true;
}

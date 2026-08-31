import type { Prompter } from '../permission/permission.js';
import type { Tool } from '../tools/types.js';
import { type Registry, materializeSkillBody } from './registry.js';

/** Optional skill-fork runner: execute skill methodology in a child agent
 *  and return a compressed summary (keeps parent context clean). */
export type SkillForkRunner = (
  skillName: string,
  objective: string | undefined,
  signal: AbortSignal,
) => Promise<string>;

export class LoadSkillTool implements Tool {
  private readonly reg: Registry;
  private readonly forkRunner?: SkillForkRunner;

  constructor(reg: Registry, forkRunner?: SkillForkRunner) {
    this.reg = reg;
    this.forkRunner = forkRunner;
  }

  name(): string {
    return 'load_skill';
  }

  description(): string {
    return [
      'Load a named skill playbook (methodology, payloads, constraints).',
      'Call when a listed skill matches the task.',
      'Set fork=true to run the skill in a child agent and get back only a summary (preferred for large playbooks so parent context stays clean).',
    ].join(' ');
  }

  schema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: "Skill name (matches the 'name' field listed in the system prompt).",
        },
        fork: {
          type: 'boolean',
          description:
            'If true, run the skill in a forked child agent and return a summary instead of injecting the full playbook into this conversation.',
        },
        objective: {
          type: 'string',
          description:
            'When fork=true, optional focused objective for the child (defaults to skill description).',
        },
      },
      required: ['name'],
    };
  }

  requiresPermission(): boolean {
    return false;
  }

  async run(args: Record<string, unknown>, signal: AbortSignal, _p: Prompter): Promise<string> {
    const nm = typeof args.name === 'string' ? args.name : '';
    if (!nm) throw new Error('name is required');
    const s = this.reg.get(nm);
    if (!s) {
      const names = this.reg
        .listEnabled()
        .filter((sk) => !sk.disableModelInvocation)
        .map((sk) => sk.name)
        .join(', ');
      throw new Error(`unknown skill "${nm}". Available: ${names}`);
    }
    if (this.reg.isDisabled(nm)) {
      throw new Error(
        `skill "${nm}" is disabled. The user must enable it via /skills enable ${nm} before it can be loaded.`,
      );
    }
    if (s.disableModelInvocation) {
      throw new Error(
        `skill "${nm}" is marked disable-model-invocation: true. Only the user can load it via /${nm}.`,
      );
    }
    const fork = args.fork === true;
    if (fork) {
      if (!this.forkRunner) {
        throw new Error('skill fork is not available in this runtime — load without fork=true');
      }
      const objective =
        typeof args.objective === 'string' && args.objective.trim()
          ? args.objective.trim()
          : `Execute the "${nm}" skill methodology for the current engagement objective.`;
      return this.forkRunner(nm, objective, signal);
    }
    return materializeSkillBody(s);
  }
}

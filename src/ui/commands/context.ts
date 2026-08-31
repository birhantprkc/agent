// Shared dependency bag for every slash-command handler. handleSlash
// (index.ts) builds one of these per invocation from the App component's
// props/callbacks and passes it to whichever handler the command name
// resolves to — the handlers themselves take no positional parameters
// beyond this, so adding a new command dependency doesn't ripple through
// every existing handler's signature.

import type { Agent, AgentRunOptions } from '../../agent/agent.js';
import type { Backend } from '../../config/config.js';
import type { ApplyProvider, PersistDisabledSkills } from '../appTypes.js';
import type { SecretInputRequest } from '../secretInput.js';
import type { Action } from '../state.js';

export interface SlashContext {
  agent: Agent;
  /** Whitespace-split arguments after the command name (e.g. `/model list` → ['list']). */
  rest: string[];
  dispatch: React.Dispatch<Action>;
  exit: () => void;
  clearScreen: () => void;
  yolo: boolean;
  applyYolo: (on: boolean) => void;
  /** Optional: set ask|auto-safe|yolo on the tiered prompter. */
  applyPermissionMode?: (mode: 'ask' | 'auto-safe' | 'yolo') => void;
  compactMode: boolean;
  applyCompactMode: (on: boolean) => void;
  readConfig: () => {
    backend: Backend;
    baseURL: string;
    apiKey: string;
    model: string;
    customModels?: string[];
  };
  applyProvider: ApplyProvider;
  promptSecret: (req: Omit<SecretInputRequest, 'resolve' | 'reject'>) => Promise<string>;
  persistDisabledSkills: PersistDisabledSkills | undefined;
  onSkillCreated: ((skillRootDir: string) => void) | undefined;
  runAgentTurn: (
    value: string,
    opts?: { transcriptUserText?: string; systemText?: string; runOptions?: AgentRunOptions },
  ) => void;
  runAgentCompact: () => void;
  startBurpBridge:
    | ((port?: number) => Promise<{ url: string; token: string; alreadyRunning: boolean }>)
    | undefined;
  generateFindingsReport:
    | ((format: 'markdown' | 'sarif') => Promise<{ path: string; count: number }>)
    | undefined;
  /** Snapshot of background shell jobs for /jobs. */
  listJobs?: () => string;
}

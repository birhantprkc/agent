// Slash-command dispatcher. Each command's actual behavior lives in a
// sibling module grouped by concern (session.ts, memory.ts, provider.ts,
// agentTurns.ts, integrations.ts, settings.ts, skills.ts) — this file only
// builds the shared SlashContext once per call and routes to the right
// handler, so adding a command means adding one line here plus a handler
// function, not growing a single giant switch body.

import type { Agent, AgentRunOptions } from '../../agent/agent.js';
import type { Backend } from '../../config/config.js';
import type { ApplyProvider, PersistDisabledSkills } from '../appTypes.js';
import type { SecretInputRequest } from '../secretInput.js';
import type { Action } from '../state.js';
import { handleCompact, handleNext, handlePlan } from './agentTurns.js';
import type { SlashContext } from './context.js';
import {
  handleBurp,
  handleJobs,
  handleReport,
  handleSnapshot,
  handleUpdate,
} from './integrations.js';
import { handleMemory, handleUser } from './memory.js';
import { handleModel, handleProvider } from './provider.js';
import {
  handleClear,
  handleExit,
  handleHelp,
  handleMode,
  handleReset,
  handleYolo,
} from './session.js';
import {
  handleCompactModeToggle,
  handleConfig,
  handleMaxSteps,
  handleScope,
  handleTarget,
  handleThinking,
} from './settings.js';
import { handleSkillDirectInvoke, handleSkills } from './skills.js';

export function handleSlash(
  agent: Agent,
  raw: string,
  dispatch: React.Dispatch<Action>,
  exit: () => void,
  clearScreen: () => void,
  yolo: boolean,
  applyYolo: (on: boolean) => void,
  compactMode: boolean,
  applyCompactMode: (on: boolean) => void,
  readConfig: () => {
    backend: Backend;
    baseURL: string;
    apiKey: string;
    model: string;
    customModels?: string[];
  },
  applyProvider: ApplyProvider,
  promptSecret: (req: Omit<SecretInputRequest, 'resolve' | 'reject'>) => Promise<string>,
  persistDisabledSkills: PersistDisabledSkills | undefined,
  onSkillCreated: ((skillRootDir: string) => void) | undefined,
  runAgentTurn: (
    value: string,
    opts?: { transcriptUserText?: string; systemText?: string; runOptions?: AgentRunOptions },
  ) => void,
  runAgentCompact: () => void,
  startBurpBridge:
    | ((port?: number) => Promise<{ url: string; token: string; alreadyRunning: boolean }>)
    | undefined,
  generateFindingsReport:
    | ((format: 'markdown' | 'sarif') => Promise<{ path: string; count: number }>)
    | undefined,
  applyPermissionMode?: (mode: 'ask' | 'auto-safe' | 'yolo') => void,
  listJobs?: () => string,
): boolean {
  const [cmd, ...rest] = raw.trim().split(/\s+/);
  // Case-insensitive matching (/Model, /MODEL, /model all resolve the same
  // way) — the switch below matches on this, not the original `cmd`.
  const cmdLower = cmd?.toLowerCase();
  const ctx: SlashContext = {
    agent,
    rest,
    dispatch,
    exit,
    clearScreen,
    yolo,
    applyYolo,
    applyPermissionMode,
    compactMode,
    applyCompactMode,
    readConfig,
    applyProvider,
    promptSecret,
    persistDisabledSkills,
    onSkillCreated,
    runAgentTurn,
    runAgentCompact,
    startBurpBridge,
    generateFindingsReport,
    listJobs,
  };

  switch (cmdLower) {
    case '/exit':
    case '/quit':
      handleExit(ctx);
      return true;
    case '/yolo':
      handleYolo(ctx);
      return true;
    case '/mode':
    case '/act':
      if (cmdLower === '/act') {
        ctx.rest = ['act'];
      }
      handleMode(ctx);
      return true;
    case '/compact-mode':
      handleCompactModeToggle(ctx);
      return true;
    case '/clear':
      handleClear(ctx);
      return true;
    case '/reset':
      handleReset(ctx);
      return true;
    case '/help':
      handleHelp(ctx);
      return true;
    case '/memory':
      handleMemory(ctx);
      return true;
    case '/user':
      handleUser(ctx);
      return true;
    case '/snapshot':
      handleSnapshot(ctx);
      return true;
    case '/burp':
      handleBurp(ctx);
      return true;
    case '/jobs':
      handleJobs(ctx);
      return true;
    case '/report':
      handleReport(ctx);
      return true;
    case '/compact':
      handleCompact(ctx);
      return true;
    case '/next':
      handleNext(ctx);
      return true;
    case '/plan':
      handlePlan(ctx);
      return true;
    case '/provider':
      handleProvider(ctx);
      return true;
    case '/model':
      handleModel(ctx);
      return true;
    case '/target':
      handleTarget(ctx);
      return true;
    case '/scope':
      handleScope(ctx);
      return true;
    case '/maxsteps':
      handleMaxSteps(ctx);
      return true;
    case '/thinking':
      handleThinking(ctx);
      return true;
    case '/config':
      handleConfig(ctx);
      return true;
    case '/update':
      handleUpdate(ctx);
      return true;
    case '/skills':
      handleSkills(ctx);
      return true;
    default: {
      if (handleSkillDirectInvoke(ctx, cmd)) return true;
      // Previously fell through to App.tsx sending the raw, unmodified text
      // to the LLM as a normal chat message — a mistyped or wrong-case
      // command (e.g. /mdoel) silently became an agent instruction instead
      // of a clear error, which during a live engagement risks the model
      // acting on text the user believed was a client-side command.
      dispatch({
        type: 'append',
        entry: { kind: 'error', text: `unknown command: ${cmd} (try /help)` },
      });
      return true;
    }
  }
}

// Shared TUI prop types — used by the OpenTUI App and slash handlers.
// Kept free of React / OpenTUI so non-UI modules can import them.

import type { Agent } from '../agent/agent.js';
import type { Backend } from '../config/config.js';
import type { SessionDebugLog } from '../logger/sessionDebug.js';
import type { NoticePayload } from '../tools/delegate.js';
import type { BannerData } from './Banner.js';
import type { AskRequest } from './askBridge.js';
import type { PermissionRequest } from './permBridge.js';

/** Mutate the live config + agent client + persist to disk. CLI wires this. */
export interface ProviderChange {
  backend: Backend;
  model: string;
  baseURL?: string;
  apiKey?: string;
}
export type ApplyProvider = (change: ProviderChange) => Promise<void>;

/** Persist a disabled-skills list change (writes ~/.pentesterflow/config.json). */
export type PersistDisabledSkills = (names: string[]) => Promise<void>;

export interface AppProps {
  agent: Agent;
  bannerData: BannerData;
  parentSignal: AbortSignal;
  bindPermPublisher?: (publish: (req: PermissionRequest | null) => void) => void;
  bindAskPublisher?: (publish: (req: AskRequest | null) => void) => void;
  yoloInitial?: boolean;
  readConfig: () => {
    backend: Backend;
    baseURL: string;
    apiKey: string;
    model: string;
    customModels?: string[];
  };
  applyProvider: ApplyProvider;
  setYolo?: (on: boolean) => void;
  setPermissionMode?: (mode: 'ask' | 'auto-safe' | 'yolo') => void;
  bindBannerPublisher?: (publish: (patch: Partial<BannerData>) => void) => void;
  persistDisabledSkills?: PersistDisabledSkills;
  sessionDebug?: SessionDebugLog;
  onSkillCreated?: (skillRootDir: string) => void;
  bindNoticePublisher?: (publish: (notice: NoticePayload) => void) => void;
  startBurpBridge?: (
    port?: number,
  ) => Promise<{ url: string; token: string; alreadyRunning: boolean }>;
  generateFindingsReport?: (
    format: 'markdown' | 'sarif',
  ) => Promise<{ path: string; count: number }>;
  listJobs?: () => string;
  resumeSummary?: string;
  /** OpenTUI: CLI destroys the renderer when the app requests exit. */
  onExit?: () => void;
}

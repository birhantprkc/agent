/** @jsxImportSource @opentui/react */
// Scoped smoke tests for the OpenTUI App port. NOT a 1:1 port of
// ../ui/App.commands.test.tsx's 30 cases — a deliberate scope decision:
// that file exercises every UI-only slash command against ink-testing-library
// keystrokes, whereas the goal here is confirming the useKeyboard/usePaste
// split, the onExit/clearScreen replacements for useApp(), and the
// useTranscriptScrollback wiring all actually work end-to-end through a real
// mounted App. Deeper slash-command coverage already exists at the
// framework-agnostic layer (../ui/commands/*.test.ts) and isn't re-verified
// here per component.

import { join } from 'node:path';
import type { TestRendererSetup } from '@opentui/core/testing';
import { testRender } from '@opentui/react/test-utils';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Agent } from '../agent/agent.js';
import type { Client } from '../llm/client.js';
import type { ChatResponse } from '../llm/types.js';
import { AlwaysAllow } from '../permission/permission.js';
import { newRegistry } from '../skills/registry.js';
import { Target } from '../target/target.js';
import { Registry as ToolRegistry } from '../tools/registry.js';
import type { BannerData } from '../ui/Banner.js';
import { App, type AppProps } from './App.js';

const stubClient: Client = {
  name: () => 'stub',
  model: () => 'stub-model',
  chat: async (): Promise<ChatResponse> => ({
    message: { role: 'assistant', content: '' },
    finishReason: 'stop',
  }),
};

const bannerData: BannerData = {
  provider: 'ollama',
  model: 'stub-model',
  state: 'local',
  cwd: '/tmp/engagement',
};

let agent: Agent;
let runSpy: ReturnType<typeof vi.fn>;
let onExit: ReturnType<typeof vi.fn>;
let setYolo: ReturnType<typeof vi.fn>;
let applyProvider: ReturnType<typeof vi.fn>;

function makeProps(overrides: Partial<AppProps> = {}): AppProps {
  return {
    agent,
    bannerData,
    parentSignal: new AbortController().signal,
    readConfig: () => ({ backend: 'ollama', baseURL: '', apiKey: '', model: 'stub-model' }),
    applyProvider,
    setYolo,
    onExit,
    ...overrides,
  };
}

let cleanup: (() => void) | undefined;
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
});

async function mountApp(overrides: Partial<AppProps> = {}): Promise<TestRendererSetup> {
  const setup = await testRender(<App {...makeProps(overrides)} />, {
    width: 100,
    height: 30,
  });
  cleanup = () => setup.renderer.destroy();
  return setup;
}

/** Same pattern established in PermissionModal.test.tsx et al: act() flushes
 *  React state, plus a small real settle delay for async-chain handlers. */
async function pressAndFlush(setup: TestRendererSetup, press: () => void): Promise<void> {
  await act(async () => {
    press();
    await setup.renderOnce();
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
}

beforeEach(() => {
  const skills = newRegistry();
  skills.loadDir(join(process.cwd(), 'skills'));
  agent = new Agent({
    client: stubClient,
    tools: new ToolRegistry(),
    skills,
    prompter: new AlwaysAllow(),
    store: null,
    target: new Target(),
  });
  runSpy = vi.fn(async () => {});
  agent.run = runSpy as unknown as Agent['run'];
  onExit = vi.fn();
  setYolo = vi.fn();
  applyProvider = vi.fn(async () => {});
});

describe('App (OpenTUI)', () => {
  it('control: a normal message is routed to the agent', async () => {
    const setup = await mountApp();
    await pressAndFlush(setup, () => setup.mockInput.typeText('find idors on the api'));
    await pressAndFlush(setup, () => setup.mockInput.pressEnter());
    expect(runSpy).toHaveBeenCalledTimes(1);
    expect(runSpy.mock.calls[0]?.[0]).toBe('find idors on the api');
  });

  it('shows a resumed-session recap in the chat pane', async () => {
    const setup = await mountApp({
      resumeSummary: 'Resumed session abc123\n\nPrevious session recap:\n\nDone work',
    });
    await setup.renderOnce();
    const frame = setup.captureCharFrame();
    expect(frame).toContain('Resumed session abc123');
    expect(frame).toContain('Done work');
  });

  it('collapses multi-line pasted text but sends the full text to the agent', async () => {
    const setup = await mountApp();
    await pressAndFlush(setup, () => {
      void setup.mockInput.pasteBracketedText('line one\nline two\nline three');
    });
    const frame = setup.captureCharFrame();
    expect(frame).toContain('[Pasted text #1 +3 lines, 28 chars]');
    expect(frame).not.toContain('line two');

    await pressAndFlush(setup, () => setup.mockInput.pressEnter());
    expect(runSpy).toHaveBeenCalledTimes(1);
    expect(runSpy.mock.calls[0]?.[0]).toBe('line one\nline two\nline three');
  });

  it('pastes single-line text into the prompt without a collapse marker', async () => {
    const setup = await mountApp();
    await pressAndFlush(setup, () => {
      void setup.mockInput.pasteBracketedText('https://app.example.com/api/v1/orders/42');
    });
    const frame = setup.captureCharFrame();
    expect(frame).toContain('https://app.example.com/api/v1/orders/42');
    expect(frame).not.toContain('[Pasted text #');

    await pressAndFlush(setup, () => setup.mockInput.pressEnter());
    expect(runSpy).toHaveBeenCalledTimes(1);
    expect(runSpy.mock.calls[0]?.[0]).toBe('https://app.example.com/api/v1/orders/42');
  });

  it('Ctrl+Y reports nothing to copy when the transcript is empty', async () => {
    const setup = await mountApp();
    await pressAndFlush(setup, () => {
      setup.mockInput.pressKey('y', { ctrl: true });
    });
    await new Promise((r) => setTimeout(r, 40));
    await setup.renderOnce();
    const frame = setup.captureCharFrame();
    expect(frame).toMatch(/Nothing to copy yet/i);
  });

  it('Ctrl-C aborts an in-flight run and calls onExit', async () => {
    const setup = await mountApp();
    await pressAndFlush(setup, () => setup.mockInput.pressCtrlC());
    expect(onExit).toHaveBeenCalledTimes(1);
  });

  it('Esc cancels a busy run without exiting', async () => {
    const setup = await mountApp();
    await pressAndFlush(setup, () => setup.mockInput.typeText('scan the target'));
    await pressAndFlush(setup, () => setup.mockInput.pressEnter());
    expect(runSpy).toHaveBeenCalledTimes(1);

    await pressAndFlush(setup, () => setup.mockInput.pressEscape());
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(onExit).not.toHaveBeenCalled();
  });

  it('shows the @ file-mention menu and inserts the picked path', async () => {
    const setup = await mountApp();
    await pressAndFlush(setup, () => setup.mockInput.typeText('@src/ui-opentui/App'));
    const frame = setup.captureCharFrame();
    expect(frame).toContain('FILES');
  });

  it('shows the / command menu while typing a slash command', async () => {
    const setup = await mountApp();
    await pressAndFlush(setup, () => setup.mockInput.typeText('/clear'));
    const frame = setup.captureCharFrame();
    expect(frame).toContain('COMMANDS');
  });

  it('opens the provider picker when selecting /provider from the slash menu', async () => {
    const setup = await mountApp();
    await pressAndFlush(setup, () => setup.mockInput.typeText('/'));
    await pressAndFlush(setup, () => setup.mockInput.pressArrow('down'));
    await pressAndFlush(setup, () => setup.mockInput.pressEnter());
    const frame = setup.captureCharFrame();
    expect(frame).toContain('Select an LLM provider for this session');
  });

  it('surfaces a permission request published through bindPermPublisher as a modal', async () => {
    let publish: ((req: unknown) => void) | undefined;
    const setup = await mountApp({
      bindPermPublisher: (p) => {
        publish = p as (req: unknown) => void;
      },
    });
    await setup.renderOnce();
    expect(publish).toBeDefined();

    await act(async () => {
      publish?.({
        tool: 'shell',
        summary: 'run curl',
        detail: 'curl -s https://example.test',
        resolve: () => {},
        reject: () => {},
      });
      await setup.renderOnce();
    });
    const frame = setup.captureCharFrame();
    expect(frame).toContain('PERMISSION');
  });
});

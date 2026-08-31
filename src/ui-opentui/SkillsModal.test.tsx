/** @jsxImportSource @opentui/react */
import { testRender } from '@opentui/react/test-utils';
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Agent } from '../agent/agent.js';
import type { Client } from '../llm/client.js';
import type { ChatResponse } from '../llm/types.js';
import { AlwaysAllow } from '../permission/permission.js';
import { Registry as SkillRegistry } from '../skills/registry.js';
import { Target } from '../target/target.js';
import { Registry as ToolRegistry } from '../tools/registry.js';
import { SkillsModal } from './SkillsModal.js';

// No original ../ui/SkillsModal.test.tsx exists — zero test coverage before
// this port. See PermissionModal.test.tsx for the act()/pressEscapeAndWait
// background on these helpers.
async function pressAndFlush(
  setup: Awaited<ReturnType<typeof testRender>>,
  press: () => void,
): Promise<void> {
  await act(async () => {
    press();
    await setup.renderOnce();
  });
  // Toggle/toggleAll are async (multiple await hops through
  // agent.setSkillEnabled -> rebuildSystemPrompt -> save()) — the 10ms that
  // sufficed for SecretInputModal's synchronous setState isn't enough here.
  await new Promise((resolve) => setTimeout(resolve, 50));
}
async function pressEscapeAndWait(setup: Awaited<ReturnType<typeof testRender>>): Promise<void> {
  setup.mockInput.pressEscape();
  await new Promise((resolve) => setTimeout(resolve, 50));
}

class FakeClient implements Client {
  constructor(private scripted: ChatResponse[] = []) {}
  name(): string {
    return 'fake';
  }
  model(): string {
    return 'fake-model';
  }
  async chat(): Promise<ChatResponse> {
    return (
      this.scripted.shift() ?? { message: { role: 'assistant', content: '' }, finishReason: 'stop' }
    );
  }
}

function makeAgentWithSkills(names: string[]): Agent {
  const skills = new SkillRegistry();
  for (const name of names) {
    skills.add({
      name,
      description: `${name} playbook`,
      tools: [],
      disableModelInvocation: false,
      path: `/tmp/${name}/SKILL.md`,
      body: '',
    });
  }
  return new Agent({
    client: new FakeClient(),
    tools: new ToolRegistry(),
    skills,
    prompter: new AlwaysAllow(),
    store: null,
    target: new Target(),
  });
}

let cleanup: (() => void) | undefined;
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
});

async function renderModal(node: Parameters<typeof testRender>[0]) {
  const setup = await testRender(node, { width: 100, height: 30 });
  cleanup = () => setup.renderer.destroy();
  await setup.renderOnce();
  return setup;
}

describe('SkillsModal rendering', () => {
  it('shows "no skills" chrome when the registry is empty', async () => {
    const agent = makeAgentWithSkills([]);
    const setup = await renderModal(<SkillsModal agent={agent} onClose={vi.fn()} />);
    const frame = setup.captureCharFrame();
    expect(frame).toContain('SKILLS');
    expect(frame).toContain('No skills are loaded');
  });

  it('lists skills with enabled state and count', async () => {
    const agent = makeAgentWithSkills(['recon', 'webvuln']);
    const setup = await renderModal(<SkillsModal agent={agent} onClose={vi.fn()} />);
    const frame = setup.captureCharFrame();
    expect(frame).toContain('recon');
    expect(frame).toContain('webvuln');
    expect(frame).toContain('2/2 enabled');
    expect(frame).toContain('[on]');
  });

  it('windows a long skill list and shows more-above/below cues', async () => {
    const names = Array.from({ length: 20 }, (_, i) => `skill${String(i).padStart(2, '0')}`);
    const agent = makeAgentWithSkills(names);
    const setup = await renderModal(<SkillsModal agent={agent} onClose={vi.fn()} />);
    let frame = setup.captureCharFrame();
    expect(frame).toContain('20/20 enabled');
    expect(frame).toContain('more below');
    expect(frame).not.toContain('skill19'); // sorted alpha; last page has skill19

    // Jump down past the first page so the "more above" cue appears.
    for (let i = 0; i < 14; i += 1) {
      await pressAndFlush(setup, () => setup.mockInput.pressArrow('down'));
    }
    frame = setup.captureCharFrame();
    expect(frame).toMatch(/more above/);
  });
});

describe('SkillsModal key handling', () => {
  it('closes on Escape', async () => {
    const agent = makeAgentWithSkills(['recon']);
    const onClose = vi.fn();
    const setup = await renderModal(<SkillsModal agent={agent} onClose={onClose} />);
    await pressEscapeAndWait(setup);
    expect(onClose).toHaveBeenCalled();
  });

  it('closes on "q"', async () => {
    const agent = makeAgentWithSkills(['recon']);
    const onClose = vi.fn();
    const setup = await renderModal(<SkillsModal agent={agent} onClose={onClose} />);
    await pressAndFlush(setup, () => setup.mockInput.pressKey('q'));
    expect(onClose).toHaveBeenCalled();
  });

  it('toggles the selected skill off on Enter, then back on', async () => {
    const agent = makeAgentWithSkills(['recon']);
    const setup = await renderModal(<SkillsModal agent={agent} onClose={vi.fn()} />);
    await pressAndFlush(setup, () => setup.mockInput.pressEnter());
    expect(agent.skills.isDisabled('recon')).toBe(true);
    let frame = setup.captureCharFrame();
    expect(frame).toContain('[off]');
    expect(frame).toContain('0/1 enabled');

    await pressAndFlush(setup, () => setup.mockInput.pressEnter());
    expect(agent.skills.isDisabled('recon')).toBe(false);
    frame = setup.captureCharFrame();
    expect(frame).toContain('[on]');
    expect(frame).toContain('1/1 enabled');
  });

  it('digit jump moves selection to the Nth skill in list() order', async () => {
    // Registry.list() sorts alphabetically, not insertion order: jwt, recon,
    // webvuln — digit '2' selects the 2nd in THAT order ('recon').
    const agent = makeAgentWithSkills(['recon', 'webvuln', 'jwt']);
    const setup = await renderModal(<SkillsModal agent={agent} onClose={vi.fn()} />);
    await pressAndFlush(setup, () => setup.mockInput.pressKey('2'));
    await pressAndFlush(setup, () => setup.mockInput.pressEnter());
    expect(agent.skills.isDisabled('recon')).toBe(true);
    expect(agent.skills.isDisabled('jwt')).toBe(false);
    expect(agent.skills.isDisabled('webvuln')).toBe(false);
  });

  it('"d" disables all, "a" re-enables all', async () => {
    const agent = makeAgentWithSkills(['recon', 'webvuln']);
    const setup = await renderModal(<SkillsModal agent={agent} onClose={vi.fn()} />);
    await pressAndFlush(setup, () => setup.mockInput.pressKey('d'));
    expect(agent.skills.isDisabled('recon')).toBe(true);
    expect(agent.skills.isDisabled('webvuln')).toBe(true);

    await pressAndFlush(setup, () => setup.mockInput.pressKey('a'));
    expect(agent.skills.isDisabled('recon')).toBe(false);
    expect(agent.skills.isDisabled('webvuln')).toBe(false);
  });
});

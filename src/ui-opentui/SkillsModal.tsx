/** @jsxImportSource @opentui/react */
// OpenTUI port of ../ui/SkillsModal.tsx.
//
// Key-handling notes: key.upArrow/downArrow -> e.name === 'up'/'down';
// rawInput === ' ' (space bar) -> e.name === 'space' (confirmed against
// OpenTUI's terminalNamedSingleStrokeKeys list — space is a named key, not
// delivered as a literal ' ' character); plain letter keys ('q'/'a'/'d')
// and the 1-9 digit-jump range still compare against e.name/e.sequence
// directly, same as every other modal ported so far.
//
// Long registries: window with computeMenuWindow (same sliding-window math
// as slash/@ menus) so a 30-skill list doesn't blow past a short terminal.

import { TextAttributes } from '@opentui/core';
import { useKeyboard } from '@opentui/react';
import { useState } from 'react';
import type { Agent } from '../agent/agent.js';
import type { PersistDisabledSkills } from '../ui/appTypes.js';
import { computeMenuWindow } from '../ui/menuWindow.js';
import { theme } from '../ui/theme.js';

export interface SkillsModalProps {
  agent: Agent;
  persistDisabledSkills?: PersistDisabledSkills;
  onClose: () => void;
}

/** Visible skill rows before scroll cues kick in. */
const SKILLS_WINDOW = 12;

export function SkillsModal({ agent, persistDisabledSkills, onClose }: SkillsModalProps) {
  const [idx, setIdx] = useState(0);
  const [, setTick] = useState(0);
  const [busyName, setBusyName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const skills = agent.skills.list();
  const total = skills.length;
  const safeIdx = total > 0 ? Math.min(idx, total - 1) : 0;
  const current = skills[safeIdx];
  const win = computeMenuWindow(total, safeIdx, SKILLS_WINDOW);
  const visible = skills.slice(win.start, win.end);

  const toggle = async (): Promise<void> => {
    if (!current || busyName) return;
    const targetEnabled = agent.skills.isDisabled(current.name);
    setBusyName(current.name);
    setError(null);
    try {
      const changed = await agent.setSkillEnabled(current.name, targetEnabled);
      if (changed && persistDisabledSkills) {
        await persistDisabledSkills(agent.skills.disabledNames());
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyName(null);
      setTick((t) => t + 1);
    }
  };

  const toggleAll = async (enabled: boolean): Promise<void> => {
    if (busyName) return;
    setBusyName('*');
    setError(null);
    try {
      for (const s of skills) {
        if (agent.skills.isDisabled(s.name) === !enabled) continue;
        await agent.setSkillEnabled(s.name, enabled);
      }
      if (persistDisabledSkills) {
        await persistDisabledSkills(agent.skills.disabledNames());
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyName(null);
      setTick((t) => t + 1);
    }
  };

  useKeyboard((e) => {
    if (busyName) return;
    if (e.name === 'escape' || e.name === 'q') {
      onClose();
      return;
    }
    if (e.name === 'up') {
      setIdx((i) => (i - 1 + Math.max(1, total)) % Math.max(1, total));
      return;
    }
    if (e.name === 'down') {
      setIdx((i) => (i + 1) % Math.max(1, total));
      return;
    }
    if (e.name === 'return' || e.name === 'space') {
      void toggle();
      return;
    }
    if (e.name === 'a') {
      void toggleAll(true);
      return;
    }
    if (e.name === 'd') {
      void toggleAll(false);
      return;
    }
    const input = e.sequence;
    if (input >= '1' && input <= '9') {
      const n = Number.parseInt(input, 10) - 1;
      if (n < total) setIdx(n);
    }
  });

  if (total === 0) {
    return (
      <box
        style={{
          border: true,
          borderStyle: 'rounded',
          borderColor: theme.border.focus,
          flexDirection: 'column',
          alignSelf: 'flex-start',
          paddingX: 2,
          paddingY: 1,
          marginTop: 1,
        }}
      >
        <box style={{ flexDirection: 'row' }}>
          <text fg={theme.focus} attributes={TextAttributes.BOLD}>
            SKILLS
          </text>
        </box>
        <box style={{ flexDirection: 'row' }}>
          <text fg={theme.text}>No skills are loaded.</text>
        </box>
        <box style={{ flexDirection: 'row', marginTop: 1 }}>
          <text fg={theme.muted} attributes={TextAttributes.DIM}>
            Esc · q to close
          </text>
        </box>
      </box>
    );
  }

  const enabledCount = skills.filter((s) => !agent.skills.isDisabled(s.name)).length;

  return (
    <box
      style={{
        border: true,
        borderStyle: 'rounded',
        borderColor: theme.border.focus,
        flexDirection: 'column',
        alignSelf: 'flex-start',
        paddingX: 2,
        paddingY: 1,
        marginTop: 1,
      }}
    >
      <box style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
        <text fg={theme.focus} attributes={TextAttributes.BOLD}>
          SKILLS
        </text>
        <text fg={theme.muted} attributes={TextAttributes.DIM}>
          {enabledCount}/{total} enabled
        </text>
      </box>
      <box style={{ flexDirection: 'row' }}>
        <text fg={theme.text} attributes={TextAttributes.BOLD}>
          Toggle skills available to the agent
        </text>
      </box>
      {win.hiddenAbove > 0 ? (
        <box style={{ flexDirection: 'row', marginTop: 1 }}>
          <text fg={theme.muted} attributes={TextAttributes.DIM}>
            ··· {win.hiddenAbove} more above ···
          </text>
        </box>
      ) : (
        <box style={{ marginTop: 1 }} />
      )}
      <box style={{ flexDirection: 'column' }}>
        {visible.map((s, vi) => {
          const i = win.start + vi;
          const selected = i === safeIdx;
          const disabled = agent.skills.isDisabled(s.name);
          const busy = busyName === s.name || busyName === '*';
          const stateLabel = busy ? '…    ' : disabled ? '[off]' : '[on] ';
          const stateColor = busy ? theme.warning : disabled ? theme.muted : theme.success;
          return (
            <box key={s.name} style={{ flexDirection: 'row' }}>
              <text fg={selected ? theme.focus : theme.text}>
                {selected ? `${theme.glyphs.caret} ` : '  '}
              </text>
              <text fg={stateColor}>{stateLabel}</text>
              <text fg={selected ? theme.focus : disabled ? theme.muted : theme.text}>
                {' '}
                {s.name}
              </text>
              <text fg={theme.muted} attributes={TextAttributes.DIM}>
                {' '}
                — {truncate(s.description, 60)}
              </text>
            </box>
          );
        })}
      </box>
      {win.hiddenBelow > 0 ? (
        <box style={{ flexDirection: 'row' }}>
          <text fg={theme.muted} attributes={TextAttributes.DIM}>
            ··· {win.hiddenBelow} more below ···
          </text>
        </box>
      ) : null}
      {error ? (
        <box style={{ flexDirection: 'row', marginTop: 1 }}>
          <text fg={theme.error}>error: {error}</text>
        </box>
      ) : null}
      <box style={{ flexDirection: 'row', marginTop: 1 }}>
        <text fg={theme.muted} attributes={TextAttributes.DIM}>
          ↑↓ select · Space/Enter toggle · a enable all · d disable all · Esc/q close
        </text>
      </box>
    </box>
  );
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

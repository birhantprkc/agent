/** @jsxImportSource @opentui/react */
// OpenTUI port of ../ui/MentionMenu.tsx. Pure composition of MenuFrame/MenuRow
// (already ported) + shared logic — no Box/Text usage of its own.

import type { MentionCandidate } from '../agent/mentions.js';
import { computeMenuWindow } from '../ui/menuWindow.js';
import { theme } from '../ui/theme.js';
import { MenuFrame, MenuRow } from './MenuFrame.js';

export interface MentionMenuProps {
  cwd: string;
  candidates: MentionCandidate[];
  selected: number;
}

export function MentionMenu({ cwd, candidates, selected }: MentionMenuProps) {
  if (candidates.length === 0) return null;
  const w = computeMenuWindow(candidates.length, selected);
  const visible = candidates.slice(w.start, w.end);
  const pathLabel = cwd ? `@ ${cwd}` : '@ files';

  return (
    <MenuFrame
      header="Files"
      subtitle={pathLabel}
      hiddenAbove={w.hiddenAbove}
      hiddenBelow={w.hiddenBelow}
      footer="↑↓ navigate · Enter insert · Esc dismiss"
    >
      {visible.map((c, idx) => {
        const absoluteIdx = w.start + idx;
        const isSelected = absoluteIdx === selected;
        const icon = c.isDir ? theme.glyphs.dir : theme.glyphs.file;
        return <MenuRow key={c.insert} selected={isSelected} primary={c.display} icon={icon} />;
      })}
    </MenuFrame>
  );
}

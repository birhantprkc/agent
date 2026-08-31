/** @jsxImportSource @opentui/react */
// OpenTUI port of ../ui/SlashMenu.tsx. Pure composition of MenuFrame/MenuRow
// (already ported) + shared logic (computeMenuWindow) — no Box/Text usage of
// its own, so this port is just swapping the MenuFrame/MenuRow import source.

import { computeMenuWindow } from '../ui/menuWindow.js';
import type { SlashItem } from '../ui/slashItems.js';
import { MenuFrame, MenuRow } from './MenuFrame.js';

export interface SlashMenuProps {
  items: SlashItem[];
  selected: number;
}

export function SlashMenu({ items, selected }: SlashMenuProps) {
  if (items.length === 0) return null;
  const w = computeMenuWindow(items.length, selected);
  const visible = items.slice(w.start, w.end);

  return (
    <MenuFrame
      header="Commands"
      subtitle={`${items.length} match${items.length === 1 ? '' : 'es'}`}
      hiddenAbove={w.hiddenAbove}
      hiddenBelow={w.hiddenBelow}
      footer="↑↓ navigate · Enter select · Esc dismiss"
    >
      {visible.map((item, idx) => {
        const absoluteIdx = w.start + idx;
        const isSelected = absoluteIdx === selected;
        const args = item.args ? ` ${item.args}` : '';
        return (
          <MenuRow
            key={item.name}
            selected={isSelected}
            primary={`${item.name}${args}`}
            secondary={item.description}
          />
        );
      })}
    </MenuFrame>
  );
}

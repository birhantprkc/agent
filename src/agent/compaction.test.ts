import { describe, expect, it } from 'vitest';
import type { Message } from '../llm/types.js';
import type { SessionMemory } from '../session/store.js';
import {
  MICROCOMPACT_PREFIX,
  boundedHistoryForCompaction,
  formatPinnedMemory,
  microcompactMessages,
} from './compaction.js';

function toolMsg(content: string): Message {
  return { role: 'tool', content, toolCallID: 't1', name: 'shell' };
}

describe('microcompactMessages', () => {
  it('leaves recent tool results intact and shrinks older bulky ones', () => {
    const msgs: Message[] = [
      { role: 'user', content: 'hi' },
      toolMsg('A'.repeat(5000)),
      toolMsg('B'.repeat(5000)),
      toolMsg('C'.repeat(100)),
      toolMsg('D'.repeat(100)),
      toolMsg('E'.repeat(100)),
      toolMsg('F'.repeat(100)),
    ];
    const { messages, truncatedCount, droppedBytes } = microcompactMessages(msgs, {
      keepRecentToolResults: 4,
      maxToolResultChars: 200,
    });
    // First two tool results (A,B) are older than the keep-4 window of 6 tools → truncated.
    expect(truncatedCount).toBe(2);
    expect(droppedBytes).toBeGreaterThan(0);
    expect(messages[1]?.content.startsWith(MICROCOMPACT_PREFIX)).toBe(true);
    // Last four stay full.
    expect(messages[3]?.content).toBe('C'.repeat(100));
    expect(messages[6]?.content).toBe('F'.repeat(100));
  });

  it('does not mutate the input array objects for short messages', () => {
    const short = toolMsg('ok');
    const msgs = [short];
    const { messages } = microcompactMessages(msgs, { maxToolResultChars: 800 });
    expect(messages[0]).toBe(short);
  });
});

describe('boundedHistoryForCompaction', () => {
  it('microcompacts older tool spam before formatting', () => {
    // 6 tool results so the first 2 fall outside keep-recent=4.
    const msgs: Message[] = [
      { role: 'user', content: 'go' },
      toolMsg('X'.repeat(4000)),
      toolMsg('Y'.repeat(4000)),
      toolMsg('a'.repeat(50)),
      toolMsg('b'.repeat(50)),
      toolMsg('c'.repeat(50)),
      toolMsg('recent-tail'),
    ];
    const out = boundedHistoryForCompaction(msgs);
    expect(out).toContain('recent-tail');
    // Bulky older tool bodies should not appear in full.
    expect(out.includes('X'.repeat(4000))).toBe(false);
    expect(out.includes('Y'.repeat(4000))).toBe(false);
    expect(out).toContain(MICROCOMPACT_PREFIX);
  });
});

describe('formatPinnedMemory', () => {
  it('returns empty when memory is empty', () => {
    expect(formatPinnedMemory(null)).toBe('');
  });

  it('lists objectives and findings', () => {
    const mem: SessionMemory = {
      version: 1,
      updatedAt: new Date().toISOString(),
      compactions: 1,
      objectives: ['map auth'],
      plan: ['recon', 'test IDOR'],
      completed: [],
      findings: ['IDOR /api/users'],
      tested: [],
      files: [],
      commands: [],
      credentials: [],
      todos: ['write report'],
    };
    const text = formatPinnedMemory(mem);
    expect(text).toContain('Pinned session state');
    expect(text).toContain('map auth');
    expect(text).toContain('IDOR /api/users');
    expect(text).toContain('write report');
  });
});

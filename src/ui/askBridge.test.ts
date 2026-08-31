import { describe, expect, it } from 'vitest';
import type { Question } from '../ask/ask.js';
import { type AskRequest, BridgedAskPrompter } from './askBridge.js';

const q = (prompt: string): Question => ({
  question: prompt,
  options: [
    { label: 'a', description: 'A' },
    { label: 'b', description: 'B' },
  ],
});

describe('BridgedAskPrompter concurrency', () => {
  it('serializes concurrent asks so only one modal is open at once', async () => {
    let open = 0;
    let maxOpen = 0;
    let pending: AskRequest | null = null;
    const bridge = new BridgedAskPrompter((req) => {
      if (req) {
        open += 1;
        maxOpen = Math.max(maxOpen, open);
        pending = req;
      } else {
        open -= 1;
      }
    });
    const flush = () => new Promise((r) => setTimeout(r, 0));

    const p1 = bridge.ask(q('first'));
    const p2 = bridge.ask(q('second'));

    expect(open).toBe(1); // second is parked until first resolves

    pending?.resolve('a');
    await p1;
    await flush();

    expect(open).toBe(1); // second modal now open
    pending?.resolve('b');
    await expect(p2).resolves.toBe('b');
    expect(maxOpen).toBe(1);
  });
});

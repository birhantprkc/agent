import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { USER_PROFILE_CHAR_LIMIT, UserProfileStore } from './store.js';

let home = '';

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'pf-userprofile-'));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe('UserProfileStore.load', () => {
  it('returns empty string when no file exists yet', () => {
    const store = new UserProfileStore({ home });
    expect(store.load()).toBe('');
  });
});

describe('UserProfileStore.append', () => {
  it('creates the file (and parent dir) on first append', async () => {
    const store = new UserProfileStore({ home });
    await store.append('prefers terse output');
    expect(store.load()).toBe('- prefers terse output');
    expect(store.path).toBe(join(home, '.pentesterflow', 'USER.md'));
  });

  it('accumulates multiple notes as separate bullet lines', async () => {
    const store = new UserProfileStore({ home });
    await store.append('prefers terse output');
    await store.append('always wants a curl repro attached');
    expect(store.load()).toBe('- prefers terse output\n- always wants a curl repro attached');
  });

  it('is a no-op for empty or whitespace-only text', async () => {
    const store = new UserProfileStore({ home });
    await store.append('   ');
    expect(store.load()).toBe('');
  });

  it('redacts secrets before writing — never persists a live credential', async () => {
    const store = new UserProfileStore({ home });
    await store.append('uses api_key=sk-abcdefghijklmnopqrstuvwxyz123456 for testing');
    const content = readFileSync(store.path, 'utf8');
    expect(content).not.toContain('sk-abcdefghijklmnopqrstuvwxyz123456');
  });

  it('caps total size by dropping the oldest lines first', async () => {
    const store = new UserProfileStore({ home });
    const longNote = 'x'.repeat(500);
    for (let i = 0; i < 20; i += 1) {
      await store.append(`note-${i}-${longNote}`);
    }
    const content = store.load();
    expect(content.length).toBeLessThanOrEqual(USER_PROFILE_CHAR_LIMIT);
    // Oldest note should have been dropped; a recent one should survive.
    expect(content).not.toContain('note-0-');
    expect(content).toContain('note-19-');
  });
});

describe('UserProfileStore.clear', () => {
  it('wipes the file back to empty', async () => {
    const store = new UserProfileStore({ home });
    await store.append('something');
    await store.clear();
    expect(store.load()).toBe('');
  });

  it('is safe to call when nothing was ever written', async () => {
    const store = new UserProfileStore({ home });
    await expect(store.clear()).resolves.not.toThrow();
  });
});

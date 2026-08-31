import { describe, expect, it } from 'vitest';
import { ScopeStore } from './scope.js';

describe('ScopeStore', () => {
  it('enforces nothing when empty', async () => {
    const s = new ScopeStore();
    expect(s.isEmpty()).toBe(true);
    expect((await s.check('anything.example')).inScope).toBe(true);
  });

  it('matches an exact domain and its subdomains, not unrelated domains', async () => {
    const s = new ScopeStore();
    s.add('example.com');
    expect((await s.check('example.com')).inScope).toBe(true);
    expect((await s.check('api.example.com')).inScope).toBe(true);
    expect((await s.check('notexample.com')).inScope).toBe(false);
    expect((await s.check('evil.com')).inScope).toBe(false);
  });

  it('matches a wildcard pattern', async () => {
    const s = new ScopeStore();
    s.add('*.example.com');
    expect((await s.check('api.example.com')).inScope).toBe(true);
    expect((await s.check('example.com')).inScope).toBe(true);
    expect((await s.check('evil.com')).inScope).toBe(false);
  });

  it('matches CIDR ranges against a literal IP host', async () => {
    const s = new ScopeStore();
    s.add('10.0.0.0/8');
    expect((await s.check('10.1.2.3')).inScope).toBe(true);
    expect((await s.check('11.0.0.1')).inScope).toBe(false);
  });

  it('matches CIDR ranges against a hostname by resolving it first', async () => {
    // 'localhost' resolves via the OS hosts file (127.0.0.1), no real DNS
    // query — deterministic offline. This is the case that used to silently
    // never match: a CIDR rule checked against a hostname, not a raw IP.
    const s = new ScopeStore();
    s.add('127.0.0.0/8', 'deny');
    expect((await s.check('localhost')).inScope).toBe(false);
    const allow = new ScopeStore();
    allow.add('127.0.0.0/8');
    expect((await allow.check('localhost')).inScope).toBe(true);
  });

  it('a CIDR rule does not match an unrelated hostname', async () => {
    const s = new ScopeStore();
    s.add('10.0.0.0/8');
    expect((await s.check('example.com')).inScope).toBe(false);
  });

  it('deny always wins over allow, even for an in-scope domain', async () => {
    const s = new ScopeStore();
    s.add('example.com', 'allow');
    s.add('admin.example.com', 'deny');
    expect((await s.check('api.example.com')).inScope).toBe(true);
    expect((await s.check('admin.example.com')).inScope).toBe(false);
  });

  it('a deny-only scope allows everything else (denylist semantics)', async () => {
    const s = new ScopeStore();
    s.add('evil.com', 'deny');
    expect((await s.check('example.com')).inScope).toBe(true);
    expect((await s.check('evil.com')).inScope).toBe(false);
  });

  it('remove() drops a pattern and clear() empties the whole list', () => {
    const s = new ScopeStore();
    s.add('example.com');
    expect(s.remove('example.com')).toBe(true);
    expect(s.remove('example.com')).toBe(false);
    expect(s.isEmpty()).toBe(true);

    s.add('a.com');
    s.add('b.com');
    s.clear();
    expect(s.list()).toEqual([]);
  });

  it('re-adding the same pattern replaces rather than duplicates', async () => {
    const s = new ScopeStore();
    s.add('example.com', 'allow');
    s.add('example.com', 'deny');
    expect(s.list()).toHaveLength(1);
    expect((await s.check('example.com')).inScope).toBe(false);
  });
});

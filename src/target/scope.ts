// Engagement scope store. `Target` (target.ts) is just a default base URL
// for the http tool — nothing today stops a tool call from hitting a host
// outside the engagement, which matters a lot for bug-bounty program
// compliance (testing out-of-scope assets is a contract violation, not just
// a mistake). This adds an explicit, structured allowlist that gateOutOfScope
// (scopeGate.ts) checks before a network request goes out.
//
// Opt-in by design: an empty scope list means no enforcement at all, so a
// session that never calls /scope or the scope tool behaves exactly like
// today. Deny entries always win over allow entries (an explicit
// out-of-scope carve-out inside an otherwise in-scope domain — e.g. a bounty
// program's own admin panel).
//
// CIDR entries resolve DNS when the checked host isn't already a literal IP
// (same lookup privateHost.ts's SSRF gate already does) — without this, a
// CIDR deny rule like 10.0.0.0/8 would only ever match a request that
// spells out the raw IP, silently never firing for the overwhelmingly
// common case of a hostname that resolves into that range.

import { lookup } from 'node:dns/promises';

export type ScopeMode = 'allow' | 'deny';
export type ScopeKind = 'domain' | 'wildcard' | 'cidr';

export interface ScopeEntry {
  pattern: string;
  kind: ScopeKind;
  mode: ScopeMode;
}

export interface ScopeCheck {
  inScope: boolean;
  reason: string;
}

export class ScopeStore {
  private entries: ScopeEntry[] = [];

  add(pattern: string, mode: ScopeMode = 'allow'): ScopeEntry {
    const clean = pattern.trim().toLowerCase();
    const kind = classify(clean);
    const entry: ScopeEntry = { pattern: clean, kind, mode };
    // Replace an existing entry for the same pattern rather than duplicating.
    this.entries = this.entries.filter((e) => e.pattern !== clean);
    this.entries.push(entry);
    return entry;
  }

  remove(pattern: string): boolean {
    const clean = pattern.trim().toLowerCase();
    const before = this.entries.length;
    this.entries = this.entries.filter((e) => e.pattern !== clean);
    return this.entries.length < before;
  }

  list(): ScopeEntry[] {
    return this.entries.slice();
  }

  clear(): void {
    this.entries = [];
  }

  /** No entries at all = enforcement is off (opt-in). */
  isEmpty(): boolean {
    return this.entries.length === 0;
  }

  /**
   * hostname may be a DNS name or a literal IP. Deny entries win over allow
   * entries regardless of order. When any allow entries exist, a host that
   * matches none of them is out of scope (allowlist semantics); when only
   * deny entries exist, everything else is in scope (denylist semantics).
   */
  async check(hostname: string): Promise<ScopeCheck> {
    if (this.isEmpty()) return { inScope: true, reason: '' };
    const host = hostname.trim().toLowerCase().replace(/\.$/, '');

    const denies = this.entries.filter((e) => e.mode === 'deny');
    for (const e of denies) {
      if (await matches(host, e))
        return { inScope: false, reason: `matches deny rule "${e.pattern}"` };
    }

    const allows = this.entries.filter((e) => e.mode === 'allow');
    if (allows.length === 0) return { inScope: true, reason: '' };
    for (const e of allows) {
      if (await matches(host, e))
        return { inScope: true, reason: `matches allow rule "${e.pattern}"` };
    }
    return {
      inScope: false,
      reason: `does not match any of ${allows.length} configured scope rule(s)`,
    };
  }
}

function classify(pattern: string): ScopeKind {
  if (pattern.includes('/')) return 'cidr';
  if (pattern.startsWith('*.')) return 'wildcard';
  return 'domain';
}

async function matches(host: string, entry: ScopeEntry): Promise<boolean> {
  if (entry.kind === 'cidr') return cidrMatchesResolved(host, entry.pattern);
  if (entry.kind === 'wildcard') {
    const suffix = entry.pattern.slice(1); // ".example.com"
    return host === entry.pattern.slice(2) || host.endsWith(suffix);
  }
  // domain: exact match or subdomain of it (example.com matches api.example.com)
  return host === entry.pattern || host.endsWith(`.${entry.pattern}`);
}

/** Matches `host` (literal IP or DNS name) against `cidr`. A DNS name is
 *  resolved and every returned IPv4 address is checked — best-effort; a
 *  lookup failure just means no match (the caller's own request will
 *  surface the real DNS error). */
async function cidrMatchesResolved(host: string, cidr: string): Promise<boolean> {
  if (ipv4ToInt(host) !== null) return cidrMatches(host, cidr);
  try {
    const resolved = await lookup(host, { all: true, verbatim: true });
    return resolved.some((addr) => addr.family === 4 && cidrMatches(addr.address, cidr));
  } catch {
    return false;
  }
}

function cidrMatches(host: string, cidr: string): boolean {
  const [base, bitsStr] = cidr.split('/');
  if (!base || !bitsStr) return false;
  const bits = Number.parseInt(bitsStr, 10);
  if (!Number.isFinite(bits)) return false;
  const hostBits = ipv4ToInt(host);
  const baseBits = ipv4ToInt(base);
  if (hostBits === null || baseBits === null) return false;
  if (bits <= 0) return true;
  if (bits >= 32) return hostBits === baseBits;
  const mask = (0xffffffff << (32 - bits)) >>> 0;
  return (hostBits & mask) === (baseBits & mask);
}

function ipv4ToInt(addr: string): number | null {
  const parts = addr.split('.').map((p) => Number.parseInt(p, 10));
  if (parts.length !== 4 || parts.some((p) => !Number.isFinite(p) || p < 0 || p > 255)) return null;
  const [a, b, c, d] = parts as [number, number, number, number];
  return ((a << 24) | (b << 16) | (c << 8) | d) >>> 0;
}

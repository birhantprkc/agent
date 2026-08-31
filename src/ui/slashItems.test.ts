import { describe, expect, it } from 'vitest';
import { SLASH_ITEMS, filterSlash } from './slashItems.js';

describe('filterSlash', () => {
  it('returns all items when input is just "/"', () => {
    const r = filterSlash('/');
    expect(r.length).toBe(SLASH_ITEMS.length);
  });

  it('returns no items when input does not start with /', () => {
    expect(filterSlash('hello')).toEqual([]);
    expect(filterSlash('')).toEqual([]);
  });

  it('prefix-matches command names', () => {
    expect(filterSlash('/he').map((s) => s.name)).toEqual(['/help']);
    expect(filterSlash('/re').map((s) => s.name)).toEqual(['/report', '/reset']);
    expect(
      filterSlash('/t')
        .map((s) => s.name)
        .sort(),
    ).toEqual(['/target', '/thinking']);
    expect(
      filterSlash('/m')
        .map((s) => s.name)
        .sort(),
    ).toEqual(['/maxsteps', '/memory', '/mode', '/model']);
    expect(filterSlash('/pl').map((s) => s.name)).toEqual(['/plan']);
  });

  it('includes /provider in the catalog', () => {
    expect(SLASH_ITEMS.map((s) => s.name)).toContain('/provider');
    expect(filterSlash('/prov').map((s) => s.name)).toEqual(['/provider']);
  });

  it('includes /compact-mode in the catalog, distinct from /compact', () => {
    expect(SLASH_ITEMS.map((s) => s.name)).toContain('/compact-mode');
    expect(filterSlash('/compact-m').map((s) => s.name)).toEqual(['/compact-mode']);
  });

  it('hides the menu once the user is typing args (space after command)', () => {
    expect(filterSlash('/target https://')).toEqual([]);
    expect(filterSlash('/maxsteps 20')).toEqual([]);
  });

  it('matches case-insensitively', () => {
    expect(filterSlash('/HELP').map((s) => s.name)).toEqual(['/help']);
  });

  it('falls back to fuzzy subsequence match when no prefix matches', () => {
    // typo: dropped the 'r' — prefix match is empty, subsequence finds it
    expect(filterSlash('/povider').map((s) => s.name)).toEqual(['/provider']);
    // match-anywhere subsequence
    expect(filterSlash('/cmpct').map((s) => s.name)).toContain('/compact');
  });

  it('prefers prefix matches over fuzzy when both exist', () => {
    // '/re' prefix-matches /report and /reset only — fuzzy is NOT consulted
    expect(filterSlash('/re').map((s) => s.name)).toEqual(['/report', '/reset']);
  });
});

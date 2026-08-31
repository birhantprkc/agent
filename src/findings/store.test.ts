import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Finding, Store } from './store.js';

let dir = '';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pf-findings-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function makeFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    title: 'IDOR',
    severity: 'high',
    url: 'https://app.example.com/api/orders/1',
    impact: 'Cross-account read.',
    createdAt: '2026-06-06T00:00:00.000Z',
    slug: 'idor',
    ...overrides,
  };
}

describe('Findings Store', () => {
  it('does not overwrite existing findings with a colliding slug but different url/param', async () => {
    const store = new Store(dir);
    const finding = makeFinding();

    const first = await store.save(finding);
    const second = await store.save({ ...finding, url: 'https://app.example.com/api/orders/2' });

    expect(first.path).toBe(join(dir, 'idor.md'));
    expect(first.duplicate).toBe(false);
    expect(second.path).toBe(join(dir, 'idor-2.md'));
    expect(second.duplicate).toBe(false);
  });

  it('skips writing a duplicate file for the same title+url+parameter', async () => {
    const store = new Store(dir);
    const finding = makeFinding({ parameter: 'id' });

    const first = await store.save(finding);
    const second = await store.save({ ...finding, payload: 'id=2' });

    expect(second.duplicate).toBe(true);
    expect(second.path).toBe(first.path);
  });

  it('treats a different parameter on the same title+url as a distinct finding', async () => {
    const store = new Store(dir);
    const a = await store.save(makeFinding({ parameter: 'id' }));
    const b = await store.save(makeFinding({ parameter: 'orderId', slug: 'idor-2' }));

    expect(b.duplicate).toBe(false);
    expect(b.path).not.toBe(a.path);
  });

  it('re-records a finding if the previously saved file was deleted out of band', async () => {
    const store = new Store(dir);
    const finding = makeFinding({ parameter: 'id' });

    const first = await store.save(finding);
    unlinkSync(first.path);
    const second = await store.save(finding);

    expect(second.duplicate).toBe(false);
    expect(existsSync(second.path)).toBe(true);
  });

  it('serializes concurrent saves of the same finding to a single file', async () => {
    const store = new Store(dir);
    const finding = makeFinding({ parameter: 'id' });

    const results = await Promise.all([
      store.save(finding),
      store.save(finding),
      store.save(finding),
    ]);

    const paths = new Set(results.map((r) => r.path));
    expect(paths.size).toBe(1);
    expect(results.filter((r) => r.duplicate).length).toBe(2);
  });
});

describe('Findings Store.list', () => {
  it('returns an empty list when nothing has been saved', async () => {
    const store = new Store(dir);
    expect(await store.list()).toEqual([]);
  });

  it('returns saved findings sorted oldest-first, excluding a duplicate re-save', async () => {
    const store = new Store(dir);
    await store.save(makeFinding({ parameter: 'id', createdAt: '2026-06-06T00:02:00.000Z' }));
    await store.save(
      makeFinding({
        title: 'SQLi',
        slug: 'sqli',
        parameter: 'q',
        createdAt: '2026-06-06T00:01:00.000Z',
      }),
    );
    // Duplicate of the first save — must not appear twice in list().
    await store.save(makeFinding({ parameter: 'id', createdAt: '2026-06-06T00:03:00.000Z' }));

    const list = await store.list();
    expect(list.map((f) => f.title)).toEqual(['SQLi', 'IDOR']);
  });

  it('excludes an entry whose file was deleted out of band', async () => {
    const store = new Store(dir);
    const saved = await store.save(makeFinding({ parameter: 'id' }));
    unlinkSync(saved.path);
    expect(await store.list()).toEqual([]);
  });
});

describe('Findings Store.writeReport', () => {
  it('writes a markdown report covering every saved finding', async () => {
    const store = new Store(dir);
    await store.save(makeFinding({ parameter: 'id' }));
    await store.save(
      makeFinding({ title: 'SQLi', slug: 'sqli', parameter: 'q', severity: 'critical' }),
    );

    const result = await store.writeReport('markdown');
    expect(result.count).toBe(2);
    expect(result.path).toBe(join(dir, 'report.md'));
    const content = readFileSync(result.path, 'utf8');
    expect(content).toContain('### IDOR');
    expect(content).toContain('### SQLi');
  });

  it('writes a SARIF report and reports zero findings when none exist', async () => {
    const store = new Store(dir);
    const result = await store.writeReport('sarif');
    expect(result.count).toBe(0);
    expect(result.path).toBe(join(dir, 'report.sarif.json'));
    const parsed = JSON.parse(readFileSync(result.path, 'utf8'));
    expect(parsed.runs[0].results).toEqual([]);
  });
});

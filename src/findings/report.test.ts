import { describe, expect, it } from 'vitest';
import { renderMarkdownReport, renderSarifReport } from './report.js';
import type { Finding } from './store.js';

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    title: 'Reflected XSS in search',
    severity: 'high',
    url: 'https://example.com/search?q=x',
    parameter: 'q',
    impact: 'Attacker can execute arbitrary JS in a victim session.',
    createdAt: '2026-01-01T00:00:00.000Z',
    slug: 'reflected-xss-in-search',
    ...overrides,
  };
}

describe('renderMarkdownReport', () => {
  it('reports zero findings without throwing', () => {
    const out = renderMarkdownReport([]);
    expect(out).toContain('Total findings: 0');
    expect(out).toContain('No findings recorded yet.');
  });

  it('groups findings by severity section and includes full repro detail', () => {
    const out = renderMarkdownReport([
      finding({ severity: 'critical', title: 'SQLi in login' }),
      finding({ severity: 'high', curl: 'curl https://example.com' }),
    ]);
    expect(out).toContain('## CRITICAL (1)');
    expect(out).toContain('## HIGH (1)');
    expect(out).toContain('### SQLi in login');
    expect(out).toContain('### Reflected XSS in search');
    expect(out).toContain('curl https://example.com');
    // Critical section must appear before high in the output.
    expect(out.indexOf('CRITICAL')).toBeLessThan(out.indexOf('## HIGH'));
  });
});

describe('renderSarifReport', () => {
  it('produces valid SARIF 2.1.0 JSON with one result per finding', () => {
    const parsed = JSON.parse(
      renderSarifReport([finding(), finding({ severity: 'low', title: 'Verbose error' })]),
    );
    expect(parsed.version).toBe('2.1.0');
    expect(parsed.runs[0].results).toHaveLength(2);
    expect(parsed.runs[0].results[0].level).toBe('error');
    expect(parsed.runs[0].results[1].level).toBe('note');
    expect(parsed.runs[0].results[0].locations[0].physicalLocation.artifactLocation.uri).toBe(
      'https://example.com/search?q=x',
    );
  });

  it('deduplicates rules by title so repeated finding types share one rule id', () => {
    const parsed = JSON.parse(
      renderSarifReport([finding(), finding({ url: 'https://example.com/other' })]),
    );
    expect(parsed.runs[0].tool.driver.rules).toHaveLength(1);
    expect(parsed.runs[0].results).toHaveLength(2);
  });
});

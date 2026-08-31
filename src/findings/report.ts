// Aggregate findings report generation. Pure rendering functions (no I/O)
// so /report can turn everything Store.list() returns into either a
// human-readable Markdown writeup (grouped by severity, full repro detail)
// or a SARIF 2.1.0 log for ingestion into CI/security dashboards.

import { render as renderFinding } from './store.js';
import type { Finding, Severity } from './store.js';

const SEVERITY_ORDER: Severity[] = ['critical', 'high', 'medium', 'low', 'info'];

function groupBySeverity(findings: Finding[]): Map<Severity, Finding[]> {
  const map = new Map<Severity, Finding[]>();
  for (const sev of SEVERITY_ORDER) map.set(sev, []);
  for (const f of findings) map.get(f.severity)?.push(f);
  return map;
}

export function renderMarkdownReport(findings: Finding[]): string {
  const lines: string[] = [];
  lines.push('# Findings Report', '');
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push(`Total findings: ${findings.length}`, '');

  if (findings.length === 0) {
    lines.push('No findings recorded yet.');
    return lines.join('\n');
  }

  const grouped = groupBySeverity(findings);
  lines.push(
    `Severity breakdown: ${SEVERITY_ORDER.map((s) => `${s}: ${grouped.get(s)?.length ?? 0}`).join(' · ')}`,
    '',
  );

  for (const sev of SEVERITY_ORDER) {
    const group = grouped.get(sev) ?? [];
    if (group.length === 0) continue;
    lines.push(`## ${sev.toUpperCase()} (${group.length})`, '', '---', '');
    for (const f of group) {
      // Demote the per-finding heading a level so it nests under its
      // severity section instead of competing with the report title.
      lines.push(renderFinding(f).replace(/^# /, '### '), '');
    }
  }
  return lines.join('\n');
}

const SARIF_LEVEL: Record<Severity, 'error' | 'warning' | 'note'> = {
  critical: 'error',
  high: 'error',
  medium: 'warning',
  low: 'note',
  info: 'note',
};

function ruleId(title: string): string {
  const slug = title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-+|-+$)/g, '')
    .slice(0, 64);
  return slug || 'finding';
}

export function renderSarifReport(findings: Finding[]): string {
  const rules = new Map<string, { title: string; severity: Severity }>();
  for (const f of findings) {
    const id = ruleId(f.title);
    if (!rules.has(id)) rules.set(id, { title: f.title, severity: f.severity });
  }

  const sarif = {
    $schema:
      'https://raw.githubusercontent.com/oasis-tcs/sarif-spec/master/Schemata/sarif-schema-2.1.0.json',
    version: '2.1.0',
    runs: [
      {
        tool: {
          driver: {
            name: 'pentesterflow',
            rules: [...rules.entries()].map(([id, r]) => ({
              id,
              name: r.title,
              shortDescription: { text: r.title },
              defaultConfiguration: { level: SARIF_LEVEL[r.severity] },
            })),
          },
        },
        results: findings.map((f) => ({
          ruleId: ruleId(f.title),
          level: SARIF_LEVEL[f.severity],
          message: { text: f.impact },
          locations: [{ physicalLocation: { artifactLocation: { uri: f.url } } }],
          properties: {
            severity: f.severity,
            method: f.method,
            parameter: f.parameter,
            reportedAt: f.createdAt,
          },
        })),
      },
    ],
  };
  return JSON.stringify(sarif, null, 2);
}

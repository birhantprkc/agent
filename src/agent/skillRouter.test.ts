import { describe, expect, it } from 'vitest';
import type { Skill } from '../skills/registry.js';
import { Target } from '../target/target.js';
import { buildObserveNote, routeSkill } from './skillRouter.js';

const skill = (name: string, description: string): Skill => ({
  name,
  description,
  tools: [],
  disableModelInvocation: false,
  path: `/tmp/${name}/SKILL.md`,
  body: '',
});

const skills = [
  skill('graphql', 'GraphQL pentest playbook for introspection'),
  skill('webvuln', 'Web vulnerability pentest playbook'),
  skill('recon', 'External recon for subdomain enumeration'),
];

describe('routeSkill', () => {
  it('does not route bare pentest to graphql', () => {
    const r = routeSkill('authorized pentest of the login flow', skills, new Target());
    expect(r?.skill).not.toBe('graphql');
  });

  it('routes real graphql signals', () => {
    const r = routeSkill(
      'run graphql introspection on https://api.example.com/graphql',
      skills,
      new Target(),
    );
    expect(r?.skill).toBe('graphql');
    expect(r?.summary).toBe('plan · graphql');
    expect(r?.guidance).toContain('load_skill');
  });

  it('routes recon for subdomain work', () => {
    const r = routeSkill('enumerate subdomains for example.com', skills, new Target());
    expect(r?.skill).toBe('recon');
  });

  it('stays quiet for greetings', () => {
    expect(routeSkill('hello', skills, new Target())).toBeUndefined();
  });
});

describe('buildObserveNote', () => {
  it('flags failed tools', () => {
    const note = buildObserveNote([
      { name: 'http', err: 'timeout', result: 'ERROR: timeout' },
      { name: 'shell', err: '', result: 'ok' },
    ]);
    expect(note).toContain('failed');
    expect(note).toContain('http');
    expect(note).toContain('identical');
  });

  it('stays quiet for a single success', () => {
    expect(buildObserveNote([{ name: 'http', err: '', result: '200' }])).toBeUndefined();
  });
});

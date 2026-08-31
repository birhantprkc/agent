// Lightweight skill router — steers small/local models toward load_skill
// without the old noisy "decision planner" transcript spam.
//
// Matching uses skill name + high-signal keyword maps only (never free-text
// description tokens like "pentest", which false-routed every skill).

import type { Skill } from '../skills/registry.js';
import type { Target } from '../target/target.js';

export interface SkillRoute {
  skill: string;
  reason: string;
  risk: 'normal' | 'high';
  /** Quiet transcript badge, e.g. "plan · graphql". */
  summary: string;
  /** Injected into the system message for this turn only. */
  guidance: string;
}

const SKILL_KEYWORDS: Record<string, string[]> = {
  recon: [
    'recon',
    'subdomain',
    'subdomains',
    'enumerate',
    'enumeration',
    'attack surface',
    'crt.sh',
    'fingerprint',
    'content discovery',
  ],
  webvuln: [
    'idor',
    'bola',
    'broken access',
    'xss',
    'sqli',
    'sql injection',
    'access control',
    'authorization bug',
    'api security',
  ],
  jwt: ['jwt', 'json web token', 'alg none', 'jwks', 'jku', 'hs256', 'rs256'],
  ssrf: ['ssrf', '169.254.169.254', 'imds', 'metadata service', 'server-side request'],
  ssti: ['ssti', 'server-side template', 'jinja', 'twig', 'freemarker'],
  graphql: ['graphql', 'gql', 'introspection', '__schema', 'graphiql', 'apollo', '/graphql'],
  race: ['race condition', 'double spend', 'toctou', 'parallel redeem'],
  takeover: ['subdomain takeover', 'dangling cname', 'takeover'],
  supabase: ['supabase', 'postgrest', 'row level security', 'rls'],
  deserialize: ['deserialize', 'deserialization', 'pickle', 'unserialize', 'binaryformatter'],
};

const HIGH_RISK = [
  'sqlmap',
  'nuclei',
  'ffuf',
  'masscan',
  'bruteforce',
  'brute force',
  'rce',
  'exploit chain',
  'ddos',
];

/**
 * Recommend a skill for this user turn, or undefined if confidence is low.
 */
export function routeSkill(
  userMsg: string,
  skills: Skill[],
  target: Target,
): SkillRoute | undefined {
  const text = userMsg.trim();
  if (!text) return undefined;
  const normalized = normalize(text);
  const risk: 'normal' | 'high' = HIGH_RISK.some((t) => normalized.includes(t)) ? 'high' : 'normal';

  let best: { name: string; score: number; hits: string[] } | undefined;
  for (const skill of skills) {
    if (skill.disableModelInvocation) continue;
    const scored = score(normalized, skill);
    if (scored.score < 2) continue;
    if (!best || scored.score > best.score) {
      best = { name: skill.name, score: scored.score, hits: scored.hits };
    }
  }

  if (!best && risk === 'normal') return undefined;

  const skillName = best?.name;
  const reason = best
    ? `matched ${best.name}: ${best.hits.slice(0, 3).join(', ')}`
    : 'high-risk phrasing without a specialized skill match';
  const targetKnown = !target.empty() || hasHost(text);
  const checklist: string[] = [];
  if (!targetKnown) checklist.push('confirm in-scope target/host before active testing');
  if (skillName) checklist.push(`call load_skill name=${skillName} before other tools`);
  if (risk === 'high') checklist.push('ask before scanner-like or high-volume actions');
  checklist.push('use coverage to avoid retesting the same surface');
  checklist.push('require real request/response evidence before confirm_finding');

  const summary = skillName
    ? risk === 'high'
      ? `plan · ${skillName} · high risk`
      : `plan · ${skillName}`
    : 'plan · high risk';

  const guidance = [
    'Turn routing (follow unless the user clearly wants something else):',
    `- ${skillName ? `Recommended skill: ${skillName} (${reason}).` : `No skill match (${reason}).`}`,
    `- Risk: ${risk}.`,
    ...checklist.map((c) => `- ${c}`),
  ].join('\n');

  return {
    skill: skillName ?? '',
    reason,
    risk,
    summary,
    guidance,
  };
}

/**
 * After tools run: short observe note for the next model step when something
 * failed. Stops small models from blindly repeating the same broken call.
 */
export function buildObserveNote(
  results: Array<{ name: string; err: string; result: string }>,
): string | undefined {
  if (results.length === 0) return undefined;
  const failed = results.filter((r) => r.err || /^\s*ERROR:/i.test(r.result));
  const ok = results.length - failed.length;
  if (failed.length === 0) {
    // Light nudge only when many tools ran with no failures — avoid spam.
    if (results.length >= 3) {
      return `Observe: ${ok} tool(s) succeeded. Summarize evidence, mark coverage, then pick a NEW untested surface — do not re-run identical calls.`;
    }
    return undefined;
  }
  const names = failed.map((f) => f.name).join(', ');
  return `Observe: ${failed.length}/${results.length} tool(s) failed (${names}). Do not retry the same tool with identical arguments. Adjust payload/path/auth, try an alternate approach, or ask the user once if blocked.`;
}

function score(normalized: string, skill: Skill): { score: number; hits: string[] } {
  const hits: string[] = [];
  let s = 0;
  const name = normalize(skill.name);
  if (name && normalized.includes(name)) {
    s += 3;
    hits.push(skill.name);
  }
  for (const kw of SKILL_KEYWORDS[skill.name] ?? []) {
    const k = normalize(kw);
    if (k.length >= 3 && normalized.includes(k)) {
      s += 2;
      hits.push(kw);
    }
  }
  return { score: s, hits };
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/[_-]+/g, ' ');
}

function hasHost(s: string): boolean {
  return /https?:\/\/[^\s]+/i.test(s) || /\b[a-z0-9-]+(?:\.[a-z0-9-]+)+\b/i.test(s);
}

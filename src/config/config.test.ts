// Validates that the shell-meta
// rejection set matches and that a clean config round-trips through save
// and load.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  defaultConfig,
  formatConfig,
  load,
  parseConfigText,
  save,
  stripJsonComments,
  toPersistable,
} from './config.js';

let tmp = '';
const originalEnv = process.env.PENTESTERFLOW_CONFIG;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'pf-config-'));
  process.env.PENTESTERFLOW_CONFIG = join(tmp, 'config.json');
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  if (originalEnv === undefined) {
    process.env.PENTESTERFLOW_CONFIG = undefined;
  } else {
    process.env.PENTESTERFLOW_CONFIG = originalEnv;
  }
});

describe('config', () => {
  it('returns a default config when the file is missing', () => {
    const cfg = load();
    expect(cfg.backend).toBe('');
    expect(cfg.mcp_servers).toEqual([]);
  });

  it('round-trips through save and load', async () => {
    const cfg = defaultConfig();
    cfg.backend = 'groq';
    cfg.model = 'openai/gpt-oss-20b';
    cfg.base_url = 'https://api.groq.com/openai/v1';
    cfg.api_key = 'sk-test';
    cfg.mcp_servers = [{ name: 'browser', command: 'npx', args: ['-y', '@browsermcp/mcp@latest'] }];
    await save(cfg);
    const reloaded = load();
    expect(reloaded.backend).toBe('groq');
    expect(reloaded.model).toBe('openai/gpt-oss-20b');
    expect(reloaded.base_url).toBe('https://api.groq.com/openai/v1');
    expect(reloaded.api_key).toBe('sk-test');
    expect(reloaded.mcp_servers[0]?.command).toBe('npx');
  });

  it('supports overlapping saves without temp-file collisions', async () => {
    const one = defaultConfig();
    one.backend = 'ollama';
    one.model = 'model-one';
    const two = defaultConfig();
    two.backend = 'groq';
    two.model = 'model-two';
    two.api_key = 'sk-test';

    await expect(Promise.all([save(one), save(two)])).resolves.toHaveLength(2);
    expect(['model-one', 'model-two']).toContain(load().model);
  });

  it('rejects shell-meta in mcp command', async () => {
    const cfg = defaultConfig();
    cfg.mcp_servers = [{ name: 'evil', command: 'npx; rm -rf /', args: [] }];
    await save(cfg);
    expect(() => load()).toThrow(/shell metacharacters/);
  });

  it('rejects pipe in plugin command', async () => {
    const cfg = defaultConfig();
    cfg.plugins = [{ name: 'evil', command: 'sh | nc', args: [], description: '' }];
    await save(cfg);
    expect(() => load()).toThrow(/shell metacharacters/);
  });

  it('rejects command substitution in plugin command', async () => {
    const cfg = defaultConfig();
    cfg.plugins = [{ name: 'evil', command: '$(whoami)', args: [], description: '' }];
    await save(cfg);
    expect(() => load()).toThrow(/shell metacharacters/);
  });

  it('rejects shell-meta in hook command', async () => {
    const cfg = defaultConfig();
    cfg.hooks = [{ event: 'post-tool-call', command: 'sh | nc', args: [] }];
    await save(cfg);
    expect(() => load()).toThrow(/shell metacharacters/);
  });

  it('persists hooks through save + load', async () => {
    const cfg = defaultConfig();
    cfg.hooks = [{ event: 'pre-tool-call', matcher: 'shell', command: 'echo', args: ['audit'] }];
    await save(cfg);
    const reloaded = load();
    expect(reloaded.hooks).toEqual([
      { event: 'pre-tool-call', matcher: 'shell', command: 'echo', args: ['audit'] },
    ]);
  });

  it('omits empty hooks from the persisted config (default)', () => {
    expect(formatConfig(defaultConfig())).not.toContain('hooks');
  });

  it('persists tooling_profile through save + load', async () => {
    const cfg = defaultConfig();
    cfg.tooling_profile = 'full';
    await save(cfg);
    const reloaded = load();
    expect(reloaded.tooling_profile).toBe('full');
  });

  it('accepts Gemini as a backend', async () => {
    const cfg = defaultConfig();
    cfg.backend = 'gemini';
    cfg.model = 'models/gemini-3.5-flash';
    cfg.api_key = 'gemini-test';
    await save(cfg);
    const reloaded = load();
    expect(reloaded.backend).toBe('gemini');
    expect(reloaded.model).toBe('models/gemini-3.5-flash');
  });

  it('accepts OpenRouter as a backend', async () => {
    const cfg = defaultConfig();
    cfg.backend = 'openrouter';
    cfg.model = 'openrouter/auto';
    cfg.api_key = 'sk-or-test';
    await save(cfg);
    const reloaded = load();
    expect(reloaded.backend).toBe('openrouter');
    expect(reloaded.model).toBe('openrouter/auto');
  });

  it('accepts DeepSeek as a backend', async () => {
    const cfg = defaultConfig();
    cfg.backend = 'deepseek';
    cfg.model = 'deepseek-v4-flash';
    cfg.api_key = 'sk-deepseek-test';
    await save(cfg);
    const reloaded = load();
    expect(reloaded.backend).toBe('deepseek');
    expect(reloaded.model).toBe('deepseek-v4-flash');
  });

  it('leaves tooling_profile undefined when never set (signals first run)', () => {
    const cfg = load(); // file doesn't exist → defaults
    expect(cfg.tooling_profile).toBeUndefined();
  });

  it('saved file has 0o600 perms', async () => {
    const cfg = defaultConfig();
    cfg.backend = 'ollama';
    await save(cfg);
    const { statSync } = await import('node:fs');
    const mode = statSync(process.env.PENTESTERFLOW_CONFIG ?? '').mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('formatConfig omits empty defaults so the file stays small', () => {
    const cfg = defaultConfig();
    cfg.backend = 'ollama';
    cfg.model = 'qwen2.5:14b';
    cfg.tooling_profile = 'minimal';
    const text = formatConfig(cfg);
    const obj = JSON.parse(text) as Record<string, unknown>;
    expect(obj).toEqual({
      backend: 'ollama',
      model: 'qwen2.5:14b',
      tooling_profile: 'minimal',
    });
    // Noise defaults must not appear.
    expect(obj).not.toHaveProperty('api_key');
    expect(obj).not.toHaveProperty('skills_dirs');
    expect(obj).not.toHaveProperty('mcp_servers');
    expect(obj).not.toHaveProperty('streaming_enabled'); // true is default
    expect(obj).not.toHaveProperty('thinking_enabled'); // false is default
    expect(obj).not.toHaveProperty('memory_provider'); // off is default
  });

  it('toPersistable keeps non-default knobs', () => {
    const cfg = defaultConfig();
    cfg.backend = 'openai';
    cfg.model = 'gpt-4.1';
    cfg.api_key = 'sk-x';
    cfg.streaming_enabled = false;
    cfg.temperature = 0.3;
    cfg.custom_models = ['my-ft'];
    const obj = toPersistable(cfg);
    expect(obj.streaming_enabled).toBe(false);
    expect(obj.temperature).toBe(0.3);
    expect(obj.custom_models).toEqual(['my-ft']);
    expect(obj.api_key).toBe('sk-x');
  });

  it('save writes ordered compact JSON that reloads with defaults filled', async () => {
    const cfg = defaultConfig();
    cfg.backend = 'anthropic';
    cfg.model = 'claude-sonnet-5';
    cfg.api_key = 'sk-ant';
    cfg.tooling_profile = 'full';
    await save(cfg);
    const raw = readFileSync(process.env.PENTESTERFLOW_CONFIG ?? '', 'utf8');
    expect(raw).toMatch(/^\{\n {2}"backend": "anthropic"/);
    expect(raw).not.toContain('"skills_dirs"');
    const reloaded = load();
    expect(reloaded.backend).toBe('anthropic');
    expect(reloaded.streaming_enabled).toBe(true); // default restored
    expect(reloaded.mcp_servers).toEqual([]);
  });

  it('load accepts JSONC comments and $doc keys', () => {
    const path = process.env.PENTESTERFLOW_CONFIG ?? '';
    writeFileSync(
      path,
      `{
  // provider
  "backend": "groq",
  "model": "openai/gpt-oss-20b", /* curated */
  "$schema": "https://example.invalid/ignore",
  "_comment": "hand-edited",
  "api_key": "sk-test"
}
`,
      { mode: 0o600 },
    );
    const cfg = load();
    expect(cfg.backend).toBe('groq');
    expect(cfg.model).toBe('openai/gpt-oss-20b');
    expect(cfg.api_key).toBe('sk-test');
  });

  it('stripJsonComments leaves // inside strings alone', () => {
    const src = '{ "base_url": "https://example.com//v1", "x": 1 } // trailing';
    expect(stripJsonComments(src)).toContain('https://example.com//v1');
    expect(stripJsonComments(src)).not.toContain('trailing');
    const parsed = parseConfigText(src) as { base_url: string; x: number };
    expect(parsed.base_url).toBe('https://example.com//v1');
    expect(parsed.x).toBe(1);
  });

  it('zod errors name the field on bad types', () => {
    const path = process.env.PENTESTERFLOW_CONFIG ?? '';
    writeFileSync(path, '{ "max_steps": "nope" }\n', { mode: 0o600 });
    expect(() => load()).toThrow(/max_steps/);
  });
});

import { describe, expect, it } from 'vitest';
import { inferModelBillions, modelReliabilityWarning } from './modelWarnings.js';

describe('inferModelBillions', () => {
  it('parses common local model size suffixes', () => {
    expect(inferModelBillions('qwen2.5-coder:7b-instruct-q4_K_M')).toBe(7);
    expect(inferModelBillions('qwen2.5-coder:14b-instruct-q4_K_M')).toBe(14);
    expect(inferModelBillions('llama-3.1-8b')).toBe(8);
    expect(inferModelBillions('mixtral-8x7b')).toBe(7);
  });

  it('prefers the largest size when names contain variant suffixes (e.g. -a3b after 35b)', () => {
    expect(inferModelBillions('qwen3.6-35b-a3b-uncensored-hauhaucs-aggressive')).toBe(35);
    expect(inferModelBillions('some-model-72b-distill-8b')).toBe(72);
    expect(inferModelBillions('llama-70b-8b-lora')).toBe(70);
  });

  it('returns undefined when no model size is encoded', () => {
    expect(inferModelBillions('gpt-4.1-mini')).toBeUndefined();
  });
});

describe('modelReliabilityWarning', () => {
  it('warns for sub-14b local models', () => {
    expect(modelReliabilityWarning('ollama', 'qwen2.5-coder:7b')).toContain(
      'Recommended minimum: 14b locally',
    );
  });

  it('does not warn for 14b local models', () => {
    expect(modelReliabilityWarning('ollama', 'qwen2.5-coder:14b')).toBeUndefined();
  });

  it('uses largest size for local model warnings on complex names', () => {
    // Should treat as 26b (no warning for local >=14), not 4b
    expect(modelReliabilityWarning('ollama', 'gemma-4-26b-a4b-it')).toBeUndefined();
    // Sub-14 should still warn even with extra numbers
    expect(modelReliabilityWarning('ollama', 'qwen-9b-a3b-variant')).toContain('14b locally');
  });

  it('warns differently for small openai-compatible hosted models', () => {
    expect(modelReliabilityWarning('openai-compat', 'llama-3.1-8b')).toContain('70b+');
  });

  it('skips size warnings for first-party frontier APIs (Claude/Gemini/Kimi/OpenAI/DeepSeek)', () => {
    expect(modelReliabilityWarning('kimi', 'llama-3.1-8b')).toBeUndefined();
    expect(modelReliabilityWarning('deepseek', 'openai/gpt-oss-20b')).toBeUndefined();
    expect(modelReliabilityWarning('gemini', 'gemma-4-26b-a4b-it')).toBeUndefined();
    expect(modelReliabilityWarning('anthropic', 'claude-sonnet-5')).toBeUndefined();
    expect(modelReliabilityWarning('openai', 'gpt-4.1-mini')).toBeUndefined();
  });

  it('treats Groq as a hosted open-weight style provider for size warnings', () => {
    expect(modelReliabilityWarning('groq', 'openai/gpt-oss-20b')).toContain('70b+');
  });

  it('treats OpenRouter as a hosted open-weight style provider for size warnings', () => {
    expect(modelReliabilityWarning('openrouter', 'openai/gpt-oss-20b')).toContain('70b+');
  });
});

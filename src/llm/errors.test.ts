// Backend error-classification tests.

import { describe, expect, it } from 'vitest';
import { BackendError, classifyBackend, formatUserError, isTransient } from './errors.js';

describe('classifyBackend', () => {
  it('tags ECONNREFUSED as backend-down', () => {
    const err = new Error('fetch failed: connect ECONNREFUSED 127.0.0.1:11434');
    const out = classifyBackend('ollama', err, 0, undefined);
    expect(out).toBeInstanceOf(BackendError);
    expect(out.category).toBe('backend-down');
  });

  it('tags ENOTFOUND as backend-down', () => {
    const err = new Error('getaddrinfo ENOTFOUND missing.host');
    const out = classifyBackend('openai-compat', err, 0, undefined);
    expect(out.category).toBe('backend-down');
  });

  it('tags ollama "model not found" body as model-not-found', () => {
    const body = JSON.stringify({ error: 'model qwen2.5:7b not found, try pulling it first' });
    const out = classifyBackend('ollama', null, 404, body);
    expect(out.category).toBe('model-not-found');
    expect(out.statusCode).toBe(404);
  });

  it('tags lmstudio "no model loaded" body as model-not-loaded', () => {
    const body = JSON.stringify({
      error: { message: 'No models loaded; please load a model in the UI' },
    });
    const out = classifyBackend('lmstudio', null, 400, body);
    expect(out.category).toBe('model-not-loaded');
  });

  it('leaves unrecognized errors as unknown', () => {
    const out = classifyBackend('ollama', null, 500, 'internal server error');
    expect(out.category).toBe('unknown');
    expect(out.message).toContain('500');
  });

  it('maps bare/empty HTTP 404 to endpoint-not-found (not model-not-found)', () => {
    // Dead reverse proxy (RunPod tunnel) returns empty 404 — not a missing pull.
    const out = classifyBackend('ollama', null, 404, '');
    expect(out.category).toBe('endpoint-not-found');
    expect(out.statusCode).toBe(404);
  });

  it('maps 404 with model context but no not-found phrasing to endpoint-not-found', () => {
    const out = classifyBackend(
      'ollama',
      null,
      404,
      'model=qwythos-9b:latest url=https://x.example/api/chat',
    );
    expect(out.category).toBe('endpoint-not-found');
  });

  it('falls back to raw body when not JSON', () => {
    const out = classifyBackend('ollama', null, 500, 'plain text');
    expect(out.detail).toBe('plain text');
  });

  it('extracts message from OpenAI envelope', () => {
    const body = JSON.stringify({ error: { message: 'invalid api key' } });
    const out = classifyBackend('openai-compat', null, 401, body);
    expect(out.detail).toBe('invalid api key');
  });

  it('maps rate-limit phrasing in a 200 body to a retryable 429', () => {
    // Proxies (OpenRouter, ...) surface transient rate limits inside an HTTP 200.
    const out = classifyBackend('openrouter', null, 200, 'Rate limit exceeded, retry shortly');
    expect(out.statusCode).toBe(429);
    expect(isTransient(out)).toBe(true);
  });

  it('keeps the original status for rate-limit phrasing on an error response', () => {
    const out = classifyBackend('openrouter', null, 503, 'too many requests');
    expect(out.statusCode).toBe(503);
    expect(isTransient(out)).toBe(true);
  });
});

describe('isTransient status set', () => {
  it('flags 408 request timeout as transient', () => {
    expect(isTransient(new BackendError('test', 'unknown', 408, 'timeout'))).toBe(true);
  });
});

describe('formatUserError', () => {
  it('turns ollama model-not-found into actionable multi-line copy', () => {
    const err = new BackendError(
      'ollama',
      'model-not-found',
      404,
      'model qwen2.5:7b not found, try pulling it first',
    );
    const out = formatUserError(err);
    expect(out).toContain('Model not found on ollama');
    expect(out).toContain('try pulling it first');
    expect(out).toContain('ollama pull');
    expect(out).toContain('/model');
    // Not the raw wire string alone.
    expect(out).not.toBe(err.message);
  });

  it('formats backend-down with start-daemon hints', () => {
    const err = new BackendError(
      'ollama',
      'backend-down',
      0,
      'connect ECONNREFUSED 127.0.0.1:11434',
    );
    const out = formatUserError(err);
    expect(out).toContain("Can't reach ollama");
    expect(out).toContain('ollama serve');
  });

  it('recovers from a plain "ollama error 404: model … not found" message', () => {
    const out = formatUserError(new Error('ollama error 404: model foo not found'));
    expect(out).toContain('Model not found');
    expect(out).toContain('/model');
  });

  it('formats empty 404 as endpoint-not-found with base_url fix', () => {
    const err = new BackendError(
      'ollama',
      'endpoint-not-found',
      404,
      'model=qwythos-9b:latest url=https://pod.example/api/chat',
    );
    const out = formatUserError(err);
    expect(out).toContain('Endpoint not found');
    expect(out).toContain('base_url');
    expect(out).not.toContain('Model not found');
    expect(out).not.toContain('ollama pull');
  });

  it('formats 401 as auth failed with /provider fix', () => {
    const err = new BackendError('openai-compat', 'unknown', 401, 'invalid api key');
    const out = formatUserError(err);
    expect(out).toContain('Auth failed');
    expect(out).toContain('/provider');
  });

  it('passes through unrelated errors unchanged', () => {
    expect(formatUserError(new Error('turn cancelled'))).toBe('turn cancelled');
  });
});

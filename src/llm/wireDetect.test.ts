import { type Server, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { detectWireKind, suggestBackendForOllamaUrl } from './wireDetect.js';

let server: Server;
let base = '';
let mode: 'ollama' | 'openai' | 'both' | 'none' = 'none';

beforeAll(async () => {
  server = createServer((req, res) => {
    if (mode === 'ollama' || mode === 'both') {
      if (req.url === '/api/tags') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ models: [] }));
        return;
      }
    }
    if (mode === 'openai' || mode === 'both') {
      if (req.url === '/v1/models') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [] }));
        return;
      }
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address() as AddressInfo;
  base = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

describe('detectWireKind', () => {
  it('detects native ollama', async () => {
    mode = 'ollama';
    const out = await detectWireKind(base, { timeoutMs: 2000 });
    expect(out.kind).toBe('ollama');
  });

  it('detects openai-compat-only proxies', async () => {
    mode = 'openai';
    const out = await detectWireKind(base, { timeoutMs: 2000 });
    expect(out.kind).toBe('openai-compat');
    expect(await suggestBackendForOllamaUrl(base)).toBe('openai-compat');
  });

  it('prefers ollama when both surfaces work', async () => {
    mode = 'both';
    const out = await detectWireKind(base, { timeoutMs: 2000 });
    expect(out.kind).toBe('ollama');
    expect(await suggestBackendForOllamaUrl(base)).toBeNull();
  });

  it('returns unknown when nothing answers', async () => {
    mode = 'none';
    const out = await detectWireKind(base, { timeoutMs: 2000 });
    expect(out.kind).toBe('unknown');
  });
});

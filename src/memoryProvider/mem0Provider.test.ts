// Integration test against a real in-process HTTP server shaped like the
// self-hosted Mem0 OSS server (POST /memories to add, POST /search to
// recall, no /v1 prefix, X-API-Key auth). No live Mem0 account involved.

import { type Server, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Prompter } from '../permission/permission.js';
import { createMem0Provider } from './mem0Provider.js';

let server: Server;
let baseURL = '';
let lastPath = '';
let lastBody: Record<string, unknown> | null = null;
let lastApiKeyHeader: string | undefined;
let searchResponse: unknown = { results: [] };

beforeAll(async () => {
  server = createServer((req, res) => {
    lastPath = req.url ?? '';
    lastApiKeyHeader = req.headers['x-api-key'] as string | undefined;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      lastBody = raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
      if (req.url === '/memories' && req.method === 'POST') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ results: [{ id: '1', memory: 'stored' }] }));
        return;
      }
      if (req.url === '/search' && req.method === 'POST') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(searchResponse));
        return;
      }
      res.writeHead(404);
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address() as AddressInfo;
  baseURL = `http://127.0.0.1:${addr.port}`;
});

afterAll(() => {
  server.close();
});

describe('Mem0Provider', () => {
  it('posts to /memories (no /v1 prefix) with the X-API-Key header when recording', async () => {
    const provider = createMem0Provider({ baseURL, apiKey: 'test-key', userId: 'u1' });
    await provider.record({
      role: 'user',
      content: 'found an IDOR',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    expect(lastPath).toBe('/memories');
    expect(lastApiKeyHeader).toBe('test-key');
    expect(lastBody).toEqual({
      messages: [{ role: 'user', content: 'found an IDOR' }],
      user_id: 'u1',
    });
  });

  it('omits the X-API-Key header entirely when no key is configured', async () => {
    const provider = createMem0Provider({ baseURL });
    await provider.record({ role: 'user', content: 'x', createdAt: '2026-01-01T00:00:00.000Z' });
    expect(lastApiKeyHeader).toBeUndefined();
  });

  it('is a no-op for empty content — never sends a request', async () => {
    lastPath = '';
    const provider = createMem0Provider({ baseURL });
    await provider.record({ role: 'user', content: '   ', createdAt: '2026-01-01T00:00:00.000Z' });
    expect(lastPath).toBe('');
  });

  it('recall posts to /search and renders results from the { results: [...] } shape', async () => {
    searchResponse = { results: [{ memory: 'found an IDOR on /api/orders/{id}' }] };
    const provider = createMem0Provider({ baseURL, userId: 'u1' });
    const out = await provider.recall('idor', 3);
    expect(lastPath).toBe('/search');
    expect(lastBody).toEqual({ query: 'idor', user_id: 'u1', limit: 3 });
    expect(out).toContain('found an IDOR on /api/orders/{id}');
  });

  it('recall also accepts a bare-array response shape', async () => {
    searchResponse = [{ memory: 'bare array result' }];
    const provider = createMem0Provider({ baseURL });
    const out = await provider.recall('anything');
    expect(out).toContain('bare array result');
  });

  it('recall returns empty string when nothing matches', async () => {
    searchResponse = { results: [] };
    const provider = createMem0Provider({ baseURL });
    expect(await provider.recall('nothing')).toBe('');
  });

  it('recall returns empty string (never throws) when the server is unreachable', async () => {
    const provider = createMem0Provider({ baseURL: 'http://127.0.0.1:1' });
    await expect(provider.recall('anything')).resolves.toBe('');
  });

  it('systemPromptContext reflects successful record() calls', async () => {
    const provider = createMem0Provider({ baseURL });
    expect(provider.systemPromptContext()).toBe('');
    await provider.record({ role: 'user', content: 'one', createdAt: '2026-01-01T00:00:00.000Z' });
    expect(provider.systemPromptContext()).toContain('1 turn');
  });

  it('exposes the shared memory_provider_search tool', async () => {
    searchResponse = { results: [{ memory: 'xss found' }] };
    const provider = createMem0Provider({ baseURL });
    const tools = provider.tools();
    expect(tools).toHaveLength(1);
    const tool = tools[0];
    if (!tool) throw new Error('expected a tool');
    expect(tool.name()).toBe('memory_provider_search');
    const out = await tool.run({ query: 'xss' }, new AbortController().signal, {} as Prompter);
    expect(out).toContain('xss found');
  });
});

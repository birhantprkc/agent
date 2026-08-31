// Integration test against a real in-process HTTP server shaped like the
// Hindsight (Vectorize) API: POST .../memories to write, POST
// .../memories/recall to recall, Bearer auth. No live Hindsight account
// involved.

import { type Server, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHindsightProvider } from './hindsightProvider.js';

let server: Server;
let baseURL = '';
let lastPath = '';
let lastBody: Record<string, unknown> | null = null;
let lastAuthHeader: string | undefined;
let recallResponse: unknown = { results: [] };

beforeAll(async () => {
  server = createServer((req, res) => {
    lastPath = req.url ?? '';
    lastAuthHeader = req.headers.authorization as string | undefined;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      lastBody = raw ? (JSON.parse(raw) as Record<string, unknown>) : null;

      if (req.url?.endsWith('/memories/recall') && req.method === 'POST') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(recallResponse));
        return;
      }
      if (req.url?.endsWith('/memories') && req.method === 'POST') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id: 'mem-1' }));
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

describe('HindsightProvider', () => {
  it('writes to the bank-scoped memories endpoint with Bearer auth', async () => {
    const provider = createHindsightProvider({ baseURL, apiKey: 'hs-key', bankId: 'bank1' });
    await provider.record({
      role: 'user',
      content: 'found an IDOR',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    expect(lastPath).toBe('/v1/default/banks/bank1/memories');
    expect(lastBody).toEqual({ text: '[user] found an IDOR' });
    expect(lastAuthHeader).toBe('Bearer hs-key');
  });

  it('omits the Authorization header when no key is configured', async () => {
    const provider = createHindsightProvider({ baseURL, bankId: 'bank2' });
    await provider.record({ role: 'user', content: 'x', createdAt: '2026-01-01T00:00:00.000Z' });
    expect(lastAuthHeader).toBeUndefined();
  });

  it('is a no-op for empty content', async () => {
    lastPath = '';
    const provider = createHindsightProvider({ baseURL, bankId: 'bank3' });
    await provider.record({ role: 'user', content: '  ', createdAt: '2026-01-01T00:00:00.000Z' });
    expect(lastPath).toBe('');
  });

  it('recall posts to the recall endpoint with query + budget + max_tokens', async () => {
    recallResponse = { results: [{ text: 'found an IDOR on /api/orders/{id}' }] };
    const provider = createHindsightProvider({ baseURL, bankId: 'bank4' });
    const out = await provider.recall('idor', 2048);
    expect(lastPath).toBe('/v1/default/banks/bank4/memories/recall');
    expect(lastBody).toEqual({ query: 'idor', budget: 'mid', max_tokens: 2048 });
    expect(out).toContain('found an IDOR on /api/orders/{id}');
  });

  it('recall returns empty string when results is empty', async () => {
    recallResponse = { results: [] };
    const provider = createHindsightProvider({ baseURL, bankId: 'bank5' });
    expect(await provider.recall('nothing')).toBe('');
  });

  it('recall never throws when the server is unreachable', async () => {
    const provider = createHindsightProvider({ baseURL: 'http://127.0.0.1:1', bankId: 'bank6' });
    await expect(provider.recall('anything')).resolves.toBe('');
  });

  it('systemPromptContext reflects successful record() calls', async () => {
    const provider = createHindsightProvider({ baseURL, bankId: 'bank7' });
    expect(provider.systemPromptContext()).toBe('');
    await provider.record({
      role: 'assistant',
      content: 'noted',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    expect(provider.systemPromptContext()).toContain('1 turn');
  });

  it('exposes the shared memory_provider_search tool named after this provider', () => {
    const provider = createHindsightProvider({ baseURL, bankId: 'bank8' });
    expect(provider.name()).toBe('hindsight');
    expect(provider.tools()[0]?.name()).toBe('memory_provider_search');
  });
});

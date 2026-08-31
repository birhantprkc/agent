// Integration test against a real in-process HTTP server shaped like the
// Supermemory API: POST /v3/documents to add, POST /v3/search to recall,
// containerTag namespacing, Bearer auth. No live Supermemory account
// involved.

import { type Server, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSupermemoryProvider } from './supermemoryProvider.js';

let server: Server;
let baseURL = '';
let lastPath = '';
let lastBody: Record<string, unknown> | null = null;
let lastAuthHeader: string | undefined;
let searchResponse: unknown = { results: [] };

beforeAll(async () => {
  server = createServer((req, res) => {
    lastPath = req.url ?? '';
    lastAuthHeader = req.headers.authorization as string | undefined;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      lastBody = raw ? (JSON.parse(raw) as Record<string, unknown>) : null;

      if (req.url === '/v3/search' && req.method === 'POST') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(searchResponse));
        return;
      }
      if (req.url === '/v3/documents' && req.method === 'POST') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id: 'doc-1', status: 'queued' }));
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

describe('SupermemoryProvider', () => {
  it('adds a document tagged instant with the configured containerTag, Bearer auth', async () => {
    const provider = createSupermemoryProvider({
      baseURL,
      apiKey: 'sm-key',
      containerTag: 'engagement-1',
    });
    await provider.record({
      role: 'user',
      content: 'found an IDOR',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    expect(lastPath).toBe('/v3/documents');
    expect(lastBody).toEqual({
      content: 'user: found an IDOR',
      containerTag: 'engagement-1',
      dreaming: 'instant',
    });
    expect(lastAuthHeader).toBe('Bearer sm-key');
  });

  it('omits the Authorization header when no key is configured', async () => {
    const provider = createSupermemoryProvider({ baseURL, containerTag: 'c2' });
    await provider.record({ role: 'user', content: 'x', createdAt: '2026-01-01T00:00:00.000Z' });
    expect(lastAuthHeader).toBeUndefined();
  });

  it('is a no-op for empty content', async () => {
    lastPath = '';
    const provider = createSupermemoryProvider({ baseURL, containerTag: 'c3' });
    await provider.record({ role: 'user', content: '  ', createdAt: '2026-01-01T00:00:00.000Z' });
    expect(lastPath).toBe('');
  });

  it('recall searches with q + containerTag + searchMode: memories + limit', async () => {
    searchResponse = { results: [{ memory: 'found an IDOR on /api/orders/{id}' }] };
    const provider = createSupermemoryProvider({ baseURL, containerTag: 'c4' });
    const out = await provider.recall('idor', 3);
    expect(lastPath).toBe('/v3/search');
    expect(lastBody).toEqual({ q: 'idor', containerTag: 'c4', searchMode: 'memories', limit: 3 });
    expect(out).toContain('found an IDOR on /api/orders/{id}');
  });

  it('falls back to content/text fields when memory is absent', async () => {
    searchResponse = { results: [{ content: 'via content field' }] };
    const provider = createSupermemoryProvider({ baseURL, containerTag: 'c5' });
    expect(await provider.recall('anything')).toContain('via content field');
  });

  it('recall returns empty string when nothing matches', async () => {
    searchResponse = { results: [] };
    const provider = createSupermemoryProvider({ baseURL, containerTag: 'c6' });
    expect(await provider.recall('nothing')).toBe('');
  });

  it('recall never throws when the server is unreachable', async () => {
    const provider = createSupermemoryProvider({
      baseURL: 'http://127.0.0.1:1',
      containerTag: 'c7',
    });
    await expect(provider.recall('anything')).resolves.toBe('');
  });

  it('exposes the shared memory_provider_search tool named after this provider', () => {
    const provider = createSupermemoryProvider({ baseURL, containerTag: 'c8' });
    expect(provider.name()).toBe('supermemory');
    expect(provider.tools()[0]?.name()).toBe('memory_provider_search');
  });
});

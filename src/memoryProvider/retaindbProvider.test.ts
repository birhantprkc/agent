// Integration test against a real in-process HTTP server shaped like
// RetainDB's generic memory API: POST /v1/memory to write, POST
// /v1/memory/search to recall, Bearer auth. No live RetainDB account
// involved.

import { type Server, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRetainDBProvider } from './retaindbProvider.js';

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

      if (req.url === '/v1/memory/search' && req.method === 'POST') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(searchResponse));
        return;
      }
      if (req.url === '/v1/memory' && req.method === 'POST') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id: 'm1' }));
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

describe('RetainDBProvider', () => {
  it('writes to /v1/memory scoped by project + user_id, with Bearer auth', async () => {
    const provider = createRetainDBProvider({
      baseURL,
      apiKey: 'rdb-key',
      project: 'proj1',
      userId: 'u1',
    });
    await provider.record({
      role: 'user',
      content: 'found an IDOR',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    expect(lastPath).toBe('/v1/memory');
    expect(lastBody).toEqual({ content: '[user] found an IDOR', project: 'proj1', user_id: 'u1' });
    expect(lastAuthHeader).toBe('Bearer rdb-key');
  });

  it('omits the Authorization header when no key is configured', async () => {
    const provider = createRetainDBProvider({ baseURL, project: 'proj2' });
    await provider.record({ role: 'user', content: 'x', createdAt: '2026-01-01T00:00:00.000Z' });
    expect(lastAuthHeader).toBeUndefined();
  });

  it('is a no-op for empty content', async () => {
    lastPath = '';
    const provider = createRetainDBProvider({ baseURL, project: 'proj3' });
    await provider.record({ role: 'user', content: '  ', createdAt: '2026-01-01T00:00:00.000Z' });
    expect(lastPath).toBe('');
  });

  it('recall posts to /v1/memory/search with query + project + user_id + limit', async () => {
    searchResponse = { results: [{ content: 'found an IDOR on /api/orders/{id}' }] };
    const provider = createRetainDBProvider({ baseURL, project: 'proj4', userId: 'u4' });
    const out = await provider.recall('idor', 3);
    expect(lastPath).toBe('/v1/memory/search');
    expect(lastBody).toEqual({ query: 'idor', project: 'proj4', user_id: 'u4', limit: 3 });
    expect(out).toContain('found an IDOR on /api/orders/{id}');
  });

  it('recall also accepts a bare-array response shape', async () => {
    searchResponse = [{ content: 'bare array result' }];
    const provider = createRetainDBProvider({ baseURL, project: 'proj5' });
    expect(await provider.recall('anything')).toContain('bare array result');
  });

  it('recall returns empty string when nothing matches', async () => {
    searchResponse = { results: [] };
    const provider = createRetainDBProvider({ baseURL, project: 'proj6' });
    expect(await provider.recall('nothing')).toBe('');
  });

  it('recall never throws when the server is unreachable', async () => {
    const provider = createRetainDBProvider({ baseURL: 'http://127.0.0.1:1', project: 'proj7' });
    await expect(provider.recall('anything')).resolves.toBe('');
  });

  it('exposes the shared memory_provider_search tool named after this provider', () => {
    const provider = createRetainDBProvider({ baseURL, project: 'proj8' });
    expect(provider.name()).toBe('retaindb');
    expect(provider.tools()[0]?.name()).toBe('memory_provider_search');
  });
});

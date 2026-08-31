// Integration test against a real in-process HTTP server shaped like the
// OpenViking self-hosted server: POST /api/v1/search/find to recall, POST
// /api/v1/resources to store. No live OpenViking server involved.

import { type Server, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createOpenVikingProvider } from './openvikingProvider.js';

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

      if (req.url === '/api/v1/search/find' && req.method === 'POST') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(searchResponse));
        return;
      }
      if (req.url === '/api/v1/resources' && req.method === 'POST') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id: 'r1' }));
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

describe('OpenVikingProvider', () => {
  it('defaults to the local server address when no baseURL is given', () => {
    const provider = createOpenVikingProvider({});
    expect(provider.name()).toBe('openviking');
  });

  it('stores content via POST /api/v1/resources with Bearer auth', async () => {
    const provider = createOpenVikingProvider({ baseURL, apiKey: 'ov-key' });
    await provider.record({
      role: 'user',
      content: 'found an IDOR',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    expect(lastPath).toBe('/api/v1/resources');
    expect(lastBody).toEqual({ content: 'user: found an IDOR' });
    expect(lastAuthHeader).toBe('Bearer ov-key');
  });

  it('omits the Authorization header when no key is configured', async () => {
    const provider = createOpenVikingProvider({ baseURL });
    await provider.record({ role: 'user', content: 'x', createdAt: '2026-01-01T00:00:00.000Z' });
    expect(lastAuthHeader).toBeUndefined();
  });

  it('is a no-op for empty content', async () => {
    lastPath = '';
    const provider = createOpenVikingProvider({ baseURL });
    await provider.record({ role: 'user', content: '  ', createdAt: '2026-01-01T00:00:00.000Z' });
    expect(lastPath).toBe('');
  });

  it('recall posts to /api/v1/search/find with query + limit', async () => {
    searchResponse = { results: [{ text: 'found an IDOR on /api/orders/{id}' }] };
    const provider = createOpenVikingProvider({ baseURL });
    const out = await provider.recall('idor', 3);
    expect(lastPath).toBe('/api/v1/search/find');
    expect(lastBody).toEqual({ query: 'idor', limit: 3 });
    expect(out).toContain('found an IDOR on /api/orders/{id}');
  });

  it('accepts resources/items response key variants too', async () => {
    searchResponse = { resources: [{ content: 'via resources key' }] };
    const provider = createOpenVikingProvider({ baseURL });
    expect(await provider.recall('anything')).toContain('via resources key');

    searchResponse = { items: [{ summary: 'via items key' }] };
    expect(await provider.recall('anything')).toContain('via items key');
  });

  it('recall returns empty string when nothing matches', async () => {
    searchResponse = { results: [] };
    const provider = createOpenVikingProvider({ baseURL });
    expect(await provider.recall('nothing')).toBe('');
  });

  it('recall never throws when the server is unreachable', async () => {
    const provider = createOpenVikingProvider({ baseURL: 'http://127.0.0.1:1' });
    await expect(provider.recall('anything')).resolves.toBe('');
  });

  it('exposes the shared memory_provider_search tool named after this provider', () => {
    const provider = createOpenVikingProvider({ baseURL });
    expect(provider.tools()[0]?.name()).toBe('memory_provider_search');
  });
});

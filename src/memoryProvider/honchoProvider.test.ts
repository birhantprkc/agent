// Integration test against a real in-process HTTP server shaped like the
// Honcho API (per honcho.dev/docs/v3/openapi.json): workspace-scoped
// sessions, POST .../messages to record, POST .../search to recall, Bearer
// auth. No live Honcho account involved.

import { type Server, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHonchoProvider } from './honchoProvider.js';

let server: Server;
let baseURL = '';
let lastPath = '';
let lastBody: Record<string, unknown> | null = null;
let lastAuthHeader: string | undefined;
let sessionCreateCalls = 0;
let searchResponse: unknown = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    lastPath = req.url ?? '';
    lastAuthHeader = req.headers.authorization as string | undefined;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      lastBody = raw ? (JSON.parse(raw) as Record<string, unknown>) : null;

      if (req.url?.endsWith('/sessions') && req.method === 'POST') {
        sessionCreateCalls += 1;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id: 'session-abc' }));
        return;
      }
      if (req.url?.endsWith('/messages') && req.method === 'POST') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify([{ id: 'm1' }]));
        return;
      }
      if (req.url?.endsWith('/search') && req.method === 'POST') {
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

describe('HonchoProvider', () => {
  it('creates a session lazily on first record(), then reuses it', async () => {
    sessionCreateCalls = 0;
    const provider = createHonchoProvider({ baseURL, apiKey: 'hch-test', workspaceId: 'ws1' });
    await provider.record({
      role: 'user',
      content: 'found an IDOR',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    expect(lastPath).toBe('/v3/workspaces/ws1/sessions/session-abc/messages');
    expect(lastBody).toEqual({ messages: [{ peer_id: 'user', content: 'found an IDOR' }] });
    expect(lastAuthHeader).toBe('Bearer hch-test');
    expect(sessionCreateCalls).toBe(1);

    await provider.record({
      role: 'assistant',
      content: 'noted',
      createdAt: '2026-01-01T00:00:01.000Z',
    });
    expect(sessionCreateCalls).toBe(1); // session reused, not recreated
  });

  it('tags assistant messages with the configured peer name', async () => {
    const provider = createHonchoProvider({
      baseURL,
      workspaceId: 'ws2',
      peerName: 'pentesterflow-bot',
    });
    await provider.record({
      role: 'assistant',
      content: 'done',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    expect(lastBody).toEqual({ messages: [{ peer_id: 'pentesterflow-bot', content: 'done' }] });
  });

  it('omits the Authorization header when no key is configured', async () => {
    const provider = createHonchoProvider({ baseURL, workspaceId: 'ws3' });
    await provider.record({ role: 'user', content: 'x', createdAt: '2026-01-01T00:00:00.000Z' });
    expect(lastAuthHeader).toBeUndefined();
  });

  it('is a no-op for empty content — never creates a session or sends a request', async () => {
    sessionCreateCalls = 0;
    lastPath = '';
    const provider = createHonchoProvider({ baseURL, workspaceId: 'ws4' });
    await provider.record({ role: 'user', content: '   ', createdAt: '2026-01-01T00:00:00.000Z' });
    expect(sessionCreateCalls).toBe(0);
    expect(lastPath).toBe('');
  });

  it('recall searches at the workspace level without needing a session', async () => {
    searchResponse = [{ content: 'found an IDOR on /api/orders/{id}' }];
    const provider = createHonchoProvider({ baseURL, workspaceId: 'ws5' });
    const out = await provider.recall('idor');
    expect(lastPath).toBe('/v3/workspaces/ws5/search');
    expect(out).toContain('found an IDOR on /api/orders/{id}');
  });

  it('recall returns empty string when nothing matches', async () => {
    searchResponse = [];
    const provider = createHonchoProvider({ baseURL, workspaceId: 'ws6' });
    expect(await provider.recall('nothing')).toBe('');
  });

  it('recall never throws when the server is unreachable', async () => {
    const provider = createHonchoProvider({ baseURL: 'http://127.0.0.1:1', workspaceId: 'ws7' });
    await expect(provider.recall('anything')).resolves.toBe('');
  });

  it('record never throws when the session-create call fails', async () => {
    const provider = createHonchoProvider({ baseURL: 'http://127.0.0.1:1', workspaceId: 'ws8' });
    await expect(
      provider.record({ role: 'user', content: 'x', createdAt: '2026-01-01T00:00:00.000Z' }),
    ).resolves.toBeUndefined();
  });

  it('exposes the shared memory_provider_search tool named after this provider', () => {
    const provider = createHonchoProvider({ baseURL, workspaceId: 'ws9' });
    expect(provider.name()).toBe('honcho');
    const tools = provider.tools();
    expect(tools).toHaveLength(1);
    expect(tools[0]?.name()).toBe('memory_provider_search');
  });
});

// Integration test for the Anthropic client against a real in-process HTTP
// server. Covers request encoding (including prompt-cache breakpoints on
// the system prompt + tool catalog), response mapping, and error surfacing.

import { type Server, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AnthropicClient } from './anthropic.js';
import type { ChatRequest } from './types.js';

let server: Server;
let baseURL = '';
let lastBody: Record<string, unknown> | null = null;
let lastApiKeyHeader: string | undefined;
let nextStatus = 200;
let nextResponse: unknown = {};

beforeAll(async () => {
  server = createServer((req, res) => {
    lastApiKeyHeader = req.headers['x-api-key'] as string | undefined;
    if (req.method === 'GET' && req.url === '/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [] }));
      return;
    }
    if (req.method !== 'POST' || req.url !== '/messages') {
      res.writeHead(404);
      res.end();
      return;
    }
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      lastBody = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
      res.writeHead(nextStatus, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(nextResponse));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address() as AddressInfo;
  baseURL = `http://127.0.0.1:${addr.port}`;
});

afterAll(() => {
  server.close();
});

function client(): AnthropicClient {
  return new AnthropicClient(baseURL, 'sk-ant-test', 'claude-test');
}

describe('AnthropicClient request encoding', () => {
  it('marks the system prompt as a cacheable ephemeral block', async () => {
    nextStatus = 200;
    nextResponse = { content: [{ type: 'text', text: 'hi' }], stop_reason: 'end_turn' };
    const req: ChatRequest = {
      model: 'claude-test',
      messages: [
        { role: 'system', content: 'You are a pentest assistant.' },
        { role: 'user', content: 'hello' },
      ],
    };
    await client().chat(req);
    expect(lastBody?.system).toEqual([
      {
        type: 'text',
        text: 'You are a pentest assistant.',
        cache_control: { type: 'ephemeral' },
      },
    ]);
  });

  it('marks the last tool definition as a cacheable ephemeral breakpoint', async () => {
    nextStatus = 200;
    nextResponse = { content: [{ type: 'text', text: 'hi' }], stop_reason: 'end_turn' };
    const req: ChatRequest = {
      model: 'claude-test',
      messages: [{ role: 'user', content: 'hello' }],
      tools: [
        { type: 'function', function: { name: 'http', description: 'send http', parameters: {} } },
        { type: 'function', function: { name: 'shell', description: 'run shell', parameters: {} } },
      ],
    };
    await client().chat(req);
    const tools = lastBody?.tools as Array<Record<string, unknown>>;
    expect(tools).toHaveLength(2);
    expect(tools[0].cache_control).toBeUndefined();
    expect(tools[1].cache_control).toEqual({ type: 'ephemeral' });
  });

  it('sends the api key via x-api-key, never as a query param', async () => {
    nextStatus = 200;
    nextResponse = { content: [{ type: 'text', text: 'hi' }], stop_reason: 'end_turn' };
    await client().chat({ model: 'claude-test', messages: [{ role: 'user', content: 'hi' }] });
    expect(lastApiKeyHeader).toBe('sk-ant-test');
  });
});

describe('AnthropicClient response mapping', () => {
  it('maps text + tool_use content blocks and tool_use finish reason', async () => {
    nextStatus = 200;
    nextResponse = {
      content: [
        { type: 'text', text: 'checking now' },
        { type: 'tool_use', id: 'toolu_1', name: 'http', input: { url: 'https://example.com' } },
      ],
      stop_reason: 'tool_use',
    };
    const out = await client().chat({
      model: 'claude-test',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(out.message.content).toBe('checking now');
    expect(out.message.toolCalls).toEqual([
      {
        id: 'toolu_1',
        type: 'function',
        function: { name: 'http', arguments: JSON.stringify({ url: 'https://example.com' }) },
      },
    ]);
    expect(out.finishReason).toBe('tool_calls');
  });

  it('maps max_tokens stop_reason to length', async () => {
    nextStatus = 200;
    nextResponse = { content: [{ type: 'text', text: 'partial' }], stop_reason: 'max_tokens' };
    const out = await client().chat({
      model: 'claude-test',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(out.finishReason).toBe('length');
  });

  it('surfaces an API error body as a thrown error instead of a message', async () => {
    nextStatus = 400;
    nextResponse = { error: { message: 'invalid request: bad model' } };
    await expect(
      client().chat({ model: 'claude-test', messages: [{ role: 'user', content: 'hi' }] }),
    ).rejects.toThrow(/bad model/);
  });
});

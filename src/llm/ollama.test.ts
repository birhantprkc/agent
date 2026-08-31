// Integration test for the Ollama client against a real in-process HTTP
// server. We don't mock fetch — we want to exercise the actual streaming
// + parsing path end-to-end.

import { type Server, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OllamaClient } from './ollama.js';
import type { ChatRequest } from './types.js';

let server: Server;
let baseURL = '';
let lastBody: Record<string, unknown> | null = null;

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/api/tags') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ models: [] }));
      return;
    }
    if (req.method !== 'POST' || req.url !== '/api/chat') {
      res.writeHead(404);
      res.end();
      return;
    }
    // Read request body, decide based on the model field.
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
        model: string;
        stream?: boolean;
      };
      lastBody = body as Record<string, unknown>;

      if (body.model === 'length-truncated') {
        // Non-streaming response truncated at the token cap.
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            message: { role: 'assistant', content: 'partial' },
            done: true,
            done_reason: 'length',
          }),
        );
        return;
      }

      if (body.model === 'thinking-nonstream') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            message: {
              role: 'assistant',
              content: 'the answer is 42',
              thinking: 'let me work it out',
            },
            done: true,
            done_reason: 'stop',
          }),
        );
        return;
      }

      if (body.model === 'thinking-only-nonstream') {
        // Whole budget spent thinking — content empty, thinking has the only text.
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            message: {
              role: 'assistant',
              content: '',
              thinking: 'still ruminating, ran out of tokens',
            },
            done: true,
            done_reason: 'length',
          }),
        );
        return;
      }

      if (body.model === 'usage-nonstream') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            message: { role: 'assistant', content: 'hi' },
            done: true,
            done_reason: 'stop',
            prompt_eval_count: 30,
            eval_count: 5,
          }),
        );
        return;
      }

      if (body.model === 'usage-stream') {
        // Counts only appear on the terminal done:true chunk.
        res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
        res.write(`${JSON.stringify({ message: { role: 'assistant', content: 'hi ' } })}\n`);
        res.end(
          `${JSON.stringify({
            message: { role: 'assistant', content: 'there' },
            done: true,
            done_reason: 'stop',
            prompt_eval_count: 33,
            eval_count: 8,
          })}\n`,
        );
        return;
      }

      if (body.model === 'thinking-stream') {
        res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
        res.write(
          `${JSON.stringify({ message: { role: 'assistant', content: '', thinking: 'Let' } })}\n`,
        );
        res.write(
          `${JSON.stringify({ message: { role: 'assistant', content: '', thinking: ' me think.' } })}\n`,
        );
        res.write(`${JSON.stringify({ message: { role: 'assistant', content: '42' } })}\n`);
        res.end(
          `${JSON.stringify({ message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop' })}\n`,
        );
        return;
      }

      if (body.model === 'thinking-only-stream') {
        // Model spends its whole budget thinking — content never arrives.
        res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
        res.write(
          `${JSON.stringify({ message: { role: 'assistant', content: '', thinking: 'stuck ruminating' } })}\n`,
        );
        res.end(
          `${JSON.stringify({ message: { role: 'assistant', content: '' }, done: true, done_reason: 'length' })}\n`,
        );
        return;
      }

      if (body.model === 'streaming-length-truncated') {
        // Streaming terminal chunk carries done_reason=length.
        res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
        res.write(`${JSON.stringify({ message: { role: 'assistant', content: 'half ' } })}\n`);
        res.end(
          `${JSON.stringify({
            message: { role: 'assistant', content: 'answer' },
            done: true,
            done_reason: 'length',
          })}\n`,
        );
        return;
      }

      if (body.model === 'streaming-with-tool') {
        // Tool call delivered in a mid-stream chunk; final chunk carries done:true with empty content.
        res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
        res.write(
          `${JSON.stringify({ message: { role: 'assistant', content: 'Looking up... ' } })}\n`,
        );
        res.write(
          `${JSON.stringify({
            message: {
              role: 'assistant',
              content: '',
              tool_calls: [
                { function: { name: 'http', arguments: { url: 'https://x.example.com' } } },
              ],
            },
          })}\n`,
        );
        res.end(`${JSON.stringify({ message: { role: 'assistant', content: '' }, done: true })}\n`);
        return;
      }

      if (body.model === 'streaming-malformed-chunk') {
        // Insert a malformed line between two valid ones — should be
        // dropped + logged, but the surrounding chunks should still parse.
        res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
        res.write(`${JSON.stringify({ message: { role: 'assistant', content: 'hi' } })}\n`);
        res.write('{ not valid json\n');
        res.end(
          `${JSON.stringify({ message: { role: 'assistant', content: ' there' }, done: true })}\n`,
        );
        return;
      }

      if (body.model === 'content-json-tool-call') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            message: {
              role: 'assistant',
              content: JSON.stringify({
                name: 'http',
                arguments: { method: 'GET', url: 'https://x.example.com' },
              }),
            },
            done: true,
          }),
        );
        return;
      }

      if (body.model === 'content-fenced-tool-calls') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            message: {
              role: 'assistant',
              content: `\`\`\`json
${JSON.stringify({
  tool_calls: [
    {
      function: {
        name: 'http',
        arguments: '{"url":"https://x.example.com/a","method":"POST"}',
      },
    },
  ],
})}
\`\`\``,
            },
            done: true,
          }),
        );
        return;
      }

      if (body.model === 'streaming-content-json-tool-call') {
        res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
        res.write(
          `${JSON.stringify({ message: { role: 'assistant', content: '{"name":"http",' } })}\n`,
        );
        res.write(
          `${JSON.stringify({
            message: {
              role: 'assistant',
              content: '"arguments":{"url":"https://x.example.com/stream"}}',
            },
            done: true,
          })}\n`,
        );
        return;
      }

      if (body.model === 'content-qwen-action-tool-call') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            message: {
              role: 'assistant',
              content: JSON.stringify({
                action: 'http',
                action_input: { url: 'https://x.example.com/action' },
              }),
            },
            done: true,
          }),
        );
        return;
      }

      if (body.model === 'content-function-string-tool-call') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            message: {
              role: 'assistant',
              content: JSON.stringify({
                function: 'http',
                parameters: { url: 'https://x.example.com/function-string' },
              }),
            },
            done: true,
          }),
        );
        return;
      }

      if (body.model === 'content-singular-tool-call') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            message: {
              role: 'assistant',
              content: JSON.stringify({
                tool_call: {
                  name: 'http',
                  args: { url: 'https://x.example.com/singular' },
                },
              }),
            },
            done: true,
          }),
        );
        return;
      }

      // Default non-streaming response.
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          message: { role: 'assistant', content: 'hello back' },
          done: true,
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address() as AddressInfo;
  baseURL = `http://127.0.0.1:${addr.port}`;
});

afterAll(() => {
  server?.close();
});

describe('OllamaClient', () => {
  it('non-streaming chat returns the assembled message', async () => {
    const c = new OllamaClient(baseURL, 'qwen2.5:7b');
    const req: ChatRequest = {
      model: 'qwen2.5:7b',
      messages: [{ role: 'user', content: 'hi' }],
    };
    const out = await c.chat(req);
    expect(out.message.content).toBe('hello back');
    expect(out.finishReason).toBe('stop');
  });

  it('forwards tool_name on role:tool messages for multi-tool association', async () => {
    lastBody = null;
    const c = new OllamaClient(baseURL, 'qwen2.5:7b');
    await c.chat({
      model: 'qwen2.5:7b',
      messages: [
        { role: 'user', content: 'go' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [
            { id: '1', type: 'function', function: { name: 'http', arguments: '{}' } },
            { id: '2', type: 'function', function: { name: 'shell', arguments: '{}' } },
          ],
        },
        { role: 'tool', content: 'ok-http', toolCallID: '1', name: 'http' },
        { role: 'tool', content: 'ok-shell', toolCallID: '2', name: 'shell' },
      ],
    });
    const msgs = lastBody?.messages as Array<{
      role: string;
      tool_name?: string;
      content?: string;
    }>;
    expect(msgs).toBeTruthy();
    const toolMsgs = msgs.filter((m) => m.role === 'tool');
    expect(toolMsgs).toHaveLength(2);
    expect(toolMsgs[0]?.tool_name).toBe('http');
    expect(toolMsgs[1]?.tool_name).toBe('shell');
  });

  it('non-streaming chat maps prompt_eval_count/eval_count to usage', async () => {
    const c = new OllamaClient(baseURL, 'usage-nonstream');
    const out = await c.chat({
      model: 'usage-nonstream',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(out.usage).toEqual({ inputTokens: 30, outputTokens: 5 });
  });

  it('streaming chat maps usage from the terminal done:true chunk', async () => {
    const c = new OllamaClient(baseURL, 'usage-stream');
    const out = await c.chatStream(
      { model: 'usage-stream', messages: [{ role: 'user', content: 'hi' }] },
      () => undefined,
    );
    expect(out.usage).toEqual({ inputTokens: 33, outputTokens: 8 });
  });

  it('leaves usage undefined when the backend reports no counts', async () => {
    const c = new OllamaClient(baseURL, 'qwen2.5:7b');
    const out = await c.chat({ model: 'qwen2.5:7b', messages: [{ role: 'user', content: 'hi' }] });
    expect(out.usage).toBeUndefined();
  });

  it('streams thinking as visible deltas but excludes it from the returned message', async () => {
    const c = new OllamaClient(baseURL, 'thinking-stream');
    const deltas: string[] = [];
    const out = await c.chatStream(
      { model: 'thinking-stream', messages: [{ role: 'user', content: 'go' }] },
      (d) => deltas.push(d),
    );
    expect(deltas.join('')).toBe('Let me think.42');
    expect(out.message.content).toBe('42');
    expect(out.message.content).not.toContain('Let me think');
  });

  it('non-streaming chat keeps thinking out of content when content is present', async () => {
    const c = new OllamaClient(baseURL, 'thinking-nonstream');
    const out = await c.chat({
      model: 'thinking-nonstream',
      messages: [{ role: 'user', content: 'go' }],
    });
    expect(out.message.content).toBe('the answer is 42');
    expect(out.message.content).not.toContain('let me work it out');
  });

  it('non-streaming returns empty content when the model spent its whole budget reasoning (never re-enters history)', async () => {
    const c = new OllamaClient(baseURL, 'thinking-only-nonstream');
    const out = await c.chat({
      model: 'thinking-only-nonstream',
      messages: [{ role: 'user', content: 'go' }],
    });
    // The old fallback-to-thinking behavior let raw chain-of-thought re-enter
    // history via message.content, contradicting this file's own invariant
    // that reasoning stays out of the returned message — an empty turn is
    // the correct outcome here, matching what streaming already does below.
    expect(out.message.content).toBe('');
    expect(out.finishReason).toBe('length');
  });

  it('streaming shows accumulated thinking live but returns empty content (never re-enters history)', async () => {
    const c = new OllamaClient(baseURL, 'thinking-only-stream');
    const deltas: string[] = [];
    const out = await c.chatStream(
      { model: 'thinking-only-stream', messages: [{ role: 'user', content: 'go' }] },
      (d) => deltas.push(d),
    );
    expect(deltas.join('')).toBe('stuck ruminating');
    expect(out.message.content).toBe('');
    expect(out.finishReason).toBe('length');
  });

  it('streaming accumulates tool calls from intermediate chunks', async () => {
    const c = new OllamaClient(baseURL, 'streaming-with-tool');
    const deltas: string[] = [];
    const req: ChatRequest = {
      model: 'streaming-with-tool',
      messages: [{ role: 'user', content: 'do it' }],
    };
    const out = await c.chatStream(req, (d) => deltas.push(d));
    expect(deltas.join('')).toBe('Looking up... ');
    expect(out.message.toolCalls).toHaveLength(1);
    expect(out.message.toolCalls?.[0]?.function.name).toBe('http');
    expect(out.finishReason).toBe('tool_calls');
  });

  it('streaming survives a malformed chunk and keeps the surrounding text', async () => {
    const c = new OllamaClient(baseURL, 'streaming-malformed-chunk');
    const deltas: string[] = [];
    const out = await c.chatStream(
      { model: 'streaming-malformed-chunk', messages: [{ role: 'user', content: 'x' }] },
      (d) => deltas.push(d),
    );
    expect(deltas.join('')).toBe('hi there');
    expect(out.message.content).toBe('hi there');
  });

  it('non-streaming parses JSON content tool calls for Ollama models that do not emit native tool_calls', async () => {
    const c = new OllamaClient(baseURL, 'content-json-tool-call');
    const out = await c.chat({
      model: 'content-json-tool-call',
      messages: [{ role: 'user', content: 'fetch it' }],
      tools: [
        {
          type: 'function',
          function: { name: 'http', description: 'http tool', parameters: {} },
        },
      ],
    });

    expect(out.message.toolCalls).toHaveLength(1);
    expect(out.message.toolCalls?.[0]?.function.name).toBe('http');
    expect(out.message.toolCalls?.[0]?.function.arguments).toBe(
      '{"method":"GET","url":"https://x.example.com"}',
    );
    // The raw JSON must not leak into the transcript once lifted into a tool call.
    expect(out.message.content).toBe('');
    expect(out.finishReason).toBe('tool_calls');
  });

  it('non-streaming parses fenced tool_calls content with string arguments', async () => {
    const c = new OllamaClient(baseURL, 'content-fenced-tool-calls');
    const out = await c.chat({
      model: 'content-fenced-tool-calls',
      messages: [{ role: 'user', content: 'fetch it' }],
      tools: [
        {
          type: 'function',
          function: { name: 'http', description: 'http tool', parameters: {} },
        },
      ],
    });

    expect(out.message.toolCalls).toHaveLength(1);
    expect(out.message.toolCalls?.[0]?.function.name).toBe('http');
    expect(out.message.toolCalls?.[0]?.function.arguments).toBe(
      '{"url":"https://x.example.com/a","method":"POST"}',
    );
  });

  it('streaming parses JSON content tool calls when native tool_calls are absent', async () => {
    const c = new OllamaClient(baseURL, 'streaming-content-json-tool-call');
    const deltas: string[] = [];
    const out = await c.chatStream(
      {
        model: 'streaming-content-json-tool-call',
        messages: [{ role: 'user', content: 'fetch it' }],
        tools: [
          {
            type: 'function',
            function: { name: 'http', description: 'http tool', parameters: {} },
          },
        ],
      },
      (d) => deltas.push(d),
    );

    expect(deltas.join('')).toBe(
      '{"name":"http","arguments":{"url":"https://x.example.com/stream"}}',
    );
    expect(out.message.toolCalls).toHaveLength(1);
    expect(out.message.toolCalls?.[0]?.function.arguments).toBe(
      '{"url":"https://x.example.com/stream"}',
    );
    // Content cleared so the raw JSON isn't replayed alongside the tool call.
    expect(out.message.content).toBe('');
    expect(out.finishReason).toBe('tool_calls');
  });

  it('does not execute JSON content for unknown tools', async () => {
    const c = new OllamaClient(baseURL, 'content-json-tool-call');
    const out = await c.chat({
      model: 'content-json-tool-call',
      messages: [{ role: 'user', content: 'fetch it' }],
      tools: [
        {
          type: 'function',
          function: { name: 'shell', description: 'shell tool', parameters: {} },
        },
      ],
    });

    expect(out.message.toolCalls).toBeUndefined();
    // Nothing was extracted, so the original content is preserved (not cleared).
    expect(out.message.content).not.toBe('');
    expect(out.finishReason).toBe('stop');
  });

  it('parses Qwen-style action/action_input content tool calls', async () => {
    const c = new OllamaClient(baseURL, 'content-qwen-action-tool-call');
    const out = await c.chat({
      model: 'content-qwen-action-tool-call',
      messages: [{ role: 'user', content: 'fetch it' }],
      tools: [
        {
          type: 'function',
          function: { name: 'http', description: 'http tool', parameters: {} },
        },
      ],
    });

    expect(out.message.toolCalls).toHaveLength(1);
    expect(out.message.toolCalls?.[0]?.function.arguments).toBe(
      '{"url":"https://x.example.com/action"}',
    );
    expect(out.finishReason).toBe('tool_calls');
  });

  it('parses function string and parameters content tool calls', async () => {
    const c = new OllamaClient(baseURL, 'content-function-string-tool-call');
    const out = await c.chat({
      model: 'content-function-string-tool-call',
      messages: [{ role: 'user', content: 'fetch it' }],
      tools: [
        {
          type: 'function',
          function: { name: 'http', description: 'http tool', parameters: {} },
        },
      ],
    });

    expect(out.message.toolCalls).toHaveLength(1);
    expect(out.message.toolCalls?.[0]?.function.arguments).toBe(
      '{"url":"https://x.example.com/function-string"}',
    );
  });

  it('parses singular tool_call content tool calls', async () => {
    const c = new OllamaClient(baseURL, 'content-singular-tool-call');
    const out = await c.chat({
      model: 'content-singular-tool-call',
      messages: [{ role: 'user', content: 'fetch it' }],
      tools: [
        {
          type: 'function',
          function: { name: 'http', description: 'http tool', parameters: {} },
        },
      ],
    });

    expect(out.message.toolCalls).toHaveLength(1);
    expect(out.message.toolCalls?.[0]?.function.arguments).toBe(
      '{"url":"https://x.example.com/singular"}',
    );
  });

  it('sends a default num_ctx floor of 8192 when unconfigured', async () => {
    const c = new OllamaClient(baseURL, 'qwen2.5:7b');
    await c.chat({ model: 'qwen2.5:7b', messages: [{ role: 'user', content: 'hi' }] });
    expect((lastBody?.options as { num_ctx?: number })?.num_ctx).toBe(8192);
  });

  it('sends a configured num_ctx (constructor or setNumCtx) verbatim', async () => {
    const c = new OllamaClient(baseURL, 'qwen2.5:7b', 32768);
    await c.chat({ model: 'qwen2.5:7b', messages: [{ role: 'user', content: 'hi' }] });
    expect((lastBody?.options as { num_ctx?: number })?.num_ctx).toBe(32768);

    c.setNumCtx(16384);
    await c.chat({ model: 'qwen2.5:7b', messages: [{ role: 'user', content: 'hi' }] });
    expect((lastBody?.options as { num_ctx?: number })?.num_ctx).toBe(16384);
  });

  it('forwards configured temperature and max_tokens as options', async () => {
    const c = new OllamaClient(baseURL, 'qwen2.5:7b', undefined, {
      temperature: 0.2,
      maxTokens: 512,
    });
    await c.chat({ model: 'qwen2.5:7b', messages: [{ role: 'user', content: 'hi' }] });
    const opts = lastBody?.options as { temperature?: number; num_predict?: number };
    expect(opts?.temperature).toBe(0.2);
    expect(opts?.num_predict).toBe(512);
  });

  it('omits temperature and num_predict when unconfigured', async () => {
    const c = new OllamaClient(baseURL, 'qwen2.5:7b');
    await c.chat({ model: 'qwen2.5:7b', messages: [{ role: 'user', content: 'hi' }] });
    const opts = lastBody?.options as { temperature?: number; num_predict?: number };
    expect(opts?.temperature).toBeUndefined();
    expect(opts?.num_predict).toBeUndefined();
  });

  it('maps done_reason=length to a length finishReason (non-streaming)', async () => {
    const c = new OllamaClient(baseURL, 'length-truncated');
    const out = await c.chat({
      model: 'length-truncated',
      messages: [{ role: 'user', content: 'go' }],
    });
    expect(out.message.content).toBe('partial');
    expect(out.finishReason).toBe('length');
  });

  it('maps done_reason=length to a length finishReason (streaming)', async () => {
    const c = new OllamaClient(baseURL, 'streaming-length-truncated');
    const deltas: string[] = [];
    const out = await c.chatStream(
      { model: 'streaming-length-truncated', messages: [{ role: 'user', content: 'go' }] },
      (d) => deltas.push(d),
    );
    expect(deltas.join('')).toBe('half answer');
    expect(out.finishReason).toBe('length');
  });

  it('ping succeeds against a live server', async () => {
    const c = new OllamaClient(baseURL, 'qwen2.5:7b');
    await expect(c.ping()).resolves.toBeUndefined();
  });

  it('ping rejects on connection failure', async () => {
    const c = new OllamaClient('http://127.0.0.1:1', 'qwen2.5:7b');
    await expect(c.ping()).rejects.toBeInstanceOf(Error);
  });

  it('strips trailing slashes from baseURL', () => {
    const c = new OllamaClient(`${baseURL}/`, 'qwen2.5:7b');
    expect(c.baseURL).toBe(baseURL);
  });

  it('chat 404 includes model + url context (endpoint-not-found)', async () => {
    // baseURL with an extra path segment so /api/chat never hits the mock route.
    const dead = new OllamaClient(`${baseURL}/nope`, 'qwen2.5:7b');
    await expect(
      dead.chat({ model: 'qwen2.5:7b', messages: [{ role: 'user', content: 'hi' }] }),
    ).rejects.toMatchObject({
      name: 'BackendError',
      statusCode: 404,
      category: 'endpoint-not-found',
    });
  });
});

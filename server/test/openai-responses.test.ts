/**
 * OpenAI Responses API 渠道（openai-responses）：
 * 覆盖请求体结构、SSE 解析（思考 / 文本 / 工具调用多轮往返 / 错误与截断 / 非法 JSON 参数）、
 * 非流式调用（generateText / generateJson / testAiConfig / fetchUpstreamModels）与用量统计。
 */
import assert from 'node:assert/strict';
import { after, afterEach, before, describe, test } from 'node:test';
import { z } from 'zod';
import { setup, type Env } from './helpers.js';

let env: Env;
let aiMod: typeof import('../src/services/ai.js');
let assistantMod: typeof import('../src/services/assistant.js');
let limitMod: typeof import('../src/services/ai-limit.js');

const BASE_URL = 'https://responses.example/v1';
const originalFetch = globalThis.fetch;

function sseResponse(events: Array<{ event?: string; data: unknown }>) {
  const enc = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const e of events) {
        const prefix = e.event ? `event: ${e.event}\n` : '';
        controller.enqueue(enc.encode(`${prefix}data: ${JSON.stringify(e.data)}\n\n`));
      }
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function stubFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (url.startsWith(BASE_URL)) return handler(url, init);
    return originalFetch(input, init);
  }) as typeof fetch;
}

const auth = () => ({
  kind: 'session' as const,
  userId: env.users.alice.id,
  scopes: ['read', 'organize', 'draft', 'send', 'automation', 'admin'],
  scope: { accountIds: null },
});

before(async () => {
  env = await setup();
  aiMod = await import('../src/services/ai.js');
  assistantMod = await import('../src/services/assistant.js');
  limitMod = await import('../src/services/ai-limit.js');

  await aiMod.saveAiSettings({
    enabled: true,
    channels: [
      {
        id: 'resp',
        name: 'OpenAI Responses',
        provider: 'openai-responses',
        baseUrl: BASE_URL,
        apiKey: 'sk-test-key',
        models: ['gpt-6.2-sol'],
        modelsSyncedAt: null,
        prices: { 'gpt-6.2-sol': { input: 2, output: 8, cacheRead: 0.5, cacheWrite: null } },
        priceRate: 1,
      },
    ],
    channelId: 'resp',
    model: 'gpt-6.2-sol',
    effort: 'low',
    assistantChannelId: null,
    assistantModel: null,
    assistantEffort: 'medium',
    translateChannelId: null,
    translateModel: null,
    translateLanguage: '',
    analysisEnabled: true,
    accountIds: null,
  });
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  limitMod.resetAiGates();
});

after(async () => {
  globalThis.fetch = originalFetch;
  await env?.close();
});

describe('OpenAI Responses API assistant loop', () => {
  test('请求体格式、流式思考与文本、工具调用多轮往返及用量累计', async () => {
    const captured: Array<{ url: string; authHeader: string | null; body: Record<string, unknown> }> = [];

    stubFetch((url, init) => {
      const headers = new Headers(init?.headers);
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      captured.push({ url, authHeader: headers.get('authorization'), body });

      if (captured.length === 1) {
        const reasoningItem = {
          id: 'rs_1',
          type: 'reasoning',
          summary: [{ type: 'summary_text', text: 'Need to search mail.' }],
          encrypted_content: 'enc_blob_1',
        };
        const msgItem = {
          id: 'msg_1',
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: 'Checking your inbox.' }],
        };
        const callItem = {
          id: 'fc_1',
          type: 'function_call',
          call_id: 'call_search_1',
          name: 'search_emails',
          arguments: '{"query":"subject:work-mail"}',
        };
        return sseResponse([
          { event: 'response.reasoning_summary_text.delta', data: { type: 'response.reasoning_summary_text.delta', delta: 'Need to search mail.' } },
          { event: 'response.output_item.done', data: { type: 'response.output_item.done', output_index: 0, item: reasoningItem } },
          { event: 'response.output_text.delta', data: { type: 'response.output_text.delta', delta: 'Checking your inbox.' } },
          { event: 'response.output_item.done', data: { type: 'response.output_item.done', output_index: 1, item: msgItem } },
          {
            event: 'response.output_item.added',
            data: { type: 'response.output_item.added', output_index: 2, item: { id: 'fc_1', type: 'function_call', call_id: 'call_search_1', name: 'search_emails', arguments: '' } },
          },
          {
            event: 'response.function_call_arguments.delta',
            data: { type: 'response.function_call_arguments.delta', output_index: 2, item_id: 'fc_1', delta: '{"query":' },
          },
          {
            event: 'response.function_call_arguments.delta',
            data: { type: 'response.function_call_arguments.delta', output_index: 2, item_id: 'fc_1', delta: '"subject:work-mail"}' },
          },
          { event: 'response.output_item.done', data: { type: 'response.output_item.done', output_index: 2, item: callItem } },
          {
            event: 'response.completed',
            data: {
              type: 'response.completed',
              response: {
                status: 'completed',
                output: [reasoningItem, msgItem, callItem],
                usage: { input_tokens: 120, output_tokens: 30, input_tokens_details: { cached_tokens: 40 } },
              },
            },
          },
        ]);
      }

      return sseResponse([
        { event: 'response.output_text.delta', data: { type: 'response.output_text.delta', delta: 'Found work-mail.' } },
        {
          event: 'response.completed',
          data: {
            type: 'response.completed',
            response: {
              status: 'completed',
              output: [{ id: 'msg_2', type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Found work-mail.' }] }],
              usage: { input_tokens: 200, output_tokens: 25, input_tokens_details: { cached_tokens: 100 } },
            },
          },
        },
      ]);
    });

    const events: Array<import('../src/services/assistant.js').AssistantEvent> = [];
    await assistantMod.runAssistant(
      auth(),
      [{ role: 'user', content: 'Find work-mail' }],
      (e) => events.push(e),
      new AbortController().signal,
    );

    assert.equal(captured.length, 2);

    // 第一轮请求体校验
    const req1 = captured[0]!;
    assert.equal(req1.url, `${BASE_URL}/responses`);
    assert.equal(req1.authHeader, 'Bearer sk-test-key');
    assert.equal(req1.body.model, 'gpt-6.2-sol');
    assert.equal(req1.body.stream, true);
    assert.equal(req1.body.store, false);
    assert.equal(typeof req1.body.instructions, 'string');
    assert.deepEqual(req1.body.include, ['reasoning.encrypted_content']);
    assert.deepEqual(req1.body.reasoning, { effort: 'medium', summary: 'auto' });
    assert.deepEqual(req1.body.input, [{ type: 'message', role: 'user', content: 'Find work-mail' }]);

    const reqTools = req1.body.tools as Array<Record<string, unknown>>;
    const searchTool = reqTools.find((t) => t.name === 'search_emails');
    assert.ok(searchTool, '工具列表应包含 search_emails');
    assert.equal(searchTool.type, 'function');
    assert.equal(searchTool.strict, false);
    assert.equal(typeof searchTool.description, 'string');
    assert.equal(typeof searchTool.parameters, 'object');

    // 第二轮 input 应带回 reasoning（含 encrypted_content、无服务端 id）、message、function_call 与 function_call_output
    const input2 = captured[1]!.body.input as Array<Record<string, unknown>>;
    assert.equal(input2.length, 5);
    assert.deepEqual(input2[0], { type: 'message', role: 'user', content: 'Find work-mail' });
    assert.deepEqual(input2[1], {
      type: 'reasoning',
      summary: [{ type: 'summary_text', text: 'Need to search mail.' }],
      encrypted_content: 'enc_blob_1',
    });
    assert.equal('id' in input2[1]!, false);
    assert.deepEqual(input2[2], {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'Checking your inbox.' }],
    });
    assert.deepEqual(input2[3], {
      type: 'function_call',
      call_id: 'call_search_1',
      name: 'search_emails',
      arguments: '{"query":"subject:work-mail"}',
    });
    assert.equal(input2[4]!.type, 'function_call_output');
    assert.equal(input2[4]!.call_id, 'call_search_1');
    assert.match(String(input2[4]!.output), /work-mail/);

    // 事件流校验
    const thinking = events.filter((e) => e.type === 'thinking').map((e) => e.delta).join('');
    const text = events.filter((e) => e.type === 'text').map((e) => e.delta).join('');
    const toolDone = events.find((e) => e.type === 'tool_done');
    const usage = events.find((e) => e.type === 'usage');
    assert.equal(thinking, 'Need to search mail.');
    assert.equal(text, 'Checking your inbox.\n\nFound work-mail.');
    assert.ok(toolDone && toolDone.type === 'tool_done' && toolDone.ok);
    assert.ok(usage && usage.type === 'usage');
    assert.equal(usage.rounds, 2);
    assert.equal(usage.inputTokens, 320);
    assert.equal(usage.outputTokens, 55);
    assert.equal(usage.cacheReadTokens, 140);
  });

  test('非法 JSON 工具参数返回 INVALID_JSON 给模型继续处理', async () => {
    const inputs: Array<Array<Record<string, unknown>>> = [];
    stubFetch((_url, init) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { input: Array<Record<string, unknown>> };
      inputs.push(body.input);
      if (inputs.length === 1) {
        return sseResponse([
          {
            data: {
              type: 'response.output_item.added',
              output_index: 0,
              item: { id: 'fc_bad', type: 'function_call', call_id: 'call_bad', name: 'search_emails', arguments: '' },
            },
          },
          { data: { type: 'response.function_call_arguments.delta', output_index: 0, item_id: 'fc_bad', delta: '{broken' } },
          { data: { type: 'response.completed', response: { usage: { input_tokens: 10, output_tokens: 5 } } } },
        ]);
      }
      return sseResponse([
        { data: { type: 'response.output_text.delta', delta: 'Recovered.' } },
        { data: { type: 'response.completed', response: { usage: { input_tokens: 20, output_tokens: 5 } } } },
      ]);
    });

    const events: Array<import('../src/services/assistant.js').AssistantEvent> = [];
    await assistantMod.runAssistant(auth(), [{ role: 'user', content: 'hi' }], (e) => events.push(e), new AbortController().signal);

    assert.equal(inputs.length, 2);
    const toolDone = events.find((e) => e.type === 'tool_done');
    assert.ok(toolDone && toolDone.type === 'tool_done' && !toolDone.ok);
    const outputItem = inputs[1]!.find((it) => it.type === 'function_call_output');
    assert.equal(outputItem?.call_id, 'call_bad');
    assert.match(String(outputItem?.output), /INVALID_JSON/);
  });

  test('response.failed 与 response.incomplete 抛出 AiError', async () => {
    stubFetch(() =>
      sseResponse([
        {
          data: {
            type: 'response.failed',
            response: { status: 'failed', error: { message: 'upstream boom' } },
          },
        },
      ]),
    );
    await assert.rejects(
      assistantMod.runAssistant(auth(), [{ role: 'user', content: 'hi' }], () => {}, new AbortController().signal),
      (err: unknown) => err instanceof aiMod.AiError && /upstream boom/.test(err.message),
    );

    stubFetch(() =>
      sseResponse([
        {
          data: {
            type: 'response.incomplete',
            response: { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } },
          },
        },
      ]),
    );
    await assert.rejects(
      assistantMod.runAssistant(auth(), [{ role: 'user', content: 'hi' }], () => {}, new AbortController().signal),
      (err: unknown) => err instanceof aiMod.AiError && /max_output_tokens/.test(err.message),
    );
  });

  test('未设置 effort 时不发送 reasoning 与 include 参数', async () => {
    const captured: Array<{ body: Record<string, unknown> }> = [];
    await aiMod.saveAiSettings({
      ...(await aiMod.getAiSettings()),
      assistantEffort: null,
      channels: (await aiMod.getAiSettings()).channels.map(({ apiKey: _k, ...ch }) => ch),
    });
    try {
      stubFetch((_url, init) => {
        captured.push({ body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown> });
        return sseResponse([
          { event: 'response.output_text.delta', data: { type: 'response.output_text.delta', delta: 'Plain reply.' } },
          {
            event: 'response.completed',
            data: {
              type: 'response.completed',
              response: {
                object: 'response',
                status: 'completed',
                output: [{ id: 'msg_plain', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Plain reply.' }] }],
                usage: { input_tokens: 10, output_tokens: 4 },
              },
            },
          },
        ]);
      });

      const events: Array<import('../src/services/assistant.js').AssistantEvent> = [];
      await assistantMod.runAssistant(auth(), [{ role: 'user', content: 'hi' }], (e) => events.push(e), new AbortController().signal);
      assert.equal(captured.length, 1);
      assert.equal(captured[0]!.body.reasoning, undefined);
      assert.equal(captured[0]!.body.include, undefined);
      assert.equal(events.filter((e) => e.type === 'text').map((e) => e.delta).join(''), 'Plain reply.');
    } finally {
      await aiMod.saveAiSettings({
        ...(await aiMod.getAiSettings()),
        assistantEffort: 'medium',
        channels: (await aiMod.getAiSettings()).channels.map(({ apiKey: _k, ...ch }) => ch),
      });
    }
  });
});

describe('OpenAI Chat API assistant loop', () => {
  test('流式思考（reasoning_content）、文本、工具调用往返及无 API Key 时不发 Authorization 头', async () => {
    const cur = await aiMod.getAiSettings();
    await aiMod.saveAiSettings({
      ...cur,
      channels: [
        ...cur.channels.map(({ apiKey: _k, ...ch }) => ch),
        {
          id: 'chat-local',
          name: 'OpenAI Chat',
          provider: 'openai',
          baseUrl: BASE_URL,
          apiKey: '',
          models: ['deepseek-r1'],
          modelsSyncedAt: null,
          prices: { 'deepseek-r1': { input: 1, output: 2 } },
          priceRate: 1,
        },
      ],
    });

    const captured: Array<{ url: string; authHeader: string | null; body: Record<string, unknown> }> = [];
    stubFetch((url, init) => {
      const headers = new Headers(init?.headers);
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      captured.push({ url, authHeader: headers.get('authorization'), body });

      if (captured.length === 1) {
        return sseResponse([
          { data: { id: 'cmpl_1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { reasoning_content: 'Think first.' }, finish_reason: null }] } },
          { data: { id: 'cmpl_1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: 'Searching...' }, finish_reason: null }] } },
          {
            data: {
              id: 'cmpl_1',
              object: 'chat.completion.chunk',
              choices: [
                {
                  index: 0,
                  delta: { tool_calls: [{ index: 0, id: 'call_chat_1', type: 'function', function: { name: 'search_emails', arguments: '{"query":' } }] },
                  finish_reason: null,
                },
              ],
            },
          },
          {
            data: {
              id: 'cmpl_1',
              object: 'chat.completion.chunk',
              choices: [
                {
                  index: 0,
                  delta: { tool_calls: [{ index: 0, function: { arguments: '"subject:work-mail"}' } }] },
                  finish_reason: 'tool_calls',
                },
              ],
            },
          },
          { data: { id: 'cmpl_1', object: 'chat.completion.chunk', choices: [], usage: { prompt_tokens: 80, completion_tokens: 20 } } },
        ]);
      }

      return sseResponse([
        { data: { id: 'cmpl_2', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: 'Done searching.' }, finish_reason: 'stop' }] } },
        { data: { id: 'cmpl_2', object: 'chat.completion.chunk', choices: [], usage: { prompt_tokens: 120, completion_tokens: 15 } } },
      ]);
    });

    const events: Array<import('../src/services/assistant.js').AssistantEvent> = [];
    await assistantMod.runAssistant(
      auth(),
      [{ role: 'user', content: 'Find work-mail' }],
      (e) => events.push(e),
      new AbortController().signal,
      { channelId: 'chat-local', model: 'deepseek-r1' },
    );

    assert.equal(captured.length, 2);
    assert.equal(captured[0]!.url, `${BASE_URL}/chat/completions`);
    assert.equal(captured[0]!.authHeader, null);
    assert.equal(captured[0]!.body.stream, true);
    assert.deepEqual(captured[0]!.body.stream_options, { include_usage: true });
    assert.equal(captured[0]!.body.reasoning_effort, 'medium');

    const msgs2 = captured[1]!.body.messages as Array<Record<string, unknown>>;
    const toolMsg = msgs2.find((m) => m.role === 'tool');
    assert.equal(toolMsg?.tool_call_id, 'call_chat_1');
    assert.match(String(toolMsg?.content), /work-mail/);

    const thinking = events.filter((e) => e.type === 'thinking').map((e) => e.delta).join('');
    const text = events.filter((e) => e.type === 'text').map((e) => e.delta).join('');
    const usage = events.find((e) => e.type === 'usage');
    assert.equal(thinking, 'Think first.');
    assert.equal(text, 'Searching...\n\nDone searching.');
    assert.ok(usage && usage.type === 'usage');
    assert.equal(usage.rounds, 2);
    assert.equal(usage.inputTokens, 200);
    assert.equal(usage.outputTokens, 35);
  });
});

describe('OpenAI Responses API non-streaming helpers', () => {
  test('generateText、generateJson、testAiConfig 与 fetchUpstreamModels', async () => {
    const calls: Array<{ method: string; url: string; body?: Record<string, unknown> }> = [];
    stubFetch((url, init) => {
      const method = init?.method ?? 'GET';
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
      calls.push({ method, url, body });

      if (url.endsWith('/models')) {
        return new Response(JSON.stringify({ data: [{ id: 'gpt-6.2-sol' }, { id: 'gpt-4.1-mini' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (body?.text) {
        return new Response(
          JSON.stringify({
            status: 'completed',
            output_text: JSON.stringify({
              category: 'finance',
              priority: 'high',
              summary: '账单',
              needs_reply: false,
              verification_codes: ['482913'],
              amounts: [{ value: 3280.5, currency: 'CNY', label: '账单' }],
              due_date: '2026-11-25',
              tracking_numbers: [],
              action_items: [],
            }),
            usage: { input_tokens: 50, output_tokens: 40, input_tokens_details: { cached_tokens: 10 } },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response(
        JSON.stringify({
          object: 'response',
          status: 'completed',
          output: [{ type: 'message', content: [{ type: 'output_text', text: 'Hello from responses' }] }],
          usage: { input_tokens: 15, output_tokens: 5 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });

    const text = await aiMod.generateText('sys', 'usr', { purpose: 'reply' });
    assert.equal(text, 'Hello from responses');
    assert.equal(calls[0]!.url, `${BASE_URL}/responses`);
    assert.equal(calls[0]!.body?.instructions, 'sys');
    assert.equal(calls[0]!.body?.input, 'usr');
    assert.equal(calls[0]!.body?.store, false);

    const cfg = await aiMod.getAiConfig();
    const tested = await aiMod.testAiConfig(cfg);
    assert.equal(tested.insight.category, 'finance');
    assert.deepEqual(tested.insight.extracted.codes, ['482913']);
    assert.deepEqual(calls[1]!.body?.text, { format: { type: 'json_object' } });
    // JSON 模式下 json 字样必须出现在 input 消息里（instructions 不算）
    assert.equal(calls[1]!.body?.instructions, undefined);
    const jsonInput = calls[1]!.body?.input as Array<{ role: string; content: string }>;
    assert.equal(jsonInput[0]!.role, 'developer');
    assert.match(jsonInput[0]!.content, /json/i);
    assert.equal(jsonInput[1]!.role, 'user');

    const jsonOut = await aiMod.generateJson('sys', 'usr', z.object({ category: z.string() }), {
      purpose: 'search',
      shape: '{"category": "..."}',
    });
    assert.equal(jsonOut.category, 'finance');

    const models = await aiMod.fetchUpstreamModels({ provider: 'openai-responses', baseUrl: BASE_URL, apiKey: 'sk-test-key' });
    assert.deepEqual(models, ['gpt-4.1-mini', 'gpt-6.2-sol']);
    assert.equal(calls[3]!.url, `${BASE_URL}/models`);
  });
});

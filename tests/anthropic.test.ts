import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { createAnthropicClient } from '../src/anthropic';

const reply = (status: number, body: any, headers: Record<string, string> = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
  json: async () => body,
  text: async () => (typeof body === 'string' ? body : JSON.stringify(body))
});

test('posts to the Messages API with the required headers', async () => {
  const calls: any[] = [];
  const client = createAnthropicClient({
    apiKey: 'sk-test',
    baseUrl: 'https://example.test/',
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return reply(200, { stop_reason: 'end_turn', content: [] });
    }
  });
  const result = await client.messages.create({ model: 'm', max_tokens: 1, messages: [] });
  assert.equal(result.stop_reason, 'end_turn');
  assert.equal(calls[0].url, 'https://example.test/v1/messages');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers['x-api-key'], 'sk-test');
  assert.equal(calls[0].init.headers['anthropic-version'], '2023-06-01');
  assert.deepEqual(JSON.parse(calls[0].init.body), { model: 'm', max_tokens: 1, messages: [] });
});

test('retries rate limits and overloads, honouring retry-after', async () => {
  const waits: number[] = [];
  const responses = [reply(429, 'slow down', { 'retry-after': '2' }), reply(529, 'overloaded'), reply(200, { ok: 1 })];
  const client = createAnthropicClient({
    apiKey: 'k',
    fetchImpl: async () => responses.shift(),
    sleep: async (ms) => {
      waits.push(ms);
    }
  });
  assert.deepEqual(await client.messages.create({}), { ok: 1 });
  assert.deepEqual(waits, [2000, 1000]);
});

test('surfaces the API error message without retrying client errors', async () => {
  let count = 0;
  const client = createAnthropicClient({
    apiKey: 'k',
    fetchImpl: async () => {
      count++;
      return reply(400, { type: 'error', error: { type: 'invalid_request_error', message: 'bad model' } });
    }
  });
  await assert.rejects(client.messages.create({}), /Anthropic API 400: bad model/);
  assert.equal(count, 1);
});

test('retries network errors then gives up', async () => {
  let count = 0;
  const client = createAnthropicClient({
    apiKey: 'k',
    maxRetries: 1,
    fetchImpl: async () => {
      count++;
      throw new Error('ECONNRESET');
    },
    sleep: async () => {}
  });
  await assert.rejects(client.messages.create({}), /ECONNRESET/);
  assert.equal(count, 2);
});

test('points at the API key on 401', async () => {
  const client = createAnthropicClient({
    apiKey: 'bad',
    fetchImpl: async () => reply(401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } })
  });
  await assert.rejects(client.messages.create({}), /401: invalid x-api-key \(check ANTHROPIC_API_KEY\)/);
});

test('hides only the fetch ExperimentalWarning', async () => {
  const seen: string[] = [];
  const listener = (w: Error) => seen.push(w.message);
  process.on('warning', listener);
  process.emitWarning('The Fetch API is an experimental feature.', 'ExperimentalWarning');
  process.emitWarning('something else', 'ExperimentalWarning');
  await new Promise((resolve) => setImmediate(resolve));
  process.off('warning', listener);
  assert.deepEqual(seen, ['something else']);
});

test('sends anthropic-workspace-id only when configured', async () => {
  const headers: any[] = [];
  const fetchImpl = async (_url: string, init: any) => {
    headers.push(init.headers);
    return reply(200, {});
  };
  await createAnthropicClient({ apiKey: 'k', workspaceId: 'wrkspc_123', fetchImpl }).messages.create({});
  await createAnthropicClient({ apiKey: 'k', workspaceId: '', fetchImpl }).messages.create({});
  assert.equal(headers[0]['anthropic-workspace-id'], 'wrkspc_123');
  assert.equal('anthropic-workspace-id' in headers[1], false);
});

const unscoped = () =>
  reply(400, { type: 'error', error: { type: 'invalid_request_error', message: 'must include the anthropic-workspace-id header' } });

test('discovers the only workspace for unscoped keys and reuses it', async () => {
  const calls: any[] = [];
  const client = createAnthropicClient({
    apiKey: 'k',
    workspaceId: '',
    fetchImpl: async (url, init) => {
      calls.push({ url, headers: init.headers });
      if (url.includes('/workspaces')) return reply(200, { data: [{ id: 'wrkspc_old', archived_at: '2026' }, { id: 'wrkspc_1', archived_at: null }] });
      return init.headers['anthropic-workspace-id'] ? reply(200, { ok: 1 }) : unscoped();
    }
  });
  assert.deepEqual(await client.messages.create({}), { ok: 1 });
  assert.deepEqual(await client.messages.create({}), { ok: 1 });
  assert.equal(calls.filter((c) => c.url.includes('/workspaces')).length, 1);
  assert.equal(calls.at(-1).headers['anthropic-workspace-id'], 'wrkspc_1');
});

test('asks for ANTHROPIC_WORKSPACE_ID when the workspace is ambiguous', async () => {
  const client = createAnthropicClient({
    apiKey: 'k',
    workspaceId: '',
    fetchImpl: async (url) =>
      url.includes('/workspaces') ? reply(200, { data: [{ id: 'a', archived_at: null }, { id: 'b', archived_at: null }] }) : unscoped()
  });
  await assert.rejects(client.messages.create({}), /set ANTHROPIC_WORKSPACE_ID/);
});

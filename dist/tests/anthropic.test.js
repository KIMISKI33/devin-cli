"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = require("node:test");
const assert = __importStar(require("node:assert/strict"));
const anthropic_1 = require("../src/anthropic");
const reply = (status, body, headers = {}) => ({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => headers[k.toLowerCase()] ?? null },
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body))
});
(0, node_test_1.test)('posts to the Messages API with the required headers', async () => {
    const calls = [];
    const client = (0, anthropic_1.createAnthropicClient)({
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
(0, node_test_1.test)('retries rate limits and overloads, honouring retry-after', async () => {
    const waits = [];
    const responses = [reply(429, 'slow down', { 'retry-after': '2' }), reply(529, 'overloaded'), reply(200, { ok: 1 })];
    const client = (0, anthropic_1.createAnthropicClient)({
        apiKey: 'k',
        fetchImpl: async () => responses.shift(),
        sleep: async (ms) => {
            waits.push(ms);
        }
    });
    assert.deepEqual(await client.messages.create({}), { ok: 1 });
    assert.deepEqual(waits, [2000, 1000]);
});
(0, node_test_1.test)('surfaces the API error message without retrying client errors', async () => {
    let count = 0;
    const client = (0, anthropic_1.createAnthropicClient)({
        apiKey: 'k',
        fetchImpl: async () => {
            count++;
            return reply(400, { type: 'error', error: { type: 'invalid_request_error', message: 'bad model' } });
        }
    });
    await assert.rejects(client.messages.create({}), /Anthropic API 400: bad model/);
    assert.equal(count, 1);
});
(0, node_test_1.test)('retries network errors then gives up', async () => {
    let count = 0;
    const client = (0, anthropic_1.createAnthropicClient)({
        apiKey: 'k',
        maxRetries: 1,
        fetchImpl: async () => {
            count++;
            throw new Error('ECONNRESET');
        },
        sleep: async () => { }
    });
    await assert.rejects(client.messages.create({}), /ECONNRESET/);
    assert.equal(count, 2);
});
//# sourceMappingURL=anthropic.test.js.map
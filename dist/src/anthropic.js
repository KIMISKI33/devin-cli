"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createAnthropicClient = createAnthropicClient;
const RETRYABLE = new Set([408, 409, 429, 500, 502, 503, 504, 529]);
/**
 * Minimal Anthropic Messages API client over Node's built-in fetch, used
 * instead of the official SDK to keep the CLI's install and binary small.
 */
function createAnthropicClient(options) {
    const { apiKey, baseUrl = process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com', maxRetries = 2, timeoutMs = 600000, fetchImpl = globalThis.fetch, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = options;
    if (typeof fetchImpl !== 'function')
        throw new Error('fetch is unavailable; Node.js 18+ is required.');
    const create = async (params) => {
        for (let attempt = 0;; attempt++) {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), timeoutMs);
            let response;
            try {
                response = await fetchImpl(`${baseUrl.replace(/\/$/, '')}/v1/messages`, {
                    method: 'POST',
                    headers: {
                        'content-type': 'application/json',
                        'x-api-key': apiKey,
                        'anthropic-version': '2023-06-01'
                    },
                    body: JSON.stringify(params),
                    signal: controller.signal
                });
            }
            catch (error) {
                if (attempt < maxRetries) {
                    await sleep(500 * 2 ** attempt);
                    continue;
                }
                throw new Error(`Anthropic request failed: ${error?.message ?? error}`);
            }
            finally {
                clearTimeout(timer);
            }
            if (response.ok)
                return response.json();
            const body = await response.text().catch(() => '');
            if (RETRYABLE.has(response.status) && attempt < maxRetries) {
                const retryAfter = Number(response.headers?.get?.('retry-after'));
                await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 500 * 2 ** attempt);
                continue;
            }
            let message = body;
            try {
                message = JSON.parse(body)?.error?.message ?? body;
            }
            catch { }
            throw new Error(`Anthropic API ${response.status}: ${message}`);
        }
    };
    return { messages: { create } };
}
//# sourceMappingURL=anthropic.js.map
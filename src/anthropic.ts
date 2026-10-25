import { MessagesClient } from './loop';

export interface AnthropicClientOptions {
  apiKey: string;
  baseUrl?: string;
  maxRetries?: number;
  timeoutMs?: number;
  fetchImpl?: (url: string, init: any) => Promise<any>;
  sleep?: (ms: number) => Promise<void>;
}

// Node 18 prints an ExperimentalWarning the first time global fetch is used; it is stable enough here.
const originalEmitWarning = process.emitWarning;
process.emitWarning = ((warning: any, ...rest: any[]) => {
  const type = typeof rest[0] === 'string' ? rest[0] : rest[0]?.type;
  if (type === 'ExperimentalWarning' && String(warning?.message ?? warning).includes('Fetch API')) return;
  return (originalEmitWarning as any).call(process, warning, ...rest);
}) as typeof process.emitWarning;

const RETRYABLE = new Set([408, 409, 429, 500, 502, 503, 504, 529]);

/**
 * Minimal Anthropic Messages API client over Node's built-in fetch, used
 * instead of the official SDK to keep the CLI's install and binary small.
 */
export function createAnthropicClient(options: AnthropicClientOptions): MessagesClient {
  const {
    apiKey,
    baseUrl = process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com',
    maxRetries = 2,
    timeoutMs = 600000,
    fetchImpl = (globalThis as any).fetch,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  } = options;

  if (typeof fetchImpl !== 'function') throw new Error('fetch is unavailable; Node.js 18+ is required.');

  const create = async (params: any): Promise<any> => {
    for (let attempt = 0; ; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let response: any;
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
      } catch (error: any) {
        if (attempt < maxRetries) {
          await sleep(500 * 2 ** attempt);
          continue;
        }
        throw new Error(`Anthropic request failed: ${error?.message ?? error}`);
      } finally {
        clearTimeout(timer);
      }

      if (response.ok) return response.json();

      const body = await response.text().catch(() => '');
      if (RETRYABLE.has(response.status) && attempt < maxRetries) {
        const retryAfter = Number(response.headers?.get?.('retry-after'));
        await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 500 * 2 ** attempt);
        continue;
      }
      let message = body;
      try {
        message = JSON.parse(body)?.error?.message ?? body;
      } catch {}
      const hint = response.status === 401 ? ' (check ANTHROPIC_API_KEY)' : '';
      throw new Error(`Anthropic API ${response.status}: ${message}${hint}`);
    }
  };

  return { messages: { create } };
}

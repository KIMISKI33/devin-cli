import { MessagesClient } from './loop';
export interface AnthropicClientOptions {
    apiKey: string;
    baseUrl?: string;
    maxRetries?: number;
    timeoutMs?: number;
    fetchImpl?: (url: string, init: any) => Promise<any>;
    sleep?: (ms: number) => Promise<void>;
}
/**
 * Minimal Anthropic Messages API client over Node's built-in fetch, used
 * instead of the official SDK to keep the CLI's install and binary small.
 */
export declare function createAnthropicClient(options: AnthropicClientOptions): MessagesClient;
//# sourceMappingURL=anthropic.d.ts.map
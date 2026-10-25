"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createAnthropicClient = createAnthropicClient;
// Node 18 prints an ExperimentalWarning the first time global fetch is used; it is stable enough here.
const originalEmitWarning = process.emitWarning;
process.emitWarning = ((warning, ...rest) => {
    const type = typeof rest[0] === 'string' ? rest[0] : rest[0]?.type;
    if (type === 'ExperimentalWarning' && String(warning?.message ?? warning).includes('Fetch API'))
        return;
    return originalEmitWarning.call(process, warning, ...rest);
});
const RETRYABLE = new Set([408, 409, 429, 500, 502, 503, 504, 529]);
/**
 * Minimal Anthropic Messages API client over Node's built-in fetch, used
 * instead of the official SDK to keep the CLI's install and binary small.
 */
function createAnthropicClient(options) {
    let workspaceId = options.workspaceId ?? process.env.ANTHROPIC_WORKSPACE_ID;
    let workspaceLookupDone = false;
    const { apiKey, baseUrl = process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com', maxRetries = 2, timeoutMs = 600000, fetchImpl = globalThis.fetch, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = options;
    if (typeof fetchImpl !== 'function')
        throw new Error('fetch is unavailable; Node.js 18+ is required.');
    const root = baseUrl.replace(/\/$/, '');
    // Keys that aren't scoped to a workspace must name one; pick it automatically when there is exactly one.
    const discoverWorkspace = async () => {
        workspaceLookupDone = true;
        try {
            const res = await fetchImpl(`${root}/v1/organizations/workspaces?limit=100`, {
                method: 'GET',
                headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }
            });
            if (!res.ok)
                return false;
            const active = ((await res.json())?.data ?? []).filter((w) => !w.archived_at);
            if (active.length !== 1)
                return false;
            workspaceId = active[0].id;
            return true;
        }
        catch {
            return false;
        }
    };
    const create = async (params) => {
        for (let attempt = 0;; attempt++) {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), timeoutMs);
            let response;
            try {
                response = await fetchImpl(`${root}/v1/messages`, {
                    method: 'POST',
                    headers: {
                        'content-type': 'application/json',
                        'x-api-key': apiKey,
                        'anthropic-version': '2023-06-01',
                        ...(workspaceId ? { 'anthropic-workspace-id': workspaceId } : {})
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
            if (response.status === 400 && !workspaceId && !workspaceLookupDone && body.includes('anthropic-workspace-id')) {
                if (await discoverWorkspace()) {
                    attempt--;
                    continue;
                }
            }
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
            const hint = response.status === 401
                ? ' (check ANTHROPIC_API_KEY)'
                : body.includes('anthropic-workspace-id')
                    ? ' (set ANTHROPIC_WORKSPACE_ID)'
                    : '';
            throw new Error(`Anthropic API ${response.status}: ${message}${hint}`);
        }
    };
    return { messages: { create } };
}
//# sourceMappingURL=anthropic.js.map
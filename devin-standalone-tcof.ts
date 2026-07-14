#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * devin-standalone-tcof.ts (TIER 1 FIXES APPLIED)
 *
 * ✅ FIXES APPLIED:
 * 1. Memory cleanup policy (src/memory-system.ts)
 * 2. Transaction timeout protection (30s git operations)
 * 3. Approval timeout for CI/CD (30s with default ABORT)
 *
 * Usage:
 *   node devin-standalone-tcof.ts "your task"
 *   TCOF_AUTO_APPROVE=true node devin-standalone-tcof.ts "your task"
 */

import { Anthropic, APIError, AuthenticationError, RateLimitError } from "@anthropic-ai/sdk";
import { spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import * as path from "node:path";
import { v4 as uuidv4 } from "uuid";
import {
  TransactionalOrchestrator,
  TransactionState,
} from "./src/tcof-orchestrator.ts";
import type {
  TransactionRequest,
  TransactionResult,
} from "./src/tcof-orchestrator.ts";
import { resolveMcpServersConfig } from "./src/devin-mcp-discovery.ts";
import type { ResolvedMcpConfig } from "./src/devin-mcp-discovery.ts";

type Message = Anthropic.Message;
type MessageParam = Anthropic.MessageParam;
type Tool = Anthropic.Tool;

const DEFAULT_MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-5-20250929";
const DEFAULT_MAX_TOKENS = 8192;
const DEFAULT_MAX_TURNS = 25;
const MAX_TOOL_RESULT_BYTES = 40_000;
const MAX_RETRIES = 4;
const TCOF_AUTO_APPROVE = process.env.TCOF_AUTO_APPROVE === "true";
type ModelRates = { input: number; output: number; cacheRead?: number; cacheWrite?: number };

const MODEL_RATES: Record<string, ModelRates> = {
  "claude-opus-4-1-20250805": { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
  "claude-sonnet-4-5-20250929": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  "claude-3-5-sonnet-20241022": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  "claude-3-opus-20240229": { input: 15, output: 75 },
  "claude-3-sonnet-20240229": { input: 3, output: 15 },
  "claude-3-haiku-20240307": { input: 0.25, output: 1.25 },
};

function ratesFor(model: string): ModelRates {
  return MODEL_RATES[model] || { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };
}

interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUSD: number;
  apiCalls: number;
}

function emptyTotals(): UsageTotals {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, costUSD: 0, apiCalls: 0 };
}

function accumulateUsage(model: string, usage: Message["usage"], totals: UsageTotals): void {
  const rates = ratesFor(model);
  const u = usage ?? ({} as NonNullable<Message["usage"]>);
  const inputTokens = Number(u.input_tokens ?? 0);
  const outputTokens = Number(u.output_tokens ?? 0);
  const inCost = (inputTokens / 1_000_000) * rates.input;
  const outCost = (outputTokens / 1_000_000) * rates.output;
  totals.inputTokens += inputTokens;
  totals.outputTokens += outputTokens;
  totals.costUSD += inCost + outCost;
  totals.apiCalls += 1;
}

function formatCost(usd: number): string {
  return usd < 0.01 ? `$${usd.toFixed(6)}` : `$${usd.toFixed(4)}`;
}

function printTotals(label: string, t: UsageTotals): void {
  console.error(`\n[${label}] apiCalls=${t.apiCalls} input=${t.inputTokens} output=${t.outputTokens} cost=${formatCost(t.costUSD)}`);
}

const SYSTEM_PROMPT = `You are Devin, autonomous AI software engineer. Complete tasks by reading files and running commands.
- Always gather context first.
- Use write_file_transactional for ALL file modifications.
- Never invent file contents without reading first.
- When MCP tools are available, use mcp_list_tools to discover them and mcp_call (server:tool_name) to invoke them.`;

const readFileTool: Tool = {
  name: "read_file",
  description: "Read file contents.",
  input_schema: {
    type: "object" as const,
    properties: { path: { type: "string" }, max_bytes: { type: "integer" } },
    required: ["path"],
  },
};

const scrapeWebTool: Tool = {
  name: "scrape_web",
  description: "Scrape web content from a URL. Requires FIRECRAWL_API_KEY env var.",
  input_schema: {
    type: "object" as const,
    properties: {
      url: { type: "string", description: "URL to scrape" },
      format: { type: "string", enum: ["markdown", "json"], description: "Output format" },
    },
    required: ["url"],
  },
};

const searchWebTool: Tool = {
  name: "search_web",
  description: "Search the web using Firecrawl. Requires FIRECRAWL_API_KEY env var.",
  input_schema: {
    type: "object" as const,
    properties: {
      query: { type: "string", description: "Search query" },
      limit: { type: "integer", description: "Max results (default 5)" },
    },
    required: ["query"],
  },
};

const runShellTool: Tool = {
  name: "run_shell",
  description: "Run shell commands.",
  input_schema: {
    type: "object" as const,
    properties: { command: { type: "string" }, cwd: { type: "string" }, timeout_ms: { type: "integer" } },
    required: ["command"],
  },
};

const writeFileTransactionalTool: Tool = {
  name: "write_file_transactional",
  description: "Write file with TCOF safety (validation, testing, approval, rollback).",
  input_schema: {
    type: "object" as const,
    properties: { path: { type: "string" }, content: { type: "string" } },
    required: ["path", "content"],
  },
};

const mcpListToolsTool: Tool = {
  name: "mcp_list_tools",
  description:
    "List available MCP tools. Uses MCP_SERVERS_CONFIG if set; otherwise auto-discovers servers from `devin mcp list`.",
  input_schema: { type: "object" as const, properties: {} },
};

const mcpCallToolDef: Tool = {
  name: "mcp_call",
  description:
    "Call an MCP tool by qualified name (server:tool). Uses MCP_SERVERS_CONFIG if set; otherwise auto-discovers servers from `devin mcp list`.",
  input_schema: {
    type: "object" as const,
    properties: {
      qualified_name: { type: "string", description: "server:tool_name" },
      arguments: { type: "object", description: "Tool arguments JSON object" },
    },
    required: ["qualified_name"],
  },
};

// resolveMcpServersConfig() is defensive internally and should already return
// null on failure rather than throw, but auto-discovery is a best-effort
// convenience feature: guard the call site too so a regression there can
// never prevent the agent from starting.
let MCP_CONFIG: ResolvedMcpConfig | null = null;
try {
  MCP_CONFIG = resolveMcpServersConfig();
} catch (err) {
  console.error(`[mcp] auto-discovery failed, continuing without MCP tools: ${err instanceof Error ? err.message : String(err)}`);
}
if (MCP_CONFIG) {
  console.error(`[mcp] ${MCP_CONFIG.source} config: ${MCP_CONFIG.configPath}`);
  if (MCP_CONFIG.servers.length > 0) {
    console.error(`[mcp] servers: ${MCP_CONFIG.servers.join(", ")}`);
  }
}

const TOOLS: Tool[] = [
  readFileTool,
  runShellTool,
  writeFileTransactionalTool,
  ...(process.env.FIRECRAWL_API_KEY ? [scrapeWebTool, searchWebTool] : []),
  ...(MCP_CONFIG ? [mcpListToolsTool, mcpCallToolDef] : []),
];

type ReadFileArgs = { path: string; max_bytes?: number };
type RunShellArgs = { command: string; cwd?: string; timeout_ms?: number };
type WriteFileArgs = { path: string; content: string };
type ScrapeWebArgs = { url: string; format?: "markdown" | "json" };
type SearchWebArgs = { query: string; limit?: number };
type McpCallArgs = { qualified_name: string; arguments?: Record<string, unknown> };

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function safeParseJSON(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function asOptionalString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function asOptionalNumber(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function truncateForToolOutput(s: string, max = MAX_TOOL_RESULT_BYTES): string {
  if (s.length <= max) return s;
  const head = s.slice(0, Math.floor(max * 0.6));
  const tail = s.slice(s.length - Math.floor(max * 0.3));
  return head + `\n\n... [truncated ${s.length - max} bytes] ...\n\n` + tail;
}

function executeReadFile(args: ReadFileArgs): string {
  const target = args.path ?? "";
  if (!target) return "Error: missing path";
  try {
    const st = statSync(target);
    if (!st.isFile()) return `Error: ${target} not a file`;
    const maxBytes = args.max_bytes ?? 200_000;
    const fd = readFileSync(target);
    const slice = fd.subarray(0, maxBytes);
    let text: string;
    try {
      text = slice.toString("utf8");
    } catch {
      text = fd.includes(0) ? `Error: ${target} appears binary` : slice.toString("latin1");
    }
    return text + (fd.length > maxBytes ? `\n\n[truncated at ${maxBytes}/${fd.length}]` : "");
  } catch (err) {
    return `Error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

function executeRunShell(args: RunShellArgs): string {
  const cmd = args.command ?? "";
  if (!cmd) return "Error: missing command";
  try {
    const res = spawnSync("cmd.exe", ["/d", "/s", "/c", cmd], {
      cwd: args.cwd ?? process.cwd(),
      timeout: args.timeout_ms ?? 120_000,
      maxBuffer: 4 * 1024 * 1024,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = (res.stdout ?? "") + (res.stderr ?? "");
    if (res.status !== 0) out += `\n[exit: ${res.status}]`;
    return truncateForToolOutput(out || "(no output)");
  } catch (err) {
    return `Error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

async function executeScrapeWeb(args: ScrapeWebArgs): Promise<string> {
  if (!process.env.FIRECRAWL_API_KEY) {
    return "Error: FIRECRAWL_API_KEY not set. Web scraping disabled.";
  }

  try {
    const { DirectWebProvider } = await import("./src/firecrawl-provider.ts");
    const provider = new DirectWebProvider(process.env.FIRECRAWL_API_KEY);
    const url = args.url ?? "";
    const format = args.format ?? "markdown";

    if (!url) return "Error: missing url";

    const content = await provider.scrapeURL(url, format as "markdown" | "json");
    return truncateForToolOutput(
      `URL: ${content.url}\nTitle: ${content.title || "(no title)"}\n\n${content.markdown}`,
      MAX_TOOL_RESULT_BYTES
    );
  } catch (err) {
    return `Error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

async function executeSearchWeb(args: SearchWebArgs): Promise<string> {
  if (!process.env.FIRECRAWL_API_KEY) {
    return "Error: FIRECRAWL_API_KEY not set. Web search disabled.";
  }

  try {
    const { DirectWebProvider } = await import("./src/firecrawl-provider.ts");
    const provider = new DirectWebProvider(process.env.FIRECRAWL_API_KEY);
    const query = args.query ?? "";
    const limit = args.limit ?? 5;

    if (!query) return "Error: missing query";

    const results = await provider.search(query, limit);
    const formatted = results
      .map((r, i) => `${i + 1}. [${r.title}](${r.url})\n${r.markdown.slice(0, 200)}...`)
      .join("\n\n");
    return truncateForToolOutput(formatted, MAX_TOOL_RESULT_BYTES);
  } catch (err) {
    return `Error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

function executeMcpListTools(): string {
  const configPath = MCP_CONFIG?.configPath;
  if (!configPath) return "Error: no MCP servers configured (set MCP_SERVERS_CONFIG or run `devin mcp list`)";
  try {
    const res = spawnSync("python", ["mcp_client.py", "--config", configPath, "--list"], {
      cwd: process.cwd(),
      timeout: 60_000,
      maxBuffer: 4 * 1024 * 1024,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = (res.stdout ?? "") + (res.stderr ?? "");
    if (res.status !== 0) out += `\n[exit: ${res.status}]`;
    return truncateForToolOutput(out || "(no output)");
  } catch (err) {
    return `Error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

function executeMcpCall(args: McpCallArgs): string {
  const configPath = MCP_CONFIG?.configPath;
  if (!configPath) return "Error: no MCP servers configured (set MCP_SERVERS_CONFIG or run `devin mcp list`)";
  const qualifiedName = args.qualified_name ?? "";
  if (!qualifiedName) return "Error: missing qualified_name";
  if (!qualifiedName.includes(":")) return `Error: qualified_name must be 'server:tool', got '${qualifiedName}'`;
  try {
    const res = spawnSync(
      "python",
      ["mcp_client.py", "--config", configPath, "--call", qualifiedName, "--args", JSON.stringify(args.arguments ?? {})],
      {
        cwd: process.cwd(),
        timeout: 120_000,
        maxBuffer: 4 * 1024 * 1024,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }
    );
    let out = (res.stdout ?? "") + (res.stderr ?? "");
    if (res.status !== 0) out += `\n[exit: ${res.status}]`;
    return truncateForToolOutput(out || "(no output)");
  } catch (err) {
    return `Error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function backoffMs(attempt: number): number {
  const base = Math.min(1000 * 2 ** attempt, 60_000);
  return base + Math.floor(Math.random() * 500);
}

async function createMessageWithRetry(
  client: Anthropic,
  params: Parameters<Anthropic["messages"]["create"]>[0],
  totals: UsageTotals,
  model: string
): Promise<Message> {
  let attempt = 0;
  while (true) {
    try {
      const msg = (await client.messages.create(params)) as Message;
      accumulateUsage(model, msg.usage, totals);
      return msg;
    } catch (err: unknown) {
      if (err instanceof AuthenticationError || (err instanceof APIError && err.status === 401)) {
        console.error("\n[api] Auth failed. Check ANTHROPIC_API_KEY.");
        throw err;
      }
      if ((err instanceof RateLimitError || (err instanceof APIError && err.status === 429)) && attempt < MAX_RETRIES) {
        const delay = backoffMs(attempt);
        console.error(`[api] Rate limited; backoff ${delay}ms`);
        await sleep(delay);
        attempt++;
        continue;
      }
      if (err instanceof APIError && err.status === 529 && attempt < MAX_RETRIES) {
        const delay = backoffMs(attempt);
        console.error(`[api] Overloaded; backoff ${delay}ms`);
        await sleep(delay);
        attempt++;
        continue;
      }
      throw err;
    }
  }
}

type ContentBlock = { type: string; text?: string; id?: string; name?: string; input?: unknown };

function extractToolUseBlocks(msg: Message): ContentBlock[] {
  return ((msg.content ?? []) as ContentBlock[]).filter((b) => b.type === "tool_use");
}

function extractText(msg: Message): string {
  return ((msg.content ?? []) as ContentBlock[])
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("\n");
}

async function runAgent(
  client: Anthropic,
  model: string,
  userPrompt: string,
  opts: { maxTurns: number; maxTokens: number }
): Promise<void> {
  const orch = new TransactionalOrchestrator({
    workspaceRoot: process.cwd(),
    autoApprove: TCOF_AUTO_APPROVE,
    approvalTimeoutMs: 30000,
    commitTimeoutMs: 30000,
    commitToBranch: process.env.TCOF_COMMIT_TO_BRANCH === "true",
    transactionLogDir: path.join(process.cwd(), ".tcof-transactions"),
  });

  async function executeTcofWrite(args: WriteFileArgs): Promise<string> {
    if (!args.path || !args.content) return "Error: missing path or content";
    try {
      const result: TransactionResult = await orch.processTransaction({
        transaction_id: uuidv4(),
        protocol_version: "1.2.0",
        target_file: args.path,
        proposed_source: args.content,
      });
      return result.success
        ? `Committed: ${args.path} [${result.final_state}] ${result.duration_ms}ms`
        : `Failed: ${result.error || "unknown"} (${result.final_state})`;
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  const totals = emptyTotals();
  const conversation: MessageParam[] = [{ role: "user", content: userPrompt }];

  console.error(`\n=== Devin + TCOF (TIER 1 FIXES) ===\nmodel: ${model} | turns: ${opts.maxTurns} | tokens: ${opts.maxTokens}\nprompt: ${userPrompt.slice(0, 100)}...\n`);

  for (let turn = 1; turn <= opts.maxTurns; turn++) {
    console.error(`--- turn ${turn} ---`);
    const response = await createMessageWithRetry(
      client,
      { model, max_tokens: opts.maxTokens, system: SYSTEM_PROMPT, tools: TOOLS, messages: conversation },
      totals,
      model
    );

    conversation.push({ role: "assistant", content: response.content as MessageParam["content"] });

    const text = extractText(response);
    if (text.trim()) console.log(`\n[assistant] ${text}\n`);

    const toolUses = extractToolUseBlocks(response);
    printTotals(`turn ${turn}`, totals);

    if (response.stop_reason === "end_turn" || toolUses.length === 0) {
      console.error(`\n[agent] Done.`);
      break;
    }

    const toolResults: Array<{ type: "tool_result"; tool_use_id: string; content: string }> = [];

    for (const tu of toolUses) {
      const id = tu.id ?? "";
      const name = tu.name ?? "";
      const parsed = safeParseJSON(JSON.stringify(tu.input ?? {})) ?? tu.input;
      console.error(`[tool] ${name}`);

      let resultText: string;
      try {
        if (name === "read_file" && isObject(parsed)) {
          resultText = executeReadFile({ path: asString(parsed.path), max_bytes: asOptionalNumber(parsed.max_bytes) });
        } else if (name === "run_shell" && isObject(parsed)) {
          resultText = executeRunShell({ command: asString(parsed.command), cwd: asOptionalString(parsed.cwd), timeout_ms: asOptionalNumber(parsed.timeout_ms) });
        } else if (name === "write_file_transactional" && isObject(parsed)) {
          resultText = await executeTcofWrite({ path: asString(parsed.path), content: asString(parsed.content) });
        } else if (name === "scrape_web" && isObject(parsed)) {
          resultText = await executeScrapeWeb({ url: asString(parsed.url), format: asOptionalString(parsed.format) as "markdown" | "json" | undefined });
        } else if (name === "search_web" && isObject(parsed)) {
          resultText = await executeSearchWeb({ query: asString(parsed.query), limit: asOptionalNumber(parsed.limit) });
        } else if (name === "mcp_list_tools") {
          resultText = executeMcpListTools();
        } else if (name === "mcp_call" && isObject(parsed)) {
          resultText = executeMcpCall({
            qualified_name: asString(parsed.qualified_name),
            arguments: isObject(parsed.arguments) ? (parsed.arguments as Record<string, unknown>) : undefined,
          });
        } else {
          resultText = `Error: unknown tool ${name}`;
        }
      } catch (err) {
        resultText = `Error: ${err instanceof Error ? err.message : String(err)}`;
      }

      const preview = resultText.length > 100 ? resultText.slice(0, 100) + "…" : resultText;
      console.error(`[tool->] ${preview.replace(/\n/g, " | ")}`);
      toolResults.push({ type: "tool_result", tool_use_id: id, content: resultText });
    }

    conversation.push({ role: "user", content: toolResults });
  }

  console.error(`\n=== FINAL ===`);
  printTotals("FINAL", totals);
}

function parseArgs(argv: string[]): { prompt: string | null; model: string; maxTurns: number; maxTokens: number } {
  const args = argv.slice(2);
  if (args.length === 0 || args.includes("-h") || args.includes("--help")) {
    return { prompt: null, model: DEFAULT_MODEL, maxTurns: DEFAULT_MAX_TURNS, maxTokens: DEFAULT_MAX_TOKENS };
  }

  let prompt: string | null = null;
  let model = DEFAULT_MODEL;
  let maxTurns = DEFAULT_MAX_TURNS;
  let maxTokens = DEFAULT_MAX_TOKENS;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--model" || a === "-m") model = args[++i] ?? model;
    else if (a.startsWith("--model=")) model = a.slice("--model=".length);
    else if (a === "--max-turns") {
      const v = Number(args[++i]);
      if (Number.isFinite(v)) maxTurns = Math.max(1, Math.floor(v));
    } else if (a.startsWith("--max-turns=")) {
      const v = Number(a.slice("--max-turns=".length));
      if (Number.isFinite(v)) maxTurns = Math.max(1, Math.floor(v));
    } else if (a === "--max-tokens") {
      const v = Number(args[++i]);
      if (Number.isFinite(v)) maxTokens = Math.floor(v);
    } else if (a.startsWith("--max-tokens=")) {
      const v = Number(a.slice("--max-tokens=".length));
      if (Number.isFinite(v)) maxTokens = Math.floor(v);
    } else if (prompt === null) {
      prompt = a;
    }
  }

  return { prompt, model, maxTurns, maxTokens };
}

function printHelp(): void {
  console.log(`devin-standalone-tcof — Devin + TCOF (TIER 1 FIXES APPLIED)
Usage:
  node devin-standalone-tcof.ts "<prompt>" [options]
Options:
  --model <name>        Model (default: ${DEFAULT_MODEL})
  --max-turns <n>       Turns (default: ${DEFAULT_MAX_TURNS})
  --max-tokens <n>      Tokens (default: ${DEFAULT_MAX_TOKENS})
Env:
  ANTHROPIC_API_KEY     Required
  TCOF_AUTO_APPROVE     Auto-approve (true/false)
  TCOF_COMMIT_TO_BRANCH Commit each TCOF write to a short-lived git branch (true/false)
  MCP_SERVERS_CONFIG    Optional JSON config for mcp_call / mcp_list_tools.
                        If omitted, the agent auto-discovers servers from 'devin mcp list'.`);
}

async function main(): Promise<void> {
  const { prompt, model, maxTurns, maxTokens } = parseArgs(process.argv);

  if (!prompt) {
    printHelp();
    process.exit(prompt === null && process.argv.slice(2).length === 0 ? 0 : 1);
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("Error: ANTHROPIC_API_KEY not set");
    process.exit(2);
  }

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  try {
    await runAgent(client, model, prompt, { maxTurns, maxTokens });
  } catch (err) {
    console.error(`\n[fatal] ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Unhandled error:", err);
  process.exit(1);
});

/**
 * devin-mcp-discovery.ts
 *
 * Auto-discover MCP servers registered with the Devin CLI (`devin mcp list`)
 * and bridge them into the TCOF standalone agent. If the user has already set
 * MCP_SERVERS_CONFIG, that config takes precedence.
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface DevinMcpServer {
  name: string;
  command: string;
  properties: Record<string, string>;
}

export interface McpServersConfig {
  name: string;
  transport: "stdio";
  command: string;
  args: string[];
  timeout: number;
}

export interface ResolvedMcpConfig {
  configPath: string;
  source: "env" | "discovered";
  servers: string[];
}

let discoveredConfigPath: string | null = null;

/**
 * Run `devin mcp list` and capture its output.
 * Returns the stdout on success, or an error message on failure.
 */
export function runDevinMcpList(): { ok: true; stdout: string } | { ok: false; error: string } {
  const res = spawnSync("devin", ["mcp", "list"], {
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 4 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });

  if (res.error) {
    return { ok: false, error: `failed to run devin mcp list: ${res.error.message}` };
  }
  if (res.status !== 0) {
    const detail = (res.stderr ?? "").trim() || `exit code ${res.status}`;
    return { ok: false, error: `devin mcp list failed: ${detail}` };
  }
  return { ok: true, stdout: res.stdout ?? "" };
}

/**
 * Parse the human-readable output of `devin mcp list`.
 *
 * Example input:
 *   Configured MCP servers:
 *
 *     • MCP_DOCKER
 *       Command: docker mcp gateway run --profile terminal_control
 *
 * The bullet is a UTF-8 glyph; we avoid relying on the exact character by
 * treating any non-property line after the header as a new server block and
 * dropping its first token if that token is not a normal identifier.
 */
export function parseDevinMcpList(text: string): DevinMcpServer[] {
  const servers: DevinMcpServer[] = [];
  let current: DevinMcpServer | null = null;
  let pastHeader = false;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    if (!pastHeader) {
      pastHeader = true;
      continue;
    }

    // Property lines look like "Key: value".
    const propMatch = line.match(/^([A-Za-z][A-Za-z0-9_\s]*):\s*(.+)$/);
    if (current && propMatch) {
      const key = propMatch[1].trim();
      const value = propMatch[2].trim();
      current.properties[key] = value;
      continue;
    }

    // New server block. Devin prints a leading glyph; drop the first token if
    // it isn't a normal identifier, otherwise treat the whole line as the name.
    const [first, rest] = line.split(/\s+/, 2);
    const name = /^[A-Za-z0-9_]+$/.test(first) ? line : (rest ?? "");

    if (current) servers.push(current);
    current = { name, command: "", properties: {} };
  }

  if (current) servers.push(current);
  return servers.filter((s) => s.name);
}

/**
 * Build an MCP_SERVERS_CONFIG JSON array from parsed Devin server entries.
 * Throws if any entry is missing a usable Command. See
 * buildMcpServersConfigLenient for a variant that skips bad entries instead.
 */
export function buildMcpServersConfig(
  servers: DevinMcpServer[],
  timeoutSeconds = 30
): McpServersConfig[] {
  return servers.map((srv) => {
    const commandLine = srv.properties["Command"] ?? "";
    const parts = commandLine.split(/\s+/).filter(Boolean);
    if (parts.length === 0) {
      throw new Error(`Server '${srv.name}' has no Command value`);
    }
    return {
      name: srv.name,
      transport: "stdio" as const,
      command: parts[0],
      args: parts.slice(1),
      timeout: timeoutSeconds,
    };
  });
}

/**
 * Like buildMcpServersConfig, but tolerates malformed entries: any server
 * missing a usable Command is skipped (with a reason) instead of aborting
 * the whole batch. Used by resolveMcpServersConfig so that one unexpected
 * entry (e.g. a future non-stdio server Devin describes without a
 * "Command:" property) doesn't prevent every other configured server from
 * being discovered.
 */
export function buildMcpServersConfigLenient(
  servers: DevinMcpServer[],
  timeoutSeconds = 30
): { configs: McpServersConfig[]; skipped: string[] } {
  const configs: McpServersConfig[] = [];
  const skipped: string[] = [];

  for (const srv of servers) {
    try {
      configs.push(...buildMcpServersConfig([srv], timeoutSeconds));
    } catch (err) {
      skipped.push(`${srv.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return { configs, skipped };
}

/**
 * Write a UTF-8 (no BOM) JSON config file for mcp_client.py to a temp location.
 */
export function writeTempMcpConfig(config: McpServersConfig[]): string {
  const tmpDir = os.tmpdir();
  const tmpFile = path.join(tmpDir, `devin-mcp-discovery-${process.pid}-${Date.now()}.json`);
  fs.writeFileSync(tmpFile, JSON.stringify(config, null, 2), { encoding: "utf8" });
  return tmpFile;
}

function cleanupDiscoveredConfig(): void {
  if (discoveredConfigPath) {
    try {
      fs.unlinkSync(discoveredConfigPath);
    } catch {
      // ignore cleanup failures
    }
    discoveredConfigPath = null;
  }
}

/**
 * Resolve the effective MCP servers config path.
 *
 * 1. If MCP_SERVERS_CONFIG is set, use it directly.
 * 2. Otherwise, run `devin mcp list`, parse the output, write a temporary
 *    config, and return that path.
 * 3. If Devin has no MCP servers or the Devin CLI is unavailable, return null.
 * 4. This function never throws: `devin mcp list` failures, malformed server
 *    entries, and filesystem errors are all caught, logged to stderr, and
 *    treated as "no MCP tools available" so a discovery problem never takes
 *    down the calling process (e.g. the standalone agent at startup).
 */
export function resolveMcpServersConfig(
  timeoutSeconds = 30
): ResolvedMcpConfig | null {
  const envPath = process.env.MCP_SERVERS_CONFIG;
  if (envPath) {
    return { configPath: envPath, source: "env", servers: [] };
  }

  try {
    const listResult = runDevinMcpList();
    if (!listResult.ok) {
      console.error(`[mcp-discovery] ${listResult.error}`);
      return null;
    }

    const servers = parseDevinMcpList(listResult.stdout);
    if (servers.length === 0) {
      return null;
    }

    const { configs, skipped } = buildMcpServersConfigLenient(servers, timeoutSeconds);
    for (const reason of skipped) {
      console.error(`[mcp-discovery] skipping server: ${reason}`);
    }
    if (configs.length === 0) {
      return null;
    }

    cleanupDiscoveredConfig();
    discoveredConfigPath = writeTempMcpConfig(configs);

    // Best-effort cleanup on normal or signal-driven exit.
    process.once("exit", cleanupDiscoveredConfig);
    for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
      process.once(sig, () => {
        cleanupDiscoveredConfig();
        process.exit(128 + 2); // signal exit code convention
      });
    }

    return {
      configPath: discoveredConfigPath,
      source: "discovered",
      servers: configs.map((c) => c.name),
    };
  } catch (err) {
    console.error(
      `[mcp-discovery] auto-discovery failed, continuing without MCP tools: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
    return null;
  }
}

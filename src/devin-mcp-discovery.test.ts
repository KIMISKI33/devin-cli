/**
 * Tests for devin-mcp-discovery.ts
 *
 * Covers parsing of `devin mcp list` output and config building. The
 * spawn-based auto-discovery path is exercised indirectly by the standalone
 * agent; here we unit-test the deterministic helpers.
 */

import { describe, it } from "node:test";
import assert from "node:assert";
import {
  parseDevinMcpList,
  buildMcpServersConfig,
  resolveMcpServersConfig,
} from "./devin-mcp-discovery.ts";

const SAMPLE_OUTPUT = `Configured MCP servers:

  • MCP_DOCKER
    Command: docker mcp gateway run --profile terminal_control
`;

const SAMPLE_OUTPUT_NO_BULLET = `Configured MCP servers:

  MCP_FILES
    Command: npx -y @modelcontextprotocol/server-filesystem /tmp
`;

const EMPTY_OUTPUT = `Configured MCP servers:

`;

describe("parseDevinMcpList", { concurrency: true }, () => {
  it("parses output with a UTF-8 bullet glyph", () => {
    const servers = parseDevinMcpList(SAMPLE_OUTPUT);
    assert.strictEqual(servers.length, 1);
    assert.strictEqual(servers[0].name, "MCP_DOCKER");
    assert.strictEqual(
      servers[0].properties["Command"],
      "docker mcp gateway run --profile terminal_control"
    );
  });

  it("parses output without a bullet glyph", () => {
    const servers = parseDevinMcpList(SAMPLE_OUTPUT_NO_BULLET);
    assert.strictEqual(servers.length, 1);
    assert.strictEqual(servers[0].name, "MCP_FILES");
    assert.strictEqual(
      servers[0].properties["Command"],
      "npx -y @modelcontextprotocol/server-filesystem /tmp"
    );
  });

  it("returns an empty array when no servers are configured", () => {
    const servers = parseDevinMcpList(EMPTY_OUTPUT);
    assert.strictEqual(servers.length, 0);
  });

  it("ignores stray whitespace and blank lines", () => {
    const messy = "\n\nConfigured MCP servers:\n\n\n  • S1\n    Command: cmd a\n\n  • S2\n    Command: cmd b\n\n";
    const servers = parseDevinMcpList(messy);
    assert.strictEqual(servers.length, 2);
    assert.deepStrictEqual(
      servers.map((s) => s.name),
      ["S1", "S2"]
    );
  });
});

describe("buildMcpServersConfig", { concurrency: true }, () => {
  it("splits Command into command and args", () => {
    const servers = parseDevinMcpList(SAMPLE_OUTPUT);
    const config = buildMcpServersConfig(servers, 30);
    assert.strictEqual(config.length, 1);
    assert.deepStrictEqual(config[0], {
      name: "MCP_DOCKER",
      transport: "stdio",
      command: "docker",
      args: ["mcp", "gateway", "run", "--profile", "terminal_control"],
      timeout: 30,
    });
  });

  it("throws when a server has no Command", () => {
    assert.throws(
      () =>
        buildMcpServersConfig(
          [{ name: "BAD", command: "", properties: {} }],
          30
        ),
      /no Command value/
    );
  });

  it("respects a custom timeout", () => {
    const servers = parseDevinMcpList(SAMPLE_OUTPUT);
    const config = buildMcpServersConfig(servers, 60);
    assert.strictEqual(config[0].timeout, 60);
  });
});

describe("resolveMcpServersConfig", { concurrency: false }, () => {
  it("prefers the MCP_SERVERS_CONFIG env var over discovery", () => {
    const original = process.env.MCP_SERVERS_CONFIG;
    process.env.MCP_SERVERS_CONFIG = "/custom/mcp_servers.json";
    try {
      const resolved = resolveMcpServersConfig();
      assert.ok(resolved);
      assert.strictEqual(resolved!.configPath, "/custom/mcp_servers.json");
      assert.strictEqual(resolved!.source, "env");
    } finally {
      if (original === undefined) {
        delete process.env.MCP_SERVERS_CONFIG;
      } else {
        process.env.MCP_SERVERS_CONFIG = original;
      }
    }
  });
});

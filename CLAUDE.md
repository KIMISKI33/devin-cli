# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository Purpose

Windows distribution scripts and utilities for the Devin CLI, plus a growing set of agentic/transactional code-modification runtimes. The canonical installer is `setup.ps1`, which mirrors the official curl|bash installer served from `https://static.devin.ai/cli`. `upgrade-devin.ps1` is a legacy GitHub-Releases-based self-upgrade retained only for historical installs from the `jspecc33-del/devin-cli` mirror.

Beyond distribution, the repo contains:

- A Firecrawl-backed scraper and structured extractor (`scrape.ts`, `apify-store.ts`).
- Standalone Claude-driven and Groq-driven agent CLIs (`devin-standalone.ts`, `devin-standalone-tcof.ts`, `devin-standalone-tcof-ollama.ts`, `devin-standalone-groq.ts`).
- Transactional code orchestration engines: FOAS (`foas_orchestrator.py`) and TCOF (`src/tcof-orchestrator.ts`, `devin-standalone-tcof.ts`).
- Defensive execution / Sentinel pipeline (`agent_guardrails.py`, `sentinel_guardrails.py`, `run_secure_pipeline.py`, `git_promotion_engine.py`, `config_loader.py`).
- A small Python suite for locating and exporting Blender files for Bambu Studio.
- GUS runtime modules (`mcp_client.py`, `memory_store.py`, `task_payload.py`).

## Common Commands

### Install / upgrade the Devin CLI

```powershell
# Official install (equivalent to `irm https://static.devin.ai/cli/setup.ps1 | iex`)
.\setup.ps1 -Verbose

# Dry run
.\setup.ps1 -DryRun

# Specific version or distribution channel
.\setup.ps1 -Version 2026.3.5-1 -Distribution curl-bash-enterprise

# Thin bootstrap wrapper that downloads setup.ps1 from the CDN
.\bootstrap-devin.ps1 -Verbose
```

### Legacy GitHub-Release upgrade

```powershell
# Preview, then commit
.\upgrade-devin.ps1 -WhatIf
.\upgrade-devin.ps1 -Verbose

# Use the Firecrawl scraper instead of the GitHub REST API
$env:FIRECRAWL_API_KEY = "fc-..."
.\upgrade-devin.ps1 -UseFirecrawl -Verbose
```

### Inspect Devin MCP tools

`devin mcp list` shows configured servers, but the Devin CLI has no built-in
`tools` subcommand. `devin-mcp-tools.ps1` bridges that gap by reading the
registry, building a temporary `MCP_SERVERS_CONFIG`, and using `mcp_client.py`
to introspect or call the actual tools.

```powershell
# List every tool exposed by every configured Devin MCP server
.\devin-mcp-tools.ps1

# Show connection status and tool counts instead
.\devin-mcp-tools.ps1 -Status

# Call a specific tool (use the qualified server:tool_name form)
.\devin-mcp-tools.ps1 -Call "MCP_DOCKER:read_file" -Arguments '{"path":"/tmp/foo.txt"}'

# Use a longer timeout for slow-to-start servers
.\devin-mcp-tools.ps1 -Timeout 60
```

### TypeScript / Node tooling

```powershell
# Install dependencies
npm install

# Type check (tsconfig.json exists; tsc --noEmit)
npm run type-check

# Build declarations to dist/
npm run build

# Run the main TCOF standalone agent (package.json "start")
npm start

# Dev mode with ts-node loader
npm run dev

# Scrape a URL to markdown (native Node type stripping)
node scrape.ts https://example.com

# Scrape with structured extraction
node scrape.ts https://github.com/jspecc33-del/devin-cli/releases/latest `
    --schema ./src/schemas/github-release.ts `
    --prompt "Extract the latest release: tag_name, published_at, html_url, prerelease, body, and the assets array."

# Direct invocation of the scraper CLIs
node scrape.ts https://example.com
node apify-store.ts --help
```

### Standalone Claude CLI

```powershell
# Primary TCOF agent (uses devin-standalone-tcof.ts)
$env:ANTHROPIC_API_KEY = "sk-ant-..."
node devin-standalone-tcof.ts "your prompt"

# Auto-approve for CI-style runs
$env:TCOF_AUTO_APPROVE = "true"
node devin-standalone-tcof.ts "your prompt"

# TCOF agent with MCP tool access (enables mcp_call / mcp_list_tools)
# If MCP_SERVERS_CONFIG is omitted, the agent auto-discovers servers from `devin mcp list`.
$env:MCP_SERVERS_CONFIG = "C:\Users\c33ce\mcp_servers.json"
node devin-standalone-tcof.ts "use filesystem:read_file to inspect /tmp/foo.txt"

# Auto-discovery only: if `devin mcp list` shows MCP_DOCKER, the agent can list and call its tools
node devin-standalone-tcof.ts "list my MCP tools and then use the right one to inspect /tmp/foo.txt"

# Original standalone agent
node devin-standalone.ts "your prompt"

# Groq / OpenAI-compatible variant
$env:GROQ_API_KEY = "gsk-..."
node devin-standalone-groq.ts "your prompt"
```

### Blender file utilities

```powershell
# Discover .blend files
python find_blend_files.py ./models --format json

# Analyze and export a single file (requires Blender / bpy)
python auto_export_blend.py model.blend --output-dir ./exports --format stl

# Batch workflow: discovery → analysis → export → report
python batch_process_blends.py ./models --export-dir ./exports --json
```

### GUS runtime modules (Python)

```powershell
# MCP client — list tools from configured servers and call one
$env:MCP_SERVERS_CONFIG = "C:\Users\c33ce\mcp_servers.json"
python mcp_client.py --config $env:MCP_SERVERS_CONFIG --list
python mcp_client.py --config $env:MCP_SERVERS_CONFIG --call filesystem:read_file --args '{"path":"/tmp/foo.txt"}'

# Memory store — save / scan / search markdown-frontmatter memories
python memory_store.py

# Task payload — build and validate an agentic task payload
python task_payload.py security_scan
python task_payload.py env_config_push
python task_payload.py api_resource
```

### FOAS orchestrator (transactional code modification)

```powershell
# Multi-file edit with local LLM plan generation and rollback
.\foas-orchestrator.ps1 "Add error handling" crawler/engine.py crawler/utils.py -Local

# Or run the Python engine directly
python foas_orchestrator.py --task "Add error handling" --files crawler/engine.py --local
```

### Sentinel / enterprise pipeline

```powershell
# Validate pipeline configuration
python config_loader.py

# Run the 6-phase secure pipeline (requires .env.sentinel)
python run_secure_pipeline.py --config .env.sentinel

# Run with MCP tool access; MCP calls are checkpoint-gated
python run_secure_pipeline.py --mcp-config C:\Users\c33ce\mcp_servers.json --auto-approve

# Promote verified files from a sandbox to a local staging branch
python git_promotion_engine.py --primary-repo . --sandbox-dir C:\Users\c33ce\sandbox\<node_id>
```

### Python tests

```powershell
# Full pytest suite
python -m pytest

# Run one test file
python -m pytest test_foas_orchestrator.py

# Run a single test
python -m pytest test_foas_orchestrator.py::test_orchestrator_modify_file -v
```

### Inspect Devin account / enterprise settings

```powershell
.\Get-DevinAccountStatus.ps1
.\Get-DevinEnterpriseSettings.ps1 -RefreshAuth
```

## Architecture

### Distribution layer (PowerShell)

- `setup.ps1` — Canonical installer. Fetches a manifest from `https://static.devin.ai/cli`, downloads the Windows bundle matching the detected architecture (MSVC preferred, gnu/gnullvm fallback), verifies its SHA-256, installs a versioned copy under `~/.local/share/devin/cli/_versions`, creates a `current` junction, and places `devin.exe` in `~/.local/bin` as a symlink (copy fallback when symlinks are unavailable). Adds the install directory to the user PATH and runs `devin setup`. Supports legacy namespace migration from older `cognition`/`chisel` data directories. Parameters include `-Version`, `-Distribution` (`curl-bash`, `curl-bash-enterprise`, `curl-bash-windsurfcom`), `-InstallDir`, `-DryRun`, and `-Verbose`.
- `bootstrap-devin.ps1` — Downloads `setup.ps1` from the CDN to a temp file and executes it with forwarded parameters. This is the script the README one-liner ultimately invokes.
- `upgrade-devin.ps1` — Legacy installer for the GitHub Releases mirror. Uses the GitHub REST API by default; the `-UseFirecrawl` switch delegates release resolution to `scrape.ts` (requires Node, npm dependencies, and `FIRECRAWL_API_KEY`). Supports `-WhatIf` / `-Confirm` via `[CmdletBinding(SupportsShouldProcess)]`; `-DryRun` is a backward-compatible alias for `-WhatIf`.
- `Get-DevinAccountStatus.ps1` and `Get-DevinEnterpriseSettings.ps1` — Read-only wrappers that parse `devin auth status` output and pretty-print account, team, and enterprise status. They do not mutate plan or billing state.
- `devin-mcp-tools.ps1` — Wrapper that fills the missing `devin mcp tools` subcommand. Parses `devin mcp list`, builds a temporary `MCP_SERVERS_CONFIG` for `mcp_client.py`, and lists, checks status of, or calls tools exposed by each configured Devin MCP server.

### Scraper and standalone CLI (TypeScript / Node)

- `scrape.ts` — CLI built on `commander` and the Firecrawl SDK. Scrapes a URL, optionally extracts structured data using a Zod schema, and prints JSON. Exit codes: `0` success, `1` transient/runtime failure, `2` configuration error (missing key, missing `--prompt`, bad schema). It is the runtime used by `upgrade-devin.ps1 -UseFirecrawl` to resolve `tag_name` and asset metadata from a GitHub release page.
- `apify-store.ts` — Batch-scrape Apify Store Actor pages with the same Firecrawl/Zod pipeline. Supports `--from-file`, `--from-crawl`, `--limit`, and `--concurrency`.
- `devin-standalone.ts` — Autonomous Claude-driven coding agent with `read_file` and `run_shell` tools, HTTP 429/529 retry with exponential backoff, HTTP 401 fast-fail, prompt caching, adaptive thinking, and per-turn cost/usage tracking against a built-in model pricing table. Expects `ANTHROPIC_API_KEY` and Node >= 22.6.0 (uses native TypeScript type-stripping).
- `devin-standalone-tcof.ts` — TCOF-aware variant used by `npm start`. Adds transactional code orchestration hooks and integrates with `src/tcof-orchestrator.ts`. Respects `TCOF_AUTO_APPROVE` and 30-second git/approval timeouts. Auto-discovers MCP servers from `devin mcp list` (via `src/devin-mcp-discovery.ts`) so `mcp_call` / `mcp_list_tools` work without a manually-created `MCP_SERVERS_CONFIG`; an explicit `MCP_SERVERS_CONFIG` env var still takes precedence.
- `devin-standalone-tcof-ollama.ts` — Ollama-compatible port of the TCOF agent.
- `devin-standalone-groq.ts` — OpenAI SDK port of the standalone agent that targets a Groq-compatible endpoint (`GROQ_API_KEY`, optional `GROQ_BASE_URL`). Mirrors the tool loop and cost tracking.
- `src/scrape-client.ts` and `src/schema-loader.ts` — Runtime support for `scrape.ts` and `apify-store.ts`: Firecrawl client wrapper and schema-file loader. `schema-loader.ts` appends a cache-busting query string when dynamically importing `.ts`/`.js` schemas to avoid Node ESM cache reuse across CLI invocations.
- `src/schemas/github-release.ts` — Zod schema modeling the GitHub `/releases/latest` API response. Used by the Firecrawl extraction path.
- `src/tcof-orchestrator.ts` — TypeScript implementation of the Transactional Code Orchestration Framework: FSM-based transaction states, snapshot-based rollback, Python/JSON syntax validation, dependency tracing, and staged commit flow.

#### Anthropic SDK type notes

`@anthropic-ai/sdk` v0.32.1 is used in the standalone agents. Keep these subtleties in mind when editing those files:

- `Message`, `MessageParam`, and `Tool` are namespace members under `Anthropic` (e.g., `type Message = Anthropic.Message`), not top-level named exports.
- The `Usage` type in SDK 0.32.1 does not include `cache_read_input_tokens` / `cache_creation_input_tokens`; access them via cast if needed.
- `stop_reason` values are `"end_turn" | "tool_use" | "max_tokens" | "stop_sequence" | null`, not `"stop"` (that is OpenAI).
- Prompt caching (`cache_control`) and extended thinking (`thinking`) are cast-injected on request params because the SDK types predate them, but the SDK serializes the body verbatim so the fields reach the API.

### Transactional code orchestration (FOAS + TCOF)

Two overlapping systems for safe, agentic file edits:

- `foas_orchestrator.py` — Python execution engine for the File Orchestration & Automation System. Takes a natural-language task and target files, asks an LLM for a structured `OrchestratorPlan` (Pydantic), validates proposed changes with `ValidatorRegistry` (Python/JSON syntax), snapshots originals, applies atomically, and rolls back on failure. `foas_orchestrator.ps1` is the terminal wrapper. `test_foas_orchestrator.py` covers mocked plan flows.
- `src/tcof-orchestrator.ts` + `devin-standalone-tcof.ts` — TypeScript TCOF implementation. Used by `npm start`. Adds FSM transaction states (`PENDING` → `TRACE_DEPENDENCIES` → `VALIDATING` → `TESTING` → `AWAITING_APPROVAL` → `COMMITTING` → `COMPLETED`), dependency tracing, and 30-second git/approval timeouts. Auto-approve mode is controlled by `TCOF_AUTO_APPROVE`.

Both systems create isolated git branches for edits and never commit directly to the protected main branch.

### Blender file utilities (Python)

- `find_blend_files.py` — File discovery with recursive/non-recursive search, hidden-file/directory filtering, and simple / detailed / JSON output. Uses only the Python standard library.
- `auto_export_blend.py` — Opens `.blend` files with `bpy`, collects scene/object metadata, suggests Bambu-optimized export settings, and exports to STL or OBJ. Falls back to analysis-only when `bpy` is unavailable.
- `batch_process_blends.py` — Orchestrates the end-to-end workflow: discovery → analysis → export → reporting. Imports functions from the other Python modules when available; otherwise uses built-in fallbacks. Continues processing remaining files if one fails.

### GUS runtime modules (Python)

- `mcp_client.py` — MCP client/manager with stdio (subprocess) and HTTP/SSE transports. Wraps JSON-RPC 2.0 handshakes, exposes `list_tools()` and `call_tool()`, and routes calls across multiple registered servers via `MCPManager`. The CLI mode (`--config`, `--list`, `--status`, `--call`) reads server definitions from JSON and supports `${VAR}` / `${VAR:-default}` environment expansion. Requires `requests` for the HTTP/SSE path.
- `memory_store.py` — Markdown-frontmatter memory store with three layers: CRUD (`save_memory`, `load_entries`, `search_memory`), lightweight header-only scan (`scan_all_memories`, `format_memory_manifest`), and session consolidation (`consolidate_session`) that sends conversation text to Claude and stores the returned facts. Stores user-scoped memories in `~/.local/share/agent-memory/` and project-scoped memories in `./.agent-memory/`.
- `task_payload.py` — Structured payload schema for agentic task execution. Defines `TaskPayload` with timeouts, state deltas, steps, retry policies, exit-code policies, and a fluent `PayloadBuilder`. Includes `PayloadValidator` for duplicate-ID, dangling-reference, circular-dependency, and timeout sanity checks. Built-in examples cover security scans, env config pushes, and MCP-driven API resource creation.

### Defensive execution / Sentinel pipeline (Python)

A multi-layer guardrail system used by the enterprise / secure-pipeline flow:

- `agent_guardrails.py` — Core defensive controls: `SystemLabelConfig` validation, `ImmutableReplica` workspace cloning, `OutOfBandVerifier` (syntax, secret scan, checksum, custom checks independent of the agent), `CheckpointManager` human-in-the-loop gating, and `GuardrailPipeline` end-to-end orchestration.
- `sentinel_guardrails.py` — Enterprise variant with `ImmutableReplicaCloner`, `OutOfBandVerifier`, and `SystemLabelConfig` tailored for production pipeline execution and isolation.
- `config_loader.py` — Pydantic v2 settings loader for the Sentinel pipeline. Reads `.env.sentinel` and exports a normalized payload consumed by the cloner, auditor, and promotion engine.
- `run_secure_pipeline.py` — 6-phase enterprise pipeline orchestrator (cloning → verification → checkpoint gating → git promotion → reporting). Integrates `sentinel_guardrails`, `config_loader`, and `git_promotion_engine`. Optionally loads an `MCPManager` from `--mcp-config` / `MCP_SERVERS_CONFIG` and checkpoint-gates MCP tool calls in the agent phase.
- `git_promotion_engine.py` — Promotes verified files from an isolated sandbox replica into a short-lived `sentinel_promo_*` staging branch on the primary repo. Enforces clean working tree, path containment, atomic copy, and no network mutation (no push/pull).

Test coverage: `test_agent_guardrails.py`, `test_foas_orchestrator.py`, `test_git_promotion_engine.py`, `test_sentinel_audit.py`, `test_mcp_client.py`.

## Notes

- TypeScript is validated with `npm run type-check` (`tsc --noEmit` against `tsconfig.json`). There is no separate build step for the CLI entry points; `npm run build` emits declarations to `dist/` if needed.
- PowerShell scripts target PowerShell 5.1+ (`#requires -Version 5.1`). `setup.ps1` uses `Expand-Archive` for ZIP bundles and `tar` for `.tar.gz` bundles; it creates NTFS junctions/symlinks and falls back to file copies when symlinks cannot be created.
- `scrape.ts`, `apify-store.ts`, `devin-standalone.ts`, `devin-standalone-tcof.ts`, `devin-standalone-tcof-ollama.ts`, and `devin-standalone-groq.ts` rely on Node's native TypeScript type-stripping, so they execute directly with `node <file>.ts`. `npx tsx` is used only where a runtime needs `tsx` specifically (e.g., the `-UseFirecrawl` PowerShell invocation path).
- `devin.exe` is not built or stored in this repository; it is fetched from the Devin CDN or GitHub Releases.
- `.env` may contain API keys. Do not commit it or log its contents.
- `.env.sentinel` is used by the Sentinel pipeline (`config_loader.py`, `run_secure_pipeline.py`).
- `MCP_SERVERS_CONFIG` (env var or `--mcp-config`) points to a JSON array of MCP server definitions consumed by `mcp_client.py`, `devin-standalone-tcof.ts`, and `run_secure_pipeline.py`.
- Keep AI guidance files in sync: `CLAUDE.md` (this file), `AGENTS.md` (Codex guidance), and `.github/copilot-instructions.md`.
- `.claude/skills/gus/SKILL.md` is the active Claude Code skill for coding tasks; it selects prompt patterns and enforces a draft-verification gate.

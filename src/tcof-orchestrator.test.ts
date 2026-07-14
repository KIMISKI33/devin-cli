/**
 * tcof-orchestrator.test.ts
 *
 * Test suite for the Transactional Orchestrator Framework (TCOF).
 * Uses Node's native test runner (node:test) and assertion module.
 */

import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";
import assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  AutoApprovalProvider,
  BaseApprovalProvider,
  CLIApprovalProvider,
  TransactionalOrchestrator,
  TransactionState,
  type TransactionRequest,
} from "./tcof-orchestrator.ts";

function makeWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "tcof-test-"));
}

function buildRequest(
  overrides: Partial<TransactionRequest> = {}
): TransactionRequest {
  return {
    transaction_id: `tx-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    protocol_version: "1.2.0",
    target_file: "test.txt",
    proposed_source: "hello world",
    ...overrides,
  };
}

class RejectApprovalProvider extends BaseApprovalProvider {
  promptUserApproval(
    _targetFile: string,
    _metadata: Record<string, unknown>
  ): Promise<boolean> {
    return Promise.resolve(false);
  }
}

describe("TransactionalOrchestrator", { concurrency: false }, () => {
  it("rejects path traversal in target_file", async (t) => {
    const workspace = makeWorkspace();
    t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));

    const orchestrator = new TransactionalOrchestrator({
      workspaceRoot: workspace,
    });
    const result = await orchestrator.processTransaction(
      buildRequest({
        target_file: "../../../etc/passwd",
        proposed_source: "any content",
      })
    );

    assert.strictEqual(result.success, false);
    assert.strictEqual(result.final_state, TransactionState.ROLLING_BACK);
    assert.ok(result.error?.includes("Path escapes workspace"));
  });

  it("rejects null bytes in target_file", async (t) => {
    const workspace = makeWorkspace();
    t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));

    const orchestrator = new TransactionalOrchestrator({
      workspaceRoot: workspace,
    });
    const result = await orchestrator.processTransaction(
      buildRequest({
        target_file: "safe\x00evil.txt",
        proposed_source: "any content",
      })
    );

    assert.strictEqual(result.success, false);
    assert.strictEqual(result.final_state, TransactionState.ROLLING_BACK);
    assert.ok(result.error?.includes("null byte"));
  });

  it("rejects an absolute path outside the workspace", async (t) => {
    const workspace = makeWorkspace();
    t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));

    const outside = path.resolve(workspace, "..", "outside-workspace.txt");
    const orchestrator = new TransactionalOrchestrator({
      workspaceRoot: workspace,
    });
    const result = await orchestrator.processTransaction(
      buildRequest({
        target_file: outside,
        proposed_source: "any content",
      })
    );

    assert.strictEqual(result.success, false);
    assert.strictEqual(result.final_state, TransactionState.ROLLING_BACK);
    assert.ok(result.error?.includes("Path escapes workspace"));
  });

  it("returns ROLLING_BACK and does not write the file when syntax validation fails", async (t) => {
    const workspace = makeWorkspace();
    t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));

    const target = "broken.js";
    const orchestrator = new TransactionalOrchestrator({
      workspaceRoot: workspace,
    });
    const result = await orchestrator.processTransaction(
      buildRequest({
        target_file: target,
        proposed_source: "function { bad syntax",
      })
    );

    assert.strictEqual(result.success, false);
    assert.strictEqual(result.final_state, TransactionState.ROLLING_BACK);
    assert.ok(result.error?.includes("Syntax validation failed"));
    assert.strictEqual(fs.existsSync(path.join(workspace, target)), false);
  });

  it("restores the original file content when tests fail after writing", async (t) => {
    const workspace = makeWorkspace();
    t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));

    const target = "module.js";
    const original = "console.log('original');";
    const proposed = "console.log('changed');";
    fs.writeFileSync(path.join(workspace, target), original, "utf-8");
    fs.writeFileSync(
      path.join(workspace, "package.json"),
      JSON.stringify({
        scripts: { test: 'node -e "process.exit(1)"' },
      }),
      "utf-8"
    );

    const orchestrator = new TransactionalOrchestrator({
      workspaceRoot: workspace,
    });
    const result = await orchestrator.processTransaction(
      buildRequest({
        target_file: target,
        proposed_source: proposed,
      })
    );

    assert.strictEqual(result.success, false);
    assert.strictEqual(result.final_state, TransactionState.ROLLING_BACK);
    assert.ok(result.error?.includes("Test suite failed"));
    assert.strictEqual(
      fs.readFileSync(path.join(workspace, target), "utf-8"),
      original
    );
  });

  it("defaults to ABORT when the CLI approval prompt times out", async (t) => {
    const workspace = makeWorkspace();
    t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));

    const target = "pending.js";
    const proposed = "console.log('pending');";
    const orchestrator = new TransactionalOrchestrator({
      workspaceRoot: workspace,
      autoApprove: false,
      approvalProvider: new CLIApprovalProvider({ timeoutMs: 50 }),
    });
    const result = await orchestrator.processTransaction(
      buildRequest({
        target_file: target,
        proposed_source: proposed,
      })
    );

    assert.strictEqual(result.success, false);
    assert.strictEqual(result.final_state, TransactionState.ROLLING_BACK);
    assert.ok(result.error?.includes("User rejected transaction"));
    assert.strictEqual(fs.existsSync(path.join(workspace, target)), false);
  });

  it("completes without prompting when auto-approve is enabled", async (t) => {
    const workspace = makeWorkspace();
    t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));

    const target = "auto.js";
    const proposed = "console.log('auto');";
    const orchestrator = new TransactionalOrchestrator({
      workspaceRoot: workspace,
      autoApprove: true,
    });
    const result = await orchestrator.processTransaction(
      buildRequest({
        target_file: target,
        proposed_source: proposed,
      })
    );

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.final_state, TransactionState.COMPLETED);
    assert.strictEqual(
      fs.readFileSync(path.join(workspace, target), "utf-8"),
      proposed
    );
  });

  it("deletes a newly created file on rollback", async (t) => {
    const workspace = makeWorkspace();
    t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));

    const target = "reject.js";
    const proposed = "console.log('reject');";
    const orchestrator = new TransactionalOrchestrator({
      workspaceRoot: workspace,
      approvalProvider: new RejectApprovalProvider(),
    });
    const result = await orchestrator.processTransaction(
      buildRequest({
        target_file: target,
        proposed_source: proposed,
      })
    );

    assert.strictEqual(result.success, false);
    assert.strictEqual(result.final_state, TransactionState.ROLLING_BACK);
    assert.strictEqual(fs.existsSync(path.join(workspace, target)), false);
  });

  it("writes the transaction JSON log to the configured log directory", async (t) => {
    const workspace = makeWorkspace();
    t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));

    const logDir = path.join(workspace, "tx-logs");
    const target = "logged.js";
    const txId = `tx-log-${Date.now()}`;
    const orchestrator = new TransactionalOrchestrator({
      workspaceRoot: workspace,
      autoApprove: true,
      transactionLogDir: logDir,
    });
    const result = await orchestrator.processTransaction(
      buildRequest({
        transaction_id: txId,
        target_file: target,
        proposed_source: "console.log('logged');",
      })
    );

    assert.strictEqual(result.success, true);
    const logPath = path.join(logDir, `${txId}.json`);
    assert.strictEqual(fs.existsSync(logPath), true);
    const entry = JSON.parse(fs.readFileSync(logPath, "utf-8")) as {
      transaction_id: string;
      states: Array<{ state: string }>;
    };
    assert.strictEqual(entry.transaction_id, txId);
    assert.ok(entry.states.some((s) => s.state === "COMPLETED"));
  });

  it("creates a short-lived git branch and commits when commitToBranch is true", async (t) => {
    const workspace = makeWorkspace();
    t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));

    const target = "committed.js";
    const proposed = "console.log('committed');";
    const txId = `tx-git-${Date.now()}`;

    spawnSync("git", ["init"], { cwd: workspace });
    spawnSync("git", ["config", "user.email", "tcof@example.com"], {
      cwd: workspace,
    });
    spawnSync("git", ["config", "user.name", "TCOF Test"], { cwd: workspace });

    // Create an initial commit so the repo has a stable HEAD. This makes
    // checkout/create-branch behavior deterministic across git versions and
    // avoids edge cases in empty repositories that can slow down or fail on
    // some Windows/git configurations.
    fs.writeFileSync(path.join(workspace, "README.md"), "# init\n", "utf8");
    spawnSync("git", ["add", "README.md"], { cwd: workspace });
    spawnSync("git", ["commit", "-m", "init"], { cwd: workspace });

    const orchestrator = new TransactionalOrchestrator({
      workspaceRoot: workspace,
      autoApprove: true,
      commitToBranch: true,
      commitTimeoutMs: 30000,
    });
    const result = await orchestrator.processTransaction(
      buildRequest({
        transaction_id: txId,
        target_file: target,
        proposed_source: proposed,
      })
    );

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.final_state, TransactionState.COMPLETED);
    assert.ok(result.branch?.startsWith("tcof_tx_"));

    const branchList = spawnSync("git", ["branch", "--list"], { cwd: workspace });
    assert.ok(branchList.stdout?.toString().includes(result.branch ?? ""));

    const logPath = path.join(workspace, ".tcof-transactions", `${txId}.json`);
    assert.strictEqual(fs.existsSync(logPath), true);
  });
});

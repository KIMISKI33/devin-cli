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
const fs = __importStar(require("fs"));
const os = __importStar(require("os"));
const path = __importStar(require("path"));
const memory_1 = require("../src/memory");
const tools_1 = require("../src/tools");
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'devin-tools-'));
const context = (overrides = {}) => {
    const prompts = [];
    const mutations = [];
    const ctx = {
        approve: async (d) => {
            prompts.push(d);
            return true;
        },
        memory: new memory_1.AgentMemory(tmp()),
        agentRoot: null,
        onMutation: async (d) => {
            mutations.push(d);
        },
        runShell: async (c) => `ran: ${c}`,
        ...overrides
    };
    return { ctx, prompts, mutations };
};
(0, node_test_1.test)('isDangerousCommand blocks destructive commands but not normal ones', () => {
    for (const cmd of ['rm -rf /', 'sudo rm -rf / --no-preserve-root', 'mkfs.ext4 /dev/sda1', 'dd if=/dev/zero of=/dev/sda', ':(){ :|:& };:']) {
        assert.equal((0, tools_1.isDangerousCommand)(cmd), true, cmd);
    }
    for (const cmd of ['git add .', 'npm run build', 'rm -rf ./dist', 'echo address', 'ls /']) {
        assert.equal((0, tools_1.isDangerousCommand)(cmd), false, cmd);
    }
});
(0, node_test_1.test)('run_shell asks for approval, runs, and checkpoints', async () => {
    const { ctx, prompts, mutations } = context();
    const result = await (0, tools_1.executeTool)('run_shell', { command: 'git add .' }, ctx);
    assert.equal(result.isError, false);
    assert.equal(result.output, 'ran: git add .');
    assert.equal(prompts.length, 1);
    assert.equal(mutations.length, 1);
});
(0, node_test_1.test)('run_shell respects a declined approval', async () => {
    let ran = false;
    const { ctx } = context({
        approve: async () => false,
        runShell: async () => {
            ran = true;
            return '';
        }
    });
    const result = await (0, tools_1.executeTool)('run_shell', { command: 'ls' }, ctx);
    assert.equal(result.isError, true);
    assert.equal(ran, false);
});
(0, node_test_1.test)('run_shell refuses dangerous commands without prompting', async () => {
    const { ctx, prompts } = context();
    const result = await (0, tools_1.executeTool)('run_shell', { command: 'rm -rf /' }, ctx);
    assert.equal(result.isError, true);
    assert.equal(prompts.length, 0);
});
(0, node_test_1.test)('write, append, read and list files', async () => {
    const dir = tmp();
    const file = path.join(dir, 'nested', 'a.txt');
    const { ctx } = context();
    assert.equal((await (0, tools_1.executeTool)('write_file', { path: file, content: 'hello' }, ctx)).isError, false);
    assert.equal((await (0, tools_1.executeTool)('append_file', { path: file, content: ' world' }, ctx)).isError, false);
    assert.equal((await (0, tools_1.executeTool)('read_file', { path: file }, ctx)).output, 'hello world');
    assert.equal((await (0, tools_1.executeTool)('list_directory', { path: dir }, ctx)).output, 'nested/');
    assert.equal((await (0, tools_1.executeTool)('read_file', { path: path.join(dir, 'missing') }, ctx)).isError, true);
    assert.equal((await (0, tools_1.executeTool)('append_file', { path: path.join(dir, 'missing'), content: 'x' }, ctx)).isError, true);
});
(0, node_test_1.test)('record_lesson stores to long-term memory', async () => {
    const { ctx } = context({ currentTask: 'build' });
    const result = await (0, tools_1.executeTool)('record_lesson', { lesson: 'use npm.cmd', outcome: 'failure' }, ctx);
    assert.equal(result.isError, false);
    assert.equal(ctx.memory.lessons[0].lesson, 'use npm.cmd');
    assert.equal(ctx.memory.lessons[0].task, 'build');
});
(0, node_test_1.test)('self-modification tools are disabled without an agent root', async () => {
    const { ctx } = context();
    assert.match((await (0, tools_1.executeTool)('read_own_source', { path: 'agent.ts' }, ctx)).output, /unavailable/);
    assert.match((await (0, tools_1.executeTool)('modify_own_source', { path: 'agent.ts', content: '', reason: 'x' }, ctx)).output, /unavailable/);
});
(0, node_test_1.test)('modify_own_source verifies, records a lesson, and checkpoints', async () => {
    const root = tmp();
    fs.writeFileSync(path.join(root, 'agent.ts'), 'old');
    const commands = [];
    const { ctx, prompts, mutations } = context({
        agentRoot: root,
        selfModify: {
            runCommand: async (c) => {
                commands.push(c);
                return { ok: true, output: '' };
            }
        }
    });
    assert.equal((await (0, tools_1.executeTool)('read_own_source', { path: 'agent.ts' }, ctx)).output, 'old');
    const result = await (0, tools_1.executeTool)('modify_own_source', { path: 'agent.ts', content: 'new', reason: 'faster' }, ctx);
    assert.equal(result.isError, false, result.output);
    assert.equal(fs.readFileSync(path.join(root, 'agent.ts'), 'utf-8'), 'new');
    assert.match(prompts[0], /MODIFY ITS OWN SOURCE/);
    assert.deepEqual(commands, ['npm run build', 'npm test']);
    assert.equal(mutations.length, 1);
    assert.match(ctx.memory.lessons[0].lesson, /Self-modified agent\.ts: faster/);
});
(0, node_test_1.test)('modify_own_source refuses files outside its source', async () => {
    const { ctx, prompts } = context({ agentRoot: tmp() });
    const result = await (0, tools_1.executeTool)('modify_own_source', { path: 'package.json', content: '{}', reason: 'x' }, ctx);
    assert.equal(result.isError, true);
    assert.equal(prompts.length, 0);
});
(0, node_test_1.test)('unknown tools return an error', async () => {
    const { ctx } = context();
    assert.equal((await (0, tools_1.executeTool)('nope', {}, ctx)).isError, true);
});
//# sourceMappingURL=tools.test.js.map
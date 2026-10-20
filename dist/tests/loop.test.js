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
const loop_1 = require("../src/loop");
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'devin-loop-'));
const scripted = (responses) => {
    const requests = [];
    const client = {
        messages: {
            create: async (params) => {
                requests.push(JSON.parse(JSON.stringify(params)));
                if (!responses.length)
                    throw new Error('no scripted response left');
                return responses.shift();
            }
        }
    };
    return { client, requests };
};
const toolUse = (id, name, input) => ({
    stop_reason: 'tool_use',
    content: [
        { type: 'text', text: `Plan: use ${name}` },
        { type: 'tool_use', id, name, input }
    ]
});
const done = (text) => ({ stop_reason: 'end_turn', content: [{ type: 'text', text }] });
const toolContext = (shell) => ({
    approve: async () => true,
    agentRoot: null,
    runShell: shell
});
(0, node_test_1.test)('runs tools in a loop until the model finishes', async () => {
    const memory = new memory_1.AgentMemory(tmp());
    const { client, requests } = scripted([toolUse('t1', 'run_shell', { command: 'npm test' }), done('All tests pass.')]);
    const history = [];
    const result = await (0, loop_1.solveTask)('make tests pass', history, {
        client,
        model: 'test-model',
        memory,
        toolContext: toolContext(async () => '5 passing')
    });
    assert.equal(result.completed, true);
    assert.equal(result.finalText, 'All tests pass.');
    assert.equal(result.steps, 2);
    assert.equal(result.toolCalls, 1);
    assert.equal(result.toolErrors, 0);
    assert.equal(requests.length, 2, 'no reflection call when nothing failed');
    const toolResultTurn = requests[1].messages[2];
    assert.equal(toolResultTurn.role, 'user');
    assert.deepEqual(toolResultTurn.content[0], { type: 'tool_result', tool_use_id: 't1', content: '5 passing', is_error: false });
    assert.ok(requests[0].tools.some((t) => t.name === 'modify_own_source'));
    assert.equal(history.length, 4);
});
(0, node_test_1.test)('reflects after failures and stores the lesson for future sessions', async () => {
    const dir = tmp();
    const memory = new memory_1.AgentMemory(dir);
    const { client } = scripted([
        toolUse('t1', 'run_shell', { command: 'npm test' }),
        toolUse('t2', 'run_shell', { command: 'npm.cmd test' }),
        done('Fixed.'),
        done('On Windows Git Bash use npm.cmd instead of npm.')
    ]);
    const result = await (0, loop_1.solveTask)('run tests', [], {
        client,
        model: 'test-model',
        memory,
        toolContext: toolContext(async (c) => (c === 'npm test' ? 'Error: npm not found' : 'ok'))
    });
    assert.equal(result.toolErrors, 1);
    assert.equal(result.lesson, 'On Windows Git Bash use npm.cmd instead of npm.');
    assert.equal(new memory_1.AgentMemory(dir).lessons[0].lesson, result.lesson);
    const { client: next, requests } = scripted([done('ok')]);
    await (0, loop_1.solveTask)('another task', [], { client: next, model: 'm', memory: new memory_1.AgentMemory(dir), toolContext: toolContext(async () => '') });
    assert.match(requests[0].system, /use npm\.cmd instead of npm/);
});
(0, node_test_1.test)('does not store NONE reflections', async () => {
    const memory = new memory_1.AgentMemory(tmp());
    const { client } = scripted([toolUse('t1', 'read_file', { path: path.join(tmp(), 'missing') }), done('Could not find it.'), done('NONE')]);
    const result = await (0, loop_1.solveTask)('read it', [], { client, model: 'm', memory, toolContext: toolContext(async () => '') });
    assert.equal(result.lesson, undefined);
    assert.equal(memory.lessons.length, 0);
});
(0, node_test_1.test)('stops at the step limit with a valid history', async () => {
    const memory = new memory_1.AgentMemory(tmp());
    const { client } = scripted([
        toolUse('a', 'run_shell', { command: 'ls' }),
        toolUse('b', 'run_shell', { command: 'ls' }),
        done('Stop and ask the user when two identical attempts make no progress.')
    ]);
    const history = [];
    const result = await (0, loop_1.solveTask)('loop', history, {
        client,
        model: 'm',
        memory,
        maxSteps: 2,
        toolContext: toolContext(async () => 'x')
    });
    assert.equal(result.completed, false);
    assert.equal(result.steps, 2);
    assert.match(result.finalText, /Stopped after 2 steps/);
    assert.equal(history[history.length - 1].role, 'assistant');
    assert.equal(memory.lessons[0].outcome, 'failure');
});
(0, node_test_1.test)('system prompt includes problem-solving guidance and lessons', () => {
    const memory = new memory_1.AgentMemory(tmp());
    assert.match((0, loop_1.buildSystemPrompt)(memory), /numbered plan/);
    assert.doesNotMatch((0, loop_1.buildSystemPrompt)(memory), /Lessons learned/);
    memory.record('t', 'success', 'prefer small diffs');
    assert.match((0, loop_1.buildSystemPrompt)(memory), /prefer small diffs/);
});
//# sourceMappingURL=loop.test.js.map
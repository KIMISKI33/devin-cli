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
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'devin-mem-'));
(0, node_test_1.test)('records lessons and persists them across instances', () => {
    const dir = tmp();
    const memory = new memory_1.AgentMemory(dir);
    memory.record('task', 'failure', 'npm on Windows needs npm.cmd');
    const reloaded = new memory_1.AgentMemory(dir);
    assert.equal(reloaded.lessons.length, 1);
    assert.equal(reloaded.lessons[0].lesson, 'npm on Windows needs npm.cmd');
    assert.equal(reloaded.lessons[0].outcome, 'failure');
    assert.ok(fs.existsSync(path.join(dir, '.devin', 'memory.json')));
});
(0, node_test_1.test)('ignores empty lessons and de-duplicates repeats', () => {
    const memory = new memory_1.AgentMemory(tmp());
    assert.equal(memory.record('t', 'success', '   '), null);
    memory.record('t', 'success', 'same');
    memory.record('t2', 'success', 'same');
    assert.equal(memory.lessons.length, 1);
});
(0, node_test_1.test)('caps the number of stored lessons, keeping the newest', () => {
    const memory = new memory_1.AgentMemory(tmp());
    for (let i = 0; i < 210; i++)
        memory.record('t', 'success', `lesson ${i}`);
    assert.equal(memory.lessons.length, 200);
    assert.equal(memory.lessons[0].lesson, 'lesson 10');
    assert.equal(memory.lessons[199].lesson, 'lesson 209');
});
(0, node_test_1.test)('promptSection lists recent lessons and is empty with no memory', () => {
    const memory = new memory_1.AgentMemory(tmp());
    assert.equal(memory.promptSection(), '');
    memory.record('t', 'failure', 'run tests before committing');
    assert.match(memory.promptSection(), /\[failure\] run tests before committing/);
});
(0, node_test_1.test)('forget removes a lesson', () => {
    const memory = new memory_1.AgentMemory(tmp());
    memory.record('t', 'success', 'keep');
    memory.record('t', 'success', 'drop');
    assert.equal(memory.forget('drop'), true);
    assert.equal(memory.forget('missing'), false);
    assert.deepEqual(memory.lessons.map((l) => l.lesson), ['keep']);
});
(0, node_test_1.test)('recovers from a corrupted memory file', () => {
    const dir = tmp();
    fs.mkdirSync(path.join(dir, '.devin'));
    fs.writeFileSync(path.join(dir, '.devin', 'memory.json'), '{not json');
    const memory = new memory_1.AgentMemory(dir);
    assert.equal(memory.lessons.length, 0);
    memory.record('t', 'success', 'works again');
    assert.equal(new memory_1.AgentMemory(dir).lessons.length, 1);
});
//# sourceMappingURL=memory.test.js.map
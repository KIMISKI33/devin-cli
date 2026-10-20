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
const selfModify_1 = require("../src/selfModify");
const makeRepo = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devin-self-'));
    fs.mkdirSync(path.join(dir, 'src'));
    fs.writeFileSync(path.join(dir, 'agent.ts'), 'original agent');
    fs.writeFileSync(path.join(dir, 'src', 'loop.ts'), 'original loop');
    return dir;
};
const runner = (failOn) => {
    const calls = [];
    const run = async (command) => {
        calls.push(command);
        return command === failOn ? { ok: false, output: 'error TS2322: boom' } : { ok: true, output: 'ok' };
    };
    return { calls, run };
};
(0, node_test_1.test)('isEditablePath only allows the agent source tree', () => {
    const root = makeRepo();
    assert.equal((0, selfModify_1.isEditablePath)(root, 'agent.ts'), true);
    assert.equal((0, selfModify_1.isEditablePath)(root, 'src/loop.ts'), true);
    assert.equal((0, selfModify_1.isEditablePath)(root, 'tests/new.test.ts'), true);
    assert.equal((0, selfModify_1.isEditablePath)(root, '../outside.ts'), false);
    assert.equal((0, selfModify_1.isEditablePath)(root, 'package.json'), false);
    assert.equal((0, selfModify_1.isEditablePath)(root, 'node_modules/x/index.js'), false);
    assert.equal((0, selfModify_1.isEditablePath)(root, 'src/payload.exe'), false);
    assert.equal((0, selfModify_1.isEditablePath)(root, path.join(os.tmpdir(), 'x.ts')), false);
});
(0, node_test_1.test)('applies a change when build and tests pass', async () => {
    const root = makeRepo();
    const { calls, run } = runner();
    const result = await (0, selfModify_1.applySelfModification)('src/loop.ts', 'improved loop', { repoRoot: root, runCommand: run });
    assert.equal(result.applied, true);
    assert.equal(fs.readFileSync(path.join(root, 'src', 'loop.ts'), 'utf-8'), 'improved loop');
    assert.deepEqual(calls, ['npm run build', 'npm test']);
    assert.equal(fs.readFileSync(result.backupPath, 'utf-8'), 'original loop');
});
(0, node_test_1.test)('rolls back and rebuilds when verification fails', async () => {
    const root = makeRepo();
    const { calls, run } = runner('npm test');
    const result = await (0, selfModify_1.applySelfModification)('agent.ts', 'broken agent', { repoRoot: root, runCommand: run });
    assert.equal(result.applied, false);
    assert.match(result.message, /Reverted agent\.ts/);
    assert.match(result.message, /boom/);
    assert.equal(fs.readFileSync(path.join(root, 'agent.ts'), 'utf-8'), 'original agent');
    assert.deepEqual(calls, ['npm run build', 'npm test', 'npm run build']);
});
(0, node_test_1.test)('removes a newly created file when verification fails', async () => {
    const root = makeRepo();
    const { run } = runner('npm run build');
    const result = await (0, selfModify_1.applySelfModification)('src/extra.ts', 'bad', { repoRoot: root, runCommand: run });
    assert.equal(result.applied, false);
    assert.equal(fs.existsSync(path.join(root, 'src', 'extra.ts')), false);
});
(0, node_test_1.test)('refuses paths outside the agent source without touching disk', async () => {
    const root = makeRepo();
    const { calls, run } = runner();
    const result = await (0, selfModify_1.applySelfModification)('../evil.ts', 'x', { repoRoot: root, runCommand: run });
    assert.equal(result.applied, false);
    assert.match(result.message, /Refused/);
    assert.equal(calls.length, 0);
});
//# sourceMappingURL=selfModify.test.js.map
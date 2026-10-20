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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.resolveAgentRoot = void 0;
exports.main = main;
const sdk_1 = __importDefault(require("@anthropic-ai/sdk"));
const child_process_1 = require("child_process");
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const readline = __importStar(require("readline"));
const dotenv = __importStar(require("dotenv"));
const memory_1 = require("./src/memory");
const loop_1 = require("./src/loop");
dotenv.config();
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5';
const MAX_STEPS = Number(process.env.DEVIN_MAX_STEPS) || 25;
/** Directory holding the agent's own source, or null when running as a packaged binary. */
const resolveAgentRoot = (dir = __dirname) => {
    if (process.pkg)
        return null;
    const root = path.basename(dir) === 'dist' ? path.dirname(dir) : dir;
    return fs.existsSync(path.join(root, 'agent.ts')) ? root : null;
};
exports.resolveAgentRoot = resolveAgentRoot;
// --- AUTOMATED GIT TRACKING SYSTEM ---
const runSilentGitCommand = (command) => new Promise((resolve) => {
    (0, child_process_1.exec)(command, { timeout: 5000 }, (error) => resolve(!error));
});
const ensureGitRepository = async () => {
    const isGit = await runSilentGitCommand('git rev-parse --is-inside-work-tree');
    if (!isGit) {
        console.log('📁 Local directory is not a Git repo. Initialising Git tracking...');
        await runSilentGitCommand('git init');
        await runSilentGitCommand('git config user.email "devin@ai.dev"');
        await runSilentGitCommand('git config user.name "Devin AI Agent"');
        await runSilentGitCommand('git add . && git commit -m "Initial commit by Devin Agent"');
    }
};
const autoCommitChanges = async (actionDetails) => {
    await runSilentGitCommand('git add .');
    const safeMessage = `🤖 Devin Auto-Commit: ${actionDetails}`.replace(/"/g, '\\"').replace(/\r?\n/g, ' ');
    if (await runSilentGitCommand(`git commit -m "${safeMessage}"`)) {
        console.log('✨ [Git] Version checkpoint saved automatically.');
    }
};
const printEvent = (event) => {
    switch (event.type) {
        case 'thinking':
            console.log(event.step === 1 ? '🤔 Thinking...' : `🔁 Step ${event.step}...`);
            break;
        case 'text':
            console.log(`\n🤖 Devin: ${event.text}\n`);
            break;
        case 'tool_call':
            console.log(`🛠️  ${event.name}`);
            break;
        case 'tool_result': {
            const preview = event.output.length > 1500 ? `${event.output.slice(0, 1500)}\n...` : event.output;
            console.log(`${event.isError ? '❌' : '✅'} ${event.name} result:\n${preview}\n`);
            break;
        }
        case 'lesson':
            console.log(`🧠 Learned: ${event.lesson}\n`);
            break;
        case 'step_limit':
            console.log(`⏸️  Step limit (${event.steps}) reached.`);
            break;
    }
};
async function main() {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    // Buffer lines ourselves so input that arrives before a prompt (e.g. piped stdin) is not lost.
    const pendingLines = [];
    const waiters = [];
    let closed = false;
    rl.on('line', (line) => {
        const waiter = waiters.shift();
        if (waiter)
            waiter(line);
        else
            pendingLines.push(line);
    });
    rl.on('close', () => {
        closed = true;
        while (waiters.length)
            waiters.shift()(null);
    });
    const askQuestion = (query) => {
        process.stdout.write(query);
        if (pendingLines.length)
            return Promise.resolve(pendingLines.shift());
        if (closed)
            return Promise.resolve(null);
        return new Promise((resolve) => waiters.push(resolve));
    };
    const approve = async (description) => {
        const answer = await askQuestion(`⚠️ Agent wants to ${description}\nApprove? (y/n): `);
        return (answer ?? '').trim().toLowerCase() === 'y';
    };
    const memory = new memory_1.AgentMemory();
    const agentRoot = (0, exports.resolveAgentRoot)();
    const apiKey = process.env.ANTHROPIC_API_KEY;
    const client = apiKey ? new sdk_1.default({ apiKey }) : null;
    console.log('\n🤖 Devin Autonomous AI Engineer - CLI Edition');
    console.log('============================================');
    console.log(`🧠 Model: ${MODEL}`);
    console.log(`📚 Lessons in memory: ${memory.lessons.length} (${memory.filePath})`);
    console.log(`🔧 Self-modification: ${agentRoot ? `enabled (${agentRoot})` : 'disabled in packaged binary'}`);
    console.log('============================================\n');
    await ensureGitRepository();
    console.log("Commands: 'exit', 'clear' (reset conversation), 'stats', 'memory' (show lessons).\n");
    let history = [];
    let tasks = 0;
    let toolCalls = 0;
    while (true) {
        const input = await askQuestion('👤 You: ');
        if (input === null || input.trim().toLowerCase() === 'exit') {
            console.log(`\n👋 Goodbye! (${toolCalls} actions completed)\n`);
            rl.close();
            return;
        }
        const command = input.trim().toLowerCase();
        if (!command)
            continue;
        if (command === 'clear') {
            history = [];
            console.log('🔄 Conversation cleared (long-term memory kept).\n');
            continue;
        }
        if (command === 'stats') {
            console.log(`\n📊 Tasks: ${tasks} | Actions: ${toolCalls} | Messages: ${history.length} | Lessons: ${memory.lessons.length}\n`);
            continue;
        }
        if (command === 'memory') {
            const lessons = memory.lessons;
            console.log(lessons.length ? `\n${lessons.map((l) => `- [${l.outcome}] ${l.lesson}`).join('\n')}\n` : '\n(no lessons yet)\n');
            continue;
        }
        if (!client) {
            console.error('\n❌ No API key configured. Set ANTHROPIC_API_KEY.\n');
            continue;
        }
        try {
            const result = await (0, loop_1.solveTask)(input, history, {
                client,
                model: MODEL,
                memory,
                maxSteps: MAX_STEPS,
                toolContext: { approve, agentRoot, onMutation: autoCommitChanges },
                log: printEvent
            });
            tasks++;
            toolCalls += result.toolCalls;
            if (!result.completed)
                console.log(`\n🤖 Devin: ${result.finalText}\n`);
        }
        catch (error) {
            console.error(`\n❌ Error: ${error?.message ?? error}\n`);
            // Drop the unanswered turn so the next request starts from a valid history.
            while (history.length && history[history.length - 1].role === 'user')
                history.pop();
        }
    }
}
if (require.main === module) {
    main().catch((error) => {
        console.error(error);
        process.exit(1);
    });
}
//# sourceMappingURL=agent.js.map
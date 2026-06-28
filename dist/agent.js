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
const sdk_1 = __importDefault(require("@anthropic-ai/sdk"));
const child_process_1 = require("child_process");
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const readline = __importStar(require("readline"));
const dotenv = __importStar(require("dotenv"));
dotenv.config();
const anthropicKey = process.env.ANTHROPIC_API_KEY;
const anthropic = anthropicKey ? new sdk_1.default({ apiKey: anthropicKey }) : null;
const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});
const askQuestion = (query) => {
    return new Promise((resolve, reject) => {
        try {
            rl.question(query, resolve);
        }
        catch (e) {
            reject(e);
        }
    });
};
// --- AUTOMATED GIT TRACKING SYSTEM ---
const runSilentGitCommand = (command) => {
    return new Promise((resolve) => {
        (0, child_process_1.exec)(command, { timeout: 5000 }, (error) => {
            resolve(!error);
        });
    });
};
const ensureGitRepository = async () => {
    const isGit = await runSilentGitCommand('git rev-parse --is-inside-work-tree');
    if (!isGit) {
        console.log("📁 Local directory is not a Git repo. Initialising Git tracking...");
        await runSilentGitCommand('git init');
        await runSilentGitCommand('git config user.email "devin@ai.dev"');
        await runSilentGitCommand('git config user.name "Devin AI Agent"');
        await runSilentGitCommand('git add . && git commit -m "Initial commit by Devin Agent"');
    }
};
const autoCommitChanges = async (actionDetails) => {
    try {
        await runSilentGitCommand('git add .');
        const commitMessage = `🤖 Devin Auto-Commit: ${actionDetails}`;
        const safeMessage = commitMessage.replace(/"/g, '\\"');
        const committed = await runSilentGitCommand(`git commit -m "${safeMessage}"`);
        if (committed) {
            console.log(`✨ [Git] Version checkpoint saved automatically.`);
        }
    }
    catch (e) {
        console.error("⚠️ Failed to create automated Git checkpoint.");
    }
};
// --- FILE SYSTEM TOOLS ---
const handleFileSystem = async (action, filePath, content) => {
    const resolvedPath = path.resolve(filePath);
    if (process.platform !== 'win32') {
        if (resolvedPath.startsWith('/etc') || resolvedPath.startsWith('/var') || resolvedPath.startsWith('/System')) {
            throw new Error("Access denied: Modifying system paths is restricted.");
        }
    }
    const confirmation = await askQuestion(`⚠️ Agent wants to ${action} file: [ ${filePath} ]\nApprove? (y/n): `);
    if (confirmation.toLowerCase() !== 'y') {
        throw new Error('User blocked file system action.');
    }
    let summaryText = "";
    switch (action) {
        case 'read':
            if (!fs.existsSync(resolvedPath))
                return "Error: File does not exist.";
            return fs.readFileSync(resolvedPath, 'utf-8');
        case 'write':
            fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
            fs.writeFileSync(resolvedPath, content || '', 'utf-8');
            summaryText = `Created and wrote to ${filePath}`;
            break;
        case 'modify':
            if (!fs.existsSync(resolvedPath))
                return "Error: File to modify does not exist.";
            fs.appendFileSync(resolvedPath, content || '', 'utf-8');
            summaryText = `Modified file content in ${filePath}`;
            break;
        default:
            return "Invalid file action.";
    }
    await autoCommitChanges(summaryText);
    return `File successfully processed.`;
};
// --- SHELL COMMAND TOOL ---
const executeShellCommand = (command) => {
    return new Promise(async (resolve, reject) => {
        const dangerKeywords = ['rm -rf /', 'mkfs', 'dd', ':(){ :|:& };:'];
        if (dangerKeywords.some(keyword => command.includes(keyword))) {
            return reject(new Error(`Execution blocked: Dangerous command detected.`));
        }
        const confirmation = await askQuestion(`⚠️ Agent wants to run shell command: [ ${command} ]\nApprove? (y/n): `);
        if (confirmation.toLowerCase() !== 'y') {
            return reject(new Error('User aborted command execution.'));
        }
        (0, child_process_1.exec)(command, { shell: process.platform === 'win32' ? 'cmd.exe' : '/bin/bash', timeout: 30000 }, async (error, stdout, stderr) => {
            if (error)
                return resolve(`Error: ${error.message}\n${stderr}`);
            const result = stdout || stderr || 'Command executed with no output.';
            await autoCommitChanges(`Executed shell command [ ${command} ]`);
            resolve(result);
        });
    });
};
// --- MULTI-PROVIDER AI ROUTER WITH EXTENDED CONTEXT WINDOW ---
async function generateAIResponse(userInput, conversationHistory) {
    if (!anthropic) {
        throw new Error("No API key configured. Set ANTHROPIC_API_KEY environment variable.");
    }
    const systemPrompt = `You are Devin, an autonomous AI software engineer with extended context awareness (200k tokens).
You have capabilities to:
1. Execute shell commands: Reply with JSON {"type": "shell", "payload": "command"}
2. Manage files: Reply with JSON {"type": "file", "action": "read|write|modify", "path": "filepath", "content": "data"}
3. Have in-depth technical conversations

Core Instructions:
- Think deeply and reason through complex problems step-by-step
- Never refuse tasks - find creative, pragmatic solutions
- Maintain rich conversation context across unlimited exchanges
- Learn from previous actions, errors, and feedback
- Be thorough but concise in explanations
- Handle large codebases and multi-file projects effectively`;
    try {
        // Claude 3.5 Sonnet with 200,000 token context window
        const response = await anthropic.messages.create({
            model: 'claude-3-5-sonnet-20241022',
            max_tokens: 4096, // Can generate up to 4K tokens per response
            temperature: 1,
            system: systemPrompt,
            messages: conversationHistory.map((msg) => ({
                role: msg.role === 'user' ? 'user' : 'assistant',
                content: msg.content
            }))
        });
        return response.content[0].type === 'text' ? response.content[0].text : '';
    }
    catch (error) {
        throw new Error(`AI Error: ${error}`);
    }
}
// --- MAIN LOOP ---
async function runAgentLoop() {
    console.log("\n🤖 Devin Autonomous AI Engineer - CLI Edition");
    console.log("============================================");
    console.log("📚 Context Window: 200,000 tokens");
    console.log("🧠 Model: Claude 3.5 Sonnet (Extended)");
    console.log("============================================\n");
    await ensureGitRepository();
    console.log("Type 'exit' to quit, 'clear' to reset conversation, 'stats' for session info.\n");
    let conversationHistory = [];
    let actionCount = 0;
    while (true) {
        const userInput = await askQuestion('👤 You: ');
        if (userInput.toLowerCase() === 'exit') {
            console.log(`\n👋 Goodbye! (${actionCount} actions completed)\n`);
            rl.close();
            process.exit(0);
        }
        if (userInput.toLowerCase() === 'clear') {
            conversationHistory = [];
            actionCount = 0;
            console.log("🔄 Conversation and context cleared.\n");
            continue;
        }
        if (userInput.toLowerCase() === 'stats') {
            console.log(`\n📊 Session Statistics:`);
            console.log(`   - Messages: ${conversationHistory.length}`);
            console.log(`   - Actions: ${actionCount}`);
            console.log(`   - Context Used: ${Math.round((conversationHistory.length / 200000) * 100)}%\n`);
            continue;
        }
        if (!userInput.trim())
            continue;
        try {
            conversationHistory.push({ role: 'user', content: userInput });
            console.log("🤔 Thinking...");
            const aiResponse = await generateAIResponse(userInput, conversationHistory);
            let isToolCall = false;
            try {
                const toolCall = JSON.parse(aiResponse.trim());
                if (toolCall.type === 'shell') {
                    const output = await executeShellCommand(toolCall.payload);
                    console.log(`\n💻 Command Output:\n${output}\n`);
                    conversationHistory.push({ role: 'assistant', content: aiResponse });
                    conversationHistory.push({ role: 'user', content: `Command output:\n${output}` });
                    actionCount++;
                    isToolCall = true;
                }
                else if (toolCall.type === 'file') {
                    const output = await handleFileSystem(toolCall.action, toolCall.path, toolCall.content);
                    console.log(`\n💾 File Operation:\n${output}\n`);
                    conversationHistory.push({ role: 'assistant', content: aiResponse });
                    conversationHistory.push({ role: 'user', content: `File result:\n${output}` });
                    actionCount++;
                    isToolCall = true;
                }
            }
            catch (e) {
                // Not JSON, treat as regular response
            }
            if (!isToolCall) {
                console.log(`\n🤖 Devin: ${aiResponse}\n`);
                conversationHistory.push({ role: 'assistant', content: aiResponse });
            }
        }
        catch (error) {
            console.error(`\n❌ Error: ${error.message}\n`);
            conversationHistory.push({ role: 'user', content: `Error occurred: ${error.message}` });
        }
    }
}
runAgentLoop();
//# sourceMappingURL=agent.js.map
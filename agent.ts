import { exec } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import * as dotenv from 'dotenv';
import { AgentMemory } from './src/memory';
import { createAnthropicClient } from './src/anthropic';
import { AgentEvent, MessagesClient, solveTask } from './src/loop';

dotenv.config();

const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5';
const MAX_STEPS = Number(process.env.DEVIN_MAX_STEPS) || 25;

/** Directory holding the agent's own source, or null when running as a packaged binary. */
export const resolveAgentRoot = (dir: string = __dirname): string | null => {
  if ((process as any).pkg) return null;
  const root = path.basename(dir) === 'dist' ? path.dirname(dir) : dir;
  return fs.existsSync(path.join(root, 'agent.ts')) ? root : null;
};

// --- AUTOMATED GIT TRACKING SYSTEM ---
const runSilentGitCommand = (command: string): Promise<boolean> =>
  new Promise((resolve) => {
    exec(command, { timeout: 5000 }, (error) => resolve(!error));
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

const autoCommitChanges = async (actionDetails: string) => {
  await runSilentGitCommand('git add .');
  const safeMessage = `🤖 Devin Auto-Commit: ${actionDetails}`.replace(/"/g, '\\"').replace(/\r?\n/g, ' ');
  if (await runSilentGitCommand(`git commit -m "${safeMessage}"`)) {
    console.log('✨ [Git] Version checkpoint saved automatically.');
  }
};

const printEvent = (event: AgentEvent) => {
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

export async function main() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  // Buffer lines ourselves so input that arrives before a prompt (e.g. piped stdin) is not lost.
  const pendingLines: string[] = [];
  const waiters: ((line: string | null) => void)[] = [];
  let closed = false;
  rl.on('line', (line) => {
    const waiter = waiters.shift();
    if (waiter) waiter(line);
    else pendingLines.push(line);
  });
  rl.on('close', () => {
    closed = true;
    while (waiters.length) waiters.shift()!(null);
  });

  const askQuestion = (query: string): Promise<string | null> => {
    process.stdout.write(query);
    if (pendingLines.length) return Promise.resolve(pendingLines.shift()!);
    if (closed) return Promise.resolve(null);
    return new Promise((resolve) => waiters.push(resolve));
  };

  const approve = async (description: string) => {
    const answer = await askQuestion(`⚠️ Agent wants to ${description}\nApprove? (y/n): `);
    return (answer ?? '').trim().toLowerCase() === 'y';
  };

  const memory = new AgentMemory();
  const agentRoot = resolveAgentRoot();
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const client: MessagesClient | null = apiKey ? createAnthropicClient({ apiKey }) : null;

  console.log('\n🤖 Devin Autonomous AI Engineer - CLI Edition');
  console.log('============================================');
  console.log(`🧠 Model: ${MODEL}`);
  console.log(`📚 Lessons in memory: ${memory.lessons.length} (${memory.filePath})`);
  console.log(`🔧 Self-modification: ${agentRoot ? `enabled (${agentRoot})` : 'disabled in packaged binary'}`);
  console.log('============================================\n');

  await ensureGitRepository();
  console.log("Commands: 'exit', 'clear' (reset conversation), 'stats', 'memory' (show lessons).\n");

  let history: any[] = [];
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
    if (!command) continue;

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
      const result = await solveTask(input, history, {
        client,
        model: MODEL,
        memory,
        maxSteps: MAX_STEPS,
        toolContext: { approve, agentRoot, onMutation: autoCommitChanges },
        log: printEvent
      });
      tasks++;
      toolCalls += result.toolCalls;
      if (!result.completed) console.log(`\n🤖 Devin: ${result.finalText}\n`);
    } catch (error: any) {
      console.error(`\n❌ Error: ${error?.message ?? error}\n`);
      // Drop the unanswered turn so the next request starts from a valid history.
      while (history.length && history[history.length - 1].role === 'user') history.pop();
    }
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

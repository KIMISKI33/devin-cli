import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AgentMemory } from '../src/memory';
import { executeTool, isDangerousCommand, ToolContext } from '../src/tools';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'devin-tools-'));

const context = (overrides: Partial<ToolContext> = {}) => {
  const prompts: string[] = [];
  const mutations: string[] = [];
  const ctx: ToolContext = {
    approve: async (d) => {
      prompts.push(d);
      return true;
    },
    memory: new AgentMemory(tmp()),
    agentRoot: null,
    onMutation: async (d) => {
      mutations.push(d);
    },
    runShell: async (c) => `ran: ${c}`,
    ...overrides
  };
  return { ctx, prompts, mutations };
};

test('isDangerousCommand blocks destructive commands but not normal ones', () => {
  for (const cmd of ['rm -rf /', 'sudo rm -rf / --no-preserve-root', 'mkfs.ext4 /dev/sda1', 'dd if=/dev/zero of=/dev/sda', ':(){ :|:& };:']) {
    assert.equal(isDangerousCommand(cmd), true, cmd);
  }
  for (const cmd of ['git add .', 'npm run build', 'rm -rf ./dist', 'echo address', 'ls /']) {
    assert.equal(isDangerousCommand(cmd), false, cmd);
  }
});

test('run_shell asks for approval, runs, and checkpoints', async () => {
  const { ctx, prompts, mutations } = context();
  const result = await executeTool('run_shell', { command: 'git add .' }, ctx);
  assert.equal(result.isError, false);
  assert.equal(result.output, 'ran: git add .');
  assert.equal(prompts.length, 1);
  assert.equal(mutations.length, 1);
});

test('run_shell respects a declined approval', async () => {
  let ran = false;
  const { ctx } = context({
    approve: async () => false,
    runShell: async () => {
      ran = true;
      return '';
    }
  });
  const result = await executeTool('run_shell', { command: 'ls' }, ctx);
  assert.equal(result.isError, true);
  assert.equal(ran, false);
});

test('run_shell refuses dangerous commands without prompting', async () => {
  const { ctx, prompts } = context();
  const result = await executeTool('run_shell', { command: 'rm -rf /' }, ctx);
  assert.equal(result.isError, true);
  assert.equal(prompts.length, 0);
});

test('write, append, read and list files', async () => {
  const dir = tmp();
  const file = path.join(dir, 'nested', 'a.txt');
  const { ctx } = context();
  assert.equal((await executeTool('write_file', { path: file, content: 'hello' }, ctx)).isError, false);
  assert.equal((await executeTool('append_file', { path: file, content: ' world' }, ctx)).isError, false);
  assert.equal((await executeTool('read_file', { path: file }, ctx)).output, 'hello world');
  assert.equal((await executeTool('list_directory', { path: dir }, ctx)).output, 'nested/');
  assert.equal((await executeTool('read_file', { path: path.join(dir, 'missing') }, ctx)).isError, true);
  assert.equal((await executeTool('append_file', { path: path.join(dir, 'missing'), content: 'x' }, ctx)).isError, true);
});

test('record_lesson stores to long-term memory', async () => {
  const { ctx } = context({ currentTask: 'build' });
  const result = await executeTool('record_lesson', { lesson: 'use npm.cmd', outcome: 'failure' }, ctx);
  assert.equal(result.isError, false);
  assert.equal(ctx.memory.lessons[0].lesson, 'use npm.cmd');
  assert.equal(ctx.memory.lessons[0].task, 'build');
});

test('self-modification tools are disabled without an agent root', async () => {
  const { ctx } = context();
  assert.match((await executeTool('read_own_source', { path: 'agent.ts' }, ctx)).output, /unavailable/);
  assert.match((await executeTool('modify_own_source', { path: 'agent.ts', content: '', reason: 'x' }, ctx)).output, /unavailable/);
});

test('modify_own_source verifies, records a lesson, and checkpoints', async () => {
  const root = tmp();
  fs.writeFileSync(path.join(root, 'agent.ts'), 'old');
  const commands: string[] = [];
  const { ctx, prompts, mutations } = context({
    agentRoot: root,
    selfModify: {
      runCommand: async (c) => {
        commands.push(c);
        return { ok: true, output: '' };
      }
    }
  });
  assert.equal((await executeTool('read_own_source', { path: 'agent.ts' }, ctx)).output, 'old');
  const result = await executeTool('modify_own_source', { path: 'agent.ts', content: 'new', reason: 'faster' }, ctx);
  assert.equal(result.isError, false, result.output);
  assert.equal(fs.readFileSync(path.join(root, 'agent.ts'), 'utf-8'), 'new');
  assert.match(prompts[0], /MODIFY ITS OWN SOURCE/);
  assert.deepEqual(commands, ['npm run build', 'npm test']);
  assert.equal(mutations.length, 1);
  assert.match(ctx.memory.lessons[0].lesson, /Self-modified agent\.ts: faster/);
});

test('modify_own_source refuses files outside its source', async () => {
  const { ctx, prompts } = context({ agentRoot: tmp() });
  const result = await executeTool('modify_own_source', { path: 'package.json', content: '{}', reason: 'x' }, ctx);
  assert.equal(result.isError, true);
  assert.equal(prompts.length, 0);
});

test('unknown tools return an error', async () => {
  const { ctx } = context();
  assert.equal((await executeTool('nope', {}, ctx)).isError, true);
});

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AgentMemory } from '../src/memory';
import { buildSystemPrompt, MessagesClient, solveTask } from '../src/loop';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'devin-loop-'));

const scripted = (responses: any[]) => {
  const requests: any[] = [];
  const client: MessagesClient = {
    messages: {
      create: async (params: any) => {
        requests.push(JSON.parse(JSON.stringify(params)));
        if (!responses.length) throw new Error('no scripted response left');
        return responses.shift();
      }
    }
  };
  return { client, requests };
};

const toolUse = (id: string, name: string, input: any) => ({
  stop_reason: 'tool_use',
  content: [
    { type: 'text', text: `Plan: use ${name}` },
    { type: 'tool_use', id, name, input }
  ]
});
const done = (text: string) => ({ stop_reason: 'end_turn', content: [{ type: 'text', text }] });

const toolContext = (shell: (c: string) => Promise<string>) => ({
  approve: async () => true,
  agentRoot: null,
  runShell: shell
});

test('runs tools in a loop until the model finishes', async () => {
  const memory = new AgentMemory(tmp());
  const { client, requests } = scripted([toolUse('t1', 'run_shell', { command: 'npm test' }), done('All tests pass.')]);
  const history: any[] = [];
  const result = await solveTask('make tests pass', history, {
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
  assert.ok(requests[0].tools.some((t: any) => t.name === 'modify_own_source'));
  assert.equal(history.length, 4);
});

test('reflects after failures and stores the lesson for future sessions', async () => {
  const dir = tmp();
  const memory = new AgentMemory(dir);
  const { client } = scripted([
    toolUse('t1', 'run_shell', { command: 'npm test' }),
    toolUse('t2', 'run_shell', { command: 'npm.cmd test' }),
    done('Fixed.'),
    done('On Windows Git Bash use npm.cmd instead of npm.')
  ]);
  const result = await solveTask('run tests', [], {
    client,
    model: 'test-model',
    memory,
    toolContext: toolContext(async (c) => (c === 'npm test' ? 'Error: npm not found' : 'ok'))
  });

  assert.equal(result.toolErrors, 1);
  assert.equal(result.lesson, 'On Windows Git Bash use npm.cmd instead of npm.');
  assert.equal(new AgentMemory(dir).lessons[0].lesson, result.lesson);

  const { client: next, requests } = scripted([done('ok')]);
  await solveTask('another task', [], { client: next, model: 'm', memory: new AgentMemory(dir), toolContext: toolContext(async () => '') });
  assert.match(requests[0].system, /use npm\.cmd instead of npm/);
});

test('does not store NONE reflections', async () => {
  const memory = new AgentMemory(tmp());
  const { client } = scripted([toolUse('t1', 'read_file', { path: path.join(tmp(), 'missing') }), done('Could not find it.'), done('NONE')]);
  const result = await solveTask('read it', [], { client, model: 'm', memory, toolContext: toolContext(async () => '') });
  assert.equal(result.lesson, undefined);
  assert.equal(memory.lessons.length, 0);
});

test('stops at the step limit with a valid history', async () => {
  const memory = new AgentMemory(tmp());
  const { client } = scripted([
    toolUse('a', 'run_shell', { command: 'ls' }),
    toolUse('b', 'run_shell', { command: 'ls' }),
    done('Stop and ask the user when two identical attempts make no progress.')
  ]);
  const history: any[] = [];
  const result = await solveTask('loop', history, {
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

test('system prompt includes problem-solving guidance and lessons', () => {
  const memory = new AgentMemory(tmp());
  assert.match(buildSystemPrompt(memory), /numbered plan/);
  assert.doesNotMatch(buildSystemPrompt(memory), /Lessons learned/);
  memory.record('t', 'success', 'prefer small diffs');
  assert.match(buildSystemPrompt(memory), /prefer small diffs/);
});

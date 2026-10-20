import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AgentMemory } from '../src/memory';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'devin-mem-'));

test('records lessons and persists them across instances', () => {
  const dir = tmp();
  const memory = new AgentMemory(dir);
  memory.record('task', 'failure', 'npm on Windows needs npm.cmd');
  const reloaded = new AgentMemory(dir);
  assert.equal(reloaded.lessons.length, 1);
  assert.equal(reloaded.lessons[0].lesson, 'npm on Windows needs npm.cmd');
  assert.equal(reloaded.lessons[0].outcome, 'failure');
  assert.ok(fs.existsSync(path.join(dir, '.devin', 'memory.json')));
});

test('ignores empty lessons and de-duplicates repeats', () => {
  const memory = new AgentMemory(tmp());
  assert.equal(memory.record('t', 'success', '   '), null);
  memory.record('t', 'success', 'same');
  memory.record('t2', 'success', 'same');
  assert.equal(memory.lessons.length, 1);
});

test('caps the number of stored lessons, keeping the newest', () => {
  const memory = new AgentMemory(tmp());
  for (let i = 0; i < 210; i++) memory.record('t', 'success', `lesson ${i}`);
  assert.equal(memory.lessons.length, 200);
  assert.equal(memory.lessons[0].lesson, 'lesson 10');
  assert.equal(memory.lessons[199].lesson, 'lesson 209');
});

test('promptSection lists recent lessons and is empty with no memory', () => {
  const memory = new AgentMemory(tmp());
  assert.equal(memory.promptSection(), '');
  memory.record('t', 'failure', 'run tests before committing');
  assert.match(memory.promptSection(), /\[failure\] run tests before committing/);
});

test('forget removes a lesson', () => {
  const memory = new AgentMemory(tmp());
  memory.record('t', 'success', 'keep');
  memory.record('t', 'success', 'drop');
  assert.equal(memory.forget('drop'), true);
  assert.equal(memory.forget('missing'), false);
  assert.deepEqual(memory.lessons.map((l) => l.lesson), ['keep']);
});

test('recovers from a corrupted memory file', () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, '.devin'));
  fs.writeFileSync(path.join(dir, '.devin', 'memory.json'), '{not json');
  const memory = new AgentMemory(dir);
  assert.equal(memory.lessons.length, 0);
  memory.record('t', 'success', 'works again');
  assert.equal(new AgentMemory(dir).lessons.length, 1);
});

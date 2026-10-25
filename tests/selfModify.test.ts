import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { applySelfModification, isEditablePath } from '../src/selfModify';

const makeRepo = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devin-self-'));
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'agent.ts'), 'original agent');
  fs.writeFileSync(path.join(dir, 'src', 'loop.ts'), 'original loop');
  return dir;
};

const runner = (failOn?: string) => {
  const calls: string[] = [];
  const run = async (command: string) => {
    calls.push(command);
    return command === failOn ? { ok: false, output: 'error TS2322: boom' } : { ok: true, output: 'ok' };
  };
  return { calls, run };
};

test('isEditablePath only allows the agent source tree', () => {
  const root = makeRepo();
  assert.equal(isEditablePath(root, 'agent.ts'), true);
  assert.equal(isEditablePath(root, 'src/loop.ts'), true);
  assert.equal(isEditablePath(root, 'tests/new.test.ts'), true);
  assert.equal(isEditablePath(root, '../outside.ts'), false);
  assert.equal(isEditablePath(root, 'package.json'), false);
  assert.equal(isEditablePath(root, 'node_modules/x/index.js'), false);
  assert.equal(isEditablePath(root, 'src/payload.exe'), false);
  assert.equal(isEditablePath(root, path.join(os.tmpdir(), 'x.ts')), false);
});

test('applies a change when build and tests pass', async () => {
  const root = makeRepo();
  const { calls, run } = runner();
  const result = await applySelfModification('src/loop.ts', 'improved loop', { repoRoot: root, runCommand: run });
  assert.equal(result.applied, true);
  assert.equal(fs.readFileSync(path.join(root, 'src', 'loop.ts'), 'utf-8'), 'improved loop');
  assert.deepEqual(calls, ['npm run build', 'npm test']);
  assert.equal(fs.readFileSync(result.backupPath!, 'utf-8'), 'original loop');
});

test('rolls back and rebuilds when verification fails', async () => {
  const root = makeRepo();
  const { calls, run } = runner('npm test');
  const result = await applySelfModification('agent.ts', 'broken agent', { repoRoot: root, runCommand: run });
  assert.equal(result.applied, false);
  assert.match(result.message, /Reverted agent\.ts/);
  assert.match(result.message, /boom/);
  assert.equal(fs.readFileSync(path.join(root, 'agent.ts'), 'utf-8'), 'original agent');
  assert.deepEqual(calls, ['npm run build', 'npm test', 'npm run build']);
});

test('removes a newly created file when verification fails', async () => {
  const root = makeRepo();
  const { run } = runner('npm run build');
  const result = await applySelfModification('src/extra.ts', 'bad', { repoRoot: root, runCommand: run });
  assert.equal(result.applied, false);
  assert.equal(fs.existsSync(path.join(root, 'src', 'extra.ts')), false);
});

test('refuses paths outside the agent source without touching disk', async () => {
  const root = makeRepo();
  const { calls, run } = runner();
  const result = await applySelfModification('../evil.ts', 'x', { repoRoot: root, runCommand: run });
  assert.equal(result.applied, false);
  assert.match(result.message, /Refused/);
  assert.equal(calls.length, 0);
});

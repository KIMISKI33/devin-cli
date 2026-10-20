import { exec } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

export interface SelfModifyOptions {
  /** Repository root the agent is allowed to edit itself in. */
  repoRoot: string;
  /** Paths (relative to repoRoot) the agent may rewrite. */
  editableGlobs?: string[];
  /** Verification commands, run in order; the first failure rolls the edit back. */
  verifyCommands?: string[];
  /** Re-run after a rollback so build output matches the restored source. */
  rebuildCommand?: string | null;
  runCommand?: (command: string, cwd: string) => Promise<{ ok: boolean; output: string }>;
}

export interface SelfModifyResult {
  applied: boolean;
  message: string;
  verification?: { command: string; ok: boolean; output: string }[];
  backupPath?: string;
}

const DEFAULT_EDITABLE = ['agent.ts', 'src/', 'tests/', 'bin/'];
const DEFAULT_VERIFY = ['npm run build', 'npm test'];

export const defaultRunCommand = (command: string, cwd: string): Promise<{ ok: boolean; output: string }> =>
  new Promise((resolve) => {
    exec(command, { cwd, timeout: 600000, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ ok: !error, output: `${stdout || ''}${stderr || ''}`.trim() });
    });
  });

const toPosix = (p: string) => p.split(path.sep).join('/');

export function isEditablePath(repoRoot: string, filePath: string, editable: string[] = DEFAULT_EDITABLE): boolean {
  const resolved = path.resolve(repoRoot, filePath);
  const rel = toPosix(path.relative(path.resolve(repoRoot), resolved));
  if (rel === '' || rel.startsWith('../') || path.isAbsolute(rel)) return false;
  if (!/\.(ts|js|json|md)$/.test(rel)) return false;
  return editable.some((allowed) => (allowed.endsWith('/') ? rel.startsWith(allowed) : rel === allowed));
}

/**
 * Rewrite one of the agent's own source files, then verify the result. A build
 * or test failure restores the previous contents, so the agent can never leave
 * itself in a state where it no longer starts.
 */
export async function applySelfModification(
  filePath: string,
  newContent: string,
  options: SelfModifyOptions
): Promise<SelfModifyResult> {
  const {
    repoRoot,
    editableGlobs = DEFAULT_EDITABLE,
    verifyCommands = DEFAULT_VERIFY,
    rebuildCommand = 'npm run build',
    runCommand = defaultRunCommand
  } = options;

  if (!isEditablePath(repoRoot, filePath, editableGlobs)) {
    return { applied: false, message: `Refused: ${filePath} is outside the agent's own editable source.` };
  }

  const target = path.resolve(repoRoot, filePath);
  const existed = fs.existsSync(target);
  const previous = existed ? fs.readFileSync(target, 'utf-8') : null;

  const backupDir = path.join(repoRoot, '.devin', 'self-modify-backups');
  fs.mkdirSync(backupDir, { recursive: true });
  const backupPath = path.join(backupDir, `${path.basename(target)}.${Date.now()}.bak`);
  if (previous !== null) fs.writeFileSync(backupPath, previous, 'utf-8');

  const rollback = () => {
    if (previous === null) {
      if (fs.existsSync(target)) fs.unlinkSync(target);
    } else {
      fs.writeFileSync(target, previous, 'utf-8');
    }
  };

  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, newContent, 'utf-8');

  const verification: { command: string; ok: boolean; output: string }[] = [];
  for (const command of verifyCommands) {
    const result = await runCommand(command, repoRoot);
    verification.push({ command, ...result });
    if (!result.ok) {
      rollback();
      if (rebuildCommand) await runCommand(rebuildCommand, repoRoot);
      return {
        applied: false,
        message: `Reverted ${filePath}: \`${command}\` failed.\n${result.output.slice(-4000)}`,
        verification,
        backupPath: previous === null ? undefined : backupPath
      };
    }
  }

  return {
    applied: true,
    message: `Updated ${filePath} and verified with ${verifyCommands.join(', ') || 'no checks'}.`,
    verification,
    backupPath: previous === null ? undefined : backupPath
  };
}

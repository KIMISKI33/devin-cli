import { exec } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { AgentMemory } from './memory';
import { applySelfModification, isEditablePath, SelfModifyOptions } from './selfModify';

export type Approver = (description: string) => Promise<boolean>;

export interface ToolContext {
  approve: Approver;
  memory: AgentMemory;
  /** Root of the agent's own source tree; null disables self-modification. */
  agentRoot: string | null;
  currentTask?: string;
  onMutation?: (details: string) => Promise<void>;
  runShell?: (command: string) => Promise<string>;
  selfModify?: Partial<SelfModifyOptions>;
}

export interface ToolResult {
  output: string;
  isError: boolean;
}

const MAX_TOOL_OUTPUT = 20000;

export const TOOL_DEFINITIONS = [
  {
    name: 'run_shell',
    description: 'Run a shell command in the current working directory (30s timeout). Returns stdout/stderr.',
    input_schema: {
      type: 'object' as const,
      properties: { command: { type: 'string', description: 'The command to run.' } },
      required: ['command']
    }
  },
  {
    name: 'read_file',
    description: 'Read a UTF-8 text file.',
    input_schema: {
      type: 'object' as const,
      properties: { path: { type: 'string' } },
      required: ['path']
    }
  },
  {
    name: 'write_file',
    description: 'Create or overwrite a file with the given content.',
    input_schema: {
      type: 'object' as const,
      properties: { path: { type: 'string' }, content: { type: 'string' } },
      required: ['path', 'content']
    }
  },
  {
    name: 'append_file',
    description: 'Append content to an existing file.',
    input_schema: {
      type: 'object' as const,
      properties: { path: { type: 'string' }, content: { type: 'string' } },
      required: ['path', 'content']
    }
  },
  {
    name: 'list_directory',
    description: 'List entries of a directory (directories end with /).',
    input_schema: {
      type: 'object' as const,
      properties: { path: { type: 'string' } },
      required: ['path']
    }
  },
  {
    name: 'record_lesson',
    description:
      'Save a short, reusable lesson to long-term memory so future sessions benefit from it. Use for non-obvious facts about the environment, project conventions, or fixes to mistakes. Do not store secrets.',
    input_schema: {
      type: 'object' as const,
      properties: {
        lesson: { type: 'string' },
        outcome: { type: 'string', enum: ['success', 'failure'] }
      },
      required: ['lesson']
    }
  },
  {
    name: 'read_own_source',
    description: "Read one of the agent's own source files (e.g. agent.ts, src/loop.ts, src/tools.ts).",
    input_schema: {
      type: 'object' as const,
      properties: { path: { type: 'string', description: 'Path relative to the agent source root.' } },
      required: ['path']
    }
  },
  {
    name: 'modify_own_source',
    description:
      "Rewrite one of the agent's own source files (agent.ts, src/, tests/, bin/) with full new content. The change is built and tested; any failure reverts it. Changes take effect after restarting the agent.",
    input_schema: {
      type: 'object' as const,
      properties: {
        path: { type: 'string', description: 'Path relative to the agent source root.' },
        content: { type: 'string', description: 'Complete new file content.' },
        reason: { type: 'string', description: 'Why this change improves the agent.' }
      },
      required: ['path', 'content', 'reason']
    }
  }
];

const DANGEROUS_PATTERNS: RegExp[] = [
  /\brm\s+-[a-z]*r[a-z]*f?[a-z]*\s+(--no-preserve-root\s+)?\/(\s|$)/i,
  /\bmkfs(\.\w+)?\b/i,
  /\bdd\s+[^|;&]*\bof=\/dev\//i,
  /:\(\)\s*\{\s*:\|:&\s*\};:/,
  /\bformat\s+[a-z]:/i
];

export const isDangerousCommand = (command: string): boolean => DANGEROUS_PATTERNS.some((re) => re.test(command));

export const isRestrictedPath = (filePath: string): boolean => {
  if (process.platform === 'win32') return false;
  const resolved = path.resolve(filePath);
  return ['/etc', '/var', '/System'].some((p) => resolved === p || resolved.startsWith(`${p}/`));
};

const truncate = (text: string): string =>
  text.length > MAX_TOOL_OUTPUT ? `${text.slice(0, MAX_TOOL_OUTPUT)}\n...[truncated ${text.length - MAX_TOOL_OUTPUT} chars]` : text;

export const defaultRunShell = (command: string): Promise<string> =>
  new Promise((resolve) => {
    exec(
      command,
      { shell: process.platform === 'win32' ? 'cmd.exe' : '/bin/bash', timeout: 30000, maxBuffer: 10 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) return resolve(`Error (exit ${error.code ?? 'unknown'}): ${error.message}\n${stderr}`);
        resolve(stdout || stderr || 'Command executed with no output.');
      }
    );
  });

const ok = (output: string): ToolResult => ({ output: truncate(output), isError: false });
const fail = (output: string): ToolResult => ({ output: truncate(output), isError: true });

export async function executeTool(name: string, input: any, ctx: ToolContext): Promise<ToolResult> {
  try {
    switch (name) {
      case 'run_shell': {
        const command = String(input?.command ?? '');
        if (!command.trim()) return fail('No command given.');
        if (isDangerousCommand(command)) return fail('Execution blocked: dangerous command detected.');
        if (!(await ctx.approve(`run shell command: [ ${command} ]`))) return fail('User declined this command.');
        const output = await (ctx.runShell ?? defaultRunShell)(command);
        await ctx.onMutation?.(`Executed shell command [ ${command} ]`);
        return output.startsWith('Error') ? fail(output) : ok(output);
      }

      case 'read_file':
      case 'list_directory': {
        const target = String(input?.path ?? '.');
        if (isRestrictedPath(target)) return fail('Access denied: system paths are restricted.');
        const verb = name === 'read_file' ? 'read file' : 'list directory';
        if (!(await ctx.approve(`${verb}: [ ${target} ]`))) return fail(`User declined: ${verb}.`);
        const resolved = path.resolve(target);
        if (!fs.existsSync(resolved)) return fail(`Not found: ${target}`);
        if (name === 'read_file') return ok(fs.readFileSync(resolved, 'utf-8'));
        const entries = fs.readdirSync(resolved, { withFileTypes: true }).map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
        return ok(entries.join('\n') || '(empty)');
      }

      case 'write_file':
      case 'append_file': {
        const target = String(input?.path ?? '');
        if (!target) return fail('No path given.');
        if (isRestrictedPath(target)) return fail('Access denied: system paths are restricted.');
        const verb = name === 'write_file' ? 'write file' : 'append to file';
        if (!(await ctx.approve(`${verb}: [ ${target} ]`))) return fail(`User declined: ${verb}.`);
        const resolved = path.resolve(target);
        const content = String(input?.content ?? '');
        if (name === 'write_file') {
          fs.mkdirSync(path.dirname(resolved), { recursive: true });
          fs.writeFileSync(resolved, content, 'utf-8');
        } else {
          if (!fs.existsSync(resolved)) return fail(`File to append to does not exist: ${target}`);
          fs.appendFileSync(resolved, content, 'utf-8');
        }
        await ctx.onMutation?.(`${name === 'write_file' ? 'Wrote' : 'Appended to'} ${target}`);
        return ok(`${name === 'write_file' ? 'Wrote' : 'Appended'} ${content.length} chars to ${target}.`);
      }

      case 'record_lesson': {
        const outcome = input?.outcome === 'failure' ? 'failure' : 'success';
        const saved = ctx.memory.record(ctx.currentTask ?? '', outcome, String(input?.lesson ?? ''));
        return saved ? ok('Lesson saved to long-term memory.') : fail('Lesson was empty.');
      }

      case 'read_own_source': {
        if (!ctx.agentRoot) return fail('Self-inspection is unavailable in this build (packaged binary).');
        const rel = String(input?.path ?? '');
        if (!isEditablePath(ctx.agentRoot, rel)) return fail(`Not an agent source file: ${rel}`);
        const resolved = path.resolve(ctx.agentRoot, rel);
        if (!fs.existsSync(resolved)) return fail(`Not found: ${rel}`);
        return ok(fs.readFileSync(resolved, 'utf-8'));
      }

      case 'modify_own_source': {
        if (!ctx.agentRoot) return fail('Self-modification is unavailable in this build (packaged binary).');
        const rel = String(input?.path ?? '');
        const reason = String(input?.reason ?? '');
        if (!isEditablePath(ctx.agentRoot, rel)) return fail(`Refused: ${rel} is outside the agent's own source.`);
        if (!(await ctx.approve(`MODIFY ITS OWN SOURCE: [ ${rel} ]
   Reason: ${reason}`))) {
          return fail('User declined self-modification.');
        }
        const result = await applySelfModification(rel, String(input?.content ?? ''), {
          ...ctx.selfModify,
          repoRoot: ctx.agentRoot
        });
        if (result.applied) {
          await ctx.onMutation?.(`Self-modification of ${rel}: ${reason}`);
          ctx.memory.record(ctx.currentTask ?? '', 'success', `Self-modified ${rel}: ${reason}`);
          return ok(`${result.message} Restart the agent to load the new code.`);
        }
        return fail(result.message);
      }

      default:
        return fail(`Unknown tool: ${name}`);
    }
  } catch (error: any) {
    return fail(`Tool ${name} failed: ${error?.message ?? error}`);
  }
}

import { AgentMemory } from './memory';
import { executeTool, TOOL_DEFINITIONS, ToolContext } from './tools';

export interface MessagesClient {
  messages: { create(params: any): Promise<any> };
}

export interface SolveOptions {
  client: MessagesClient;
  model: string;
  memory: AgentMemory;
  toolContext: Omit<ToolContext, 'memory' | 'currentTask'>;
  maxSteps?: number;
  maxTokens?: number;
  /** Run a reflection pass that turns hard-won experience into a stored lesson. */
  reflect?: boolean;
  log?: (event: AgentEvent) => void;
}

export type AgentEvent =
  | { type: 'thinking'; step: number }
  | { type: 'text'; text: string }
  | { type: 'tool_call'; name: string; input: any }
  | { type: 'tool_result'; name: string; output: string; isError: boolean }
  | { type: 'lesson'; lesson: string }
  | { type: 'step_limit'; steps: number };

export interface SolveResult {
  finalText: string;
  steps: number;
  toolCalls: number;
  toolErrors: number;
  completed: boolean;
  lesson?: string;
}

export const BASE_SYSTEM_PROMPT = `You are Devin, an autonomous AI software engineer working in the user's terminal.

How to solve problems:
1. Understand the goal. If the request is ambiguous, ask one concise clarifying question instead of guessing.
2. Before acting on a non-trivial task, write a short numbered plan.
3. Work step by step with the tools. After each tool result, check it against what you expected.
4. When something fails, diagnose the cause from the output, then try a different approach. Never repeat an identical failing action.
5. Verify the result (run the code, tests, or re-read the file) before declaring success.
6. Finish with a brief summary of what changed and anything left undone.

Learning:
- Apply the lessons from previous sessions listed below.
- When you discover something non-obvious and reusable (environment quirks, project conventions, fixes to your own mistakes), save it with record_lesson. Never store secrets.

Self-improvement:
- You can inspect your own implementation with read_own_source and improve it with modify_own_source when that genuinely helps the user's goal. Keep edits small, preserve existing safety checks and approval prompts, and update or add tests with every change.

Every tool action requires the user's approval; if one is declined, adapt or ask what they prefer.`;

export const buildSystemPrompt = (memory: AgentMemory): string => {
  const lessons = memory.promptSection();
  return lessons ? `${BASE_SYSTEM_PROMPT}\n\n${lessons}` : BASE_SYSTEM_PROMPT;
};

const textOf = (content: any[]): string =>
  (content || [])
    .filter((b) => b?.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();

const REFLECTION_PROMPT = `Reflect on the task above. If you learned one reusable, non-obvious lesson that would help on future tasks (e.g. what caused a failure and what fixed it), reply with exactly that lesson in one sentence. If there is nothing worth remembering, reply with exactly NONE.`;

/**
 * Plan/act/observe loop: keep calling the model and executing the tools it
 * asks for until it answers without a tool call or the step budget runs out.
 * `history` is mutated in place so the conversation persists across tasks.
 */
export async function solveTask(task: string, history: any[], options: SolveOptions): Promise<SolveResult> {
  const { client, model, memory, toolContext, maxSteps = 25, maxTokens = 4096, reflect = true, log = () => {} } = options;
  const ctx: ToolContext = { ...toolContext, memory, currentTask: task };

  history.push({ role: 'user', content: task });

  let steps = 0;
  let toolCalls = 0;
  let toolErrors = 0;
  let finalText = '';
  let completed = false;

  while (steps < maxSteps) {
    steps++;
    log({ type: 'thinking', step: steps });

    const response = await client.messages.create({
      model,
      max_tokens: maxTokens,
      system: buildSystemPrompt(memory),
      tools: TOOL_DEFINITIONS,
      messages: history
    });

    const content = response?.content ?? [];
    history.push({ role: 'assistant', content });

    const text = textOf(content);
    if (text) log({ type: 'text', text });

    const toolUses = content.filter((b: any) => b?.type === 'tool_use');
    if (response?.stop_reason !== 'tool_use' || toolUses.length === 0) {
      finalText = text;
      completed = true;
      break;
    }

    const results: any[] = [];
    for (const use of toolUses) {
      toolCalls++;
      log({ type: 'tool_call', name: use.name, input: use.input });
      const result = await executeTool(use.name, use.input, ctx);
      if (result.isError) toolErrors++;
      log({ type: 'tool_result', name: use.name, output: result.output, isError: result.isError });
      results.push({ type: 'tool_result', tool_use_id: use.id, content: result.output, is_error: result.isError });
    }
    history.push({ role: 'user', content: results });
  }

  if (!completed) {
    log({ type: 'step_limit', steps });
    finalText = `Stopped after ${steps} steps without finishing. Say "continue" to keep going.`;
    // Close the open tool_result turn so the history stays valid for the next request.
    history.push({ role: 'assistant', content: [{ type: 'text', text: finalText }] });
  }

  let lesson: string | undefined;
  if (reflect && (toolErrors > 0 || !completed)) {
    lesson = await reflectOnTask(task, history, { client, model, memory, completed });
    if (lesson) log({ type: 'lesson', lesson });
  }

  return { finalText, steps, toolCalls, toolErrors, completed, lesson };
}

async function reflectOnTask(
  task: string,
  history: any[],
  opts: { client: MessagesClient; model: string; memory: AgentMemory; completed: boolean }
): Promise<string | undefined> {
  try {
    const response = await opts.client.messages.create({
      model: opts.model,
      max_tokens: 300,
      system: BASE_SYSTEM_PROMPT,
      messages: [...history, { role: 'user', content: REFLECTION_PROMPT }]
    });
    const text = textOf(response?.content ?? []);
    if (!text || /^NONE\.?$/i.test(text)) return undefined;
    opts.memory.record(task, opts.completed ? 'success' : 'failure', text);
    return text;
  } catch {
    return undefined;
  }
}

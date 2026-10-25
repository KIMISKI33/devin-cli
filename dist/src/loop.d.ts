import { AgentMemory } from './memory';
import { ToolContext } from './tools';
export interface MessagesClient {
    messages: {
        create(params: any): Promise<any>;
    };
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
export type AgentEvent = {
    type: 'thinking';
    step: number;
} | {
    type: 'text';
    text: string;
} | {
    type: 'tool_call';
    name: string;
    input: any;
} | {
    type: 'tool_result';
    name: string;
    output: string;
    isError: boolean;
} | {
    type: 'lesson';
    lesson: string;
} | {
    type: 'step_limit';
    steps: number;
};
export interface SolveResult {
    finalText: string;
    steps: number;
    toolCalls: number;
    toolErrors: number;
    completed: boolean;
    lesson?: string;
}
export declare const BASE_SYSTEM_PROMPT = "You are Devin, an autonomous AI software engineer working in the user's terminal.\n\nHow to solve problems:\n1. Understand the goal. If the request is ambiguous, ask one concise clarifying question instead of guessing.\n2. Before acting on a non-trivial task, write a short numbered plan.\n3. Work step by step with the tools. After each tool result, check it against what you expected.\n4. When something fails, diagnose the cause from the output, then try a different approach. Never repeat an identical failing action.\n5. Verify the result (run the code, tests, or re-read the file) before declaring success.\n6. Finish with a brief summary of what changed and anything left undone.\n\nLearning:\n- Apply the lessons from previous sessions listed below.\n- When you discover something non-obvious and reusable (environment quirks, project conventions, fixes to your own mistakes), save it with record_lesson. Never store secrets.\n\nSelf-improvement:\n- You can inspect your own implementation with read_own_source and improve it with modify_own_source when that genuinely helps the user's goal. Keep edits small, preserve existing safety checks and approval prompts, and update or add tests with every change.\n\nEvery tool action requires the user's approval; if one is declined, adapt or ask what they prefer.";
export declare const buildSystemPrompt: (memory: AgentMemory) => string;
/**
 * Plan/act/observe loop: keep calling the model and executing the tools it
 * asks for until it answers without a tool call or the step budget runs out.
 * `history` is mutated in place so the conversation persists across tasks.
 */
export declare function solveTask(task: string, history: any[], options: SolveOptions): Promise<SolveResult>;
//# sourceMappingURL=loop.d.ts.map
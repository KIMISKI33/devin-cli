import { AgentMemory } from './memory';
import { SelfModifyOptions } from './selfModify';
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
export declare const TOOL_DEFINITIONS: ({
    name: string;
    description: string;
    input_schema: {
        type: "object";
        properties: {
            command: {
                type: string;
                description: string;
            };
            path?: undefined;
            content?: undefined;
            lesson?: undefined;
            outcome?: undefined;
            reason?: undefined;
        };
        required: string[];
    };
} | {
    name: string;
    description: string;
    input_schema: {
        type: "object";
        properties: {
            path: {
                type: string;
                description?: undefined;
            };
            command?: undefined;
            content?: undefined;
            lesson?: undefined;
            outcome?: undefined;
            reason?: undefined;
        };
        required: string[];
    };
} | {
    name: string;
    description: string;
    input_schema: {
        type: "object";
        properties: {
            path: {
                type: string;
                description?: undefined;
            };
            content: {
                type: string;
                description?: undefined;
            };
            command?: undefined;
            lesson?: undefined;
            outcome?: undefined;
            reason?: undefined;
        };
        required: string[];
    };
} | {
    name: string;
    description: string;
    input_schema: {
        type: "object";
        properties: {
            lesson: {
                type: string;
            };
            outcome: {
                type: string;
                enum: string[];
            };
            command?: undefined;
            path?: undefined;
            content?: undefined;
            reason?: undefined;
        };
        required: string[];
    };
} | {
    name: string;
    description: string;
    input_schema: {
        type: "object";
        properties: {
            path: {
                type: string;
                description: string;
            };
            command?: undefined;
            content?: undefined;
            lesson?: undefined;
            outcome?: undefined;
            reason?: undefined;
        };
        required: string[];
    };
} | {
    name: string;
    description: string;
    input_schema: {
        type: "object";
        properties: {
            path: {
                type: string;
                description: string;
            };
            content: {
                type: string;
                description: string;
            };
            reason: {
                type: string;
                description: string;
            };
            command?: undefined;
            lesson?: undefined;
            outcome?: undefined;
        };
        required: string[];
    };
})[];
export declare const isDangerousCommand: (command: string) => boolean;
export declare const isRestrictedPath: (filePath: string) => boolean;
export declare const defaultRunShell: (command: string) => Promise<string>;
export declare function executeTool(name: string, input: any, ctx: ToolContext): Promise<ToolResult>;
//# sourceMappingURL=tools.d.ts.map
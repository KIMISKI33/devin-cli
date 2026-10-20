export interface Lesson {
    task: string;
    outcome: 'success' | 'failure';
    lesson: string;
    timestamp: string;
}
export interface MemoryFile {
    version: 1;
    lessons: Lesson[];
}
/**
 * Persistent cross-session memory. Lessons recorded while solving a task are
 * replayed into the system prompt of later sessions so the agent stops
 * repeating mistakes it already paid for.
 */
export declare class AgentMemory {
    readonly filePath: string;
    private data;
    constructor(baseDir?: string);
    private read;
    private write;
    get lessons(): Lesson[];
    record(task: string, outcome: 'success' | 'failure', lesson: string): Lesson | null;
    forget(lesson: string): boolean;
    /** Lessons formatted for injection into a system prompt. */
    promptSection(limit?: number): string;
}
//# sourceMappingURL=memory.d.ts.map
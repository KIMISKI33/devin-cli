export interface SelfModifyOptions {
    /** Repository root the agent is allowed to edit itself in. */
    repoRoot: string;
    /** Paths (relative to repoRoot) the agent may rewrite. */
    editableGlobs?: string[];
    /** Verification commands, run in order; the first failure rolls the edit back. */
    verifyCommands?: string[];
    /** Re-run after a rollback so build output matches the restored source. */
    rebuildCommand?: string | null;
    runCommand?: (command: string, cwd: string) => Promise<{
        ok: boolean;
        output: string;
    }>;
}
export interface SelfModifyResult {
    applied: boolean;
    message: string;
    verification?: {
        command: string;
        ok: boolean;
        output: string;
    }[];
    backupPath?: string;
}
export declare const defaultRunCommand: (command: string, cwd: string) => Promise<{
    ok: boolean;
    output: string;
}>;
export declare function isEditablePath(repoRoot: string, filePath: string, editable?: string[]): boolean;
/**
 * Rewrite one of the agent's own source files, then verify the result. A build
 * or test failure restores the previous contents, so the agent can never leave
 * itself in a state where it no longer starts.
 */
export declare function applySelfModification(filePath: string, newContent: string, options: SelfModifyOptions): Promise<SelfModifyResult>;
//# sourceMappingURL=selfModify.d.ts.map
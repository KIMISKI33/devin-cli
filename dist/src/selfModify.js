"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.defaultRunCommand = void 0;
exports.isEditablePath = isEditablePath;
exports.applySelfModification = applySelfModification;
const child_process_1 = require("child_process");
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const DEFAULT_EDITABLE = ['agent.ts', 'src/', 'tests/', 'bin/'];
const DEFAULT_VERIFY = ['npm run build', 'npm test'];
const defaultRunCommand = (command, cwd) => new Promise((resolve) => {
    (0, child_process_1.exec)(command, { cwd, timeout: 600000, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
        resolve({ ok: !error, output: `${stdout || ''}${stderr || ''}`.trim() });
    });
});
exports.defaultRunCommand = defaultRunCommand;
const toPosix = (p) => p.split(path.sep).join('/');
function isEditablePath(repoRoot, filePath, editable = DEFAULT_EDITABLE) {
    const resolved = path.resolve(repoRoot, filePath);
    const rel = toPosix(path.relative(path.resolve(repoRoot), resolved));
    if (rel === '' || rel.startsWith('../') || path.isAbsolute(rel))
        return false;
    if (!/\.(ts|js|json|md)$/.test(rel))
        return false;
    return editable.some((allowed) => (allowed.endsWith('/') ? rel.startsWith(allowed) : rel === allowed));
}
/**
 * Rewrite one of the agent's own source files, then verify the result. A build
 * or test failure restores the previous contents, so the agent can never leave
 * itself in a state where it no longer starts.
 */
async function applySelfModification(filePath, newContent, options) {
    const { repoRoot, editableGlobs = DEFAULT_EDITABLE, verifyCommands = DEFAULT_VERIFY, rebuildCommand = 'npm run build', runCommand = exports.defaultRunCommand } = options;
    if (!isEditablePath(repoRoot, filePath, editableGlobs)) {
        return { applied: false, message: `Refused: ${filePath} is outside the agent's own editable source.` };
    }
    const target = path.resolve(repoRoot, filePath);
    const existed = fs.existsSync(target);
    const previous = existed ? fs.readFileSync(target, 'utf-8') : null;
    const backupDir = path.join(repoRoot, '.devin', 'self-modify-backups');
    fs.mkdirSync(backupDir, { recursive: true });
    const backupPath = path.join(backupDir, `${path.basename(target)}.${Date.now()}.bak`);
    if (previous !== null)
        fs.writeFileSync(backupPath, previous, 'utf-8');
    const rollback = () => {
        if (previous === null) {
            if (fs.existsSync(target))
                fs.unlinkSync(target);
        }
        else {
            fs.writeFileSync(target, previous, 'utf-8');
        }
    };
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, newContent, 'utf-8');
    const verification = [];
    for (const command of verifyCommands) {
        const result = await runCommand(command, repoRoot);
        verification.push({ command, ...result });
        if (!result.ok) {
            rollback();
            if (rebuildCommand)
                await runCommand(rebuildCommand, repoRoot);
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
//# sourceMappingURL=selfModify.js.map
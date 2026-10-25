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
exports.AgentMemory = void 0;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const MAX_LESSONS = 200;
const EMPTY = { version: 1, lessons: [] };
/**
 * Persistent cross-session memory. Lessons recorded while solving a task are
 * replayed into the system prompt of later sessions so the agent stops
 * repeating mistakes it already paid for.
 */
class AgentMemory {
    constructor(baseDir = process.cwd()) {
        this.filePath = path.join(baseDir, '.devin', 'memory.json');
        this.data = this.read();
    }
    read() {
        try {
            const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf-8'));
            if (!parsed || !Array.isArray(parsed.lessons))
                return { ...EMPTY, lessons: [] };
            return { version: 1, lessons: parsed.lessons.filter((l) => l && typeof l.lesson === 'string') };
        }
        catch {
            return { ...EMPTY, lessons: [] };
        }
    }
    write() {
        fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
        fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), 'utf-8');
    }
    get lessons() {
        return [...this.data.lessons];
    }
    record(task, outcome, lesson) {
        const text = (lesson || '').trim();
        if (!text)
            return null;
        const existing = this.data.lessons.find((l) => l.lesson === text);
        if (existing) {
            existing.timestamp = new Date().toISOString();
            this.write();
            return existing;
        }
        const entry = { task, outcome, lesson: text, timestamp: new Date().toISOString() };
        this.data.lessons.push(entry);
        if (this.data.lessons.length > MAX_LESSONS) {
            this.data.lessons = this.data.lessons.slice(-MAX_LESSONS);
        }
        this.write();
        return entry;
    }
    forget(lesson) {
        const before = this.data.lessons.length;
        this.data.lessons = this.data.lessons.filter((l) => l.lesson !== lesson);
        if (this.data.lessons.length === before)
            return false;
        this.write();
        return true;
    }
    /** Lessons formatted for injection into a system prompt. */
    promptSection(limit = 25) {
        const recent = this.data.lessons.slice(-limit);
        if (recent.length === 0)
            return '';
        const bullets = recent
            .map((l) => `- [${l.outcome}] ${l.lesson}`)
            .join('\n');
        return `Lessons learned in previous sessions (apply them before acting):\n${bullets}`;
    }
}
exports.AgentMemory = AgentMemory;
//# sourceMappingURL=memory.js.map
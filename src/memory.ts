import * as fs from 'fs';
import * as path from 'path';

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

const MAX_LESSONS = 200;
const EMPTY: MemoryFile = { version: 1, lessons: [] };

/**
 * Persistent cross-session memory. Lessons recorded while solving a task are
 * replayed into the system prompt of later sessions so the agent stops
 * repeating mistakes it already paid for.
 */
export class AgentMemory {
  readonly filePath: string;
  private data: MemoryFile;

  constructor(baseDir: string = process.cwd()) {
    this.filePath = path.join(baseDir, '.devin', 'memory.json');
    this.data = this.read();
  }

  private read(): MemoryFile {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf-8'));
      if (!parsed || !Array.isArray(parsed.lessons)) return { ...EMPTY, lessons: [] };
      return { version: 1, lessons: parsed.lessons.filter((l: any) => l && typeof l.lesson === 'string') };
    } catch {
      return { ...EMPTY, lessons: [] };
    }
  }

  private write(): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), 'utf-8');
  }

  get lessons(): Lesson[] {
    return [...this.data.lessons];
  }

  record(task: string, outcome: 'success' | 'failure', lesson: string): Lesson | null {
    const text = (lesson || '').trim();
    if (!text) return null;

    const existing = this.data.lessons.find((l) => l.lesson === text);
    if (existing) {
      existing.timestamp = new Date().toISOString();
      this.write();
      return existing;
    }

    const entry: Lesson = { task, outcome, lesson: text, timestamp: new Date().toISOString() };
    this.data.lessons.push(entry);
    if (this.data.lessons.length > MAX_LESSONS) {
      this.data.lessons = this.data.lessons.slice(-MAX_LESSONS);
    }
    this.write();
    return entry;
  }

  forget(lesson: string): boolean {
    const before = this.data.lessons.length;
    this.data.lessons = this.data.lessons.filter((l) => l.lesson !== lesson);
    if (this.data.lessons.length === before) return false;
    this.write();
    return true;
  }

  /** Lessons formatted for injection into a system prompt. */
  promptSection(limit = 25): string {
    const recent = this.data.lessons.slice(-limit);
    if (recent.length === 0) return '';
    const bullets = recent
      .map((l) => `- [${l.outcome}] ${l.lesson}`)
      .join('\n');
    return `Lessons learned in previous sessions (apply them before acting):\n${bullets}`;
  }
}

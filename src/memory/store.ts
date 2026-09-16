import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";
import { redactSecrets } from "../sessions/redact.js";

import { resolveHome } from "../config/loader.js";
import {
  appendPrivateFile,
  ensurePrivateStateDirectoryAsync,
  writePrivateFile,
} from "../config/state-permissions.js";

const MAX_INJECTION_TOKENS = 1024;

function slugify(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-").replace(/-+/g, "-");
}

export class MemoryStore {
  private projectSlug: string;
  private memoryDir: string;
  private projectDir: string;

  constructor(workspaceDir?: string, home: string = resolveHome()) {
    const cwd = workspaceDir ?? process.cwd();
    this.projectSlug = slugify(cwd);
    this.memoryDir = join(home, "memory");
    this.projectDir = join(this.memoryDir, this.projectSlug);
  }

  async init(): Promise<void> {
    await ensurePrivateStateDirectoryAsync(dirname(this.memoryDir), "memory", this.projectSlug);
    await ensurePrivateStateDirectoryAsync(dirname(this.memoryDir), "memory", "_global");

    const indexFile = join(this.memoryDir, "MEMORY.md");
    if (!existsSync(indexFile)) {
      await writePrivateFile(indexFile, "# Memory Index\n\n");
    }
  }

  async appendSession(entries: {
    date: string;
    tasks: string[];
    decisions: string[];
    files: string[];
    summary?: string;
  }): Promise<void> {
    const file = join(this.projectDir, "sessions.md");
    const header = `## ${entries.date}\n`;
    let body = "";
    if (entries.tasks.length > 0)
      body += `- Tasks: ${entries.tasks.map((t) => redactSecrets(t)).join(", ")}\n`;
    if (entries.decisions.length > 0)
      body += `- Decisions:\n${entries.decisions.map((d) => `  - ${redactSecrets(d)}`).join("\n")}\n`;
    if (entries.files.length > 0)
      body += `- Files: ${entries.files.map((f) => redactSecrets(f)).join(", ")}\n`;
    if (entries.summary)
      body += `- Summary: ${redactSecrets(entries.summary)}\n`;

    let existing = "";
    try {
      existing = await readFile(file, "utf-8");
    } catch {
      // file does not exist yet
    }
    await writePrivateFile(file, header + body + "\n" + existing);
  }

  async writeFact(
    category: "decisions" | "patterns" | "pitfalls",
    fact: string,
  ): Promise<void> {
    const file = join(this.projectDir, `${category}.md`);
    const timestamp = new Date().toISOString();
    const entry = `- [${timestamp}] ${fact}\n`;
    await appendPrivateFile(file, entry);
  }

  async getInjection(
    maxTokens: number = MAX_INJECTION_TOKENS,
  ): Promise<string | null> {
    const indexFile = join(this.memoryDir, "MEMORY.md");
    let indexContent = "";
    try {
      indexContent = await readFile(indexFile, "utf-8");
    } catch {
      return null;
    }

    const parts: string[] = [];
    parts.push(
      indexContent.split("\n").slice(0, 20).join("\n"),
    );

    const files = ["sessions.md", "decisions.md", "patterns.md", "pitfalls.md"];
    let tokenBudget = maxTokens - Math.ceil(indexContent.length / 4);

    for (const f of files) {
      const fp = join(this.projectDir, f);
      try {
        const content = await readFile(fp, "utf-8");
        const tokens = Math.ceil(content.length / 4);
        if (tokens <= tokenBudget) {
          parts.push(`# ${f.replace(".md", "")}\n${content}`);
          tokenBudget -= tokens;
        } else {
          const maxChars = tokenBudget * 4;
          parts.push(
            `# ${f.replace(".md", "")} (truncated)\n...${content.slice(-maxChars)}`,
          );
          break;
        }
      } catch {
        continue;
      }
    }

    if (parts.length <= 1) return null;
    return parts.join("\n\n");
  }

  async remember(fact: string): Promise<void> {
    await this.writeFact("decisions", fact);
  }
}

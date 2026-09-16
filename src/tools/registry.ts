import type { ToolDef, ToolCall, ToolOutput } from "../types.js";
import type { ToolHandler, ToolContext, ToolExecOptions, ToolRegistration, ToolGroup } from "./types.js";

export class ToolRegistry {
  private registrations: Map<string, ToolRegistration> = new Map();

  register(reg: ToolRegistration): void {
    this.registrations.set(reg.def.name, reg);
  }

  getByMode(groups: ToolGroup[]): ToolDef[] {
    const defs: ToolDef[] = [];
    for (const [, reg] of this.registrations) {
      if (reg.always || groups.some(g => reg.groups.includes(g))) {
        defs.push(reg.def);
      }
    }
    return defs.sort((a, b) => a.name.localeCompare(b.name));
  }

  async execute(call: ToolCall, ctx: ToolContext, exec?: ToolExecOptions): Promise<ToolOutput> {
    const reg = this.registrations.get(call.name);
    if (!reg) {
      return { content: `Unknown tool: ${call.name}`, error: `Unknown tool: ${call.name}` };
    }
    try {
      return await reg.handler(call.arguments, ctx, exec);
    } catch (err) {
      return { content: "", error: (err as Error).message };
    }
  }

  getAllDefs(): ToolDef[] {
    return [...this.registrations.values()].map(r => r.def).sort((a, b) => a.name.localeCompare(b.name));
  }
}

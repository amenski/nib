import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import type { ToolDef, ToolOutput } from "../types.js";
import { pkg } from "../version.js";
import { buildChildEnvironment, prepareSandboxedCommand } from "../sandbox/launcher.js";
import type { SandboxLevel } from "../sandbox/seatbelt.js";

export interface McpServerConfig {
  name: string;
  url: string;
}

const MCP_TIMEOUT_MS = 10_000;
const PROTOCOL_VERSION = "2024-11-05";

export interface McpSpawnOptions {
  /** Project root used as the MCP child's cwd and fixed containment root. */
  cwd: string;
  trustedRoot: string;
  sandboxLevel?: SandboxLevel;
  writeRoots?: string[];
  sessionTempDir?: string;
}

interface McpInitializeResult {
  protocolVersion: string;
  capabilities: Record<string, unknown>;
}

interface McpTool {
  name: string;
  description?: string;
  inputSchema: {
    type: "object";
    properties?: Record<string, unknown>;
    required?: string[];
  };
}

interface McpToolsListResult {
  tools: McpTool[];
}

interface McpToolCallContent {
  type: "text";
  text: string;
}

interface McpToolCallResult {
  content: McpToolCallContent[];
  isError?: boolean;
}

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

let requestId = 1;

async function mcpRequest<T>(
  url: string,
  method: string,
  params?: Record<string, unknown>,
): Promise<T> {
  const body: JsonRpcRequest = {
    jsonrpc: "2.0",
    id: requestId++,
    method,
    params,
  };

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(MCP_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(
      `MCP server returned HTTP ${response.status}: ${response.statusText}`,
    );
  }

  const text = await response.text();
  let data: JsonRpcResponse;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(
      `MCP server returned non-JSON response: ${text.slice(0, 200)}`,
    );
  }

  if (data.error) {
    throw new Error(`MCP error ${data.error.code}: ${data.error.message}`);
  }

  return data.result as T;
}

export async function listTools(
  config: McpServerConfig,
): Promise<ToolDef[]> {
  try {
    await mcpRequest<McpInitializeResult>(config.url, "initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "nib", version: pkg.version },
    });

    const result = await mcpRequest<McpToolsListResult>(
      config.url,
      "tools/list",
    );

    return result.tools.map(
      (t): ToolDef => ({
        name: `${config.name}/${t.name}`,
        description: t.description ?? "",
        parameters: {
          type: "object",
          properties: t.inputSchema.properties ?? {},
          required: t.inputSchema.required ?? [],
        },
      }),
    );
  } catch {
    return [];
  }
}

export async function callTool(
  config: McpServerConfig,
  toolName: string,
  args: Record<string, unknown>,
): Promise<ToolOutput> {
  try {
    const shortName = toolName.startsWith(`${config.name}/`)
      ? toolName.slice(config.name.length + 1)
      : toolName;

    const result = await mcpRequest<McpToolCallResult>(
      config.url,
      "tools/call",
      { name: shortName, arguments: args },
    );

    const text = result.content
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("\n");

    return result.isError
      ? { content: text, error: text }
      : { content: text };
  } catch (err) {
    if (
      err instanceof Error &&
      (err.name === "AbortError" || err.name === "TimeoutError")
    ) {
      return {
        content: "",
        error: `Tool call timed out after ${MCP_TIMEOUT_MS}ms`,
      };
    }
    return { content: "", error: (err as Error).message };
  }
}

export class MCPClient {
  private process: ChildProcess | null = null;
  private requestId = 1;
  private pending = new Map<number, { resolve: (value: unknown) => void; reject: (err: Error) => void }>();
  private stderrTail = "";

  async connect(
    command: string,
    args: string[],
    env?: Record<string, string>,
    spawnOptions?: McpSpawnOptions,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawnOptions
        ? prepareSandboxedCommand(command, args, spawnOptions)
        : { file: command, args };
      this.process = spawn(child.file, child.args, {
        stdio: ["pipe", "pipe", "pipe"],
        ...(spawnOptions?.cwd ? { cwd: spawnOptions.cwd } : {}),
        env: {
          // A contained MCP child receives only the minimal inherited
          // environment; explicit per-server config is layered last so its
          // documented overrides (PATH, credentials, and server settings)
          // retain their existing precedence.
          ...(spawnOptions ? buildChildEnvironment(spawnOptions.sessionTempDir) : process.env),
          ...env,
        },
      });

      this.process.stderr?.on("data", (chunk: Buffer) => {
        this.stderrTail = (this.stderrTail + chunk.toString()).slice(-2000);
      });

      const rl = createInterface({ input: this.process.stdout!, historySize: 0 });

      rl.on("line", (line: string) => {
        try {
          const response = JSON.parse(line) as JsonRpcResponse;
          const pending = this.pending.get(response.id);
          if (pending) {
            this.pending.delete(response.id);
            if (response.error) {
              pending.reject(new Error(response.error.message));
            } else {
              pending.resolve(response.result);
            }
          }
        } catch {
          // ignore non-JSON lines
        }
      });

      this.process.on("error", (err) => {
        const tail = this.stderrTail.trim();
        const wrapped = tail ? new Error(`${err.message}: ${tail}`) : err;
        for (const [, pending] of this.pending) {
          pending.reject(wrapped);
        }
        this.pending.clear();
        reject(wrapped);
      });

      this.process.on("exit", (code) => {
        if (this.process && this.process.exitCode !== null) return;
        const tail = this.stderrTail.trim();
        const msg = `MCP server exited with code ${code}` + (tail ? `: ${tail}` : "");
        for (const [, pending] of this.pending) {
          pending.reject(new Error(msg));
        }
        this.pending.clear();
      });

      this.sendRequest("initialize", {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "nib", version: pkg.version },
      }).then(() => {
        this.sendNotification("notifications/initialized", {});
        resolve();
      }).catch(reject);
    });
  }

  private sendRequest<T>(method: string, params?: Record<string, unknown>): Promise<T> {
    if (!this.process || !this.process.stdin) {
      return Promise.reject(new Error("MCP client not connected"));
    }
    return new Promise((resolve, reject) => {
      const id = this.requestId++;
      const request: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };

      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request "${method}" timed out after ${MCP_TIMEOUT_MS}ms`));
      }, MCP_TIMEOUT_MS);

      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value as T);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });
      this.process!.stdin!.write(JSON.stringify(request) + "\n");
    });
  }

  disconnect(): void {
    if (this.process && this.process.exitCode === null && this.process.signalCode === null) {
      this.process.kill();
    }
  }

  private sendNotification(method: string, params?: Record<string, unknown>): void {
    if (!this.process || !this.process.stdin) return;
    const notification = { jsonrpc: "2.0", method, params };
    this.process.stdin.write(JSON.stringify(notification) + "\n");
  }

  async listTools(): Promise<McpTool[]> {
    const result = await this.sendRequest<McpToolsListResult>("tools/list");
    return result.tools;
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<McpToolCallResult> {
    return this.sendRequest<McpToolCallResult>("tools/call", {
      name,
      arguments: args,
    });
  }
}

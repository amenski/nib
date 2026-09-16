/**
 * The effects a tool must declare before policy can grant it durable access.
 * This is intentionally data-only: extraction and execution are wired in
 * separately so an unimplemented extractor fails closed as `unknown`.
 */
import { resolve } from "node:path";
import { isPathWithinWriteRoots, resolveWriteRoots } from "../sandbox/write-roots.js";
import type { ProfileLevel } from "./profile.js";
import { classifyCommand, type CommandClassificationResult } from "./command-classifier.js";

export type Capability =
  | { type: "fs.read"; path: string }
  | { type: "fs.write"; path: string }
  | { type: "net.connect"; host: string; port?: number }
  | { type: "process.execute"; command: string }
  | { type: "process.control"; target: string }
  | { type: "secret.read"; resource: string }
  | { type: "external.mutate"; service: string; target: string }
  | { type: "persistence.create"; target: string }
  | { type: "session.mutate"; target: string };

export interface CapabilityPlan {
  tool: string;
  capabilities: readonly Capability[];
  status: "known" | "unknown";
  reason?: string;
  allowPersistentApproval: boolean;
  /** Advisory only; never changes capability status or permission authority. */
  commandClassification?: CommandClassificationResult;
}

export type CapabilityExtractor = (args: Record<string, unknown>, workingDir: string) => CapabilityPlan;

export interface PatchTarget {
  rawPath: string;
  path: string;
}

export interface ApplyPatchCapabilityPlan extends CapabilityPlan {
  tool: "apply_patch";
  targets: readonly PatchTarget[];
}

export type WorkspaceWriteTarget = { path: string } | { error: string };

export interface WriteTargetOptions {
  level?: ProfileLevel;
  writeRoots?: string[];
  roots?: string[];
  sessionTempDir?: string;
}

export function resolveWorkspaceWriteTarget(
  rawPath: string,
  workingDir: string,
  options: WriteTargetOptions = {},
): WorkspaceWriteTarget {
  if (!rawPath) return { error: "write target is missing" };

  const path = resolve(workingDir, rawPath);
  if (options.level === "strict-sandbox") return { error: `write target is denied by the strict sandbox: ${rawPath}` };
  if (options.level === "unrestricted") return { path };

  const roots = options.roots ?? resolveWriteRoots("workspace-write", workingDir, options.writeRoots, options.sessionTempDir);
  if (!isPathWithinWriteRoots(path, roots)) {
    return { error: `write target escapes the working directory: ${rawPath}` };
  }

  return { path };
}

export function unknownCapabilityPlan(tool: string, reason: string): CapabilityPlan {
  return {
    tool,
    capabilities: [],
    status: "unknown",
    reason,
    allowPersistentApproval: false,
  };
}

function knownCapabilityPlan(tool: string, capabilities: Capability[], commandClassification?: CommandClassificationResult): CapabilityPlan {
  return {
    tool,
    capabilities: Object.freeze(capabilities.map((capability) => Object.freeze(capability))),
    status: "known",
    allowPersistentApproval: false,
    ...(commandClassification ? { commandClassification: Object.freeze(commandClassification) } : {}),
  };
}

function pathFromArgs(args: Record<string, unknown>, workingDir: string): string | undefined {
  const rawPath = args.path ?? args.filePath;
  return typeof rawPath === "string" && rawPath ? resolve(workingDir, rawPath) : undefined;
}

function urlHost(args: Record<string, unknown>): string | undefined {
  const url = args.url;
  if (typeof url !== "string") return undefined;
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

/**
 * Produces a conservative data-only declaration for each built-in tool. The
 * registry coverage test keeps this exhaustive as new tools are added.
 */
export function extractCapabilityPlan(
  tool: string,
  args: Record<string, unknown>,
  workingDir: string,
): CapabilityPlan {
  if (tool === "apply_patch") return extractApplyPatchPlan(args, workingDir);

  if (["read_file", "list_files"].includes(tool)) {
    const path = pathFromArgs(args, workingDir);
    return path
      ? knownCapabilityPlan(tool, [{ type: "fs.read", path }])
      : unknownCapabilityPlan(tool, "path is missing");
  }

  if (tool === "glob") {
    const cwd = typeof args.cwd === "string" && args.cwd ? args.cwd : ".";
    return knownCapabilityPlan(tool, [{ type: "fs.read", path: resolve(workingDir, cwd) }]);
  }

  if (tool === "search") {
    const dir = typeof args.dir === "string" && args.dir ? args.dir : ".";
    return knownCapabilityPlan(tool, [{ type: "fs.read", path: resolve(workingDir, dir) }]);
  }

  if (["edit", "apply_diff", "search_replace", "edit_file", "write_to_file"].includes(tool)) {
    const rawPath = args.path ?? args.filePath;
    if (typeof rawPath !== "string") return unknownCapabilityPlan(tool, "path is missing");
    const target = resolveWorkspaceWriteTarget(rawPath, workingDir);
    return "error" in target
      ? unknownCapabilityPlan(tool, target.error)
      : knownCapabilityPlan(tool, [{ type: "fs.read", path: target.path }, { type: "fs.write", path: target.path }]);
  }

  if (tool === "run_bash" || tool === "run_bash_background") {
    const command = args.command;
    return typeof command === "string" && command.trim()
      ? knownCapabilityPlan(tool, [{ type: "process.execute", command }], classifyCommand(command))
      : unknownCapabilityPlan(tool, "command is missing");
  }

  if (tool === "web_fetch") {
    const host = urlHost(args);
    return host
      ? knownCapabilityPlan(tool, [{ type: "net.connect", host }])
      : unknownCapabilityPlan(tool, "URL is missing or invalid");
  }

  if (tool === "web_search") {
    return knownCapabilityPlan(tool, [{ type: "net.connect", host: "search-provider" }]);
  }

  if (tool === "view_image") {
    const host = urlHost(args);
    if (host) return knownCapabilityPlan(tool, [{ type: "net.connect", host }]);
    const url = args.url;
    return typeof url === "string" && url
      ? knownCapabilityPlan(tool, [{ type: "fs.read", path: resolve(workingDir, url) }])
      : unknownCapabilityPlan(tool, "image source is missing");
  }

  if (tool === "check_job" || tool === "kill_job") {
    const jobId = args.job_id;
    return typeof jobId === "string" && jobId
      ? knownCapabilityPlan(tool, [{ type: "process.control", target: jobId }])
      : unknownCapabilityPlan(tool, "job_id is missing");
  }

  if (tool === "update_todo_list") {
    return knownCapabilityPlan(tool, [{ type: "persistence.create", target: "session.todo-list" }]);
  }

  if (tool === "ask_user_question") {
    return knownCapabilityPlan(tool, [{ type: "external.mutate", service: "user-interface", target: "question" }]);
  }

  if (tool === "attempt_completion" || tool === "switch_mode") {
    return knownCapabilityPlan(tool, [{ type: "session.mutate", target: tool }]);
  }

  return unknownCapabilityPlan(tool, "tool has no capability extractor");
}

export function extractApplyPatchPlan(
  args: Record<string, unknown>,
  workingDir: string,
  options?: WriteTargetOptions,
): ApplyPatchCapabilityPlan | CapabilityPlan {
  const patch = args.patch;
  if (typeof patch !== "string") return unknownCapabilityPlan("apply_patch", "patch is missing");

  const rawPaths = [...patch.matchAll(/^\+\+\+ b\/(.+)$/gm)]
    .map((match) => match[1].trim())
    .filter(Boolean);
  if (rawPaths.length === 0) return unknownCapabilityPlan("apply_patch", "patch has no target headers");

  const targets: PatchTarget[] = [];
  for (const rawPath of rawPaths) {
    const target = resolveWorkspaceWriteTarget(rawPath, workingDir, options);
    if ("error" in target) return unknownCapabilityPlan("apply_patch", `patch ${target.error}`);
    targets.push(Object.freeze({ rawPath, path: target.path }));
  }

  const frozenTargets = Object.freeze(targets);
  return {
    tool: "apply_patch",
    targets: frozenTargets,
    capabilities: Object.freeze(frozenTargets.flatMap(({ path }) => [
      Object.freeze({ type: "fs.read" as const, path }),
      Object.freeze({ type: "fs.write" as const, path }),
    ])),
    status: "known",
    allowPersistentApproval: false,
  };
}

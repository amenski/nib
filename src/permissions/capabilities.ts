/**
 * The effects a tool must declare before policy can grant it durable access.
 * This is intentionally data-only: extraction and execution are wired in
 * separately so an unimplemented extractor fails closed as `unknown`.
 */
import { resolve } from "node:path";
import { isPathWithinWriteRoots, realpathNearestAncestor } from "../sandbox/write-roots.js";

export type Capability =
  | { type: "fs.read"; path: string }
  | { type: "fs.write"; path: string }
  | { type: "net.connect"; host: string; port?: number }
  | { type: "process.execute"; command: string }
  | { type: "secret.read"; resource: string }
  | { type: "external.mutate"; service: string; target: string }
  | { type: "persistence.create"; target: string };

export interface CapabilityPlan {
  tool: string;
  capabilities: readonly Capability[];
  status: "known" | "unknown";
  reason?: string;
  allowPersistentApproval: boolean;
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

export function unknownCapabilityPlan(tool: string, reason: string): CapabilityPlan {
  return {
    tool,
    capabilities: [],
    status: "unknown",
    reason,
    allowPersistentApproval: false,
  };
}

export function extractApplyPatchPlan(
  args: Record<string, unknown>,
  workingDir: string,
): ApplyPatchCapabilityPlan | CapabilityPlan {
  const patch = args.patch;
  if (typeof patch !== "string") return unknownCapabilityPlan("apply_patch", "patch is missing");

  const rawPaths = [...patch.matchAll(/^\+\+\+ b\/(.+)$/gm)]
    .map((match) => match[1].trim())
    .filter(Boolean);
  if (rawPaths.length === 0) return unknownCapabilityPlan("apply_patch", "patch has no target headers");

  const workspaceRoot = realpathNearestAncestor(workingDir);
  const targets: PatchTarget[] = [];
  for (const rawPath of rawPaths) {
    const path = resolve(workingDir, rawPath);
    if (!isPathWithinWriteRoots(path, [workspaceRoot])) {
      return unknownCapabilityPlan("apply_patch", `patch target escapes the working directory: ${rawPath}`);
    }
    targets.push(Object.freeze({ rawPath, path }));
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

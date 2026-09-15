/**
 * The effects a tool must declare before policy can grant it durable access.
 * This is intentionally data-only: extraction and execution are wired in
 * separately so an unimplemented extractor fails closed as `unknown`.
 */
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

export function unknownCapabilityPlan(tool: string, reason: string): CapabilityPlan {
  return {
    tool,
    capabilities: [],
    status: "unknown",
    reason,
    allowPersistentApproval: false,
  };
}

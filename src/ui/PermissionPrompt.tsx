import React from "react";
import { Box, Text } from "ink";
import type { PermissionRule } from "../permissions/index.js";
import type { Capability, CapabilityPlan } from "../permissions/capabilities.js";
import type { BashEnvelope } from "../permissions/session-grant.js";
import { extractToolSubject } from "../permissions/rules.js";
import { useTheme } from "./contexts.js";
import { ansi256, type ThemeContextValue } from "./theme.js";

export interface PermissionRequest {
  toolName: string;
  command: string;
  /** False when the tool does not yet have a safe persistent approval scope. */
  allowPersistentApproval?: boolean;
  description?: string;
  /** The rule the engine matched to produce this ask (if any) — drives risk display. */
  winningRule?: PermissionRule;
  /** The rule that will be stored on approval — drives scope display. */
  defaultRule?: PermissionRule;
  /** Canonical, data-only effect declaration for this tool call. */
  capabilityPlan?: CapabilityPlan;
  /** Working directory used to canonicalize paths in the effect declaration. */
  workingDir?: string;
  /**
   * The containment this call would run under, present only on an eligible
   * foreground Bash ask (docs/permission-ux-redesign.md). When set, the options
   * offer the session grant for exactly this envelope instead of "always", and
   * the consent text is shown — the user is being asked to approve a *profile*,
   * so the profile's limits are what the prompt must state.
   */
  envelope?: BashEnvelope;
  /** AI explanation (Ctrl+E) — informational only, never gates the decision. */
  explain?: { status: "loading" | "done" | "error"; text: string };
}

export type PermissionDecision = "once" | "session" | "always" | "deny" | "envelope-grant";

interface Props {
  request: PermissionRequest;
  cursor: number;
  onChoose: (decision: PermissionDecision) => void;
  onCancel: () => void;
}

export interface RiskInfo {
  level: "low" | "medium" | "high";
  /** Semantic theme slot that colors the risk label (high=error, etc.). */
  slot: "error" | "warning" | "success";
  label: string;
}

/**
 * Render canonical capability declarations as short, user-facing effects.
 * This is presentation only: an unknown plan is deliberately called out as
 * full risk and never changes the permission decision.
 */
export function capabilitySummary(plan?: CapabilityPlan, workingDir = process.cwd()): string[] {
  if (!plan || plan.status === "unknown") {
    return ["Unknown effects — full risk; this tool's capabilities could not be determined."];
  }

  if (plan.capabilities.length === 0) return ["No effects declared"];

  const cwd = workingDir.replace(/\/$/, "");
  const home = process.env.HOME?.replace(/\/$/, "");
  const displayPath = (path: string): string => {
    if (path === cwd) return "./";
    if (path.startsWith(`${cwd}/`)) return `./${path.slice(cwd.length + 1)}`;
    if (home && path === home) return "~";
    if (home && path.startsWith(`${home}/`)) return `~/${path.slice(home.length + 1)}`;
    return path;
  };
  const displayCommand = (command: string): string => command.replace(/\s+/g, " ").trim();
  const format = (capability: Capability): string => {
    switch (capability.type) {
      case "fs.read": return `Read ${displayPath(capability.path)}`;
      case "fs.write": return `Write ${displayPath(capability.path)}`;
      case "net.connect": return `Connect to ${capability.host}${capability.port ? `:${capability.port}` : ""}`;
      case "process.execute": return `Execute ${displayCommand(capability.command)}`;
      case "process.control": return `Control process ${capability.target}`;
      case "secret.read": return `Read secret ${capability.resource}`;
      case "external.mutate": return `Mutate ${capability.service} (${capability.target})`;
      case "persistence.create": return `Create ${capability.target}`;
      case "session.mutate": return `Change session (${capability.target})`;
    }
  };
  return plan.capabilities.map(format);
}

const READ_TOOLS = new Set(["read_file", "read", "list_files", "glob", "search", "load_skill"]);

/**
 * Risk is driven by the matched rule, not a static per-scope table: a
 * destructive-origin match is always high risk regardless of tool, a write
 * or run_bash call with no narrowing rule is medium, and a plain read is low.
 */
export function riskLevel(request: PermissionRequest): RiskInfo {
  const rule = request.winningRule;

  if (rule?.origin === "builtin-destructive") {
    return { level: "high", slot: "error", label: "destructive command" };
  }

  if (READ_TOOLS.has(request.toolName)) {
    return { level: "low", slot: "success", label: "read-only" };
  }

  if (request.toolName === "run_bash" || request.toolName.startsWith("write") || request.toolName === "edit") {
    return { level: "medium", slot: "warning", label: "modifies state" };
  }

  return { level: "medium", slot: "warning", label: "unclassified" };
}

/** Resolve a semantic theme slot to an Ink color string, honoring the color gate. */
function slotColor(theme: ThemeContextValue, key: keyof ThemeContextValue["theme"]): string | undefined {
  if (!theme.colorEnabled) return undefined;
  return ansi256(theme.theme[key] as number);
}

/**
 * Renders the Ctrl+E AI explanation region. Nothing is shown until the user
 * requests it. Informational only — it never changes the options or decision.
 */
function ExplanationBlock({ explain }: { explain?: PermissionRequest["explain"] }) {
  const theme = useTheme();
  if (!explain) return null;

  const accent = slotColor(theme, "accent");

  if (explain.status === "loading" && !explain.text) {
    return (
      <Box marginTop={1}>
        <Text color={accent}>✳ </Text>
        <Text dimColor>Explaining…</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color={accent}>✳ Explanation</Text>
      <Text dimColor>{explain.text}</Text>
    </Box>
  );
}

/** Footer hint offering Ctrl+E once, before the user has requested it. */
function explainHint(explain?: PermissionRequest["explain"]): string {
  return explain ? "" : " · Ctrl+E explain";
}

/** Human-readable scope line shown above the risk label when a broader pattern
 *  is being approved (e.g. a directory glob rather than an exact file). */
function scopeLine(request: PermissionRequest): string | null {
  const rule = request.defaultRule;
  if (!rule || rule.kind !== "glob") return null;

  if (!rule.pattern.startsWith("./")) {
    // External path → parent directory
    const dir = rule.pattern.replace(/\/\*$/, "");
    const home = process.env.HOME;
    const display = home ? dir.replace(home, "~") : dir;
    return `Access external directory ${display}`;
  }
  // Internal directory glob
  const dir = rule.pattern.replace(/\/\*\*$/, "");
  return `Access directory ${dir}`;
}

const OPTIONS: { decision: PermissionDecision; label: string }[] = [
  { decision: "once", label: "Yes, just once" },
  { decision: "session", label: "Yes, for this session" },
  { decision: "always", label: "Yes, always allow" },
  { decision: "deny", label: "No" },
];

/**
 * The session grant offered in place of "always" on an eligible foreground Bash
 * ask. It is consent for one containment envelope, not for a command pattern —
 * so there is nothing to store as a rule, and the option list is exactly three
 * (docs/permission-ux-redesign.md).
 */
const ENVELOPE_GRANT_OPTION: { decision: PermissionDecision; label: string } = {
  decision: "envelope-grant",
  label: "Yes, sandboxed Bash in this workspace for this session",
};

export function permissionOptions(request: PermissionRequest): { decision: PermissionDecision; label: string }[] {
  if (request.envelope) {
    return [OPTIONS[0], ENVELOPE_GRANT_OPTION, OPTIONS[3]];
  }
  if (request.allowPersistentApproval === false) {
    return [OPTIONS[0], OPTIONS[3]];
  }
  return OPTIONS;
}

/** Home directory, or null — `process.env.HOME` is absent in some environments. */
function homeDir(): string | null {
  const home = process.env.HOME?.replace(/\/$/, "");
  return home && home.length > 0 ? home : null;
}

/**
 * The consent text for the session grant, one line per statement
 * (docs/permission-ux-redesign.md). It states the write-set the profile
 * *grants* — `envelope.writeRoots` is that set, not the one that was requested
 * — so the limits the user approves are the limits that apply. Pure, so the
 * copy can be tested without rendering.
 */
export function grantConsentLines(envelope: BashEnvelope): string[] {
  const roots = envelope.writeRoots;
  const home = homeDir();

  const lines: string[] = [
    "Eligible foreground Bash commands will run without asking, under this macOS sandbox profile:",
    roots.length > 0
      ? `Writable: ${roots.join(", ")} — not the machine's shared temporary directories, and not the package-manager cache.`
      : "Writable: nothing — this profile grants no write access at all.",
    "It can run project scripts and start child processes.",
    "Direct network connections from those children are denied; macOS name resolution may still occur outside the child.",
    "Reads are only partly contained: files outside your home directory can still be readable, and files inside the project — including .env — can be read by a script even though the file tools guard them.",
  ];

  // Decision 8: the outside-$HOME warning is repeated here, because consent is
  // the moment the authority is actually granted.
  if (home) {
    const outside = roots.filter((root) => root !== home && !root.startsWith(`${home}/`));
    if (outside.length > 0) {
      lines.push(
        `⚠ Outside your home directory: ${outside.join(", ")} — write access there is not bounded by your home directory.`,
      );
    }
  }

  lines.push(
    "Denied and guarded commands still ask.",
    "Revoke this in /permissions. Revoking does not undo changes already made, and does not stop a command that is already running.",
  );

  return lines;
}

/** Renders {@link grantConsentLines} beside the grant option. */
function GrantConsent({ envelope }: { envelope: BashEnvelope }) {
  const theme = useTheme();
  const warningColor = slotColor(theme, "warning");
  return (
    <Box flexDirection="column" marginTop={1}>
      {grantConsentLines(envelope).map((line) => (
        <Text key={line} color={line.startsWith("⚠") ? warningColor : undefined} dimColor={!line.startsWith("⚠")}>
          {line}
        </Text>
      ))}
    </Box>
  );
}

export default function PermissionPrompt({ request, cursor, onChoose, onCancel }: Props) {
  const theme = useTheme();
  const risk = riskLevel(request);
  const warningColor = slotColor(theme, "warning");
  const accentColor = slotColor(theme, "accent");
  const options = permissionOptions(request);

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={warningColor} paddingX={1} marginY={1}>
      <Box marginBottom={1}>
        <Text color={warningColor} bold>△ Permission required</Text>
      </Box>
      <Text bold>{request.toolName}</Text>
      <Text>{request.command}</Text>
      {scopeLine(request) ? <Text color={slotColor(theme, "warning")}>{scopeLine(request)}</Text> : null}
      {request.defaultRule?.kind === "glob" ? <Text dimColor>Pattern: {request.defaultRule.pattern}</Text> : null}
      {request.description ? <Text dimColor>{request.description}</Text> : null}
      <Box marginTop={1}>
        <Text dimColor>Effects: </Text>
        <Text color={slotColor(theme, risk.slot)}>{capabilitySummary(request.capabilityPlan, request.workingDir).join("; ")}</Text>
      </Box>
      {request.envelope ? <GrantConsent envelope={request.envelope} /> : null}
      <ExplanationBlock explain={request.explain} />
      <Box marginTop={1}>
        <Text>Do you want to proceed?</Text>
      </Box>
      <Box flexDirection="column" marginTop={1}>
        {options.map((opt, i) => (
          <Text key={opt.decision} color={i === cursor ? accentColor : undefined}>
            {i === cursor ? "> " : "  "}
            {i + 1}. {opt.label}
          </Text>
        ))}
      </Box>
      <Box marginTop={1}>
        <Text dimColor>1-{options.length} select · ↑↓ navigate · Esc cancel{explainHint(request.explain)}</Text>
      </Box>
    </Box>
  );
}

/**
 * Stronger-confirmation variant shown when the winning rule is
 * destructive-origin. v1 scope cut: visually distinct (red banner, explicit
 * warning) rather than a new typed/held-confirmation input paradigm — the
 * load-bearing safety property is the engine forcing kind "exact" on
 * approval (see PermissionEngine.narrowToExact), which doesn't depend on
 * this prompt's interaction style.
 */
export function DestructiveConfirmPrompt({ request, cursor, onChoose, onCancel }: Props) {
  const theme = useTheme();
  const errorColor = slotColor(theme, "error");
  const accentColor = slotColor(theme, "accent");
  const options = permissionOptions(request);

  return (
    <Box flexDirection="column" borderStyle="double" borderColor={errorColor} paddingX={1} marginY={1}>
      <Box marginBottom={1}>
        <Text color={errorColor} bold>⚠ Destructive command</Text>
      </Box>
      <Text bold>{request.toolName}</Text>
      <Text color={errorColor}>{request.command}</Text>
      {scopeLine(request) ? <Text color={slotColor(theme, "warning")}>{scopeLine(request)}</Text> : null}
      {request.defaultRule?.kind === "glob" ? <Text dimColor>Pattern: {request.defaultRule.pattern}</Text> : null}
      {request.description ? <Text dimColor>{request.description}</Text> : null}
      <Box marginTop={1}>
        <Text dimColor>Effects: </Text>
        <Text color={errorColor}>{capabilitySummary(request.capabilityPlan, request.workingDir).join("; ")}</Text>
      </Box>
      <Box marginTop={1}>
        <Text dimColor>{request.allowPersistentApproval === false
          ? "This command can cause irreversible data loss. Only one-time approval is available."
          : "This command can cause irreversible data loss. Approving \"always\" whitelists only this exact command, never the whole category."}
        </Text>
      </Box>
      <ExplanationBlock explain={request.explain} />
      <Box marginTop={1}>
        <Text>Do you want to proceed?</Text>
      </Box>
      <Box flexDirection="column" marginTop={1}>
        {options.map((opt, i) => (
          <Text key={opt.decision} color={i === cursor ? accentColor : undefined}>
            {i === cursor ? "> " : "  "}
            {i + 1}. {opt.label}
          </Text>
        ))}
      </Box>
      <Box marginTop={1}>
        <Text dimColor>1-{options.length} select · ↑↓ navigate · Esc cancel{explainHint(request.explain)}</Text>
      </Box>
    </Box>
  );
}

const SCOPE_OPTIONS: { scope: "file" | "folder"; label: string }[] = [
  { scope: "file", label: "Just this file" },
  { scope: "folder", label: "Whole folder" },
];

/** Write/edit tools — mirrors PermissionEngine.WRITE_TOOLS. Drives the elevated-risk copy below, since a recursive grant for these means write access, not just read. */
const WRITE_TOOLS = new Set(["edit", "edit_file", "write_to_file", "search_replace", "apply_diff", "apply_patch"]);

/**
 * Stage-two prompt shown after the user approves a read or write/edit
 * (session/always) for a file whose folder already has a sibling exact
 * approval. Lets them keep the exact-file rule or broaden to a recursive
 * folder glob. For write/edit tools the copy calls out that broadening
 * grants recursive WRITE access, not just read — a materially riskier grant.
 */
export function ScopeChoicePrompt({
  folderPattern,
  toolName,
  cursor,
  onChoose,
}: {
  folderPattern: string;
  toolName: string;
  cursor: number;
  onChoose: (scope: "file" | "folder") => void;
  onCancel: () => void;
}) {
  const theme = useTheme();
  const accentColor = slotColor(theme, "accent");
  const errorColor = slotColor(theme, "error");
  const folderDir = folderPattern.replace(/\/\*\*$/, "");
  const isWrite = WRITE_TOOLS.has(toolName);
  const borderColor = isWrite ? errorColor : accentColor;

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={borderColor} paddingX={1} marginY={1}>
      <Box marginBottom={1}>
        <Text bold>Grant just this file, or the whole folder?</Text>
      </Box>
      {isWrite ? (
        <Text color={errorColor}>Whole folder grants write access to {folderDir} and everything beneath it — the agent can modify or overwrite any file there.</Text>
      ) : (
        <Text dimColor>Whole folder covers {folderDir} and everything beneath it.</Text>
      )}
      <Box flexDirection="column" marginTop={1}>
        {SCOPE_OPTIONS.map((opt, i) => (
          <Text key={opt.scope} color={i === cursor ? accentColor : undefined}>
            {i === cursor ? "> " : "  "}
            {i + 1}. {opt.label}
          </Text>
        ))}
      </Box>
      <Box marginTop={1}>
        <Text dimColor>1-2 select · ↑↓ navigate · Esc cancel</Text>
      </Box>
    </Box>
  );
}

const EXTERNAL_SCOPE_OPTIONS: { scope: "file" | "folder"; label: string }[] = [
  { scope: "file", label: "This folder only" },
  { scope: "folder", label: "Include subfolders" },
];

/**
 * Stage-two prompt shown after the user approves a read (session/always) for
 * a path OUTSIDE the workspace. The default rule covers one directory level
 * only, which re-prompts for every subfolder of a tree the user believes they
 * already approved — this offers the recursive grant instead. Read-only by
 * construction (an external write approval never broadens), so no
 * elevated-risk copy: `scope` reuses ScopeChoicePrompt's narrow/broad union.
 */
export function ExternalScopeChoicePrompt({
  treePattern,
  cursor,
  onChoose,
}: {
  treePattern: string;
  cursor: number;
  onChoose: (scope: "file" | "folder") => void;
  onCancel: () => void;
}) {
  const theme = useTheme();
  const accentColor = slotColor(theme, "accent");
  const dir = treePattern.replace(/\/\*\*$/, "");
  const home = process.env.HOME;
  const display = home ? dir.replace(home, "~") : dir;

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={accentColor} paddingX={1} marginY={1}>
      <Box marginBottom={1}>
        <Text bold>Grant this folder only, or its subfolders too?</Text>
      </Box>
      <Text dimColor>This folder only covers files directly in {display}. Include subfolders covers {display} and everything beneath it.</Text>
      <Box flexDirection="column" marginTop={1}>
        {EXTERNAL_SCOPE_OPTIONS.map((opt, i) => (
          <Text key={opt.scope} color={i === cursor ? accentColor : undefined}>
            {i === cursor ? "> " : "  "}
            {i + 1}. {opt.label}
          </Text>
        ))}
      </Box>
      <Box marginTop={1}>
        <Text dimColor>1-2 select · ↑↓ navigate · Esc cancel</Text>
      </Box>
    </Box>
  );
}

export function buildPermissionRequest(
  toolName: string,
  args: Record<string, unknown>,
  winningRule?: PermissionRule,
  defaultRule?: PermissionRule,
  capabilityPlan?: CapabilityPlan,
  workingDir?: string,
): PermissionRequest {
  return {
    toolName,
    command: extractToolSubject(toolName, args),
    winningRule,
    defaultRule,
    capabilityPlan,
    workingDir,
  };
}

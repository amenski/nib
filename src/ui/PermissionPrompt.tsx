import React from "react";
import { Box, Text } from "ink";
import type { PermissionRule } from "../permissions/index.js";
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
  /** AI explanation (Ctrl+E) — informational only, never gates the decision. */
  explain?: { status: "loading" | "done" | "error"; text: string };
}

export type PermissionDecision = "once" | "session" | "always" | "deny";

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

export function permissionOptions(request: PermissionRequest): { decision: PermissionDecision; label: string }[] {
  if (request.allowPersistentApproval === false) {
    return [OPTIONS[0], OPTIONS[3]];
  }
  return OPTIONS;
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
        <Text dimColor>Risk: </Text>
        <Text color={slotColor(theme, risk.slot)}>{risk.label}</Text>
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
): PermissionRequest {
  return { toolName, command: extractToolSubject(toolName, args), winningRule, defaultRule };
}

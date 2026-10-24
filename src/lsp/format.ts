import type { LspDiagnostic, LspLocation } from "./protocol.js";
import { MAX_DIAGNOSTICS_PER_FILE } from "./server.js";
import { relPath } from "./protocol.js";
import { wrapUntrusted, sanitizeControlChars } from "../tools/untrusted-content.js";

/** Severity name for the model-facing line, matching the LSP enum. */
function severityName(severity: 1 | 2 | 3 | 4): string {
  switch (severity) {
    case 1:
      return "error";
    case 2:
      return "warning";
    case 3:
      return "info";
    default:
      return "hint";
  }
}

export interface FormattedDiagnostics {
  /** Errors + warnings only, at most MAX_DIAGNOSTICS_PER_FILE lines. */
  lines: string[];
  /** How many of the in-range diagnostics were dropped by the cap. */
  omitted: number;
  errorCount: number;
}

/**
 * Turns one file's diagnostics into model-facing lines, keeping only Error and
 * Warning. Info/Hint are dropped on purpose: they are the bulk of a linter's
 * output and say nothing about whether the edit broke the code.
 */
export function formatDiagnostics(
  path: string,
  diagnostics: readonly LspDiagnostic[],
  rootDir: string,
): FormattedDiagnostics {
  const relevant = diagnostics.filter((d) => d.severity === 1 || d.severity === 2);
  const shown = relevant.slice(0, MAX_DIAGNOSTICS_PER_FILE);
  const rel = relPath(rootDir, path);
  const lines = shown.map((d) => {
    const code = d.code !== undefined ? ` [${d.code}]` : "";
    return `${rel}:${d.line}:${d.character}  ${severityName(d.severity)}: ${d.message}${code}`;
  });
  return {
    lines,
    omitted: relevant.length - shown.length,
    errorCount: relevant.filter((d) => d.severity === 1).length,
  };
}

export function formatLocations(
  locations: readonly LspLocation[],
  rootDir: string,
): string {
  return locations
    .map((l) => `${relPath(rootDir, l.path)}:${l.line}:${l.character}`)
    .join("\n");
}

export function formatSymbols(
  symbols: ReadonlyArray<{ name: string; kind: string; path: string; line: number }>,
  rootDir: string,
): string {
  return symbols
    .map((s) => `${s.kind} ${s.name}  ${relPath(rootDir, s.path)}:${s.line}`)
    .join("\n");
}

export function formatHover(hover: { contents: string } | null): string {
  return hover?.contents ?? "";
}

export function formatCallHierarchy(
  entries: ReadonlyArray<{ name: string; from: string; path: string; line: number }>,
  rootDir: string,
): string {
  return entries
    .map((e) => `${e.name}  (from ${e.from})  ${relPath(rootDir, e.path)}:${e.line}`)
    .join("\n");
}

/**
 * The block appended to a write tool's result: a `[nib]` label outside the
 * untrusted wrapper, then the wrapped body. The label is nib's own voice and
 * must stay unwrapped; the diagnostic text embeds compiler messages that quote
 * the edited file, so it is treated as untrusted content like any other
 * external payload (security-spec T12/T14).
 *
 * Returns null when there is nothing to say, so a clean edit's result is left
 * byte-for-byte unchanged.
 */
export function diagnosticsBlock(
  serverName: string,
  path: string,
  diagnostics: readonly LspDiagnostic[],
  rootDir: string,
): string | null {
  const formatted = formatDiagnostics(path, diagnostics, rootDir);
  if (formatted.lines.length === 0) return null;

  const body = [...formatted.lines];
  if (formatted.omitted > 0) body.push(`(+${formatted.omitted} more)`);
  const label = `[nib] ${serverName} diagnostics for ${relPath(rootDir, path)}:`;
  return `${label}\n${wrapUntrusted(sanitizeControlChars(body.join("\n")))}`;
}


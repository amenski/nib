import type { Argv } from "yargs";
import Yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { pkg } from "./version.js";

// Matches the IDs generateId() produces in src/sessions/store.ts.
const SESSION_ID_REGEX = /^\d{4}-\d{2}-\d{2}T\d{4}-[0-9a-f]{4}$/;

export function isValidSessionId(value: string): boolean {
  return SESSION_ID_REGEX.test(value);
}

export type ResumeArg = string | true | undefined;

export interface ParsedCliArgs {
  prompt: string | undefined;
  print: boolean;
  resume: ResumeArg;
  version: boolean;
  help: boolean;
  continueLast: boolean;
  model: string | undefined;
  mode: string | undefined;
  debug: boolean;
  addDirs: string[];
  /** Cap the number of agentic turns; reaching it exits non-zero in print mode. */
  maxTurns: number | undefined;
  /** Restrict the offered tool set to exactly these names (allowlist). */
  allowedTools: string[];
  /** Remove these tool names from the offered set (denylist). */
  disallowedTools: string[];
  /** Custom display name for a freshly-created session. */
  name: string | undefined;
}

/** Resolve explicit additional trusted directories relative to the startup cwd. */
export function resolveAdditionalDirs(paths: string[], cwd: string = process.cwd()): string[] {
  return paths.map((path) => {
    if (path === "~") return homedir();
    if (path.startsWith("~/")) return join(homedir(), path.slice(2));
    return isAbsolute(path) ? resolve(path) : resolve(cwd, path);
  });
}

const TUI_KEYS = [
  "  Enter            Send the prompt",
  "  Shift+Enter      Insert a newline",
  "  Shift+Tab        Cycle normal / auto-approve / plan posture",
  "  Esc              Interrupt the current model turn",
  "  Ctrl+D twice     Quit",
  "  /                Open the commands menu",
].join("\n");

async function configureYargs(argv?: string[]) {
  const rawArgv = argv ?? hideBin(process.argv);
  return Yargs(rawArgv)
    .locale("en")
    .scriptName("nib")
    .usage("Usage: $0 [options] [command] [prompt]\n\nNib — starts an interactive session by default, use -p/--print for non-interactive output")
    .command("$0 [prompt]", "Launch an interactive session", (yargsInstance: Argv) =>
      yargsInstance
        .positional("prompt", { type: "string", describe: "Your prompt" })
        .option("print", { alias: "p", type: "boolean", default: false, describe: "Print response and exit (useful for pipes). Requires a prompt." })
        .option("resume", { alias: "r", type: "string", describe: "Resume a conversation by session ID, or open interactive picker with optional search term" })
        .option("continue", { alias: "c", type: "boolean", default: false, describe: "Continue the most recent conversation in the current directory" })
        .option("model", { type: "string", describe: "Model for the current session (provider/model)" })
        .option("mode", { type: "string", describe: "Start in the given persona mode" })
        .option("debug", { alias: "d", type: "boolean", default: false, describe: "Write redacted diagnostic request/response logs" })
        .option("add-dir", { type: "string", array: true, default: [], describe: "Add a trusted writable directory (repeatable)" })
        .option("max-turns", { type: "number", describe: "Cap the number of agentic turns (print mode exits non-zero at the limit)" })
        .option("allowed-tools", { alias: "allowedTools", type: "string", array: true, default: [], describe: "Restrict tools to this comma-separated allowlist (repeatable)" })
        .option("disallowed-tools", { alias: "disallowedTools", type: "string", array: true, default: [], describe: "Remove tools from the offered set (comma-separated, repeatable)" })
        .option("name", { alias: "n", type: "string", describe: "Display name for a new session" })
        .check((argv: Record<string, unknown>) => {
          const positionalPrompt = argv["prompt"] as string | undefined;
          const resume = argv["resume"] as string | undefined;
          const hasContinue = argv["continue"] === true;
          const print = argv["print"] === true;
          const maxTurns = argv["max-turns"] as number | undefined;

          if (resume !== undefined && hasContinue)
            return "Cannot use --continue together with --resume.";
          if (resume !== undefined && resume !== "" && !isValidSessionId(resume))
            return `Invalid session ID: "${resume}". Expected the form <timestamp>-<hex>, e.g. 2026-07-30T2358-15a3.`;
          if (print && !positionalPrompt)
            return "--print / -p requires a non-empty prompt.";
          if (maxTurns !== undefined && (!Number.isInteger(maxTurns) || maxTurns < 1))
            return "--max-turns must be a positive integer.";
          return true;
        })
    )
    .command("auth [action]", "Manage authentication", (yargsInstance: Argv) =>
      yargsInstance
        .positional("action", { type: "string", describe: "list | logout <provider> | <provider> [--api-key <key>]" })
    )
    .command("doctor", "Check the health of your Nib setup", () => {})
    .example("nib", "Launch the interactive TUI")
    .example("nib 'explain src/foo.ts'", "Launch with an initial prompt")
    .example("nib -p 'explain this error'", "Run one prompt non-interactively (useful for pipes)")
    .example("nib -r", "Open session picker")
    .example("nib -r <sessionId>", "Resume a specific session")
    .example("nib -c", "Continue the most recent session")
    .example('cat error.log | nib -p "Explain this error"', "Use piped stdin as context")
    .epilog(
      [
        "Configuration:",
        "  ~/.nib/settings.json    User-level settings (model, permissions, integrations)",
        "  ./.nib/settings.json    Project-level settings",
        "",
        "Inside the TUI:",
        TUI_KEYS,
      ].join("\n"),
    )
    .strict()
    .demandCommand(0, 0)
    .wrap(Math.min(process.stdout.columns || 80, 120));
}

export async function parseArguments(argv?: string[]): Promise<ParsedCliArgs> {
  const y = (await configureYargs(argv))
    .exitProcess(false)
    .fail((msg, err, yargs) => {
      process.stderr.write((msg || err?.message || "Unknown error") + "\n");
      yargs.showHelp();
      process.exit(1);
    })
    .version(pkg.version)
    .alias("v", "version")
    .help()
    .alias("h", "help");

  const parsed = y.parseSync() as Record<string, unknown>;

  const resumeRaw = parsed.resume as string | undefined;
  let resume: ResumeArg;
  if (resumeRaw === undefined) resume = undefined;
  else if (resumeRaw === "") resume = true;
  else resume = resumeRaw;

  const splitList = (value: unknown): string[] =>
    Array.isArray(value)
      ? value.flatMap((v) => String(v).split(",")).map((s) => s.trim()).filter(Boolean)
      : [];

  return {
    prompt: parsed.prompt as string | undefined,
    print: parsed.print === true,
    resume,
    version: parsed.version === true,
    help: parsed.help === true,
    continueLast: parsed.continue === true,
    model: parsed.model as string | undefined,
    mode: parsed.mode as string | undefined,
    debug: parsed.debug === true,
    addDirs: Array.isArray(parsed["add-dir"]) ? parsed["add-dir"].map(String) : [],
    maxTurns: typeof parsed["max-turns"] === "number" ? parsed["max-turns"] : undefined,
    allowedTools: splitList(parsed["allowed-tools"]),
    disallowedTools: splitList(parsed["disallowed-tools"]),
    name: typeof parsed.name === "string" && parsed.name.trim() ? parsed.name.trim() : undefined,
  };
}

import { describe, expect, it } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { runBashTimed } from "../tools/bash.js";
import { jobManager } from "../tools/jobs.js";
import { MCPClient } from "../mcp/client.js";
import { HookRunner } from "../hooks/index.js";
import { parseHooksConfig } from "../hooks/config.js";
import { defaultCommandRunner } from "../ui/statusline/manager.js";
import { fireNotify } from "../notify.js";
import type { SandboxLevel } from "./seatbelt.js";

// ── child launch paths (macOS) — release gate 3 ──
//
// Gate 3 requires every *supported* way nib can launch a child to be verified
// with the same two probes, not just the Bash one. Until now the other
// surfaces were asserted only at the argv level (`expect(cmd).toBe(
// "/usr/bin/sandbox-exec")` in notify.test.ts and friends), which proves the
// launcher was *called*, not that the profile it produced was *enforced* on a
// real child.
//
// Each surface below therefore runs the real production entry point for that
// surface — runBashTimed, jobManager, MCPClient.connect, HookRunner.dispatch,
// defaultCommandRunner, fireNotify — and the child does three things:
//
//   1. read a synthetic canary in a sibling directory under the real $HOME
//      → must be DENIED                                   (gate 1)
//   2. create and write `.git/hooks/pre-commit`
//      → must be DENIED                                   (gate 2)
//   3. write its report into the workspace and, where the surface has an
//      output stream, echo a line
//      → must SUCCEED (the allowed ordinary operation)
//
// The report is both the allowed operation and the evidence channel: a
// surface that silently failed to spawn cannot pass by producing nothing,
// because every test waits for the report and fails if it never lands. Each
// probe is paired with an **unsandboxed control through the same surface** —
// the control is what makes a denial attributable to Seatbelt rather than to
// a fixture that was never readable/writable (the release-handoff rule: a
// failed command is not evidence of denial unless the control could otherwise
// run).
//
// The control is also the honesty row for "sandbox unavailable": with no
// applicable level — what `isSandboxedLevel` yields on a non-darwin platform,
// and what `unrestricted` yields anywhere — the identical probe reads the
// canary and writes the hook. Containment is absent there, which is exactly
// why `hasActiveSandboxContainment` (src/config/loader.test.ts) exists to
// refuse auto-approval in that configuration; the refusal itself is asserted
// in src/ui/App.streaming.test.tsx. Nothing here claims containment the
// platform is not providing.
//
// The fixtures are disposable, synthetic, and never touch a real credential,
// shell startup file, or another project's checkout.

const onDarwin = process.platform === "darwin";
const itOnDarwin = it.skipIf(!onDarwin);

const CANARY = "SYNTHETIC_CANARY_4c1d7e_not_a_real_secret";
/** What a successful canary read reports (the probe truncates to 24 chars). */
const CANARY_SEEN = CANARY.slice(0, 24);

interface ProbeResult {
  /** Canary contents if the read landed, else "DENIED". */
  read: string;
  /** "WROTE" if `.git/hooks/pre-commit` was created, else "DENIED". */
  hook: string;
}

interface ProbeFixture {
  root: string;
  ws: string;
  canaryPath: string;
  hookPath: string;
  cleanup: () => void;
}

/**
 * The boundary is `$HOME`-shaped, so the fixture has to live *under the real
 * home* for the read deny to apply at all — a fixture in $TMPDIR sits outside
 * the boundary and reads happily, which would make the read probe vacuous.
 * `ws` doubles as the trusted root in every call below, so the writes under
 * test are permitted by the workspace grant, not by the temp carve-outs.
 *
 * No repository is created: the `.git` deny is path-shaped, so the probe's
 * own `mkdirSync` is enough for it to apply. (The git-integrity suite covers
 * the same deny against a real repository and a real submodule gitdir.)
 */
function fixture(): ProbeFixture {
  const root = mkdtempSync(join(homedir(), ".nib-childpaths-"));
  const ws = join(root, "ws");
  const sibling = join(root, "sibling");
  mkdirSync(ws, { recursive: true });
  mkdirSync(sibling, { recursive: true });
  const canaryPath = join(sibling, "canary.txt");
  writeFileSync(canaryPath, CANARY + "\n");
  writeFileSync(join(ws, "normal.txt"), "normal project file\n");
  return {
    root,
    ws,
    canaryPath,
    hookPath: join(ws, ".git", "hooks", "pre-commit"),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

/** A per-run report path inside the workspace (a fresh fixture per test, so
 *  a stale report can never satisfy the wait). */
const reportPath = (f: ProbeFixture, name: string): string => join(f.ws, `probe-${name}.json`);

/**
 * The child probe, as a single source string so every surface runs
 * byte-identical code and the rows are comparable. Failures are recorded, not
 * thrown: the probe exits 0 as long as the report write lands, so "the report
 * exists" means "the workspace write was allowed" and nothing else about the
 * run is inferred from an exit code.
 */
function probeSource(f: ProbeFixture, report: string, announce = true): string {
  return (
    `const fs=require("fs"),path=require("path");` +
    `let read="DENIED";try{read=fs.readFileSync(${JSON.stringify(f.canaryPath)},"utf8").trim().slice(0,24)}catch(e){}` +
    `let hook="DENIED";const h=${JSON.stringify(f.hookPath)};` +
    `try{fs.mkdirSync(path.dirname(h),{recursive:true});fs.writeFileSync(h,"x");hook="WROTE"}catch(e){}` +
    `fs.writeFileSync(${JSON.stringify(report)},JSON.stringify({read,hook}));` +
    (announce ? `process.stdout.write("PROBE-OK\\n");` : "")
  );
}

/** The same probe as a `node -e '…'` shell command. The source is quoted for
 *  the shell, so it must stay free of single quotes — every string literal
 *  below is emitted with JSON.stringify (double quotes). */
const probeCommand = (f: ProbeFixture, report: string, announce = true): string =>
  `node -e '${probeSource(f, report, announce)}'`;

async function waitFor(predicate: () => boolean, timeoutMs = 15_000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** The report is the allowed operation *and* the channel: wait for it, then
 *  read what the child observed. */
async function readReport(report: string): Promise<ProbeResult> {
  await waitFor(() => existsSync(report));
  return JSON.parse(readFileSync(report, "utf8")) as ProbeResult;
}

/**
 * Both directions for one surface. `control` is the same surface with no
 * containment, `contained` is the configured level.
 */
function expectContained(control: ProbeResult, contained: ProbeResult): void {
  // Direction 1 — the control. Without a profile the identical probe reads
  // the canary and writes the hook, so the denials below are attributable to
  // Seatbelt and not to the fixture.
  expect(control.read).toBe(CANARY_SEEN);
  expect(control.hook).toBe("WROTE");
  // Direction 2 — the release-gate effects, denied through this surface.
  expect(contained.read).toBe("DENIED");
  expect(contained.hook).toBe("DENIED");
}

describe("child launch paths (macOS) — release gate 3", () => {
  itOnDarwin(
    "foreground Bash: canary read and .git/hooks write denied, ordinary work allowed",
    async () => {
      const f = fixture();
      try {
        const controlReport = reportPath(f, "fg-control");
        // The control passes no level at all, which is the same thing as
        // `unrestricted` and the same thing a non-darwin platform yields:
        // `sandboxPrefix` returns null for both (seatbelt.test.ts,
        // "unrestricted (or absent level) returns no prefix").
        const control = await runBashTimed(probeCommand(f, controlReport), f.ws, f.ws, 30_000, false);
        expect(control.content).toContain("PROBE-OK");
        const controlResult = await readReport(controlReport);

        const report = reportPath(f, "fg");
        const contained = await runBashTimed(probeCommand(f, report), f.ws, f.ws, 30_000, false, "workspace-write");
        // The allowed ordinary operation: the workspace write and stdout.
        expect(contained.content).toContain("PROBE-OK");
        expectContained(controlResult, await readReport(report));
      } finally {
        f.cleanup();
      }
    },
    60_000,
  );

  itOnDarwin(
    "background Bash (run_bash_background): same denials, same allowed write",
    async () => {
      const f = fixture();
      try {
        // Controls and contained runs through the job manager's real spawn
        // path. The control passes no level, which must produce no profile at
        // all — the same "no silent containment" rule the foreground row
        // states.
        const runJob = async (name: string, level: SandboxLevel | undefined) => {
          const report = reportPath(f, name);
          const started = jobManager.start(probeCommand(f, report), f.ws, 30_000, {
            sandboxLevel: level,
            trustedRoot: f.ws,
          });
          expect(started.ok).toBe(true);
          const id = (started as { ok: true; id: string }).id;
          await waitFor(() => {
            const r = jobManager.check(id);
            return r !== null && r.status !== "running";
          });
          const job = jobManager.check(id)!;
          expect(job.status).toBe("done");
          expect(job.stdout).toContain("PROBE-OK");
          return readReport(report);
        };

        const control = await runJob("bg-control", undefined);
        const contained = await runJob("bg", "workspace-write");
        expectContained(control, contained);
      } finally {
        jobManager.killAll();
        f.cleanup();
      }
    },
    60_000,
  );

  itOnDarwin(
    "timeout-migrated descendant: the adopted job keeps the profile after the handover",
    async () => {
      const f = fixture();
      try {
        // The command outlives the timeout, so runBashTimed spawns the child
        // (sandboxed), migrates it into a job, and the *same detached process*
        // runs the probe afterwards. This is the row that would catch a
        // migration path that re-spawned without the profile.
        const report = reportPath(f, "migrated");
        const result = await runBashTimed(
          `echo before; sleep 1; ${probeCommand(f, report)}`,
          f.ws,
          f.ws,
          300,
          true,
          "workspace-write",
        );
        expect(result.content).toContain("moved to background");
        const jobId = result.content.match(/job ([0-9a-f-]{36})/)?.[1];
        expect(jobId).toBeTruthy();
        await waitFor(() => {
          const r = jobManager.check(jobId!);
          return r !== null && r.status !== "running";
        });
        const job = jobManager.check(jobId!)!;
        expect(job.status).toBe("done");
        // The allowed ordinary operation, post-migration.
        expect(job.stdout).toContain("PROBE-OK");

        const migrated = await readReport(report);
        expect(migrated.read).toBe("DENIED");
        expect(migrated.hook).toBe("DENIED");

        // Direction 2 needs no second job here: the unsandboxed control is the
        // foreground row above, and a migration that had dropped the profile
        // would show up as the canary contents arriving in `read`.
      } finally {
        jobManager.killAll();
        f.cleanup();
      }
    },
    60_000,
  );

  itOnDarwin(
    "npm lifecycle script: the child's child is still confined",
    async () => {
      const f = fixture();
      try {
        // A package script rather than a direct interpreter call: npm is a
        // child of the shell and the script is a child of npm, so this is the
        // path a malicious dependency would actually take. npm also needs its
        // cache (~/.npm is a workspace-write carve-out); the control proves
        // npm itself works uninhibited here.
        const writeFixture = (name: string) => {
          writeFileSync(
            join(f.ws, "package.json"),
            JSON.stringify({
              name: "nib-childpaths-fixture",
              version: "1.0.0",
              private: true,
              scripts: { probe: `node probe-${name}.js` },
            }),
          );
          writeFileSync(join(f.ws, `probe-${name}.js`), probeSource(f, reportPath(f, name), true) + "\n");
        };

        writeFixture("npm-control");
        const control = await runBashTimed("npm run --silent probe", f.ws, f.ws, 30_000, false);
        expect(control.content).toContain("PROBE-OK");
        const controlResult = await readReport(reportPath(f, "npm-control"));

        writeFixture("npm");
        const contained = await runBashTimed("npm run --silent probe", f.ws, f.ws, 30_000, false, "workspace-write");
        expect(contained.content).toContain("PROBE-OK");
        expectContained(controlResult, await readReport(reportPath(f, "npm")));
      } finally {
        f.cleanup();
      }
    },
    120_000,
  );

  itOnDarwin(
    "local stdio MCP server: the handshake works, the canary and hooks do not",
    async () => {
      const f = fixture();
      try {
        // A minimal stdio server: probe on startup, then answer the JSON-RPC
        // handshake. `announce: false` because a real stdio server must keep
        // stdout to the protocol — the allowed operation here is the
        // `tools/list` round trip, not a printed line.
        const writeServer = (name: string) => {
          const script = join(f.ws, `mcp-${name}.cjs`);
          writeFileSync(
            script,
            probeSource(f, reportPath(f, name), false) +
              `
let buf = "";
function reply(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
}
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf("\\n")) !== -1) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.method === "initialize") {
      reply(msg.id, { protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "probe", version: "1" } });
    } else if (msg.method === "tools/list") {
      reply(msg.id, { tools: [] });
    }
  }
});
`,
          );
          return script;
        };

        const runServer = async (name: string, sandboxLevel?: "workspace-write") => {
          const client = new MCPClient();
          try {
            await client.connect(process.execPath, [writeServer(name)], undefined, {
              cwd: f.ws,
              trustedRoot: f.ws,
              ...(sandboxLevel ? { sandboxLevel } : {}),
            });
            // The allowed ordinary operation: a real request/response cycle.
            expect(await client.listTools()).toEqual([]);
            return await readReport(reportPath(f, name));
          } finally {
            client.disconnect();
          }
        };

        const control = await runServer("mcp-control");
        const contained = await runServer("mcp", "workspace-write");
        expectContained(control, contained);
      } finally {
        f.cleanup();
      }
    },
    60_000,
  );

  itOnDarwin(
    "lifecycle hook: the hook command is confined and its stdout still reaches context",
    async () => {
      const f = fixture();
      try {
        const config = parseHooksConfig(
          {
            PostToolUse: [{ command: `${probeCommand(f, reportPath(f, "hook"))}; echo HOOK-OK` }],
          },
          undefined,
          "test",
          [],
        );
        if (!config) throw new Error("parseHooksConfig returned undefined");

        const runner = new HookRunner({
          config,
          cwd: f.ws,
          sessionId: () => "s",
          getPermissionMode: () => "normal",
          timeoutMs: 30_000,
          sandboxLevel: "workspace-write",
        });
        const result = await runner.dispatch("PostToolUse", { tool_name: "run_bash", tool_input: {} });
        // PostToolUse stdout is context: it must still arrive (wrapped in the
        // untrusted-content delimiters) or the hook is useless.
        expect(result.blocked).toBe(false);
        expect(result.stdout).toContain("PROBE-OK");
        expect(result.stdout).toContain("HOOK-OK");

        const contained = await readReport(reportPath(f, "hook"));
        expect(contained.read).toBe("DENIED");
        expect(contained.hook).toBe("DENIED");

        // Direction 2: the same hook with no level. A fresh runner, because
        // sandboxLevel is read at construction.
        const controlConfig = parseHooksConfig(
          { PostToolUse: [{ command: probeCommand(f, reportPath(f, "hook-control")) }] },
          undefined,
          "test",
          [],
        );
        const controlRunner = new HookRunner({
          config: controlConfig!,
          cwd: f.ws,
          sessionId: () => "s",
          getPermissionMode: () => "normal",
          timeoutMs: 30_000,
        });
        await controlRunner.dispatch("PostToolUse", { tool_name: "run_bash", tool_input: {} });
        const control = await readReport(reportPath(f, "hook-control"));
        expect(control.read).toBe(CANARY_SEEN);
        expect(control.hook).toBe("WROTE");
      } finally {
        f.cleanup();
      }
    },
    90_000,
  );

  itOnDarwin(
    "statusline provider command: denied reads reject, ordinary commands resolve",
    async () => {
      const f = fixture();
      try {
        const controlReport = reportPath(f, "statusline-control");
        const control = await defaultCommandRunner(probeCommand(f, controlReport), {
          timeoutMs: 30_000,
          cwd: f.ws,
          trustedRoot: f.ws,
        });
        expect(control).toContain("PROBE-OK");

        const report = reportPath(f, "statusline");
        const contained = await defaultCommandRunner(probeCommand(f, report), {
          timeoutMs: 30_000,
          cwd: f.ws,
          trustedRoot: f.ws,
          sandboxLevel: "workspace-write",
        });
        expect(contained).toContain("PROBE-OK");
        expectContained(await readReport(controlReport), await readReport(report));
      } finally {
        f.cleanup();
      }
    },
    60_000,
  );

  itOnDarwin(
    "notification script: fire-and-forget, still confined",
    async () => {
      const f = fixture();
      try {
        // The notify contract spawns the configured script directly with
        // argv=[] and shell:false, so the fixture is an executable script
        // rather than an argument list.
        const writeScript = (name: string) => {
          const script = join(f.ws, `notify-${name}.sh`);
          writeFileSync(script, `#!/bin/sh\n${probeCommand(f, reportPath(f, name))}\n`);
          chmodSync(script, 0o755);
          return script;
        };
        const input = { status: "completed" as const, durationMs: 1000, body: "b", title: "t" };

        fireNotify(writeScript("notify-control"), input);
        const control = await readReport(reportPath(f, "notify-control"));

        fireNotify(writeScript("notify"), input, {
          spawn: { cwd: f.ws, trustedRoot: f.ws, sandboxLevel: "workspace-write" },
        });
        const contained = await readReport(reportPath(f, "notify"));
        expectContained(control, contained);
      } finally {
        f.cleanup();
      }
    },
    60_000,
  );
});

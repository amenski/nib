import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runBashTimed } from "../tools/bash.js";
import { sandboxPrefix } from "./seatbelt.js";

const itOnDarwin = it.skipIf(process.platform !== "darwin");

function shellQuote(path: string): string {
  return `'${path.replace(/'/g, "'\\''")}'`;
}

describe("Seatbelt application failure (macOS)", () => {
  itOnDarwin("does not run a command without its profile when nesting is refused", async (ctx) => {
    const root = mkdtempSync(join(tmpdir(), "nib-sandbox-apply-check-"));
    const scratch = join(root, "scratch");
    mkdirSync(scratch);
    const controlMarker = join(root, "control-marker");
    const containedMarker = join(root, "contained-marker");
    const handlerMarker = join(root, "handler-marker");

    try {
      const control = spawnSync("/bin/sh", ["-c", `touch ${shellQuote(controlMarker)}`], {
        cwd: root, encoding: "utf8", timeout: 5000,
      });
      expect(control.status).toBe(0);
      expect(existsSync(controlMarker)).toBe(true);

      const spec = sandboxPrefix(`touch ${shellQuote(containedMarker)}`, root, root, "workspace-write", [], scratch);
      expect(spec?.file).toBe("/usr/bin/sandbox-exec");
      const contained = spawnSync(spec!.file, spec!.args, { cwd: root, encoding: "utf8", timeout: 5000 });
      if (contained.status === 0) {
        expect(existsSync(containedMarker)).toBe(true);
        ctx.skip("This runner permits nested Seatbelt; the failure branch needs a restricted runner");
        return;
      }

      expect(contained.stderr).toContain("sandbox_apply: Operation not permitted");
      expect(existsSync(containedMarker)).toBe(false);

      const output = await runBashTimed(`touch ${shellQuote(handlerMarker)}`, root, root, 5000, false, "workspace-write", [], scratch);
      expect(existsSync(handlerMarker)).toBe(false);
      expect(output.content).toContain("sandbox_apply: Operation not permitted");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 15_000);
});

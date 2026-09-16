import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { projectSettingsPath } from "../config/paths.js";
import { homedir, tmpdir } from "node:os";
import { PermissionEngine, type PermissionRule } from "./engine.js";

function rule(partial: Partial<PermissionRule>): PermissionRule {
  return { tool: "run_bash", kind: "any", pattern: "", action: "allow", origin: "config", ...partial };
}

describe("PermissionEngine.resolve", () => {
  let engine: PermissionEngine;

  beforeEach(() => {
    engine = new PermissionEngine(undefined, "/workspace");
  });

  describe("default posture with no config on disk", () => {
    it("asks for an unrecognized tool with no matching rules, even though defaultMode is askAll", () => {
      expect(engine.resolve("unknown_tool", {}).action).toBe("ask");
    });

    it("allows a plain in-repo read_file call by default (reads inside the working tree are free)", () => {
      expect(engine.resolve("read_file", { path: "/workspace/src/main.ts" }).action).toBe("allow");
    });

    it("still asks for a read_file call outside the working tree by default", () => {
      expect(engine.resolve("read_file", { path: "/etc/passwd" }).action).toBe("ask");
    });

    it("asks for run_bash by default", () => {
      expect(engine.resolve("run_bash", { command: "git status" }).action).toBe("ask");
    });

    it("fails closed when apply_patch has an escaped target", () => {
      const result = engine.resolve("apply_patch", { patch: "+++ b/../outside.txt\n@@ -1 +1 @@\n-x\n+y" });

      expect(result.action).toBe("ask");
      expect(result.wasUnresolved).toBe(true);
    });
  });

  describe("builtin-allow: free read-only access inside the working tree", () => {
    it("allows read_file, list_files, glob, and search inside the repo with no config", () => {
      expect(engine.resolve("read_file", { path: "/workspace/src/a.ts" }).action).toBe("allow");
      expect(engine.resolve("list_files", { path: "/workspace/src" }).action).toBe("allow");
      expect(engine.resolve("glob", { path: "**/*.ts" }).action).toBe("allow");
      expect(engine.resolve("search", { path: "TODO" }).action).toBe("allow");
    });

    it("does not extend the free-read fallback to write_to_file or edit", () => {
      expect(engine.resolve("write_to_file", { path: "/workspace/src/a.ts" }).action).toBe("ask");
      expect(engine.resolve("edit", { path: "/workspace/src/a.ts" }).action).toBe("ask");
    });

    it("still asks for reads outside the working tree", () => {
      expect(engine.resolve("read_file", { path: "/etc/passwd" }).action).toBe("ask");
      expect(engine.resolve("list_files", { path: "/etc" }).action).toBe("ask");
    });

    it("a user deny rule still overrides the free-read fallback (real match pre-empts it)", () => {
      engine = new PermissionEngine(
        { rules: [{ tool: "read_file", kind: "glob", pattern: "./secret/**", action: "deny", origin: "config" }] },
        "/workspace",
      );
      expect(engine.resolve("read_file", { path: "/workspace/secret/x.ts" }).action).toBe("deny");
      // other in-repo reads remain free
      expect(engine.resolve("read_file", { path: "/workspace/src/a.ts" }).action).toBe("allow");
    });
  });

  describe("explicit config precedence", () => {
    it("honors an explicit empty rules array verbatim (asks for everything except the free in-repo reads)", () => {
      engine = new PermissionEngine({ rules: [] }, "/workspace");
      // An empty config still asks for state-changing tools...
      expect(engine.resolve("run_bash", { command: "git status" }).action).toBe("ask");
      // ...but in-repo reads remain free via the builtin-allow fallback.
      expect(engine.resolve("read_file", { path: "/workspace/src/main.ts" }).action).toBe("allow");
    });

    it("an allow rule for a specific tool makes that call resolve to allow", () => {
      engine = new PermissionEngine({ rules: [rule({ tool: "run_bash", kind: "any", action: "allow" })] }, "/workspace");
      expect(engine.resolve("run_bash", { command: "git status" }).action).toBe("allow");
    });

    it("an ask rule resolves to ask even with defaultMode allowAll", () => {
      engine = new PermissionEngine(
        { rules: [rule({ tool: "run_bash", kind: "any", action: "ask" })], defaultMode: "allowAll" },
        "/workspace",
      );
      expect(engine.resolve("run_bash", { command: "git status" }).action).toBe("ask");
    });

    it("defaultMode allowAll allows a tool that has at least one rule configured, when no rule matches this specific call", () => {
      engine = new PermissionEngine(
        { rules: [rule({ tool: "run_bash", kind: "exact", pattern: "npm test", action: "allow" })], defaultMode: "allowAll" },
        "/workspace",
      );
      const result = engine.resolve("run_bash", { command: "git status" });
      expect(result.action).toBe("allow");
    });

    it("defaultMode allowAll still asks for a tool with zero configured rules anywhere (unrecognized-tool safety net)", () => {
      engine = new PermissionEngine({ rules: [rule({ tool: "read_file" })], defaultMode: "allowAll" }, "/workspace");
      expect(engine.resolve("run_bash", { command: "git status" }).action).toBe("ask");
    });
  });

  describe("deny wins by default across kinds (not by raw specificity)", () => {
    it("a narrow prefix deny beats a blanket glob allow (first-draft inversion regression)", () => {
      engine = new PermissionEngine(
        {
          rules: [
            rule({ tool: "read_file", kind: "glob", pattern: "**", action: "allow" }),
            rule({ tool: "read_file", kind: "prefix", pattern: "/etc", action: "deny" }),
          ],
        },
        "/workspace",
      );
      const result = engine.resolve("read_file", { path: "/etc/passwd" });
      expect(result.action).toBe("deny");
    });

    it("a global any-kind deny kill-switch wins over any allow rule (second-draft inversion regression)", () => {
      engine = new PermissionEngine(
        {
          rules: [
            rule({ tool: "*", kind: "any", action: "deny" }),
            rule({ tool: "run_bash", kind: "exact", pattern: "git status", action: "allow" }),
          ],
        },
        "/workspace",
      );
      const result = engine.resolve("run_bash", { command: "git status" });
      expect(result.action).toBe("deny");
    });

    it("a strictly-more-specific allow can override a deny", () => {
      engine = new PermissionEngine(
        {
          rules: [
            rule({ tool: "run_bash", kind: "prefix", pattern: "curl", action: "deny" }),
            rule({ tool: "run_bash", kind: "prefix", pattern: "curl https://api.internal.corp", action: "allow" }),
          ],
        },
        "/workspace",
      );
      const result = engine.resolve("run_bash", { command: "curl https://api.internal.corp/health" });
      expect(result.action).toBe("allow");
    });

    it("an equally-broad allow does NOT override a deny (tie goes to deny)", () => {
      engine = new PermissionEngine(
        {
          rules: [
            rule({ tool: "run_bash", kind: "prefix", pattern: "curl", action: "deny" }),
            rule({ tool: "run_bash", kind: "prefix", pattern: "curl", action: "allow" }),
          ],
        },
        "/workspace",
      );
      const result = engine.resolve("run_bash", { command: "curl https://example.com" });
      expect(result.action).toBe("deny");
    });

    it("ask likewise wins by default over an equally-broad allow", () => {
      engine = new PermissionEngine(
        {
          rules: [
            rule({ tool: "run_bash", kind: "prefix", pattern: "npm", action: "ask" }),
            rule({ tool: "run_bash", kind: "prefix", pattern: "npm", action: "allow" }),
          ],
        },
        "/workspace",
      );
      expect(engine.resolve("run_bash", { command: "npm test" }).action).toBe("ask");
    });
  });

  describe("run_bash: per-segment resolution and normalization", () => {
    it("resolves a compound command as deny if any segment denies", () => {
      engine = new PermissionEngine(
        {
          rules: [
            rule({ tool: "run_bash", kind: "prefix", pattern: "git status", action: "allow" }),
            rule({ tool: "run_bash", kind: "prefix", pattern: "rm -rf", action: "deny" }),
          ],
        },
        "/workspace",
      );
      const result = engine.resolve("run_bash", { command: "git status && rm -rf /tmp/x" });
      expect(result.action).toBe("deny");
    });

    it("resolves a compound command as ask if any segment asks and none deny", () => {
      engine = new PermissionEngine(
        {
          rules: [
            rule({ tool: "run_bash", kind: "prefix", pattern: "git status", action: "allow" }),
            rule({ tool: "run_bash", kind: "prefix", pattern: "npm", action: "ask" }),
          ],
        },
        "/workspace",
      );
      const result = engine.resolve("run_bash", { command: "git status && npm test" });
      expect(result.action).toBe("ask");
    });

    it("resolves a compound command as allow only when every segment allows", () => {
      engine = new PermissionEngine(
        {
          rules: [
            rule({ tool: "run_bash", kind: "prefix", pattern: "git status", action: "allow" }),
            rule({ tool: "run_bash", kind: "prefix", pattern: "npm test", action: "allow" }),
          ],
        },
        "/workspace",
      );
      const result = engine.resolve("run_bash", { command: "git status && npm test" });
      expect(result.action).toBe("allow");
    });

    it("flags sudo as unresolved-ask (privilege escalation always prompts)", () => {
      engine = new PermissionEngine(
        { rules: [rule({ tool: "run_bash", kind: "exact", pattern: "npm test", action: "allow" })] },
        "/workspace",
      );
      // sudo is now detected by isUnresolved before stripSudo, so even a
      // harmless sudo npm test prompts — privilege escalation is always ask.
      const result = engine.resolve("run_bash", { command: "sudo npm test" });
      expect(result.action).toBe("ask");
      expect(result.wasUnresolved).toBe(true);
    });
  });

  describe("run_bash: unresolved-ask fail-closed", () => {
    it("env-wrapped destructive commands resolve to ask (not silently denied nor allowed)", () => {
      engine = new PermissionEngine({ rules: [], defaultMode: "allowAll" }, "/workspace");
      const result = engine.resolve("run_bash", { command: "env rm -rf ~/projects" });
      expect(result.action).toBe("ask");
      expect(result.wasUnresolved).toBe(true);
    });

    it("inline command substitution resolves to ask", () => {
      const result = engine.resolve("run_bash", { command: "echo $(rm -rf ~)" });
      expect(result.action).toBe("ask");
      expect(result.wasUnresolved).toBe(true);
    });

    it("find -exec resolves to ask", () => {
      const result = engine.resolve("run_bash", { command: "find . -exec rm -rf {} \\;" });
      expect(result.action).toBe("ask");
      expect(result.wasUnresolved).toBe(true);
    });

    it("xargs resolves to ask", () => {
      const result = engine.resolve("run_bash", { command: "echo file | xargs rm" });
      expect(result.action).toBe("ask");
      expect(result.wasUnresolved).toBe(true);
    });

    it("an ordinary resolvable ask (no unresolved construct) is NOT flagged wasUnresolved", () => {
      const result = engine.resolve("run_bash", { command: "git status" });
      expect(result.action).toBe("ask");
      expect(result.wasUnresolved).toBe(false);
    });

    it("a failed bash -c unwrap resolves to ask with wasUnresolved true", () => {
      const result = engine.resolve("run_bash", { command: "bash -c 'echo $(whoami)'" });
      expect(result.action).toBe("ask");
      expect(result.wasUnresolved).toBe(true);
    });
  });

  describe("destructive tier", () => {
    it("denies rm -rf / by default with no config at all", () => {
      expect(engine.resolve("run_bash", { command: "rm -rf / --no-preserve-root" }).action).toBe("deny");
    });

    it("applies the same destructive policy to background Bash", () => {
      expect(engine.resolve("run_bash_background", { command: "rm -rf / --no-preserve-root" }).action).toBe("deny");
    });

    it("denies git push --force by default", () => {
      expect(engine.resolve("run_bash", { command: "git push --force origin main" }).action).toBe("deny");
    });

    it("a strictly-more-specific user allow overrides a destructive deny", () => {
      engine = new PermissionEngine(
        { rules: [rule({ tool: "run_bash", kind: "prefix", pattern: "git reset --hard HEAD~1", action: "allow" })] },
        "/workspace",
      );
      expect(engine.resolve("run_bash", { command: "git reset --hard HEAD~1" }).action).toBe("allow");
    });

    it("an equally-broad user allow does NOT override a destructive deny", () => {
      engine = new PermissionEngine(
        { rules: [rule({ tool: "run_bash", kind: "prefix", pattern: "git reset --hard", action: "allow" })] },
        "/workspace",
      );
      expect(engine.resolve("run_bash", { command: "git reset --hard HEAD~1" }).action).toBe("deny");
    });

    it("approveAlways forces kind exact when narrowing a destructive-origin match", () => {
      const dir = mkdtempSync(join(tmpdir(), "nib-engine-destructive-always-"));
      try {
        const scopedEngine = new PermissionEngine(undefined, dir);
        const destructiveMatch = rule({ tool: "run_bash", kind: "prefix", pattern: "git reset --hard", origin: "builtin-destructive", action: "deny" });
        scopedEngine.approveAlways(
          rule({ tool: "run_bash", kind: "prefix", pattern: "git reset --hard HEAD~1", action: "allow" }),
          destructiveMatch,
        );
        const result = scopedEngine.resolve("run_bash", { command: "git reset --hard HEAD~1" });
        expect(result.action).toBe("allow");
        expect(result.winningRule?.kind).toBe("exact");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("approveForSession forces kind exact when narrowing a destructive-origin match", () => {
      const destructiveMatch = rule({ tool: "run_bash", kind: "prefix", pattern: "git reset --hard", origin: "builtin-destructive", action: "deny" });
      engine.approveForSession(
        rule({ tool: "run_bash", kind: "prefix", pattern: "git reset --hard HEAD~1", action: "allow" }),
        destructiveMatch,
      );
      const result = engine.resolve("run_bash", { command: "git reset --hard HEAD~1" });
      expect(result.action).toBe("allow");
      expect(result.winningRule?.kind).toBe("exact");
    });

    it("buildDefaultRule + narrowToExact only allows the specific approved command, not the broader prefix category", () => {
      // This is the real code path: handlePermissionDecision passes
      // buildDefaultRule (specific command) + the builtin match (narrowing
      // signal). The destructive deny should still block a different reset.
      // Use approveForSession to skip filesystem persistence (this engine
      // has workingDir "/workspace" which doesn't exist on disk).
      const destructiveMatch = rule({ tool: "run_bash", kind: "prefix", pattern: "git reset --hard", origin: "builtin-destructive", action: "deny" });
      engine.approveForSession(
        engine.buildDefaultRule("run_bash", { command: "git reset --hard HEAD~1" }),
        destructiveMatch,
      );
      // The exact approved command is allowed
      expect(engine.resolve("run_bash", { command: "git reset --hard HEAD~1" }).action).toBe("allow");
      // A slightly different command still resolves to deny (not blanket-allowed)
      expect(engine.resolve("run_bash", { command: "git reset --hard HEAD~2" }).action).toBe("deny");
    });
  });

  describe("session tier: not persisted to disk", () => {
    let dir: string;

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), "nib-engine-session-"));
      engine = new PermissionEngine(undefined, dir);
    });

    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    it("approveForSession takes effect immediately in-memory", () => {
      engine.approveForSession(rule({ tool: "run_bash", kind: "exact", pattern: "npm test", action: "allow" }));
      expect(engine.resolve("run_bash", { command: "npm test" }).action).toBe("allow");
    });

    it("approveForSession never writes settings.json", () => {
      engine.approveForSession(rule({ tool: "run_bash", kind: "exact", pattern: "npm test", action: "allow" }));
      expect(existsSync(projectSettingsPath(dir))).toBe(false);
    });

    it("a fresh engine instance does not see a session-approved rule", () => {
      engine.approveForSession(rule({ tool: "run_bash", kind: "exact", pattern: "npm test", action: "allow" }));
      const fresh = new PermissionEngine(undefined, dir);
      expect(fresh.resolve("run_bash", { command: "npm test" }).action).toBe("ask");
    });
  });

  describe("folderScopeRule: offer whole-folder only on a second call of the same kind", () => {
    it("returns undefined for a tool that is neither a read nor a write/edit tool", () => {
      engine.approveForSession(rule({ tool: "run_bash", kind: "exact", pattern: "npm test", action: "allow" }));
      expect(engine.folderScopeRule("run_bash", { path: "./src/b.ts" })).toBeUndefined();
    });

    it("returns undefined when no sibling read is approved yet (first read)", () => {
      expect(engine.folderScopeRule("read_file", { path: "./src/a.ts" })).toBeUndefined();
    });

    it("returns a recursive folder glob once a sibling exact read is approved", () => {
      engine.approveForSession(rule({ tool: "read_file", kind: "exact", pattern: "./src/a.ts", action: "allow" }));
      const folderRule = engine.folderScopeRule("read_file", { path: "./src/b.ts" });
      expect(folderRule).toEqual({
        tool: "read_file",
        kind: "glob",
        pattern: "./src/**",
        action: "allow",
        origin: "config",
      });
    });

    it("does not offer the folder when the only prior approval is the same file", () => {
      engine.approveForSession(rule({ tool: "read_file", kind: "exact", pattern: "./src/a.ts", action: "allow" }));
      expect(engine.folderScopeRule("read_file", { path: "./src/a.ts" })).toBeUndefined();
    });

    it("does not offer the folder for a sibling approval in a different folder", () => {
      engine.approveForSession(rule({ tool: "read_file", kind: "exact", pattern: "./lib/a.ts", action: "allow" }));
      expect(engine.folderScopeRule("read_file", { path: "./src/b.ts" })).toBeUndefined();
    });

    it("returns undefined for an external path", () => {
      engine.approveForSession(rule({ tool: "read_file", kind: "exact", pattern: "/etc/a.conf", action: "allow" }));
      expect(engine.folderScopeRule("read_file", { path: "/etc/b.conf" })).toBeUndefined();
    });

    it("normalizes the incoming path spelling before comparing folders", () => {
      engine.approveForSession(rule({ tool: "read_file", kind: "exact", pattern: "./src/a.ts", action: "allow" }));
      // "src/b.ts" (no leading ./) must normalize to the same folder as "./src/a.ts"
      const folderRule = engine.folderScopeRule("read_file", { path: "src/b.ts" });
      expect(folderRule?.pattern).toBe("./src/**");
    });

    it("returns a recursive folder glob for a write tool once a sibling exact write is approved", () => {
      engine.approveForSession(rule({ tool: "write_to_file", kind: "exact", pattern: "./src/a.ts", action: "allow" }));
      const folderRule = engine.folderScopeRule("write_to_file", { path: "./src/b.ts" });
      expect(folderRule).toEqual({
        tool: "write_to_file",
        kind: "glob",
        pattern: "./src/**",
        action: "allow",
        origin: "config",
      });
    });

    it("does not offer a write folder grant when the only sibling approval is a READ in that folder", () => {
      engine.approveForSession(rule({ tool: "read_file", kind: "exact", pattern: "./src/a.ts", action: "allow" }));
      expect(engine.folderScopeRule("write_to_file", { path: "./src/b.ts" })).toBeUndefined();
    });

    it("returns undefined for a write tool with an external (non-\"./\") path", () => {
      engine.approveForSession(rule({ tool: "write_to_file", kind: "exact", pattern: "/etc/a.conf", action: "allow" }));
      expect(engine.folderScopeRule("write_to_file", { path: "/etc/b.conf" })).toBeUndefined();
    });

    it("returns undefined for the first write in a folder (no sibling write approval yet)", () => {
      expect(engine.folderScopeRule("write_to_file", { path: "./src/a.ts" })).toBeUndefined();
    });
  });

  describe("externalTreeRule: offer subfolders for an external read approval", () => {
    it("returns a recursive tree glob for an external read path", () => {
      expect(engine.externalTreeRule("read_file", { path: "/data/notes/a.md" })).toEqual({
        tool: "read_file",
        kind: "glob",
        pattern: "/data/notes/**",
        action: "allow",
        origin: "config",
      });
    });

    it("returns undefined for an internal path", () => {
      expect(engine.externalTreeRule("read_file", { path: "./src/a.ts" })).toBeUndefined();
      expect(engine.externalTreeRule("read_file", { path: "/workspace/src/a.ts" })).toBeUndefined();
    });

    it("returns undefined for a write tool (an external write approval never broadens)", () => {
      expect(engine.externalTreeRule("edit", { path: "/data/notes/a.md" })).toBeUndefined();
      expect(engine.externalTreeRule("write_to_file", { path: "/data/notes/a.md" })).toBeUndefined();
    });

    it("returns undefined for a call with no path", () => {
      expect(engine.externalTreeRule("read_file", {})).toBeUndefined();
      expect(engine.externalTreeRule("read_file")).toBeUndefined();
      expect(engine.externalTreeRule("run_bash", { command: "npm test" })).toBeUndefined();
    });

    it("uses the subject directory itself as the base for glob (a dir-scoped tool)", () => {
      expect(engine.externalTreeRule("glob", { cwd: "/data/notes" })?.pattern).toBe("/data/notes/**");
    });

    it("approving the tree rule for the session covers files nested arbitrarily deep", () => {
      const treeRule = engine.externalTreeRule("read_file", { path: "/data/notes/a.md" })!;
      engine.approveForSession(treeRule);
      expect(engine.resolve("read_file", { path: "/data/notes/dxf-viewer/sessions.md" }).action).toBe("allow");
      expect(engine.resolve("read_file", { path: "/data/notes/a/b/c.md" }).action).toBe("allow");
    });

    it("the tree rule does not cover a sibling directory outside it", () => {
      engine.approveForSession(engine.externalTreeRule("read_file", { path: "/data/notes/a.md" })!);
      expect(engine.resolve("read_file", { path: "/data/other/a.md" }).action).toBe("ask");
    });

    it("the default rule still covers one directory level only", () => {
      engine.approveForSession(engine.buildDefaultRule("read_file", { path: "/data/notes/a.md" }));
      expect(engine.resolve("read_file", { path: "/data/notes/b.md" }).action).toBe("allow");
      expect(engine.resolve("read_file", { path: "/data/notes/dxf-viewer/sessions.md" }).action).toBe("ask");
    });
  });

  describe("always tier: atomic persistence", () => {
    let dir: string;

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), "nib-engine-always-"));
      engine = new PermissionEngine(undefined, dir);
    });

    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    it("approveAlways takes effect immediately in-memory, no reload needed", () => {
      engine.approveAlways(rule({ tool: "run_bash", kind: "exact", pattern: "npm test", action: "allow" }));
      expect(engine.resolve("run_bash", { command: "npm test" }).action).toBe("allow");
    });

    it("approveAlways writes settings.json with the new rules shape", () => {
      engine.approveAlways(rule({ tool: "run_bash", kind: "exact", pattern: "npm test", action: "allow" }));
      const settingsPath = projectSettingsPath(dir);
      expect(existsSync(settingsPath)).toBe(true);
      const written = JSON.parse(readFileSync(settingsPath, "utf-8"));
      expect(written.permissions.rules).toEqual([{ tool: "run_bash", pattern: "npm test", action: "allow" }]);
    });

    it("a fresh engine instance loaded from the persisted rules resolves the same way", () => {
      engine.approveAlways(rule({ tool: "run_bash", kind: "exact", pattern: "npm test", action: "allow" }));
      const settingsPath = projectSettingsPath(dir);
      const written = JSON.parse(readFileSync(settingsPath, "utf-8"));
      const reloaded = new PermissionEngine(
        { rules: written.permissions.rules.map((r: { tool: string; pattern: string; action: string }) => ({ ...r, kind: "exact", origin: "config" })) },
        dir,
      );
      expect(reloaded.resolve("run_bash", { command: "npm test" }).action).toBe("allow");
    });

    it("preserves unrelated top-level JSON keys already on disk", () => {
      engine.approveAlways(rule({ tool: "run_bash", kind: "exact", pattern: "npm test", action: "allow" }));
      const settingsPath = projectSettingsPath(dir);
      const first = JSON.parse(readFileSync(settingsPath, "utf-8"));
      first.someOtherKey = "preserved";
      writeFileSync(settingsPath, JSON.stringify(first, null, 2), "utf-8");

      engine.approveAlways(rule({ tool: "run_bash", kind: "exact", pattern: "git status", action: "allow" }));
      const second = JSON.parse(readFileSync(settingsPath, "utf-8"));
      expect(second.someOtherKey).toBe("preserved");
      expect(second.permissions.rules.length).toBe(2);
    });
  });

  describe("buildDefaultRule", () => {
    it("builds an exact-kind rule from the literal bash command", () => {
      const built = engine.buildDefaultRule("run_bash", { command: "npm test" });
      expect(built).toEqual({ tool: "run_bash", kind: "exact", pattern: "npm test", action: "allow", origin: "config" });
    });

    it("builds an exact-kind rule from a file path, normalized to working-dir-relative form", () => {
      const built = engine.buildDefaultRule("read_file", { path: "/workspace/secret.txt" });
      expect(built).toEqual({ tool: "read_file", kind: "exact", pattern: "./secret.txt", action: "allow", origin: "config" });
    });

    it("normalizes different spellings of the same path to one canonical form", () => {
      expect(engine.buildDefaultRule("read_file", { path: "src/main.ts" }).pattern).toBe("./src/main.ts");
      expect(engine.buildDefaultRule("read_file", { path: "./src/main.ts" }).pattern).toBe("./src/main.ts");
      expect(engine.buildDefaultRule("read_file", { path: "/workspace/src/main.ts" }).pattern).toBe("./src/main.ts");
    });

    it("approving the built default rule for session makes the exact same call resolve to allow", () => {
      const built = engine.buildDefaultRule("run_bash", { command: "npm test" });
      engine.approveForSession(built);
      expect(engine.resolve("run_bash", { command: "npm test" }).action).toBe("allow");
    });

    it("the built default rule does not broaden to a similar-but-different call", () => {
      const built = engine.buildDefaultRule("run_bash", { command: "npm test" });
      engine.approveForSession(built);
      expect(engine.resolve("run_bash", { command: "npm test -- --watch" }).action).toBe("ask");
    });

    it("does not let an empty extracted subject create a session-wide allow", () => {
      const built = engine.buildDefaultRule("run_bash_background", { command: "echo safe" });
      expect(built).toEqual({ tool: "run_bash_background", kind: "exact", pattern: "echo safe", action: "allow", origin: "config" });

      engine.approveForSession(built);

      expect(engine.resolve("run_bash_background", { command: "rm -rf ~/projects" }).action).toBe("deny");
    });

    it("does not persist an empty extracted subject as an allow rule", () => {
      const dir = mkdtempSync(join(tmpdir(), "nib-empty-rule-"));
      try {
        const scopedEngine = new PermissionEngine(undefined, dir);
        scopedEngine.approveAlways(scopedEngine.buildDefaultRule("apply_patch", { patch: "+++ b/../../outside" }));

        expect(existsSync(projectSettingsPath(dir))).toBe(false);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("does not persist a non-canonical file approval target", () => {
      const dir = mkdtempSync(join(tmpdir(), "nib-noncanonical-rule-"));
      try {
        const scopedEngine = new PermissionEngine(undefined, dir);
        scopedEngine.approveAlways({ tool: "read_file", kind: "exact", pattern: "src/main.ts", action: "allow", origin: "config" });

        expect(existsSync(projectSettingsPath(dir))).toBe(false);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("ignores a legacy empty extracted-subject allow rule on load", () => {
      engine = new PermissionEngine(
        { rules: [rule({ tool: "run_bash_background", kind: "exact", pattern: "", action: "allow" })] },
        "/workspace",
      );

      expect(engine.resolve("run_bash_background", { command: "rm -rf ~/projects" }).action).toBe("deny");
    });

    it("broadens an external path to a parent-directory glob", () => {
      const built = engine.buildDefaultRule("read_file", { path: "/etc/nginx/nginx.conf" });
      expect(built.kind).toBe("glob");
      expect(built.pattern).toBe("/etc/nginx/*");
    });

    it("broadens an existing internal directory to a recursive glob", () => {
      const dir = mkdtempSync(join(tmpdir(), "nib-buildrule-dir-"));
      try {
        // Create a subdirectory inside the working dir so it's internal
        const subdir = join(dir, "packages");
        mkdirSync(subdir);
        const scopedEngine = new PermissionEngine(undefined, dir);
        const built = scopedEngine.buildDefaultRule("read_file", { path: subdir });
        expect(built.kind).toBe("glob");
        expect(built.pattern).toBe("./packages/**");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("keeps an internal non-existent path as exact match (file, not directory)", () => {
      const built = engine.buildDefaultRule("read_file", { path: "src/nonexistent.ts" });
      expect(built.kind).toBe("exact");
      expect(built.pattern).toBe("./src/nonexistent.ts");
    });

    it("guarded narrowing still forces exact even when buildDefaultRule broadens to glob", () => {
      const dir = mkdtempSync(join(tmpdir(), "nib-buildrule-guarded-dir-"));
      try {
        // Create a subdirectory so buildDefaultRule would broaden to glob
        const subdir = join(dir, "config");
        mkdirSync(subdir);
        const envPath = join(subdir, ".env");
        const scopedEngine = new PermissionEngine(undefined, dir);
        const guardedMatch: PermissionRule = { tool: "read_file", kind: "glob", pattern: "**/.env*", action: "ask", origin: "builtin-guarded" };
        // buildDefaultRule broadens the subdir to glob, but narrowing forces exact on the .env path
        scopedEngine.approveAlways(scopedEngine.buildDefaultRule("read_file", { path: envPath }), guardedMatch);
        const result = scopedEngine.resolve("read_file", { path: envPath });
        expect(result.action).toBe("allow");
        expect(result.winningRule?.kind).toBe("exact");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe("web_fetch domain scoping", () => {
    it("asks for web_fetch by default with no config", () => {
      expect(engine.resolve("web_fetch", { url: "https://example.com/page" }).action).toBe("ask");
    });

    it("buildDefaultRule scopes to the hostname, not the full URL", () => {
      const built = engine.buildDefaultRule("web_fetch", { url: "https://example.com/some/deep/path?x=1" });
      expect(built).toEqual({ tool: "web_fetch", kind: "exact", pattern: "example.com", action: "allow", origin: "config" });
    });

    it("approving the built default rule for session allows any other path on the same domain", () => {
      const built = engine.buildDefaultRule("web_fetch", { url: "https://example.com/page-a" });
      engine.approveForSession(built);
      expect(engine.resolve("web_fetch", { url: "https://example.com/page-a" }).action).toBe("allow");
      expect(engine.resolve("web_fetch", { url: "https://example.com/totally/different/page" }).action).toBe("allow");
    });

    it("approving one domain does not approve a different domain", () => {
      const built = engine.buildDefaultRule("web_fetch", { url: "https://example.com/page" });
      engine.approveForSession(built);
      expect(engine.resolve("web_fetch", { url: "https://other.com/page" }).action).toBe("ask");
    });

    it("approving one subdomain does not approve a different subdomain", () => {
      const built = engine.buildDefaultRule("web_fetch", { url: "https://docs.example.com/page" });
      engine.approveForSession(built);
      expect(engine.resolve("web_fetch", { url: "https://example.com/page" }).action).toBe("ask");
      expect(engine.resolve("web_fetch", { url: "https://api.example.com/page" }).action).toBe("ask");
    });
  });

  describe("view_image domain scoping", () => {
    it("asks for view_image by default with no config", () => {
      expect(engine.resolve("view_image", { url: "https://example.com/cat.png" }).action).toBe("ask");
    });

    it("buildDefaultRule scopes to the hostname, not the full URL", () => {
      const built = engine.buildDefaultRule("view_image", { url: "https://example.com/a/b/cat.png?w=100" });
      expect(built).toEqual({ tool: "view_image", kind: "exact", pattern: "example.com", action: "allow", origin: "config" });
    });

    it("approving the built default rule for session allows other paths on the same domain", () => {
      const built = engine.buildDefaultRule("view_image", { url: "https://example.com/a.png" });
      engine.approveForSession(built);
      expect(engine.resolve("view_image", { url: "https://example.com/b.png" }).action).toBe("allow");
      expect(engine.resolve("view_image", { url: "https://other.com/b.png" }).action).toBe("ask");
    });

    it("keeps a view_image approval from leaking to web_fetch", () => {
      const built = engine.buildDefaultRule("view_image", { url: "https://example.com/a.png" });
      engine.approveForSession(built);
      expect(engine.resolve("web_fetch", { url: "https://example.com/page" }).action).toBe("ask");
    });

    it("scopes a local-path approval to the file path, not the hostname", () => {
      const built = engine.buildDefaultRule("view_image", { url: "/tmp/shots/a.png" });
      expect(built.pattern).toBe("/tmp/shots/a.png");

      engine.approveForSession(built);
      expect(engine.resolve("view_image", { url: "/tmp/shots/a.png" }).action).toBe("allow");
      expect(engine.resolve("view_image", { url: "/tmp/shots/b.png" }).action).toBe("ask");
    });

    it("asks by default for a local path with no config", () => {
      expect(engine.resolve("view_image", { url: "/tmp/shots/a.png" }).action).toBe("ask");
    });

    it("a local-path approval does not also allow a remote URL", () => {
      const built = engine.buildDefaultRule("view_image", { url: "/tmp/shots/a.png" });
      engine.approveForSession(built);
      expect(engine.resolve("view_image", { url: "https://example.com/a.png" }).action).toBe("ask");
    });
  });

  describe("web_search session approval", () => {
    it("allows subsequent queries after an explicit session approval", () => {
      const searchEngine = new PermissionEngine(undefined, "/tmp");
      const guarded = searchEngine.resolve("web_search", { query: "first query" }).winningRule!;
      const rule = searchEngine.buildDefaultRule("web_search", { query: "first query" });

      searchEngine.approveForSession(rule, guarded);

      expect(searchEngine.resolve("web_search", { query: "first query" }).action).toBe("allow");
      expect(searchEngine.resolve("web_search", { query: "a completely different query" }).action).toBe("allow");
    });

    it("does not create a session-wide exception for an always approval", () => {
      const searchEngine = new PermissionEngine(undefined, "/tmp");
      const guarded = searchEngine.resolve("web_search", { query: "first query" }).winningRule!;
      const rule = searchEngine.buildDefaultRule("web_search", { query: "first query" });

      searchEngine.approveAlways(rule, guarded);

      expect(searchEngine.resolve("web_search", { query: "a completely different query" }).action).toBe("ask");
    });
  });

  describe("glob rules against absolute paths (relativize-to-workingDir)", () => {
    it("a './**' glob rule matches a real absolute in-cwd path (this is what migrateLegacyPermissions emits for read-in-cwd)", () => {
      engine = new PermissionEngine(
        { rules: [{ tool: "read_file", kind: "glob", pattern: "./**", action: "allow", origin: "config" }] },
        "/workspace",
      );
      const result = engine.resolve("read_file", { path: "/workspace/src/main.ts" });
      expect(result.action).toBe("allow");
    });

    it("a './**' glob rule does not match a path outside workingDir", () => {
      engine = new PermissionEngine(
        { rules: [{ tool: "read_file", kind: "glob", pattern: "./**", action: "allow", origin: "config" }] },
        "/workspace",
      );
      const result = engine.resolve("read_file", { path: "/etc/passwd" });
      expect(result.action).toBe("ask");
    });

    it("a narrower './src/**' glob rule matches only paths under that subdirectory", () => {
      // Uses write_to_file, not read_file: in-repo reads are free via the
      // builtin-allow fallback, which would mask a narrow read glob's scoping.
      // write_to_file has no such fallback, so it isolates the glob semantics.
      engine = new PermissionEngine(
        { rules: [{ tool: "write_to_file", kind: "glob", pattern: "./src/**", action: "allow", origin: "config" }] },
        "/workspace",
      );
      expect(engine.resolve("write_to_file", { path: "/workspace/src/main.ts" }).action).toBe("allow");
      expect(engine.resolve("write_to_file", { path: "/workspace/docs/readme.md" }).action).toBe("ask");
    });
  });

  describe("path normalization: different spellings of the same path", () => {
    let dir: string;

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), "nib-engine-pathnorm-"));
      engine = new PermissionEngine(undefined, dir);
    });

    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    it("an exact-match rule approved with one spelling matches the same file via a different spelling", () => {
      // Approve with an absolute path
      const absPath = join(dir, "src/main.ts");
      engine.approveForSession(engine.buildDefaultRule("read_file", { path: absPath }));

      // Same file, different spellings — all should resolve to allow
      expect(engine.resolve("read_file", { path: absPath }).action).toBe("allow");
      expect(engine.resolve("read_file", { path: "src/main.ts" }).action).toBe("allow");
      expect(engine.resolve("read_file", { path: "./src/main.ts" }).action).toBe("allow");
    });

    it("an exact-match rule approved with a relative spelling matches absolute-path calls", () => {
      engine.approveForSession(engine.buildDefaultRule("read_file", { path: "./src/main.ts" }));

      const absPath = join(dir, "src/main.ts");
      expect(engine.resolve("read_file", { path: absPath }).action).toBe("allow");
      expect(engine.resolve("read_file", { path: "src/main.ts" }).action).toBe("allow");
    });

    it("normalizes persisted absolute-path rules on load (backward compat)", () => {
      // Simulate a pre-normalization persisted rule with an absolute pattern
      const absPath = join(dir, "src/main.ts");
      const oldRule: PermissionRule = {
        tool: "read_file", kind: "exact", pattern: absPath, action: "allow", origin: "config",
      };
      const reloaded = new PermissionEngine({ rules: [oldRule] }, dir);
      expect(reloaded.resolve("read_file", { path: "src/main.ts" }).action).toBe("allow");
      expect(reloaded.resolve("read_file", { path: "./src/main.ts" }).action).toBe("allow");
    });

    it("does not affect bash exact-match rules (resolvedPath is undefined for run_bash)", () => {
      engine.approveForSession(engine.buildDefaultRule("run_bash", { command: "npm test" }));
      expect(engine.resolve("run_bash", { command: "npm test" }).action).toBe("allow");
      // Only the exact command should match — no path normalization for bash
      expect(engine.resolve("run_bash", { command: "npm test -- --watch" }).action).toBe("ask");
    });
  });

  describe("guarded tier: secret-adjacent paths always ask, never silently auto-allow", () => {
    it("reading .env resolves to ask with isGuarded true, even with no config at all", () => {
      const result = engine.resolve("read_file", { path: "/workspace/.env" });
      expect(result.action).toBe("ask");
      expect(result.isGuarded).toBe(true);
    });

    it("an ordinary read (no guarded match) has isGuarded false", () => {
      const result = engine.resolve("read_file", { path: "/workspace/src/main.ts" });
      expect(result.isGuarded).toBe(false);
    });

    it("defaultMode allowAll does NOT silently allow a guarded path — ask still wins over the fallback", () => {
      engine = new PermissionEngine({ defaultMode: "allowAll", rules: [{ tool: "read_file", kind: "any", pattern: "", action: "allow", origin: "config" }] }, "/workspace");
      const result = engine.resolve("read_file", { path: "/workspace/.env" });
      expect(result.action).toBe("ask");
      expect(result.isGuarded).toBe(true);
    });

    it("the free in-repo read fallback does NOT allow a guarded path — .env still asks with no config at all", () => {
      // Regression guard for builtin-allow: the "./**" read fallback must be
      // pre-empted by the guarded .env match. If builtin-allow were ever
      // pooled with the specificity-ranked rules, its "./**" (specificity 51)
      // would out-rank the guarded "**/.env*" ask (specificity 6) and silently
      // allow reading secrets. This test fails loudly if that happens.
      const result = engine.resolve("read_file", { path: "/workspace/.env" });
      expect(result.action).toBe("ask");
      expect(result.isGuarded).toBe(true);
    });

    it("a strictly-more-specific user allow can still override a guarded ask (same override mechanics as any other ask-tier rule)", () => {
      engine = new PermissionEngine(
        { rules: [{ tool: "read_file", kind: "exact", pattern: "/workspace/.env", action: "allow", origin: "config" }] },
        "/workspace",
      );
      const result = engine.resolve("read_file", { path: "/workspace/.env" });
      expect(result.action).toBe("allow");
    });

    it("approveAlways on a guarded match forces kind exact, mirroring destructive narrowing", () => {
      const dir = mkdtempSync(join(tmpdir(), "nib-engine-guarded-"));
      try {
        const scopedEngine = new PermissionEngine(undefined, dir);
        const envPath = join(dir, ".env");
        const guardedMatch: PermissionRule = { tool: "read_file", kind: "glob", pattern: "**/.env*", action: "ask", origin: "builtin-guarded" };
        scopedEngine.approveAlways(scopedEngine.buildDefaultRule("read_file", { path: envPath }), guardedMatch);
        const result = scopedEngine.resolve("read_file", { path: envPath });
        expect(result.action).toBe("allow");
        expect(result.winningRule?.kind).toBe("exact");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("buildDefaultRule + guarded narrowToExact only allows the specific file, not the whole guarded glob category", () => {
      const dir = mkdtempSync(join(tmpdir(), "nib-engine-guarded-scope-"));
      try {
        const scopedEngine = new PermissionEngine(undefined, dir);
        const envPath = join(dir, ".env");
        const nestedEnvPath = join(dir, "subdir", ".env");
        const guardedMatch: PermissionRule = { tool: "read_file", kind: "glob", pattern: "**/.env*", action: "ask", origin: "builtin-guarded" };
        // Approve always on the root .env using buildDefaultRule (the real code path)
        scopedEngine.approveAlways(scopedEngine.buildDefaultRule("read_file", { path: envPath }), guardedMatch);
        // The exact approved file is allowed
        expect(scopedEngine.resolve("read_file", { path: envPath }).action).toBe("allow");
        // A different .env in a subdirectory still resolves to ask (not blanket-allowed)
        expect(scopedEngine.resolve("read_file", { path: nestedEnvPath }).action).toBe("ask");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});

// ── search/glob: dir-scoped path containment (closes the search exfiltration
// gap — search's `dir` and glob's `cwd` are now subject to the same
// path/glob rule matching and out-of-workspace containment as read_file's
// `path`, see PermissionEngine.FILE_TOOLS/DIR_SCOPED_TOOLS and
// outOfWorkspaceGuardedRule). ──
describe("PermissionEngine: search/glob directory containment", () => {
  let workDir: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "nib-engine-search-dir-"));
    mkdirSync(join(workDir, "src"), { recursive: true });
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it("ANTI-REGRESSION: a search inside the workspace resolves allow silently, no guarded/out-of-workspace match", () => {
    const engine = new PermissionEngine(undefined, workDir);
    const result = engine.resolve("search", { pattern: "TODO", dir: join(workDir, "src") });
    expect(result.action).toBe("allow");
    expect(result.isGuarded).toBe(false);
    expect(result.wasUnresolved).toBe(false);
  });

  it("ANTI-REGRESSION: a search with no dir (defaults to '.') inside the workspace resolves allow silently", () => {
    const engine = new PermissionEngine(undefined, workDir);
    const result = engine.resolve("search", { pattern: "TODO" });
    expect(result.action).toBe("allow");
    expect(result.isGuarded).toBe(false);
  });

  it("ANTI-REGRESSION: a glob inside the workspace resolves allow silently", () => {
    const engine = new PermissionEngine(undefined, workDir);
    const result = engine.resolve("glob", { pattern: "**/*.ts", cwd: join(workDir, "src") });
    expect(result.action).toBe("allow");
    expect(result.isGuarded).toBe(false);
  });

  it("a search with dir outside the workspace resolves ask, isGuarded true, exempt from allowAll", () => {
    const outside = mkdtempSync(join(tmpdir(), "nib-engine-search-outside-"));
    try {
      const engine = new PermissionEngine({ defaultMode: "allowAll" }, workDir);
      const result = engine.resolve("search", { pattern: "password", dir: outside });
      expect(result.action).toBe("ask");
      expect(result.isGuarded).toBe(true);
      expect(result.winningRule?.origin).toBe("builtin-guarded");
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("a glob with cwd outside the workspace resolves ask, isGuarded true", () => {
    const outside = mkdtempSync(join(tmpdir(), "nib-engine-glob-outside-"));
    try {
      const engine = new PermissionEngine(undefined, workDir);
      const result = engine.resolve("glob", { pattern: "**/*", cwd: outside });
      expect(result.action).toBe("ask");
      expect(result.isGuarded).toBe(true);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("a search with dir inside the workspace but pointing at a secret path (.ssh) resolves ask via the guarded glob", () => {
    const sshDir = join(workDir, ".ssh");
    mkdirSync(sshDir, { recursive: true });
    writeFileSync(join(sshDir, "id_rsa"), "fake key material\n");
    const engine = new PermissionEngine(undefined, workDir);

    // dir pointing at a file under .ssh
    const fileResult = engine.resolve("search", { pattern: "BEGIN", dir: join(sshDir, "id_rsa") });
    expect(fileResult.action).toBe("ask");
    expect(fileResult.isGuarded).toBe(true);

    // dir pointing at the .ssh directory itself
    const dirResult = engine.resolve("search", { pattern: "BEGIN", dir: sshDir });
    expect(dirResult.action).toBe("ask");
    expect(dirResult.isGuarded).toBe(true);
  });

  it("a search with dir inside the workspace pointing at a .env file's directory resolves ask via the guarded glob", () => {
    writeFileSync(join(workDir, ".env"), "SECRET=1\n");
    const engine = new PermissionEngine(undefined, workDir);
    const result = engine.resolve("search", { pattern: "SECRET", dir: join(workDir, ".env") });
    expect(result.action).toBe("ask");
    expect(result.isGuarded).toBe(true);
  });

  it("a symlink inside the workspace pointing outside it resolves ask (realpath containment, not lexical)", () => {
    const outside = mkdtempSync(join(tmpdir(), "nib-engine-search-symlink-target-"));
    try {
      writeFileSync(join(outside, "secret.txt"), "top secret\n");
      const link = join(workDir, "escape-link");
      symlinkSync(outside, link, "dir");

      const engine = new PermissionEngine({ defaultMode: "allowAll" }, workDir);
      // Lexically the path starts with workDir (it's "<workDir>/escape-link"),
      // so a lexical-only check would wrongly call this in-workspace. The
      // realpath resolution must see through the symlink to `outside`.
      const result = engine.resolve("search", { pattern: "secret", dir: link });
      expect(result.action).toBe("ask");
      expect(result.isGuarded).toBe(true);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("relative dir '.' resolves to the workspace root and stays a silent allow", () => {
    const engine = new PermissionEngine(undefined, workDir);
    const result = engine.resolve("search", { pattern: "TODO", dir: "." });
    expect(result.action).toBe("allow");
  });

  it("relative dir './src' resolves relative to workingDir and stays a silent allow", () => {
    const engine = new PermissionEngine(undefined, workDir);
    const result = engine.resolve("search", { pattern: "TODO", dir: "./src" });
    expect(result.action).toBe("allow");
  });

  it("relative dir '../..' escaping the workspace resolves ask", () => {
    // workingDir is <workDir>/a/b/c; "../../.." climbs 3 levels above it,
    // landing on tmpdir() itself — strictly outside workDir.
    const nested = join(workDir, "a", "b", "c");
    mkdirSync(nested, { recursive: true });
    const engine = new PermissionEngine(undefined, nested);
    const result = engine.resolve("search", { pattern: "TODO", dir: "../../.." });
    expect(result.action).toBe("ask");
    expect(result.isGuarded).toBe(true);
  });

  it("the blanket builtin allow (search: any) does not override a guarded secret-path match", () => {
    const sshDir = join(workDir, ".ssh");
    mkdirSync(sshDir, { recursive: true });
    // defaultMode allowAll would normally make an unmatched call free, but a
    // guarded match must still win — this is the precedence property the
    // task calls out explicitly: guarded/out-of-workspace beats blanket allow.
    const engine = new PermissionEngine({ defaultMode: "allowAll" }, workDir);
    const result = engine.resolve("search", { pattern: "x", dir: sshDir });
    expect(result.action).toBe("ask");
    expect(result.winningRule?.origin).toBe("builtin-guarded");
  });

  it("the blanket builtin allow (search: any) does not override the out-of-workspace synthetic guard", () => {
    const outside = mkdtempSync(join(tmpdir(), "nib-engine-search-precedence-"));
    try {
      const engine = new PermissionEngine({ defaultMode: "allowAll" }, workDir);
      const result = engine.resolve("search", { pattern: "x", dir: outside });
      expect(result.action).toBe("ask");
      expect(result.winningRule?.origin).toBe("builtin-guarded");
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("a user-authored allow rule for an out-of-workspace dir DOES resolve the out-of-workspace guard (BUG FIX: escape hatch, same as the write boundary)", () => {
    const outside = mkdtempSync(join(tmpdir(), "nib-engine-search-killswitch-"));
    try {
      const engine = new PermissionEngine(
        { rules: [{ tool: "search", kind: "exact", pattern: outside, action: "allow", origin: "config" }] },
        workDir,
      );
      const result = engine.resolve("search", { pattern: "x", dir: outside });
      // Previously outOfWorkspaceGuardedRule's kind:"any" was an absolute
      // kill-switch with no escape hatch, so a user-approved allow rule for
      // this exact dir could never take effect and the call asked forever.
      // The write boundary already had this escape hatch (a path-scoped
      // allow resolves the same dynamic guard it was approved from); the
      // out-of-workspace guard now gets the same treatment.
      expect(result.action).toBe("allow");
      expect(result.winningRule?.pattern).toBe(outside);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe("file-tool write boundary (docs/unified-write-boundary.md §2)", () => {
  const HOME = homedir();

  it("is inactive by default — existing call sites behave exactly as before", () => {
    const engine = new PermissionEngine(undefined, "/workspace");
    expect(engine.resolve("write_to_file", { path: "/workspace/src/a.ts" }).action).toBe("ask");
    expect(engine.resolve("write_to_file", { path: "/etc/hosts" }).action).toBe("ask");
  });

  it("workspace-write boundary: in-set targets resolve silently (no prompt)", () => {
    const engine = new PermissionEngine(undefined, "/workspace", false, { enforceWriteBoundary: true });
    expect(engine.resolve("write_to_file", { path: "/workspace/src/a.ts" }).action).toBe("allow");
    expect(engine.resolve("edit", { path: "/workspace/src/a.ts" }).action).toBe("allow");
    expect(engine.resolve("edit_file", { filePath: "/workspace/src/a.ts" }).action).toBe("allow");
  });

  it("workspace-write boundary: carve-outs (/tmp) are in the silent set", () => {
    const engine = new PermissionEngine(undefined, "/workspace", false, { enforceWriteBoundary: true });
    expect(engine.resolve("write_to_file", { path: "/tmp/x.txt" }).action).toBe("allow");
  });

  it("workspace-write boundary: out-of-set targets are a guarded ask — never silent, never hard-deny", () => {
    const engine = new PermissionEngine(undefined, "/workspace", false, { enforceWriteBoundary: true });
    const r = engine.resolve("write_to_file", { path: "/etc/hosts" });
    expect(r.action).toBe("ask");
    expect(r.isGuarded).toBe(true);

    // Posture cannot bypass it.
    const allowAll = new PermissionEngine({ defaultMode: "allowAll" }, "/workspace", false, { enforceWriteBoundary: true });
    expect(allowAll.resolve("write_to_file", { path: "/etc/hosts" }).action).toBe("ask");
  });

  it("session approval allows the same external edit after its initial guarded ask", () => {
    const engine = new PermissionEngine(undefined, "/workspace", false, { enforceWriteBoundary: true });
    const args = { path: "/etc/nib-session-edit.ts" };
    const initial = engine.resolve("edit", args);
    expect(initial.action).toBe("ask");
    expect(initial.isGuarded).toBe(true);

    engine.approveForSession(engine.buildDefaultRule("edit", args), initial.winningRule);

    const approved = engine.resolve("edit", args);
    expect(approved.action).toBe("allow");
    expect(approved.isGuarded).toBe(false);
    expect(engine.resolve("edit", { path: "/etc/nib-unapproved-edit.ts" }).action).toBe("ask");
  });

  it("always approval allows the same external edit after its initial guarded ask", () => {
    const dir = mkdtempSync(join(tmpdir(), "nib-engine-write-approval-"));
    try {
      const engine = new PermissionEngine(undefined, dir, false, { enforceWriteBoundary: true });
      const args = { path: "/etc/nib-always-edit.ts" };
      const initial = engine.resolve("edit", args);
      expect(initial.action).toBe("ask");
      expect(initial.isGuarded).toBe(true);

      engine.approveAlways(engine.buildDefaultRule("edit", args), initial.winningRule);

      const approved = engine.resolve("edit", args);
      expect(approved.action).toBe("allow");
      expect(approved.isGuarded).toBe(false);
      expect(engine.resolve("edit", { path: "/etc/nib-unapproved-edit.ts" }).action).toBe("ask");

      const settings = JSON.parse(readFileSync(projectSettingsPath(dir), "utf-8"));
      const reloaded = new PermissionEngine(
        { rules: settings.permissions.rules.map((r: { tool: string; pattern: string; action: string }) => ({ ...r, kind: "exact", origin: "config" })) },
        dir,
        false,
        { enforceWriteBoundary: true },
      );
      expect(reloaded.resolve("edit", args).action).toBe("allow");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("an unapproved out-of-set write remains a guarded ask", () => {
    const engine = new PermissionEngine(undefined, "/workspace", false, { enforceWriteBoundary: true });
    const r = engine.resolve("write_to_file", { path: "/etc/hosts" });
    expect(r.action).toBe("ask");
    expect(r.isGuarded).toBe(true);
  });

  it("an explicit deny rule still beats the in-set silent allow", () => {
    const engine = new PermissionEngine(
      { rules: [{ tool: "write_to_file", kind: "glob", pattern: "./secret/**", action: "deny", origin: "config" }] },
      "/workspace",
      false,
      { enforceWriteBoundary: true },
    );
    expect(engine.resolve("write_to_file", { path: "/workspace/secret/x.ts" }).action).toBe("deny");
    expect(engine.resolve("write_to_file", { path: "/workspace/src/a.ts" }).action).toBe("allow");
  });

  it("an explicit ask rule beats the in-set silent allow (secret-adjacent paths still prompt)", () => {
    const engine = new PermissionEngine(
      { rules: [{ tool: "write_to_file", kind: "glob", pattern: "./**/*.env", action: "ask", origin: "config" }] },
      "/workspace",
      false,
      { enforceWriteBoundary: true },
    );
    expect(engine.resolve("write_to_file", { path: "/workspace/.env" }).action).toBe("ask");
  });

  it("a global writeRoot widens the silent set (the SecondBrain case)", () => {
    const writeRoot = join(HOME, "SecondBrain", "AgentMemory");
    const without = new PermissionEngine(undefined, "/workspace", false, { enforceWriteBoundary: true });
    expect(without.resolve("write_to_file", { path: join(writeRoot, "x.md") }).action).toBe("ask");

    const withRoot = new PermissionEngine(undefined, "/workspace", false, {
      enforceWriteBoundary: true,
      writeRoots: ["~/SecondBrain/AgentMemory"],
    });
    expect(withRoot.resolve("write_to_file", { path: join(writeRoot, "x.md") }).action).toBe("allow");
  });

  it("an explicitly added root widens the silent set without allowing other external paths", () => {
    const root = mkdtempSync(join(tmpdir(), "wb-primary-"));
    const added = mkdtempSync(join(tmpdir(), "wb-added-"));
    try {
      const engine = new PermissionEngine(undefined, root, false, {
        enforceWriteBoundary: true,
        writeRoots: [added],
      });
      expect(engine.resolve("edit", { path: join(added, "src", "a.ts") }).action).toBe("allow");
      expect(engine.resolve("edit", { path: join(homedir(), "wb-unlisted", "a.ts") }).action).toBe("ask");
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(added, { recursive: true, force: true });
    }
  });

  it("a symlink inside the workspace escaping it is treated as out-of-set (realpath, not lexical)", () => {
    const dir = mkdtempSync(join(tmpdir(), "wb-escape-"));
    const link = join(dir, "escape");
    symlinkSync(HOME, link, "dir");
    try {
      const engine = new PermissionEngine(undefined, dir, false, { enforceWriteBoundary: true });
      const r = engine.resolve("write_to_file", { path: link });
      expect(r.action).toBe("ask");
      expect(r.isGuarded).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("agreement with the Seatbelt layer: a path the engine silently allows is one Seatbelt emits an allow-line for", () => {
    // docs/unified-write-boundary.md §2's central claim, asserted at the
    // engine level: the silent set IS resolveWriteRoots — the same set
    // buildSeatbeltProfile emits (subpath ...) allow-lines from. A target
    // inside the workspace root, a configured writeRoot, or a carve-out is
    // silently allowed here and shell-writable there; a genuinely external
    // path is neither (Seatbelt denies it; this asks).
    const root = mkdtempSync(join(tmpdir(), "wb-agree-"));
    const writeRoot = join(HOME, "SecondBrain", "AgentMemory");
    try {
      const engine = new PermissionEngine(undefined, root, false, {
        enforceWriteBoundary: true,
        writeRoots: ["~/SecondBrain/AgentMemory"],
      });
      expect(engine.resolve("write_to_file", { path: join(root, "a.ts") }).action).toBe("allow");
      expect(engine.resolve("write_to_file", { path: join(writeRoot, "x.md") }).action).toBe("allow");
      expect(engine.resolve("write_to_file", { path: join(tmpdir(), "y.txt") }).action).toBe("allow"); // $TMPDIR carve-out
      expect(engine.resolve("write_to_file", { path: join(HOME, "wb-out-probe", "z.txt") }).action).toBe("ask");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ── BUG FIX: external search/glob can now be approved (previously the
// out-of-workspace guard's kind:"any" was an absolute kill-switch with no
// escape hatch, so an approval never took effect and the same call asked
// forever). Also covers buildDefaultRule producing a real (non-empty-pattern)
// rule for search/glob, whose subject is a directory (`dir`/`cwd`), not
// `path`/`filePath`.
describe("BUG FIX: external search/glob approval takes effect", () => {
  let workDir: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "nib-engine-search-approve-"));
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it("buildDefaultRule('search', {dir}) produces a non-empty pattern for an external dir", () => {
    const engine = new PermissionEngine(undefined, workDir);
    const built = engine.buildDefaultRule("search", { dir: "/abs/external/dir" });
    expect(built.pattern).not.toBe("");
    expect(built.pattern).toBe("/abs/external/dir");
  });

  it("buildDefaultRule('glob', {cwd}) produces a non-empty pattern for an external dir", () => {
    const engine = new PermissionEngine(undefined, workDir);
    const built = engine.buildDefaultRule("glob", { cwd: "/abs/external/dir" });
    expect(built.pattern).not.toBe("");
    expect(built.pattern).toBe("/abs/external/dir");
  });

  it("session-approving an external search allows a subsequent identical search", () => {
    const outside = mkdtempSync(join(tmpdir(), "nib-engine-search-approve-target-"));
    try {
      const engine = new PermissionEngine(undefined, workDir);
      const args = { pattern: "TODO", dir: outside };

      const initial = engine.resolve("search", args);
      expect(initial.action).toBe("ask");
      expect(initial.isGuarded).toBe(true);

      engine.approveForSession(engine.buildDefaultRule("search", args), initial.winningRule);

      const approved = engine.resolve("search", args);
      expect(approved.action).toBe("allow");
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("always-approving an external glob allows a subsequent identical glob (and survives a reload)", () => {
    const outside = mkdtempSync(join(tmpdir(), "nib-engine-glob-approve-target-"));
    try {
      const engine = new PermissionEngine(undefined, workDir);
      const args = { pattern: "**/*", cwd: outside };

      const initial = engine.resolve("glob", args);
      expect(initial.action).toBe("ask");
      expect(initial.isGuarded).toBe(true);

      engine.approveAlways(engine.buildDefaultRule("glob", args), initial.winningRule);

      const approved = engine.resolve("glob", args);
      expect(approved.action).toBe("allow");

      const settings = JSON.parse(readFileSync(projectSettingsPath(workDir), "utf-8"));
      expect(settings.permissions.rules).toContainEqual(
        expect.objectContaining({ tool: "glob", action: "allow" }),
      );
      // Fossil regression: the persisted rule must not be the empty-pattern
      // junk buildDefaultRule used to emit for search/glob (BUG 3).
      expect(settings.permissions.rules[0].pattern).not.toBe("");

      const reloaded = new PermissionEngine(
        { rules: settings.permissions.rules.map((r: { tool: string; pattern: string; action: string }) => ({ ...r, kind: "exact", origin: "config" })) },
        workDir,
      );
      expect(reloaded.resolve("glob", args).action).toBe("allow");
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("static guarded rules (e.g. ~/.ssh) still ask after an approval attempt for a different external dir — kill-switch preserved", () => {
    const sshDir = join(workDir, ".ssh");
    mkdirSync(sshDir, { recursive: true });
    writeFileSync(join(sshDir, "id_rsa"), "fake key material\n");

    const outside = mkdtempSync(join(tmpdir(), "nib-engine-search-approve-other-"));
    try {
      const engine = new PermissionEngine(undefined, workDir);

      // Approve an unrelated external dir for session/always.
      const outsideArgs = { pattern: "x", dir: outside };
      const outsideInitial = engine.resolve("search", outsideArgs);
      engine.approveAlways(engine.buildDefaultRule("search", outsideArgs), outsideInitial.winningRule);
      expect(engine.resolve("search", outsideArgs).action).toBe("allow");

      // The static guarded .ssh rule is untouched — still asks, and cannot be
      // approved away (kind:"any" static rule, not the dynamic escape hatch).
      const sshArgs = { pattern: "x", dir: sshDir };
      const sshInitial = engine.resolve("search", sshArgs);
      expect(sshInitial.action).toBe("ask");
      engine.approveAlways(engine.buildDefaultRule("search", sshArgs), sshInitial.winningRule);
      expect(engine.resolve("search", sshArgs).action).toBe("ask");
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe("BUG FIX: persist() invokes onPersist with the settings path", () => {
  it("calls onPersist with the project settings.json path after a successful write", () => {
    const dir = mkdtempSync(join(tmpdir(), "nib-engine-onpersist-"));
    try {
      const calls: string[] = [];
      const engine = new PermissionEngine(undefined, dir, false, {
        onPersist: (settingsPath) => calls.push(settingsPath),
      });
      engine.approveAlways({ tool: "run_bash", kind: "exact", pattern: "echo hi", action: "allow", origin: "config" });
      expect(calls).toEqual([projectSettingsPath(dir)]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not throw and behaves as before when onPersist is not provided", () => {
    const dir = mkdtempSync(join(tmpdir(), "nib-engine-onpersist-absent-"));
    try {
      const engine = new PermissionEngine(undefined, dir);
      expect(() =>
        engine.approveAlways({ tool: "run_bash", kind: "exact", pattern: "echo hi", action: "allow", origin: "config" }),
      ).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── BUG FIX (App.tsx): approving a prompt whose winningRule was a
// non-builtin user-authored "ask" rule must not store that rule verbatim
// (action still "ask" — a no-op approval that re-prompts forever). The
// App.tsx fix now always calls buildDefaultRule for the actual approval
// instead of reusing winningRule; this engine-level test exercises the same
// principle: buildDefaultRule always returns an "allow" rule regardless of
// what matched, so App.tsx storing its result (rather than winningRule)
// resolves the call.
describe("BUG FIX: approving a non-builtin ask-rule match must produce an allow rule", () => {
  it("buildDefaultRule always returns action allow, never reusing a matched ask rule's action", () => {
    const engine = new PermissionEngine(
      { rules: [{ tool: "read_file", kind: "glob", pattern: "**/*.secret", action: "ask", origin: "config" }] },
      "/workspace",
    );
    const args = { path: "/workspace/x.secret" };
    const initial = engine.resolve("read_file", args);
    expect(initial.action).toBe("ask");
    expect(initial.winningRule?.action).toBe("ask");
    expect(initial.winningRule?.origin).toBe("config");

    // What App.tsx now stores on approval, instead of winningRule verbatim.
    const rule = engine.buildDefaultRule("read_file", args);
    expect(rule.action).toBe("allow");

    engine.approveForSession(rule);
    expect(engine.resolve("read_file", args).action).toBe("allow");
  });
});

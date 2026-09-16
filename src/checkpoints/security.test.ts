import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";

let TEST_HOME = "";

vi.mock("node:os", async (importOriginal) => {
  const orig = await importOriginal<typeof import("node:os")>();
  return {
    ...orig,
    homedir: () => TEST_HOME,
  };
});

describe("checkpoint secret handling", () => {
  let workspaceDir: string;

  async function chkptManager(): Promise<import("./index.js").CheckpointManager> {
    const mod = await import("./index.js");
    return new mod.CheckpointManager("test-session", workspaceDir);
  }

  function shadowGitDir(): string {
    return join(TEST_HOME, ".nib", "checkpoints", "test-session", ".git");
  }

  it("routes the shadow repo under an explicit home argument", async () => {
    const custom = join(TEST_HOME, "custom-home");
    const mod = await import("./index.js");
    const cm = new mod.CheckpointManager("test-session", workspaceDir, custom);
    await cm.save("msg");
    expect(existsSync(join(custom, "checkpoints", "test-session", ".git"))).toBe(true);
  });

  beforeEach(async () => {
    TEST_HOME = mkdtempSync(join(tmpdir(), "nib-chkpt-home-"));

    workspaceDir = mkdtempSync(join(tmpdir(), "nib-chkpt-workspace-"));

    execSync("git init", { cwd: workspaceDir, stdio: "pipe" });
    execSync('git config user.email "test@test.com"', { cwd: workspaceDir, stdio: "pipe" });
    execSync('git config user.name "Test"', { cwd: workspaceDir, stdio: "pipe" });

    writeFileSync(join(workspaceDir, ".gitignore"), ".env\nnode_modules/\n");
    writeFileSync(join(workspaceDir, ".env"), 'API_KEY="sk-test-secret-key"\n');
    writeFileSync(join(workspaceDir, "app.ts"), "console.log('hello');\n");

    execSync("git add .gitignore && git commit -m init", { cwd: workspaceDir, stdio: "pipe" });
    execSync("git add app.ts && git commit -m 'add app'", { cwd: workspaceDir, stdio: "pipe" });
  });

  afterEach(() => {
    rmSync(workspaceDir, { recursive: true, force: true });
    rmSync(TEST_HOME, { recursive: true, force: true });
  });

  it("does not include gitignored .env in checkpoint shadow repo", async () => {
    const mgr = await chkptManager();

    const hash = await mgr.save("pre-modify");
    expect(hash).toBeTruthy();

    const tracked = execSync(
      `git --git-dir="${shadowGitDir()}" ls-files`,
      { encoding: "utf-8", stdio: "pipe" },
    ).trim();
    const files = tracked.split("\n").filter(Boolean);

    expect(files).toContain(".gitignore");
    expect(files).toContain("app.ts");

    const envFiles = files.filter((f) => f === ".env" || f.includes(".env"));
    expect(envFiles).toHaveLength(0);
  });

  it("fixture: a gitignored .env is absent from the shadow repo (git ls-tree)", async () => {
    // security-spec T9 re-verify: the workspace .gitignore ignores .env, and
    // the shadow repo must never contain it.
    const mgr = await chkptManager();
    const hash = await mgr.save("fixture-gitignored");
    expect(hash).toBeTruthy();

    const tree = execSync(
      `git --git-dir="${shadowGitDir()}" ls-tree -r --name-only HEAD`,
      { encoding: "utf-8", stdio: "pipe" },
    ).trim();
    const files = tree.split("\n").filter(Boolean);

    expect(files).toContain(".gitignore");
    expect(files).toContain("app.ts");
    expect(files).not.toContain(".env");
  });

  it("fixture: with NO workspace .gitignore, .env is STILL excluded — the info/exclude backstop (T9 verified result)", async () => {
    // The T9 row previously claimed a .gitignore-less workspace would commit
    // .env into the shadow repo. Verified 2026-08-14: false for .env — the
    // shadow repo's own .git/info/exclude list (checkpoints/index.ts) covers
    // .env/.env.* and common secret names regardless of the workspace.
    rmSync(join(workspaceDir, ".gitignore"));
    execSync("git add -A && git commit -m 'remove gitignore'", {
      cwd: workspaceDir,
      stdio: "pipe",
    });

    const mgr = await chkptManager();
    const hash = await mgr.save("fixture-no-gitignore");
    expect(hash).toBeTruthy();

    const tree = execSync(
      `git --git-dir="${shadowGitDir()}" ls-tree -r --name-only HEAD`,
      { encoding: "utf-8", stdio: "pipe" },
    ).trim();
    const files = tree.split("\n").filter(Boolean);

    expect(files).toContain("app.ts");
    expect(files).not.toContain(".env");
  });

  it("excludes high-value secret filename/path conventions without a workspace .gitignore", async () => {
    // The backstop is deliberately filename/path based, not content-aware.
    // Keep this fixture broad enough to catch omissions while proving that an
    // ordinary file and a credential-themed document remain checkpointable.
    const secretFiles: Record<string, string> = {
      ".npmrc": "//registry.npmjs.org/:_authToken=test-secret-token\n",
      ".netrc": "machine example.test login user password secret\n",
      ".git-credentials": "https://user:secret@example.test/repo.git\n",
      ".pypirc": "[pypi]\npassword = secret\n",
      ".yarnrc.yml": "npmAuthToken: secret\n",
      ".envrc": "export API_KEY=secret\n",
      "terraform.tfstate": "{\"private_key\":\"secret\"}\n",
      "service-account-prod.json": "{\"private_key\":\"secret\"}\n",
      "release-signing.jks": "keystore\n",
      ".vault-token": "secret\n",
      "docs/credentials-guide.md": "How credentials work\n",
      "notes.md": "ordinary user content\n",
    };
    for (const [relative, content] of Object.entries(secretFiles)) {
      const path = join(workspaceDir, relative);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, content);
    }
    const nestedSecretFiles: Record<string, string> = {
      "nested/.docker/config.json": "{\"auths\":{}}\n",
      "nested/.kube/config": "users:\n- name: admin\n",
      "nested/.config/gcloud/credentials.db": "private credential\n",
      "nested/.config/gh/hosts.yml": "oauth_token: secret\n",
      "nested/.azure/accessTokens.json": "[{\"accessToken\":\"secret\"}]\n",
      "nested/.gnupg/private-keys-v1.d/key": "private key\n",
      "nested/.direnv/state": "secret\n",
      "nested/.terraform.d/credentials.tfrc.json": "{\"token\":\"secret\"}\n",
    };
    for (const [relative, content] of Object.entries(nestedSecretFiles)) {
      const path = join(workspaceDir, relative);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, content);
    }
    rmSync(join(workspaceDir, ".gitignore"));

    const mgr = await chkptManager();
    const hash = await mgr.save("fixture-secret-backstop");
    expect(hash).toBeTruthy();

    const tree = execSync(
      `git --git-dir="${shadowGitDir()}" ls-tree -r --name-only HEAD`,
      { encoding: "utf-8", stdio: "pipe" },
    ).trim();
    const files = tree.split("\n").filter(Boolean);

    for (const relative of [...Object.keys(secretFiles), ...Object.keys(nestedSecretFiles)]) {
      if (relative === "docs/credentials-guide.md" || relative === "notes.md") continue;
      expect(files).not.toContain(relative);
    }
    expect(files).toContain("docs/credentials-guide.md");
    expect(files).toContain("notes.md");
  });

  it("fails closed when a resumed shadow repo has no exclusion file", async () => {
    const first = await chkptManager();
    expect(await first.save("initial-checkpoint")).toBeTruthy();

    rmSync(join(shadowGitDir(), "info", "exclude"));
    writeFileSync(join(workspaceDir, ".npmrc"), "//registry.npmjs.org/:_authToken=secret\n");

    const resumed = await chkptManager();
    expect(await resumed.save("must-fail-closed")).toBeNull();

    const tree = execSync(
      `git --git-dir="${shadowGitDir()}" ls-tree -r --name-only HEAD`,
      { encoding: "utf-8", stdio: "pipe" },
    ).trim();
    expect(tree.split("\n").filter(Boolean)).not.toContain(".npmrc");
  });

  it("excludes .env from the shadow repo even when the workspace has NO .gitignore at all (D4 backstop)", async () => {
    // Simulate a workspace that never had a .gitignore: remove it and
    // re-commit the removal so the shadow repo's --work-tree sees a
    // workspace with no gitignore forwarding whatsoever.
    rmSync(join(workspaceDir, ".gitignore"));
    execSync("git add -A && git commit -m 'remove gitignore'", {
      cwd: workspaceDir,
      stdio: "pipe",
    });

    const mgr = await chkptManager();
    const hash = await mgr.save("no-gitignore-checkpoint");
    expect(hash).toBeTruthy();

    const tracked = execSync(
      `git --git-dir="${shadowGitDir()}" ls-files`,
      { encoding: "utf-8", stdio: "pipe" },
    ).trim();
    const files = tracked.split("\n").filter(Boolean);

    expect(files).toContain("app.ts");
    expect(files).not.toContain(".env");
  });

  it("completes a checkpoint cycle with NO global git identity (self-contained shadow repo)", async () => {
    // Regression guard: the shadow repo must never depend on the ambient
    // global/system git config. Scrub identity for the git subprocesses so a
    // machine without a global user.name/user.email (e.g. CI) is simulated;
    // the commit must still succeed via the manager's own -c overrides.
    const prevGlobal = process.env.GIT_CONFIG_GLOBAL;
    const prevSystem = process.env.GIT_CONFIG_SYSTEM;
    process.env.GIT_CONFIG_GLOBAL = "/dev/null";
    process.env.GIT_CONFIG_SYSTEM = "/dev/null";

    try {
      const mgr = await chkptManager();

      // save
      writeFileSync(join(workspaceDir, "app.ts"), "console.log('changed');\n");
      const hash = await mgr.save("no-global-identity");
      expect(hash).toBeTruthy();

      // list sees the commit
      const entries = await mgr.list();
      expect(entries.length).toBeGreaterThan(0);
      expect(entries[0]!.hash).toBe(hash);

      // restore round-trips
      rmSync(join(workspaceDir, "app.ts"));
      const result = await mgr.restore("files");
      expect(result.restored).toBe(true);
      expect(existsSync(join(workspaceDir, "app.ts"))).toBe(true);
    } finally {
      if (prevGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
      else process.env.GIT_CONFIG_GLOBAL = prevGlobal;
      if (prevSystem === undefined) delete process.env.GIT_CONFIG_SYSTEM;
      else process.env.GIT_CONFIG_SYSTEM = prevSystem;
    }
  });

  it("restore does not recreate gitignored .env that was never tracked", async () => {
    const mgr = await chkptManager();

    await mgr.save("pre-delete");

    expect(existsSync(join(workspaceDir, "app.ts"))).toBe(true);
    expect(existsSync(join(workspaceDir, ".env"))).toBe(true);

    rmSync(join(workspaceDir, "app.ts"));
    rmSync(join(workspaceDir, ".env"));

    const result = await mgr.restore("files");
    expect(result.restored).toBe(true);

    expect(existsSync(join(workspaceDir, "app.ts"))).toBe(true);
    expect(existsSync(join(workspaceDir, ".env"))).toBe(false);
  });

  it("undoes a file CREATION, and the undo is itself redoable", async () => {
    // The user's first live /undo test: ask the agent to write a sample file,
    // then undo. checkout <hash> -- . reverted modifications but never deleted
    // the created file — the snapshot has nothing to overlay it with. The
    // read-tree --reset -u primitive syncs the worktree to the snapshot,
    // deletions included, without moving HEAD.
    const mgr = await chkptManager();

    writeFileSync(join(workspaceDir, "app.ts"), "console.log('v1');\n");
    const before = await mgr.save("pre-creation");
    expect(before).toBeTruthy();

    writeFileSync(join(workspaceDir, "created-later.txt"), "new file\n");
    writeFileSync(join(workspaceDir, "app.ts"), "console.log('v2');\n");
    const after = await mgr.save("post-creation");
    expect(after).toBeTruthy();

    const undo = await mgr.restoreFrom(before!);
    expect(undo.restored).toBe(true);
    expect(existsSync(join(workspaceDir, "created-later.txt"))).toBe(false);
    expect(readFileSync(join(workspaceDir, "app.ts"), "utf-8")).toContain("v1");

    // HEAD did not move, so the later checkpoint is still listed — redo works.
    const entries = await mgr.list();
    expect(entries.some((e) => e.hash === after)).toBe(true);
    const redo = await mgr.restoreFrom(after!);
    expect(redo.restored).toBe(true);
    expect(existsSync(join(workspaceDir, "created-later.txt"))).toBe(true);
    expect(readFileSync(join(workspaceDir, "app.ts"), "utf-8")).toContain("v2");
  });

  it("undoes a file created THIS turn with no second save (the live /undo bug)", async () => {
    // The actual live flow: checkpoints are taken at TURN START, not after
    // every tool call. save#1 happens, then within the same turn a file is
    // created and an existing file modified — with NO further save before
    // /undo runs. The created file exists in the worktree but in no snapshot
    // and not in the shadow index, so a plain `read-tree --reset -u <hash>`
    // cannot delete it: git never saw it. restoreFrom must take its own
    // pre-restore snapshot (which `add -A`s everything, indexed or not)
    // before the read-tree so the deletion actually happens.
    const mgr = await chkptManager();

    const before = await mgr.save("turn-start-checkpoint");
    expect(before).toBeTruthy();

    // Same turn: create a new file and modify an existing one. No save call
    // in between — this mirrors the live agent flow exactly.
    writeFileSync(join(workspaceDir, "sample-undo-test.txt"), "created this turn\n");
    writeFileSync(join(workspaceDir, "app.ts"), "console.log('changed this turn');\n");

    const undo = await mgr.restoreFrom(before!);
    expect(undo.restored).toBe(true);
    expect(existsSync(join(workspaceDir, "sample-undo-test.txt"))).toBe(false);
    expect(readFileSync(join(workspaceDir, "app.ts"), "utf-8")).toContain("hello");
  });

  it("the pre-restore auto-snapshot is redoable and untagged for conversation-rewind", async () => {
    const mgr = await chkptManager();

    const before = await mgr.save("turn-start-checkpoint");
    expect(before).toBeTruthy();

    writeFileSync(join(workspaceDir, "sample-undo-test.txt"), "created this turn\n");

    const undo = await mgr.restoreFrom(before!);
    expect(undo.restored).toBe(true);
    expect(existsSync(join(workspaceDir, "sample-undo-test.txt"))).toBe(false);

    const entries = await mgr.list();
    const preRestore = entries.find((e) => e.message.startsWith("[pre-restore]"));
    expect(preRestore).toBeTruthy();
    expect(preRestore!.message).not.toMatch(/\[convLen:\d+\]/);

    const redo = await mgr.restoreFrom(preRestore!.hash);
    expect(redo.restored).toBe(true);
    expect(existsSync(join(workspaceDir, "sample-undo-test.txt"))).toBe(true);
    expect(readFileSync(join(workspaceDir, "sample-undo-test.txt"), "utf-8")).toBe("created this turn\n");
  });
});

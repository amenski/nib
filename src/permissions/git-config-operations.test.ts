import { describe, expect, it } from "vitest";
import { isGitConfigOperation } from "./git-config-operations.js";

/** The bash-shaped args a run_bash call carries. */
const call = (command: unknown, toolName = "run_bash") => ({ toolName, args: { command } });

describe("isGitConfigOperation — the approved-operation grant is offered", () => {
  it.each([
    "git init",
    "git init --bare",
    "git clone https://example.invalid/repo.git",
    "git clone --depth 1 ./local-clone-source",
    "git remote add origin https://example.invalid/repo.git",
    "git remote set-url origin git@example.invalid:o/r.git",
    "git remote remove origin",
    "git remote rename origin upstream",
    "git remote set-branches origin main",
    "git submodule add ./subsrc sub",
    "git config user.email me@example.invalid",
    "git config core.autocrlf input",
    "git config --add safe.directory /tmp/x",
    "/usr/bin/git remote add origin ./remote",
    "/opt/homebrew/bin/git init",
    "git init && git remote add origin ./o",
  ])("%s", (command) => {
    expect(isGitConfigOperation(call(command).toolName, call(command).args)).toBe(true);
  });
});

describe("isGitConfigOperation — nothing else is offered a grant", () => {
  it.each([
    // Reads and ordinary workflow commands need no widened profile.
    "git status",
    "git commit -m x",
    "git config --get user.email",
    "git config --list",
    "git config -l",
    "git config --get-regexp remote",
    "git config --edit",
    "git log --oneline -5",
    "ls -la",
    "echo hi",
    // A read or an off-target scope mixed into a compound command must not
    // smuggle the grant in behind a qualifying segment.
    "git init && rm -rf /",
    "git init; git status",
    "git remote add origin ./o || true",
    // Wrappers and unresolved shapes hide the real argv.
    "sudo git init",
    "env git init",
    "timeout 60 git init",
    "git init $(echo x)",
    "sh -c 'git init'",
    "FOO=1 git init",
    // A non-standard executable path is a script in the workspace, not Git.
    "./git init",
    "/tmp/git init",
    "git -C /elsewhere config user.email me@example.invalid",
    "git --git-dir=/elsewhere/.git config user.email me@example.invalid",
    // Off-target config scopes: the workspace-scoped variant cannot honour
    // them, so they must not be shown a prompt implying it would.
    "git config --global user.email me@example.invalid",
    "git config --system core.fsmonitor true",
    "git config --file /tmp/other.conf user.email me@example.invalid",
    "git config -f /tmp/other.conf user.email me@example.invalid",
    "git config --blob HEAD:.gitmodules a.b c",
    // Writes that are not config-shaped (`--unset` takes no value).
    "git config --unset user.email",
    "git config user.email",
  ])("%s", (command) => {
    expect(isGitConfigOperation(call(command).toolName, call(command).args)).toBe(false);
  });

  it("never applies to a tool other than run_bash", () => {
    // A background job has no per-call interactive approval to grant, so the
    // grant must not be reachable there even for a qualifying command.
    expect(isGitConfigOperation("run_bash_background", { command: "git init" })).toBe(false);
    expect(isGitConfigOperation("write_to_file", { command: "git init" })).toBe(false);
  });

  it("rejects a non-string or empty command", () => {
    expect(isGitConfigOperation("run_bash", {})).toBe(false);
    expect(isGitConfigOperation("run_bash", { command: "" })).toBe(false);
    expect(isGitConfigOperation("run_bash", { command: "   " })).toBe(false);
    expect(isGitConfigOperation("run_bash", { command: 42 })).toBe(false);
  });
});

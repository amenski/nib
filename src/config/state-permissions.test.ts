import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmodSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendPrivateFile,
  ensurePrivateStateDirectory,
  ensurePrivateStateDirectoryAsync,
  writePrivateFile,
  writePrivateFileSync,
} from "./state-permissions.js";
import { SessionStore } from "../sessions/store.js";
import { saveSettingsTrust } from "./settings-trust.js";
import { saveFolderTrust } from "./folder-trust.js";
import { saveHookTrust } from "../hooks/trust.js";
import { saveSkillTrust } from "../skills/trust.js";
import { saveMcpPins } from "../mcp/pins.js";
import { authSaveKey } from "../auth/wizard.js";
import { writeCachedSnapshot } from "../providers/catalog-update.js";
import { persistThemeChoice } from "../ui/components/ThemeDropdown/index.js";
import { appendPromptHistory } from "../ui/core/history-store.js";
import { CheckpointManager } from "../checkpoints/index.js";

describe("Nib state permissions", () => {
  let root: string;
  let previousUmask: number;
  let previousNibHome: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "nib-state-permissions-"));
    previousUmask = process.umask(0o000);
    previousNibHome = process.env.NIB_HOME;
  });

  afterEach(() => {
    process.umask(previousUmask);
    if (previousNibHome === undefined) delete process.env.NIB_HOME;
    else process.env.NIB_HOME = previousNibHome;
    rmSync(root, { recursive: true, force: true });
  });

  it("keeps directories at 0700 and files at 0600 under a permissive umask", async () => {
    const leaf = ensurePrivateStateDirectory(root, "state", "nested");
    expect(statSync(root).mode & 0o777).toBe(0o700);
    expect(statSync(join(root, "state")).mode & 0o777).toBe(0o700);
    expect(statSync(leaf).mode & 0o777).toBe(0o700);

    const syncFile = join(leaf, "sync.json");
    writePrivateFileSync(syncFile, "sync");
    expect(statSync(syncFile).mode & 0o777).toBe(0o600);

    chmodSync(syncFile, 0o644);
    writePrivateFileSync(syncFile, "repaired");
    expect(statSync(syncFile).mode & 0o777).toBe(0o600);

    const asyncDir = await ensurePrivateStateDirectoryAsync(root, "async");
    const asyncFile = join(asyncDir, "async.json");
    await writePrivateFile(asyncFile, "async");
    await appendPrivateFile(asyncFile, "\nmore");
    expect(statSync(asyncDir).mode & 0o777).toBe(0o700);
    expect(statSync(asyncFile).mode & 0o777).toBe(0o600);
  });

  it("applies the private modes to the session store's actual state paths", async () => {
    const home = join(root, "nib-home");
    const id = await new SessionStore(home).create({
      cwd: process.cwd(),
      provider: "test",
      model: "test",
      mode: "ask",
    });
    const sessions = join(home, "sessions");
    const [projectSlug] = readdirSync(sessions);
    const sessionDir = join(sessions, projectSlug);

    expect(statSync(home).mode & 0o777).toBe(0o700);
    expect(statSync(sessions).mode & 0o777).toBe(0o700);
    expect(statSync(sessionDir).mode & 0o777).toBe(0o700);
    expect(statSync(join(sessionDir, `${id}.jsonl`)).mode & 0o777).toBe(0o600);
    expect(statSync(join(sessionDir, "sessions-index.json")).mode & 0o777).toBe(0o600);
  });

  it("protects the global trust, credential, catalog, settings, and history files", async () => {
    const home = join(root, "nib-home");
    process.env.NIB_HOME = home;

    saveSettingsTrust({ settings: {} });
    saveFolderTrust({ folders: {} });
    saveHookTrust({ hooks: {} });
    saveSkillTrust({ skills: {} });
    saveMcpPins({ servers: {} });
    await authSaveKey("test", "secret", true);
    writeCachedSnapshot({ providers: {} });
    persistThemeChoice("dark");
    await appendPromptHistory("/workspace", "hello");

    expect(statSync(home).mode & 0o777).toBe(0o700);
    for (const file of [
      "settings-trust.json",
      "folder-trust.json",
      "hooks-trust.json",
      "skill-trust.json",
      "mcp-pins.json",
      "credentials.yaml",
      "models-catalog.json",
      "settings.json",
    ]) {
      expect(statSync(join(home, file)).mode & 0o777, file).toBe(0o600);
    }
    const historyRoot = join(home, "prompt_history");
    expect(statSync(historyRoot).mode & 0o777).toBe(0o700);
    const [historyFile] = readdirSync(historyRoot);
    expect(statSync(join(historyRoot, historyFile)).mode & 0o777).toBe(0o600);
  });

  it("protects the checkpoint shadow repository Git creates", async () => {
    const home = join(root, "nib-home");
    const workspace = join(root, "workspace");
    ensurePrivateStateDirectory(workspace);

    await new CheckpointManager("session", workspace, home).list();

    const shadow = join(home, "checkpoints", "session");
    expect(statSync(home).mode & 0o777).toBe(0o700);
    expect(statSync(join(home, "checkpoints")).mode & 0o777).toBe(0o700);
    expect(statSync(shadow).mode & 0o777).toBe(0o700);

    const checkTree = (path: string): void => {
      for (const entry of readdirSync(path, { withFileTypes: true })) {
        const child = join(path, entry.name);
        const mode = statSync(child).mode & 0o777;
        if (entry.isDirectory()) {
          expect(mode, child).toBe(0o700);
          checkTree(child);
        } else if (entry.isFile()) {
          expect(mode, child).toBe(0o600);
        }
      }
    };
    checkTree(shadow);
  });
});

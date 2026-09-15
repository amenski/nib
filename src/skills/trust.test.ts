import { createHash } from "node:crypto";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, statSync, readdirSync, existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { projectDirPath } from "../config/paths.js";
import { tmpdir } from "node:os";
import { checkSkillTrust, trustSkill, loadSkillTrust, saveSkillTrust, skillContentHash } from "./trust.js";
import { SkillLoader } from "./index.js";

// TOFU trust model (skill-spec.md §6, security-spec T4): global user skills
// (~/.heirloom/skills, ~/.agents/skills) are trusted implicitly; project
// skills are content-hashed and keyed by source path in skill-trust.json. An
// unseen or edited project skill is withheld from the session until the
// ask-tier confirmation (y = trust that hash forever, n = skip this session);
// headless runs skip untrusted skills with a stderr warning.

const TEST_DIR = join(tmpdir(), `heirloom-skills-trust-${process.pid}`);
const HOME_DIR = join(TEST_DIR, "home");
const TRUST_FILE = join(HOME_DIR, "skill-trust.json");

let projectDir: string;
let prevCwd: string;

function writeSkill(dir: string, name: string, body = "Body of " + name) {
  const skillDir = join(projectDirPath(dir), "skills", name);
  mkdirSync(skillDir, { recursive: true });
  const path = join(skillDir, "SKILL.md");
  writeFileSync(
    path,
    `---\nname: ${name}\ndescription: test ${name}\n---\n${body}`,
    "utf-8",
  );
  return path;
}

/** The trust store keys by realpath (a workspace reached via a symlink — or
 *  macOS's /var → /private/var — must not get two keys), so expectations
 *  compare against the canonical spelling. */
function real(path: string): string {
  return realpathSync(path);
}

beforeEach(() => {
  mkdirSync(HOME_DIR, { recursive: true });
  projectDir = mkdtempSync(join(TEST_DIR, "project-"));
  prevCwd = process.cwd();
  process.chdir(projectDir);
  process.env.NIB_HOME = HOME_DIR;
  process.env.HOME = HOME_DIR;
});

afterEach(() => {
  process.chdir(prevCwd);
  delete process.env.NIB_HOME;
  delete process.env.HOME;
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("checkSkillTrust / trustSkill — content-hashed classification", () => {
  it("new → trustSkill → trusted; a content edit re-classifies as changed (re-prompt)", () => {
    const path = writeSkill(projectDir, "alpha");
    const name = "alpha";

    expect(checkSkillTrust(path, name)).toEqual({ status: "new", name, sourcePath: real(path) });

    trustSkill(path, name);
    expect(checkSkillTrust(path, name)).toEqual({ status: "trusted" });

    writeFileSync(path, `---\nname: alpha\ndescription: test alpha\n---\nEDITED BODY`);
    expect(checkSkillTrust(path, name)).toEqual({ status: "changed", name, sourcePath: real(path) });

    // The stored hash is the OLD one until the new content is re-trusted.
    trustSkill(path, name);
    expect(checkSkillTrust(path, name)).toEqual({ status: "trusted" });
  });

  it("identical content stays trusted; a second path gets its own entry", () => {
    const a = writeSkill(projectDir, "alpha");
    const b = writeSkill(projectDir, "beta");
    trustSkill(a, "alpha");
    expect(checkSkillTrust(a, "alpha")).toEqual({ status: "trusted" });
    expect(checkSkillTrust(b, "beta")).toEqual({ status: "new", name: "beta", sourcePath: real(b) });
  });
});

describe("trust store hygiene", () => {
  it("writes mode 0600, atomically, under NIB_HOME, storing the hash not the content", () => {
    const path = writeSkill(projectDir, "alpha");
    trustSkill(path, "alpha");

    const raw = readFileSync(TRUST_FILE, "utf-8");
    // Never stores skill content.
    expect(raw).not.toContain("Body of alpha");

    const parsed = JSON.parse(raw);
    const entry = parsed.skills[real(path)];
    expect(entry).toBeDefined();
    expect(entry.hash).toMatch(/^[0-9a-f]{64}$/); // full sha256, not a truncated fingerprint
    expect(entry.trusted).toBe(true);
    expect(entry.firstSeen).toEqual(expect.any(Number));

    const mode = statSync(TRUST_FILE).mode & 0o777;
    expect(mode).toBe(0o600);

    // Atomic write: no leftover temp files next to the store.
    expect(readdirSync(HOME_DIR).sort()).toEqual(["skill-trust.json"]);
  });

  it("a save failure is swallowed with a stderr note — never an unhandled rejection", () => {
    // Point NIB_HOME at a path that cannot be created (a file in the way).
    writeFileSync(join(TEST_DIR, "blocker"), "x");
    process.env.NIB_HOME = join(TEST_DIR, "blocker", "home");

    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const path = writeSkill(projectDir, "alpha");
    try {
      expect(() => trustSkill(path, "alpha")).not.toThrow();
      expect(stderr).toHaveBeenCalledWith(expect.stringContaining("failed to write skill-trust.json"));
    } finally {
      stderr.mockRestore();
    }
  });
});

describe("legacy 16-char hash migration (pre-204f856 truncated digests)", () => {
  function legacyHash(path: string): string {
    return createHash("sha256").update(readFileSync(path)).digest("hex").slice(0, 16);
  }

  function writeLegacyEntry(key: string, hash: string, overrides: Partial<Record<string, unknown>> = {}) {
    const store = loadSkillTrust();
    store.skills[key] = {
      path: key,
      hash,
      firstSeen: 1000,
      trusted: true,
      ...overrides,
    };
    saveSkillTrust(store);
  }

  it("a matching legacy hash reports trusted and rewrites the entry with the full 64-char hash", () => {
    const path = writeSkill(projectDir, "alpha");
    const key = real(path);
    writeLegacyEntry(key, legacyHash(path));

    expect(checkSkillTrust(path, "alpha")).toEqual({ status: "trusted" });

    const entry = loadSkillTrust().skills[key]!;
    expect(entry.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(entry.hash.startsWith(legacyHash(path))).toBe(true);
  });

  it("a non-matching legacy hash still reports changed (real content edit, not just a format break)", () => {
    const path = writeSkill(projectDir, "alpha");
    const key = real(path);
    // A legacy hash that does not match the current content's prefix at all.
    writeLegacyEntry(key, "0000000000000000");

    expect(checkSkillTrust(path, "alpha")).toEqual({ status: "changed", name: "alpha", sourcePath: key });

    // Not silently rewritten: the stale legacy hash is left as-is.
    expect(loadSkillTrust().skills[key]!.hash).toBe("0000000000000000");
  });

  it("a full-length 64-char entry with matching content reports trusted (unchanged behavior)", () => {
    const path = writeSkill(projectDir, "alpha");
    trustSkill(path, "alpha");
    expect(checkSkillTrust(path, "alpha")).toEqual({ status: "trusted" });
  });

  it("a full-length entry is never compared by prefix: an edit still reports changed even though the legacy-length prefix would match", () => {
    const path = writeSkill(projectDir, "alpha");
    const key = real(path);
    const fullHash = skillContentHash(path);
    writeLegacyEntry(key, fullHash); // full 64-char hash, current content

    writeFileSync(path, `---\nname: alpha\ndescription: test alpha\n---\nEDITED BODY`);
    expect(checkSkillTrust(path, "alpha")).toEqual({ status: "changed", name: "alpha", sourcePath: key });
  });

  it("prunes unreachable entries (missing files) on a migration save, while live entries survive", () => {
    const alphaPath = writeSkill(projectDir, "alpha");
    const alphaKey = real(alphaPath);
    const betaPath = writeSkill(projectDir, "beta");
    const betaKey = real(betaPath);

    // A gone entry: key points at a file that no longer exists on disk.
    const goneKey = join(projectDirPath(projectDir), "skills", "gone", "SKILL.md");
    writeLegacyEntry(goneKey, "1111111111111111");
    // A live, already-migrated (full-length) entry that should survive untouched.
    trustSkill(betaPath, "beta");
    // The legacy entry that triggers the migration save.
    writeLegacyEntry(alphaKey, legacyHash(alphaPath));

    expect(checkSkillTrust(alphaPath, "alpha")).toEqual({ status: "trusted" });

    const skills = loadSkillTrust().skills;
    expect(skills[goneKey]).toBeUndefined();
    expect(skills[alphaKey]).toBeDefined();
    expect(skills[betaKey]).toBeDefined();
    expect(skills[betaKey]!.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("preserves firstSeen across the migration rewrite", () => {
    const path = writeSkill(projectDir, "alpha");
    const key = real(path);
    writeLegacyEntry(key, legacyHash(path), { firstSeen: 12345 });

    checkSkillTrust(path, "alpha");

    expect(loadSkillTrust().skills[key]!.firstSeen).toBe(12345);
  });
});

describe("SkillLoader TOFU flow", () => {
  it("headless skips untrusted project skills with a stderr warning (fail closed)", async () => {
    writeSkill(projectDir, "alpha");
    const stderr: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: any) => {
      stderr.push(String(chunk));
      return true;
    });
    try {
      const loader = new SkillLoader();
      const skills = await loader.load({ headless: true });

      expect(skills).toHaveLength(0);
      expect(loader.pendingTrust).toHaveLength(0);
      expect(stderr.join("")).toContain("Skipping untrusted skill in headless: alpha");
    } finally {
      spy.mockRestore();
    }
  });

  it("interactive defers untrusted project skills for the ask; a 'yes' trusts forever", async () => {
    const path = writeSkill(projectDir, "alpha");

    const loader = new SkillLoader();
    const first = await loader.load();
    expect(first).toHaveLength(0);
    expect(loader.pendingTrust).toHaveLength(1);
    expect(loader.pendingTrust[0]!.skill.name).toBe("alpha");
    expect(loader.pendingTrust[0]!.status).toBe("new");

    loader.acceptTrust(loader.pendingTrust[0]!.skill, true);
    expect(first).toHaveLength(1); // pushed into the SAME array the caller holds
    expect(checkSkillTrust(path, "alpha")).toEqual({ status: "trusted" });

    // Next session: trusted, no ask.
    const second = new SkillLoader();
    const again = await second.load();
    expect(again.map((s) => s.name)).toContain("alpha");
    expect(second.pendingTrust).toHaveLength(0);
  });

  it("a 'no' skips the skill for the session without persisting trust", async () => {
    const path = writeSkill(projectDir, "alpha");

    const loader = new SkillLoader();
    await loader.load();
    loader.acceptTrust(loader.pendingTrust[0]!.skill, false);

    expect(loader.pendingTrust).toHaveLength(1); // still deferred, not applied
    expect(loadSkillTrust().skills[real(path)]).toBeUndefined();
    expect(checkSkillTrust(path, "alpha")).toEqual({ status: "new", name: "alpha", sourcePath: real(path) });
  });

  it("a content change re-prompts (pendingTrust) even after a previous trust", async () => {
    const path = writeSkill(projectDir, "alpha");
    trustSkill(path, "alpha");

    const loader = new SkillLoader();
    await loader.load();
    expect(loader.pendingTrust).toHaveLength(0);

    writeFileSync(path, `---\nname: alpha\ndescription: test alpha\n---\nEDITED`);
    const changed = new SkillLoader();
    await changed.load();
    expect(changed.pendingTrust.map((p) => p.skill.name)).toContain("alpha");
    expect(changed.pendingTrust.find((p) => p.skill.name === "alpha")?.status).toBe("changed");
  });

  it("headless runs skills trusted by a previous interactive session", async () => {
    writeSkill(projectDir, "alpha");
    trustSkill(join(projectDirPath(projectDir), "skills", "alpha", "SKILL.md"), "alpha");

    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const loader = new SkillLoader();
      const skills = await loader.load({ headless: true });
      expect(skills.map((s) => s.name)).toContain("alpha");
      expect(stderr).not.toHaveBeenCalled();
    } finally {
      stderr.mockRestore();
    }
  });
});

describe("global user skills are trusted implicitly", () => {
  it("never enters the trust store and never asks or skips", async () => {
    // NIB_HOME *is* the state dir here, so global skills live at its top
    // level — not in a nested .heirloom. This test previously nested it, which
    // only worked while skills/index.ts ignored the override.
    const globalSkill = join(HOME_DIR, "skills", "global-one");
    mkdirSync(globalSkill, { recursive: true });
    writeFileSync(
      join(globalSkill, "SKILL.md"),
      "---\nname: global-one\ndescription: user's own\n---\nGlobal body",
      "utf-8",
    );
    const agentsSkill = join(HOME_DIR, ".agents", "skills", "global-two");
    mkdirSync(agentsSkill, { recursive: true });
    writeFileSync(
      join(agentsSkill, "SKILL.md"),
      "---\nname: global-two\ndescription: user's own\n---\nGlobal body 2",
      "utf-8",
    );

    const loader = new SkillLoader();
    const skills = await loader.load({ headless: true }); // headless: global must survive the fail-closed path

    expect(skills.map((s) => s.name).sort()).toEqual(["global-one", "global-two"]);
    expect(loader.pendingTrust).toHaveLength(0);
    expect(existsSync(TRUST_FILE)).toBe(false); // no store entries written for global skills
  });
});

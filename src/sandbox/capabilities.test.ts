import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  NEVER_GRANTABLE_SERVICES,
  capabilityFor,
  isActionable,
  isCaskDir,
  parseCapabilityId,
  resolveCapabilityId,
  resolveStoredGrants,
} from "./capabilities.js";
import type { DenialGroup } from "./denials.js";

const onDarwin = process.platform === "darwin";
const itOnDarwin = it.skipIf(!onDarwin);

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "nib-cap-")));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const group = (over: Partial<DenialGroup>): DenialGroup => ({
  opClass: "write", key: "/x", ops: ["file-write-create"], samples: [], count: 1, probable: false, ...over,
});
const blocked = (r: unknown): string | undefined => (r && typeof r === "object" && "blocked" in r ? (r as { blocked: string }).blocked : undefined);

describe("capability ids", () => {
  it("round-trips a directory grant through its stored id", () => {
    const dir = join(scratch, "out");
    mkdirSync(dir);
    const cap = parseCapabilityId(`write:${dir}`)!;
    expect(cap.id).toBe(`write:${dir}`);
    expect(cap.lines).toEqual([`(allow file-write* (subpath "${dir}"))`]);
    expect(parseCapabilityId(cap.id)).toEqual(cap);
    expect(parseCapabilityId(`read:${dir}`)!.lines).toEqual([`(allow file-read* (subpath "${dir}"))`]);
  });

  it("stores the resolved path, so a symlink cannot be swapped to point elsewhere later", () => {
    const real = join(scratch, "real");
    mkdirSync(real);
    symlinkSync(real, join(scratch, "link"));
    expect(parseCapabilityId(`write:${join(scratch, "link")}`)!.id).toBe(`write:${real}`);
  });

  it("escapes the path inside the SBPL string", () => {
    const dir = join(scratch, 'we"ird');
    mkdirSync(dir);
    expect(parseCapabilityId(`write:${dir}`)!.lines[0]).toBe(`(allow file-write* (subpath "${dir.replace(/"/g, '\\"')}"))`);
  });

  it("knows the fixed capabilities and nothing else", () => {
    expect(parseCapabilityId("local-network")!.lines.join("\n")).toContain("network-outbound");
    expect(parseCapabilityId("bogus")).toBeNull();
    expect(parseCapabilityId("browser:x")).toBeNull();
    expect(parseCapabilityId("local-network:x")).toBeNull();
    expect(parseCapabilityId("")).toBeNull();
    expect(resolveCapabilityId("a".repeat(2000))).toBeNull();
  });

  itOnDarwin("builds the browser rules from the existing definition", () => {
    expect(parseCapabilityId("browser")!.lines.join("\n")).toContain('(global-name "com.apple.windowserver.active")');
  });
});

describe("a write grant under $HOME also reads", () => {
  it("emits a read line next to the write line inside home, and only the write line outside it", () => {
    const home = mkdtempSync(join(homedir(), "nib-cap-home-"));
    try {
      const real = realpathSync(home);
      const cap = parseCapabilityId(`write:${home}`)!;
      expect(cap.lines).toEqual([`(allow file-write* (subpath "${real}"))`, `(allow file-read* (subpath "${real}"))`]);
      expect(cap.risk).toMatch(/change, read and delete/);
      expect(parseCapabilityId(`read:${home}`)!.lines).toEqual([`(allow file-read* (subpath "${real}"))`]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
    const outside = join(scratch, "outside-home");
    mkdirSync(outside);
    expect(parseCapabilityId(`write:${outside}`)!.lines).toEqual([`(allow file-write* (subpath "${outside}"))`]);
  });
});

describe("Homebrew cask directories", () => {
  it("treats Caskroom/<name>/<version>/<x> as a cask dir, and nothing shallower or elsewhere", () => {
    expect(isCaskDir("/opt/homebrew/Caskroom/flutter/3.7.6/flutter")).toBe(true);
    expect(isCaskDir("/opt/homebrew/Caskroom/flutter/3.7.6/flutter/bin/cache")).toBe(true);
    expect(isCaskDir("/opt/homebrew/Caskroom/flutter/3.7.6")).toBe(false);
    expect(isCaskDir("/opt/homebrew/Caskroom/flutter")).toBe(false);
    expect(isCaskDir("/opt/homebrew/Caskroom")).toBe(false);
    expect(isCaskDir("/opt/homebrew/bin")).toBe(false);
    expect(isCaskDir("/opt/homebrew/Cellar/x/1/y")).toBe(false);
    expect(isCaskDir("/opt/homebrew/CaskroomX/a/b/c")).toBe(false);
  });

  it.skipIf(!existsSync("/opt/homebrew/bin"))("still refuses the rest of /opt/homebrew", () => {
    expect(blocked(resolveCapabilityId("write:/opt/homebrew/bin"))).toMatch(/system or program/);
    expect(blocked(resolveCapabilityId("write:/opt/homebrew"))).toMatch(/system or program/);
  });
});

describe("never grantable", () => {
  it("refuses roots, the home directory and its parents, and missing directories", () => {
    expect(blocked(resolveCapabilityId("write:/"))).toMatch(/too broad/);
    expect(blocked(resolveCapabilityId(`write:${homedir()}`))).toMatch(/home directory/);
    expect(blocked(resolveCapabilityId(`write:${join(scratch, "missing")}`))).toMatch(/does not exist/);
    // realpath("") and realpath("rel") resolve against the cwd: never a grant.
    expect(blocked(resolveCapabilityId("write"))).toMatch(/not a usable/);
    expect(blocked(resolveCapabilityId("write:."))).toMatch(/not a usable/);
    expect(blocked(resolveCapabilityId("read:relative/dir"))).toMatch(/not a usable/);
  });

  itOnDarwin("refuses system and program directories", () => {
    for (const dir of ["/usr", "/System", "/Library", "/Applications", "/etc"]) {
      expect(blocked(resolveCapabilityId(`write:${dir}`)), dir).toMatch(/system or program/);
    }
  });

  itOnDarwin("refuses a directory that holds, or sits in, credentials or startup configuration", () => {
    expect(blocked(resolveCapabilityId(`read:${join(homedir(), "Library")}`))).toMatch(/credentials or startup/);
  });

  it("refuses Git metadata", () => {
    const git = join(scratch, "repo", ".git");
    mkdirSync(git, { recursive: true });
    expect(blocked(resolveCapabilityId(`write:${git}`))).toMatch(/Git metadata/);
    mkdirSync(join(git, "hooks"));
    expect(blocked(resolveCapabilityId(`write:${join(git, "hooks")}`))).toMatch(/Git metadata/);
  });

  it("refuses a path with control characters", () => {
    expect(blocked(resolveCapabilityId("write:/tmp/a\nb"))).toMatch(/not a usable/);
  });

  it("refuses the services that would act as the user", () => {
    for (const svc of ["com.apple.appleevents", "com.apple.SecurityServer", "com.apple.pasteboard.1", "com.apple.tccd", "com.apple.coreservices.appleevents", "com.apple.CoreAuthentication.agent"]) {
      expect(blocked(resolveCapabilityId(`mach:${svc}`)), svc).toMatch(/not grantable/);
    }
    expect(NEVER_GRANTABLE_SERVICES.length).toBeGreaterThan(5);
    expect(blocked(resolveCapabilityId("mach:bad name"))).toMatch(/not a usable/);
    expect(blocked(resolveCapabilityId('mach:x") (allow default'))).toMatch(/not a usable/);
  });

  it("allows an ordinary service", () => {
    expect(parseCapabilityId("mach:com.apple.foo")!.lines).toEqual(['(allow mach-lookup (global-name "com.apple.foo"))']);
  });

  it("refuses sockets that hand out identity, allows a container socket with its warning", () => {
    const agent = join(scratch, "ssh-agent.sock");
    const docker = join(scratch, "docker.sock");
    writeFileSync(agent, "");
    writeFileSync(docker, "");
    expect(blocked(resolveCapabilityId(`unix-socket:${agent}`))).toMatch(/not grantable/);
    const cap = parseCapabilityId(`unix-socket:${docker}`)!;
    expect(cap.lines).toEqual([`(allow network-outbound (remote unix-socket (path-literal "${docker}")))`]);
    expect(cap.risk).toMatch(/control of the machine/);
  });
});

describe("resolveStoredGrants", () => {
  it("keeps good ids and warns for each one it drops", () => {
    const dir = join(scratch, "kept");
    mkdirSync(dir);
    const { grants, warnings } = resolveStoredGrants([`write:${dir}`, "bogus", "mach:com.apple.tccd"]);
    expect(grants.map((g) => g.id)).toEqual([`write:${dir}`]);
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain("unknown capability");
    expect(warnings[1]).toContain("not grantable");
    expect(resolveStoredGrants(undefined)).toEqual({ grants: [], warnings: [] });
  });
});

describe("capabilityFor", () => {
  it("grants the directory the command worked in, not the coarse group key", () => {
    const dir = join(scratch, "build");
    mkdirSync(join(dir, "a"), { recursive: true });
    const one = capabilityFor(group({ key: "/private/tmp", samples: [join(dir, "out.txt")] }));
    expect(one).toMatchObject({ id: `write:${dir}` });
    const many = capabilityFor(group({ samples: [join(dir, "a", "x"), join(dir, "b")] }));
    expect(many).toMatchObject({ id: `write:${dir}` });
  });

  it("maps services, sockets and loopback", () => {
    expect(capabilityFor(group({ opClass: "mach", key: "com.apple.foo", samples: ["com.apple.foo"] }))).toMatchObject({ id: "mach:com.apple.foo" });
    expect(blocked(capabilityFor(group({ opClass: "mach", key: "com.apple.tccd" })))).toBeDefined();
    const sock = join(scratch, "x.sock");
    writeFileSync(sock, "");
    expect(capabilityFor(group({ opClass: "network", key: sock }))).toMatchObject({ id: `unix-socket:${sock}` });
    expect(capabilityFor(group({ opClass: "network", key: "remote ip 127.0.0.1:5432" }))).toMatchObject({ id: "local-network" });
    expect(capabilityFor(group({ opClass: "network", key: "remote ip 93.184.216.34:443" }))).toBeNull();
  });

  itOnDarwin("maps Chrome's services to the browser capability", () => {
    expect(capabilityFor(group({ opClass: "mach", key: "com.apple.windowserver.active" }))).toMatchObject({ id: "browser" });
    expect(capabilityFor(group({ opClass: "mach", key: "com.google.Chrome.MachPortRendezvousXYZ" }))).toMatchObject({ id: "browser" });
  });

  it("offers nothing for exec, other classes, or a group without a usable path", () => {
    expect(capabilityFor(group({ opClass: "exec", samples: ["/opt/x"] }))).toBeNull();
    expect(capabilityFor(group({ opClass: "other" }))).toBeNull();
    expect(capabilityFor(group({ samples: [] }))).toBeNull();
    expect(capabilityFor(group({ samples: ["(unprintable name)"] }))).toBeNull();
  });
});

describe("isActionable", () => {
  const ok = { evidence: "", failed: false };
  const home = homedir();

  it("certain writes, services and network are always worth asking about", () => {
    expect(isActionable(group({ opClass: "write", samples: ["/opt/x"] }), ok)).toBe(true);
    expect(isActionable(group({ opClass: "mach", key: "svc" }), ok)).toBe(true);
    expect(isActionable(group({ opClass: "network", key: "/s" }), ok)).toBe(true);
    expect(isActionable(group({ opClass: "other" }), ok)).toBe(false);
  });

  it("reads count only when the command failed and the path is under home", () => {
    const read = group({ opClass: "read", samples: [join(home, "proj", "f")] });
    expect(isActionable(read, ok)).toBe(false);
    expect(isActionable(read, { ...ok, failed: true })).toBe(true);
    expect(isActionable(group({ opClass: "read", samples: ["/etc/hosts"] }), { ...ok, failed: true })).toBe(false);
  });

  it("a probable file denial needs its path in the command or output", () => {
    const g = group({ probable: true, samples: ["/opt/nib-x"] });
    expect(isActionable(g, ok)).toBe(false);
    expect(isActionable(g, { evidence: "touch /opt/nib-x 2>/dev/null", failed: false })).toBe(true);
    expect(isActionable(g, { evidence: "touch /opt/other", failed: true })).toBe(false);
  });

  it("a probable service or socket is never worth asking about", () => {
    expect(isActionable(group({ probable: true, opClass: "mach", key: "com.apple.diagnosticd" }), { evidence: "com.apple.diagnosticd", failed: true })).toBe(false);
    expect(isActionable(group({ probable: true, opClass: "network", key: "/s.sock" }), { evidence: "/s.sock", failed: true })).toBe(false);
  });
});

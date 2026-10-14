import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, sep } from "node:path";
import { quoteForDisplay, type DenialGroup } from "./denials.js";
import {
  BROWSER_MACH_SERVICES,
  LOOPBACK_NETWORK_ALLOWS,
  TOOLCHAIN_CONFIG_WRITE_DENIES,
  TOOLCHAIN_SECRET_DENIES,
  browserAllowLines,
  darwinUserTempDir,
  sbplQuote,
  type CapabilityGrant,
} from "./seatbelt.js";

/**
 * Named things a sandboxed command can be allowed to do beyond the default
 * profile. The sandbox reports a denial (sandbox/denials.ts); the model asks;
 * the user approves once, for the session or for good. The model never grants
 * and the user never has to write SBPL.
 *
 * Ids are what `sandbox.grants` stores:
 *   write:<dir>  read:<dir>  browser  local-network  unix-socket:<path>  mach:<service>
 */
export type CapabilityId = string;

export interface Capability {
  id: CapabilityId;
  title: string;
  /** One sentence on what this lets a command do — shown at the prompt. */
  risk: string;
  /** The SBPL this adds, shown verbatim at the prompt. */
  lines: string[];
}

export interface Blocked {
  blocked: string;
}

/**
 * Services whose lookup would let a command act as the user outside the
 * sandbox: drive other apps (Apple Events), read the Keychain, the clipboard,
 * grant itself TCC permissions, or talk to launchd. Matched as substrings of
 * the service name; none of Chrome's launch needs is among them (seatbelt.ts).
 */
export const NEVER_GRANTABLE_SERVICES = [
  "appleevents", "SecurityServer", "securityd", "tccd", "CoreAuthentication", "pasteboard",
  "com.apple.dock", "usernoted", "systemuiserver", "launchd", "bootstrap", "ctkd",
  "accessibility", "universalaccess",
] as const;

/** Home-relative trees that hold credentials or persistence points. */
const NEVER_HOME_TREES = [
  ".ssh", ".aws", ".gnupg", ".nib", "Library/Keychains", "Library/LaunchAgents",
  ...TOOLCHAIN_SECRET_DENIES, ...TOOLCHAIN_CONFIG_WRITE_DENIES,
] as const;

/** System trees, and the executables other programs run from. */
const NEVER_SYSTEM_TREES = [
  "/System", "/usr", "/bin", "/sbin", "/etc", "/private/etc", "/Library", "/Applications",
  "/opt/homebrew", "/private/var/db", "/private/var/root",
] as const;

/** Too broad to grant in themselves, though not forbidden as parents of something narrower. */
const NEVER_EXACT = ["/", "/Users", "/Volumes", "/private", "/private/var", "/var"] as const;

/** Sockets that hand out the user's identity or the whole machine's control. */
const NEVER_SOCKET_NAMES = /agent|launchd|Listeners|keychain|securityd|gpg|tccd/i;

const SAFE_SERVICE = /^[A-Za-z0-9._@-]{1,200}$/;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

function homeDir(): string {
  try {
    return realpathSync(homedir());
  } catch {
    return homedir();
  }
}

const inside = (path: string, tree: string): boolean => path === tree || path.startsWith(tree + sep);

/** Why `dir` (already realpath-resolved) must never be granted, or null. */
function blockedDirReason(dir: string, home: string): string | null {
  if (!dir.startsWith("/") || CONTROL_CHARS.test(dir)) return "not a usable absolute path";
  if ((NEVER_EXACT as readonly string[]).includes(dir)) return "too broad";
  // The home directory, and everything above it.
  if (inside(home, dir)) return "contains your home directory";
  for (const tree of NEVER_SYSTEM_TREES) {
    if (inside(dir, tree) || inside(tree, dir)) return "a system or program directory";
  }
  for (const rel of NEVER_HOME_TREES) {
    const tree = join(home, rel);
    if (inside(dir, tree) || inside(tree, dir)) return "holds credentials or startup configuration";
  }
  if (dir.split(sep).includes(".git")) return "a Git metadata directory";
  return null;
}

function realDir(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

function pathCapability(kind: "write" | "read", raw: string): Capability | Blocked {
  // Absolute only: realpath of "" or a relative path resolves against the cwd.
  if (!raw.startsWith("/") || CONTROL_CHARS.test(raw)) return { blocked: "not a usable absolute path" };
  const real = realDir(raw);
  if (real === null) return { blocked: "the directory does not exist" };
  const why = blockedDirReason(real, homeDir());
  if (why) return { blocked: `${quoteForDisplay(real)} is not grantable: ${why}` };
  const q = sbplQuote(real);
  return kind === "write"
    ? {
        id: `write:${real}`,
        title: `Write to ${quoteForDisplay(real)}`,
        risk: `Commands can create, change and delete any file under ${quoteForDisplay(real)}, including files other programs later run or read.`,
        lines: [`(allow file-write* (subpath "${q}"))`],
      }
    : {
        id: `read:${real}`,
        title: `Read ${quoteForDisplay(real)}`,
        risk: `Commands can read any file under ${quoteForDisplay(real)}, including credentials stored there.`,
        lines: [`(allow file-read* (subpath "${q}"))`],
      };
}

function socketCapability(raw: string): Capability | Blocked {
  if (!raw.startsWith("/") || CONTROL_CHARS.test(raw)) return { blocked: "not a usable absolute socket path" };
  const real = realDir(raw);
  if (real === null) return { blocked: "the socket does not exist" };
  const home = homeDir();
  if (NEVER_SOCKET_NAMES.test(basename(real)) || NEVER_SOCKET_NAMES.test(basename(dirname(real)))) {
    return { blocked: `${quoteForDisplay(real)} is not grantable: it hands out your identity or controls the system` };
  }
  for (const tree of [...NEVER_HOME_TREES.map((r) => join(home, r)), ...NEVER_SYSTEM_TREES]) {
    if (inside(real, tree)) return { blocked: `${quoteForDisplay(real)} is not grantable: it lives in a protected place` };
  }
  return {
    id: `unix-socket:${real}`,
    title: `Connect to ${quoteForDisplay(real)}`,
    risk: `Commands can use whatever listens on ${quoteForDisplay(real)} with all the access that service has — for a container runtime's socket, that is control of the machine.`,
    lines: [`(allow network-outbound (remote unix-socket (path-literal "${sbplQuote(real)}")))`],
  };
}

function machCapability(service: string): Capability | Blocked {
  if (!SAFE_SERVICE.test(service)) return { blocked: "not a usable service name" };
  const hit = NEVER_GRANTABLE_SERVICES.find((n) => service.toLowerCase().includes(n.toLowerCase()));
  if (hit) return { blocked: `${quoteForDisplay(service)} is not grantable: it would let a command act as you outside the sandbox` };
  return {
    id: `mach:${service}`,
    title: `Look up ${quoteForDisplay(service)}`,
    risk: `Commands can send requests to the macOS service ${quoteForDisplay(service)}.`,
    lines: [`(allow mach-lookup (global-name "${sbplQuote(service)}"))`],
  };
}

function browserCapability(): Capability | Blocked {
  if (process.platform !== "darwin") return { blocked: "only available on macOS" };
  return {
    id: "browser",
    title: "Run a headless browser",
    risk: "Headless Chrome can reach the window server and the system services it needs to start (not Apple Events, the clipboard or the Keychain).",
    lines: browserAllowLines(darwinUserTempDir()),
  };
}

function localNetworkCapability(): Capability {
  return {
    id: "local-network",
    title: "Reach services on this Mac",
    risk: "Commands can connect to any service listening on localhost — databases, a container runtime's API, a local proxy that itself has internet access.",
    lines: [...LOOPBACK_NETWORK_ALLOWS],
  };
}

function build(kind: string, value: string): Capability | Blocked | null {
  switch (kind) {
    case "write":
    case "read":
      return pathCapability(kind, value);
    case "unix-socket":
      return socketCapability(value);
    case "mach":
      return machCapability(value);
    case "browser":
      return value === "" ? browserCapability() : null;
    case "local-network":
      return value === "" ? localNetworkCapability() : null;
    default:
      return null;
  }
}

/** A capability from its stored id — `{ blocked }` says why one that parses must not be granted. */
export function resolveCapabilityId(id: string): Capability | Blocked | null {
  if (typeof id !== "string" || id.length > 1100) return null;
  const colon = id.indexOf(":");
  return colon === -1 ? build(id, "") : build(id.slice(0, colon), id.slice(colon + 1));
}

/** The capability for a stored id, or null when it is unknown, malformed or not grantable. */
export function parseCapabilityId(id: string): Capability | null {
  const r = resolveCapabilityId(id);
  return r !== null && !("blocked" in r) ? r : null;
}

/** `sandbox.grants` entries ready for `configureSandbox`, plus a warning for each that was dropped. */
export function resolveStoredGrants(ids: readonly string[] | undefined): { grants: CapabilityGrant[]; warnings: string[] } {
  const grants: CapabilityGrant[] = [];
  const warnings: string[] = [];
  for (const id of ids ?? []) {
    const r = resolveCapabilityId(id);
    if (r === null) warnings.push(`sandbox.grants: unknown capability ${quoteForDisplay(String(id))} was ignored`);
    else if ("blocked" in r) warnings.push(`sandbox.grants: ${quoteForDisplay(String(id))} was ignored — ${r.blocked}`);
    else grants.push({ id: r.id, lines: r.lines });
  }
  return { grants, warnings };
}

function commonDir(paths: string[]): string {
  let parts = dirname(paths[0]).split(sep);
  for (const p of paths.slice(1)) {
    const other = dirname(p).split(sep);
    let i = 0;
    while (i < parts.length && i < other.length && parts[i] === other[i]) i++;
    parts = parts.slice(0, i);
  }
  return parts.join(sep) || sep;
}

const isLoopback = (target: string): boolean => /(?:^|[\s:])(?:localhost|127\.\d+\.\d+\.\d+|\[?::1\]?)(?::|\b)/.test(target);

/** What would stop this denial, as a capability — `{ blocked }` when it must not be granted, null when nothing maps to it. */
export function capabilityFor(group: DenialGroup): Capability | Blocked | null {
  switch (group.opClass) {
    case "write":
    case "read": {
      const targets = group.samples.filter((s) => s.startsWith("/"));
      if (targets.length === 0) return null;
      // The directory the command was working in, not the whole coarse key.
      return pathCapability(group.opClass, commonDir(targets));
    }
    case "mach": {
      const service = group.key;
      if (service.startsWith("com.google.Chrome.") || (BROWSER_MACH_SERVICES as readonly string[]).includes(service)) {
        const blocked = NEVER_GRANTABLE_SERVICES.some((n) => service.toLowerCase().includes(n.toLowerCase()));
        if (!blocked) return browserCapability();
      }
      return machCapability(service);
    }
    case "network":
      if (group.key.startsWith("/")) return socketCapability(group.key);
      return isLoopback(group.key) ? localNetworkCapability() : null;
    default:
      return null;
  }
}

/**
 * Whether a denial is worth asking the user about. Reading outside what a
 * build needs is often probing that failed harmlessly, so a read counts only
 * when the command failed and the path is under $HOME (outside it, reads are
 * not contained anyway). A `probable` group (attributed by elimination, so
 * possibly another process's) counts only for files, and only when the path
 * appears in the command or its output — a stranger's `mach-lookup` never will.
 */
export function isActionable(group: DenialGroup, ctx: { evidence: string; failed: boolean }): boolean {
  if (group.probable) {
    if (group.opClass !== "write" && group.opClass !== "read" && group.opClass !== "exec") return false;
    if (!group.samples.some((s) => s.startsWith("/") && ctx.evidence.includes(s))) return false;
  }
  switch (group.opClass) {
    case "write":
    case "mach":
    case "exec":
    case "network":
      return true;
    case "read":
      return ctx.failed && group.samples.some((s) => s === homeDir() || s.startsWith(homeDir() + sep));
    default:
      return false;
  }
}

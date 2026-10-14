import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { ProfileLevel } from "../permissions/index.js";
import { realpathNearestAncestor, resolveWriteRoots } from "./write-roots.js";

/**
 * macOS Seatbelt (sandbox-exec) profile generation — the *mechanical* layer
 * under the PermissionProfile policy (permission-profile.md §8, phase (e)).
 *
 * The policy layer (ProfileEvaluator, src/permissions/profile.ts) decides
 * allow/deny per call; the Seatbelt layer makes the level's defaults hold in
 * the OS for bash children: strict-sandbox = read-only fs + no network,
 * workspace-write = write only workspace roots + outbound network over IP
 * (on by default since 2026-10-11, {@link NETWORK_OUTBOUND_ALLOWS}), with
 * deliberate, battery-proven carve-outs to the write boundary. Which
 * carve-outs are emitted depends on the caller: a launch that supplies a
 * session temp dir (what every production launch does — see
 * src/exec-runner.ts) gets the workspace root plus that private directory
 * and nothing else, while the fallback in write-roots.ts's
 * `workspaceWriteCarveoutRoots` additionally emits literal /tmp, the host
 * $TMPDIR, and ~/.npm. Measured 2026-09-16 by diffing the generated
 * profiles of the two forms. The .git always-denied set is expressed
 * here as well ({@link GIT_INTEGRITY_DENIES}): the policy layer denies
 * `.git/**` for the calls it sees, but an interpreter or package script is
 * not a call it sees, and the release-gate probe measured both writing
 * `.git/hooks`.
 *
 * Seatbelt cannot safely enforce hostname allowlists because it filters
 * resolved IPs, not hostnames. workspace-write therefore allows any IP
 * destination rather than pretending to scope it (user decision 2026-10-11);
 * a host-scoped policy would need the future network broker. strict-sandbox
 * is the no-network level.
 *
 * macOS-only. On any other platform `sandboxPrefix` returns null (plain
 * spawn args, policy-only) — the loader emits a one-time startup notice
 * when `sandbox.enabled` is set on a non-macOS host.
 */

/** Levels that get a Seatbelt profile. `unrestricted` never does (no prefix). */
export type SandboxLevel = "strict-sandbox" | "workspace-write";

export interface SandboxSpawn {
  /** Executable to spawn: /usr/bin/sandbox-exec on macOS. */
  file: string;
  /** Full argv: ["-p", "<profile>", "/bin/sh", "-c", command]. */
  args: string[];
}

const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

/**
 * Core every sandboxed level shares: deny default, then read-only fs plus
 * the plumbing a basic command needs (exec/map executable, sysctl). The
 * single write carve-out is `/dev/null` — `2>/dev/null` redirects are
 * ubiquitous (even the Xcode `git` shim does one internally) and the
 * write is a discard, not a filesystem write. Every other write stays
 * denied at this layer.
 */
const READ_ONLY_CORE = [
  "(allow process*)",
  "(allow file-read*)",
  "(allow file-map-executable)",
  "(allow sysctl-read)",
  '(allow file-write* (literal "/dev/null"))',
  // `file-read-metadata` (stat/lstat/getattr) is allowed everywhere, and the
  // child read boundary below subtracts from `file-read*`/`file-read-data`.
  // This split is load-bearing, not incidental: path resolution and Node's
  // module resolution walk *parent* components and lstat them, so denying
  // metadata for $HOME makes `node node_modules/...` and even `ls -la` die
  // with EPERM ("lstat '/Users/<user>': operation not permitted") — measured
  // 2026-09-16. Metadata is not content, and readdir stays denied (it is
  // file-read-data on the directory), so names/existence leak but contents
  // and listings do not.
  "(allow file-read-metadata)",
];

/**
 * The one deliberate hole in the child read boundary: narrow `$HOME`
 * subpaths a child may still read, because Git and npm cannot run without
 * them. Git reads its config to resolve identity and includes; npm reads its
 * cache during install (npm also *writes* that cache, but only in a launch
 * that passes no session temp dir — production redirects the cache into the
 * session directory instead, so `~/.npm` is a read re-allow and not a
 * production write root).
 *
 * Everything else under `$HOME` is unreadable to a sandboxed child:
 * credentials, SSH/GPG material, browser data, shell startup files, and —
 * the case the release gate actually failed on — *sibling project
 * directories*. Keep this list tiny; each entry is a confidentiality
 * exception and needs evidence that a real workflow requires it.
 */
const HOME_READ_ALLOWS = [".gitconfig", ".config/git", ".npm", ".cache"] as const;

/**
 * Toolchain installs under `$HOME` a sandboxed build must read: a JDK from
 * SDKMAN (`java` dies loading `libjli.dylib` otherwise), Rust, bun, Dart/
 * Flutter packages, Maven/Gradle caches, the Android SDK, CocoaPods, and the
 * version managers. Read-only here; absent entries are skipped like
 * {@link HOME_READ_ALLOWS}. `~/.android` is deliberately absent — it holds
 * `adbkey`, a private key. Added 2026-10-10 after Gradle failed in a real
 * session; credentials inside these folders are re-denied by
 * {@link TOOLCHAIN_SECRET_DENIES}.
 */
const TOOLCHAIN_READ_ALLOWS = [
  ".sdkman", ".gradle", ".m2", ".rustup", ".cargo", ".bun", ".local/bin", ".pub-cache",
  ".cocoapods", "Library/Android/sdk", "Library/Caches/CocoaPods",
  ".nvm", ".volta", ".pyenv", ".rbenv", ".asdf", "go", "fvm",
] as const;

/**
 * Build caches a sandboxed build must also write (`./gradlew` cannot start
 * without lock files in `~/.gradle`). `[toolchainDir, writeRoot]`: the root is
 * granted only when its toolchain directory exists, so a missing toolchain
 * adds nothing to the profile. Accepted risk (user decision 2026-10-10): a
 * child can tamper with cached packages a later build uses — the same class
 * as the `~/.npm` cache. Binaries (`~/.cargo/bin`, `~/.pub-cache/bin`) stay
 * read-only: writing those is direct persistence.
 */
const TOOLCHAIN_WRITE_ROOTS: ReadonlyArray<readonly [string, string]> = [
  [".gradle", ".gradle"],
  [".m2", ".m2/repository"],
  [".cargo", ".cargo/registry"],
  [".cargo", ".cargo/git"],
  [".pub-cache", ".pub-cache/hosted"],
  [".pub-cache", ".pub-cache/git"],
  [".bun", ".bun/install/cache"],
  ["Library/Caches/CocoaPods", "Library/Caches/CocoaPods"],
];

/**
 * Build config the tools must READ on every run but a child must never
 * WRITE: write-denied only, after every allow (SBPL is last-matching-rule-
 * wins). Gradle refuses to start when an existing `gradle.properties` is
 * unreadable (measured 2026-10-10), so these stay readable even though they
 * often hold repository credentials — user decision. Writing them, or an
 * init script, would run code on every later build: persistence.
 */
export const TOOLCHAIN_CONFIG_WRITE_DENIES = [
  ".gradle/gradle.properties", ".gradle/init.d", ".gradle/init.gradle", ".gradle/init.gradle.kts",
  ".m2/settings.xml", ".m2/settings-security.xml",
] as const;

/**
 * Denied for read AND write. Registry tokens are read only by publish/login,
 * so an ordinary build never needs them. `~/.gradle/daemon` holds the
 * registry (ports + auth tokens) of Gradle daemons running OUTSIDE the
 * sandbox — an IDE's, a terminal's; with loopback allowed a child could read
 * it, connect, and have that daemon run build code unsandboxed. Sandboxed
 * Gradle gets a private registry instead ({@link withSandboxChildEnv}).
 * Measured 2026-10-10: with an outside daemon running, the contained build
 * used its own daemon and the outside registry read was denied.
 */
export const TOOLCHAIN_SECRET_DENIES = [
  ".cargo/credentials", ".cargo/credentials.toml",
  ".pub-cache/credentials.json",
  ".gradle/daemon",
] as const;

/** Write roots for the toolchain caches whose toolchain directory exists under `home`. */
export function toolchainWriteRoots(home: string = homedir()): string[] {
  const roots: string[] = [];
  for (const [toolchain, root] of TOOLCHAIN_WRITE_ROOTS) {
    if (existsSync(join(home, toolchain))) roots.push(join(home, root));
  }
  return roots;
}

/**
 * Startup options from the global-only `sandbox.readRoots` and
 * `sandbox.allowLocalNetwork` settings, set once (cli.tsx, exec-runner.ts)
 * before any profile is built so every launch — Bash, jobs, MCP, hooks — and
 * the session-grant hash see the same profile.
 */
let extraReadRoots: string[] = [];
let allowLocalNetwork = true;
let browserAllows: string[] = [];
/** A capability the user granted: its id and the SBPL it adds (sandbox/capabilities.ts). */
export interface CapabilityGrant {
  id: string;
  lines: string[];
}
let persistedGrants: CapabilityGrant[] = [];
const sessionGrants = new Map<string, string[]>();
export function configureSandbox(opts: { readRoots?: string[]; allowLocalNetwork?: boolean; allowBrowser?: boolean; grants?: CapabilityGrant[] }): void {
  extraReadRoots = (opts.readRoots ?? []).map((p) =>
    p === "~" || p.startsWith("~/") ? join(homedir(), p.slice(1)) : resolve(p),
  );
  allowLocalNetwork = opts.allowLocalNetwork !== false;
  browserAllows = opts.allowBrowser !== false && process.platform === "darwin" ? browserAllowLines(darwinUserTempDir()) : [];
  persistedGrants = opts.grants ?? [];
  sessionGrants.clear();
}

/**
 * Add a capability for the rest of the session (the user approved it at the
 * prompt). Changes every profile built afterwards — and therefore the envelope
 * hash, which the caller must renew for any grant that covered the old one.
 */
export function grantCapability(grant: CapabilityGrant): void {
  sessionGrants.set(grant.id, grant.lines);
}

/** Drop every grant made this session; persisted ones (`sandbox.grants`) stay. */
export function revokeSessionGrants(): void {
  sessionGrants.clear();
}

/** Ids of the capabilities in force, persisted first. */
export function activeGrants(): string[] {
  return [...new Set([...persistedGrants.map((g) => g.id), ...sessionGrants.keys()])];
}

function grantLines(): string[] {
  const byId = new Map<string, string[]>();
  for (const g of persistedGrants) byId.set(g.id, g.lines);
  for (const [id, lines] of sessionGrants) byId.set(id, lines);
  return [...byId.values()].flat();
}

/** Whether the browser rules are on (`sandbox.allowBrowser`, default on) — for the session-grant consent text. */
export function sandboxAllowsBrowser(): boolean {
  return browserAllows.length > 0;
}

/**
 * Headless Chrome for workspace-write children (`sandbox.allowBrowser`, default
 * on, `false` opts out): Playwright/Puppeteer tests launch it, and
 * without these rules Chrome aborts in `HIServices _RegisterApplication` the
 * moment it starts — macOS shows a "quit unexpectedly" dialog per launch.
 * Measured 2026-10-14 by leave-one-out against the real workspace-write
 * profile: each group below is required, and with them Playwright launches
 * `channel: 'chrome'` and renders a page. Chrome's own sandbox must be off
 * (`--no-sandbox`, Playwright's `chromiumSandbox: false`): macOS refuses a
 * nested sandbox_init, so it cannot start inside this one — nib's profile
 * still contains the whole browser.
 *
 * Services are named, never `(allow mach-lookup)`. Left out on purpose, and
 * not needed by Chrome: Apple Events (drives other apps), the pasteboard,
 * SecurityServer (Keychain), CoreAuthentication, the Dock, usernoted, tccd.
 * Risk accepted: a child can talk to the window server and the listed system
 * daemons; screen capture and synthetic input stay behind TCC.
 *
 * Default on because the rules are not an escape hatch: checked 2026-10-14
 * under nib's real profile, `open -a`, `open x.command`, `osascript` and
 * `launchctl submit` are all still refused.
 */
export const BROWSER_MACH_SERVICES = [
  "com.apple.windowserver.active", "com.apple.window_proxies", "com.apple.windowmanager.server",
  "com.apple.CARenderServer", "com.apple.MTLCompilerService", "com.apple.fonts",
  "com.apple.coreservices.launchservicesd", "com.apple.CoreServices.coreservicesd",
  "com.apple.lsd.mapdb", "com.apple.hiservices-xpcservice",
  "com.apple.cfprefsd.daemon", "com.apple.cfprefsd.agent",
  "com.apple.logd", "com.apple.diagnosticd",
  "com.apple.system.notification_center", "com.apple.distributed_notifications@Uv3",
  "com.apple.system.opendirectoryd.libinfo", "com.apple.system.opendirectoryd.membership",
  "com.apple.SystemConfiguration.configd", "com.apple.SystemConfiguration.DNSConfiguration",
  "com.apple.PowerManagement.control",
] as const;

/**
 * The rules for {@link BROWSER_MACH_SERVICES}, plus Chrome's ProcessSingleton
 * directory and socket: `<DARWIN_USER_TEMP_DIR>/com.google.Chrome.*`, which
 * Chrome creates there regardless of TMPDIR.
 */
export function browserAllowLines(userTempDir: string): string[] {
  // `#"…"` is a raw SBPL string: backslashes reach the regex as written.
  const singleton = `^${regexEscape(userTempDir)}/com\\.google\\.Chrome\\.[^/]+(/.*)?$`;
  return [
    `(allow mach-lookup ${BROWSER_MACH_SERVICES.map((n) => `(global-name "${n}")`).join(" ")} (global-name-prefix "com.google.Chrome."))`,
    `(allow mach-register (global-name-prefix "com.google.Chrome.") (global-name "com.apple.tsm.portname") (global-name "com.apple.axserver"))`,
    `(allow iokit-open-user-client (iokit-user-client-class "IOSurfaceRootUserClient" "AGXDeviceUserClient" "RootDomainUserClient"))`,
    `(allow file-write* (regex #"${singleton}"))`,
    `(allow network-bind network-outbound (local unix-socket (path-regex #"${singleton}")) (remote unix-socket (path-regex #"${singleton}")))`,
  ];
}

/** Per-user temp dir (`/private/var/folders/…/T`), realpath-resolved. */
export function darwinUserTempDir(): string {
  const raw = execFileSync("getconf", ["DARWIN_USER_TEMP_DIR"], { encoding: "utf8" }).trim();
  return realpathSync(raw).replace(/\/+$/, "");
}

function regexEscape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Loopback networking for workspace-write children (default on, user decision
 * 2026-10-10): Gradle's client reaches its build daemon over 127.0.0.1 and
 * coordinates file locks over a loopback UDP socket, so a build cannot start
 * without it. Loopback is separate from {@link NETWORK_OUTBOUND_ALLOWS}: with
 * `sandbox.allowLocalNetwork: false` other hosts stay reachable while
 * 127.0.0.1 is denied. Risk accepted: a
 * child can reach any service listening on localhost (databases, Docker's
 * API, a local proxy that itself has egress). Opt out with
 * `sandbox.allowLocalNetwork: false`.
 */
export const LOOPBACK_NETWORK_ALLOWS = [
  `(allow network-bind (local ip "localhost:*"))`,
  `(allow network-inbound (local ip "localhost:*"))`,
  `(allow network-outbound (remote ip "localhost:*"))`,
];

/**
 * Outbound network for workspace-write children (default on, user decision
 * 2026-10-11): package installs, API calls and git over https just work.
 * Scoped to IP destinations plus the mDNSResponder socket name resolution
 * goes through — never an unscoped `network-outbound`, which also opens every
 * Unix-domain socket (Docker's API socket is host root). Measured 2026-10-11:
 * curl and Python reach https hosts; a Unix socket under $HOME is EPERM.
 * Risk accepted: a child can send anything it can read — project files,
 * `.env` included — to any host. strict-sandbox stays no-network.
 */
const NETWORK_OUTBOUND_ALLOWS = [
  `(allow network-outbound (remote ip "*:*"))`,
  `(allow network-outbound (remote unix-socket (path-literal "/private/var/run/mDNSResponder")))`,
];

/** `sandbox.allowLocalNetwork: false` with the network on: loopback stays shut. */
const LOOPBACK_OUTBOUND_DENY = `(deny network-outbound (remote ip "localhost:*"))`;

/**
 * JVM flags for a contained child, appended to any JAVA_TOOL_OPTIONS the user
 * already has:
 *   - a private Gradle daemon registry in the session temp dir, because
 *     `~/.gradle/daemon` is denied ({@link TOOLCHAIN_SECRET_DENIES}) — the
 *     contained build starts and finds only its own daemons;
 *   - with loopback allowed, Java forced onto IPv4: its default dual-stack
 *     sockets reach Seatbelt in a form the `localhost` rule does not match
 *     (measured: Gradle's daemon connect to 127.0.0.1 is denied without it).
 */
export function withSandboxChildEnv(env: NodeJS.ProcessEnv | undefined): NodeJS.ProcessEnv | undefined {
  const base = env ?? process.env;
  const flags: string[] = [];
  if (base.TMPDIR) flags.push(`-Dorg.gradle.daemon.registry.base=${join(base.TMPDIR, "gradle-daemon")}`);
  if (allowLocalNetwork) flags.push("-Djava.net.preferIPv4Stack=true");
  const existing = base.JAVA_TOOL_OPTIONS;
  const missing = flags.filter((f) => !existing?.includes(f));
  if (missing.length === 0) return env;
  return { ...base, JAVA_TOOL_OPTIONS: [existing, ...missing].filter(Boolean).join(" ") };
}

/** Deny lines for the toolchain config/secret lists under `home`. */
export function toolchainSecretDenyLines(home: string): string[] {
  return [
    ...TOOLCHAIN_CONFIG_WRITE_DENIES.map((name) => `(deny file-write* (subpath "${sbplQuote(join(home, name))}"))`),
    ...TOOLCHAIN_SECRET_DENIES.map((name) => `(deny file-read* file-write* (subpath "${sbplQuote(join(home, name))}"))`),
  ];
}

/**
 * Gradle's own *executables* under `$HOME`, which {@link TOOLCHAIN_WRITE_ROOTS}
 * makes writable as a whole (`~/.gradle` is granted because `./gradlew` needs
 * the lock files beside each distribution). Three of its children are load-
 * bearing for a LATER, unsandboxed build:
 *
 *   - `wrapper/dists/<dist>/<hash>/gradle-<version>` — the extracted
 *     distribution `./gradlew` execs;
 *   - `native` — extracted native libraries the daemon loads;
 *   - `jdks` — toolchains Gradle auto-provisions and later builds compile with.
 *
 * Writing them is persistence into later builds: unlike a poisoned package
 * cache, these files are *run*, not merely read. The extracted distribution
 * directories are enumerated at profile-build time rather than expressed as a
 * regex, because the hashed `<hash>` level is not regex-expressible without
 * also matching the sibling `*.zip.lck` / `*.zip.ok` files Gradle must write —
 * a regex re-allow for those was measured to stay denied (2026-10-10). Left
 * writable by construction here: the lock/marker siblings sit outside every
 * `gradle-*` directory, so `./gradlew` still starts.
 *
 * `native` needs one exception, measured rather than assumed (2026-10-10):
 * denying the tree outright makes Gradle fail before the build with "Could not
 * initialize native services" — it takes an exclusive lock on a 0-byte
 * `<lib>.lock` beside each extracted library, and `FileChannel.lock` needs that
 * file writable. {@link GRADLE_NATIVE_LOCK_ALLOW} re-allows exactly those lock
 * files after the deny, so the libraries themselves stay unwritable while the
 * daemon can still start; a full sandboxed `./gradlew test` then passes with
 * the deny active.
 */
export function gradleExecutableDenyLines(home: string): string[] {
  return gradleExecutableDirs(home).map((p) => `(deny file-write* (subpath "${sbplQuote(p)}"))`);
}

/**
 * The one write the `native` deny must leave open: Gradle's native services
 * lock a 0-byte `<lib>.lock` beside each extracted library, which
 * `FileChannel.lock` requires writable. Those files are lock targets, not
 * loaded code, so re-allowing them costs nothing — emitted only under
 * workspace-write, where a write set exists for the deny to carve out of.
 * Strict-sandbox emits no allow at all, which its tests pin.
 */
export const GRADLE_NATIVE_LOCK_ALLOW = `(allow file-write* (regex "^.*/\\.gradle/native/.*\\.lock$"))`;

function gradleExecutableDirs(home: string): string[] {
  const gradle = join(home, ".gradle");
  const dirs: string[] = [];
  const dists = join(gradle, "wrapper", "dists");
  try {
    for (const dist of readdirSync(dists, { withFileTypes: true })) {
      if (!dist.isDirectory()) continue;
      const distDir = join(dists, dist.name);
      for (const hash of readdirSync(distDir, { withFileTypes: true })) {
        if (!hash.isDirectory()) continue;
        const hashDir = join(distDir, hash.name);
        for (const entry of readdirSync(hashDir, { withFileTypes: true })) {
          if (entry.isDirectory() && entry.name.startsWith("gradle-")) dirs.push(join(hashDir, entry.name));
        }
      }
    }
  } catch {
    // No wrapper distributions installed — nothing to deny.
  }
  for (const name of ["native", "jdks"]) {
    const dir = join(gradle, name);
    if (existsSync(dir)) dirs.push(dir);
  }
  return dirs;
}

/**
 * Git integrity rules — the mechanical half of the `.git` always-denied set.
 *
 * permission-profile.md §8 recorded this as a policy-layer-only residual: the
 * policy denies `.git/**` for the calls it sees, but an interpreter or a
 * package lifecycle script is not a call it sees. The release-gate probe
 * confirmed a Node child *and* an npm lifecycle script could each write
 * `.git/hooks` (2026-09-16). A hook runs on the next Git operation, so that
 * is a persistence escape, not only a confidentiality one.
 *
 * Denied: hook files (arbitrary code execution), `config` (remote
 * retargeting, and `credential.helper` / `core.hooksPath` injection), and
 * `credentials` (the store-fill target). Deliberately *not* denied: the
 * index, objects, refs, HEAD, and logs, so `add` / `commit` / `stash` /
 * `branch` / `tag` / `checkout` / `worktree` need no exception at all.
 *
 * The `(/.*)?` hop between `.git` and the leaf is load-bearing, not
 * stylistic. A submodule's gitdir lives at `.git/modules/<name>/` with its
 * own `hooks/` and `config`; a regex anchored on a literal `.git/hooks/` was
 * measured to miss both, leaving the escape open one level down. Linked
 * worktrees add no case of their own — `.git/worktrees/<name>/` holds no
 * hooks or config (the common dir does), so the same rule already covers it.
 *
 * Ordering is deliberate throughout: SBPL is last-matching-rule-wins, so
 * these lines must follow the write-root grants in
 * {@link buildSeatbeltProfile}, and the `.sample` allow must follow the
 * hooks deny. The allow exists because `git init` lays down the hook
 * templates, so denying every file under `hooks/` would break repository
 * creation for no security gain — a `.sample` file is never executed.
 *
 * A regex, not a fixed `<root>/.git` path, is required: nested repositories
 * and submodules live at arbitrary depth under any write root.
 *
 * The `hooks$` rule denies the hooks *directory node* as well as its files,
 * which is what stops the obvious end run: rename `.git/hooks` aside and
 * point a fresh `.git/hooks` symlink at a directory the child may write. The
 * regex matches the resolved path, so a hook written through such a symlink
 * would land at an ordinary workspace path and be permitted — measured
 * (2026-09-16). Denying the node closes the vector, because the child can no
 * longer create, rename, or remove anything named `.git/hooks`.
 *
 * Residual, not closed by path rules: a repository whose `.git/hooks` is
 * *already* a symlink to a directory outside `.git` (a shape a user can
 * create deliberately) still resolves hook writes to ordinary paths. Git
 * follows that link, so no path-based rule can distinguish it. Recorded in
 * docs/security-architecture-plan.md rather than claimed closed.
 *
 * Measured 2026-09-16 against this profile: Node, npm-script, and shell
 * redirects into hooks / config / credentials are all denied, including
 * through a nested repository and a submodule gitdir, while the ordinary Git
 * workflow battery still passes in full.
 */
const GIT_INTEGRITY_DENIES = [
  `(deny file-write* (regex "^.*/\\.git(/.*)?/hooks$"))`,
  `(deny file-write* (regex "^.*/\\.git(/.*)?/hooks/[^/]+$"))`,
  `(allow file-write* (regex "^.*/\\.git(/.*)?/hooks/[^/]+\\.sample$"))`,
  `(deny file-write* (regex "^.*/\\.git(/.*)?/config(\\.lock)?$"))`,
  `(deny file-write* (regex "^.*/\\.git(/.*)?/credentials$"))`,
];

/**
 * The approved-operation variant (release gate 2, trusted half): the narrow
 * route back for the five repository-creation/wiring workflows
 * {@link GIT_INTEGRITY_DENIES} breaks — all of which write `.git/config`.
 *
 * Reached only through an explicit one-time user approval of *that specific
 * command*: `ToolExecOptions.approvedGitConfigWrite`, set in agent.ts's ask
 * branch when `askUser` returned a plain `true` (never on auto-approve
 * posture, never on a persisted rule — see the field's doc comment), and
 * only for commands `isGitConfigOperation` accepts.
 *
 * Scope is the workspace root alone, deliberately — not the whole
 * `resolveWriteRoots` set. Measured consequence: an approved `git config`
 * still fails when it targets a repository under a configured external
 * write root, which is the fail-closed direction and is recorded in
 * docs/security-architecture-plan.md rather than widened away.
 *
 * Two allows, in this order, and both after the denies above:
 *   - `config` (and its `config.lock`) at any depth under the workspace, so
 *     `init`, `clone`, `remote add`, and `config <name> <value>` can write.
 *   - the `hooks` *directory node*, which `git init` must create to lay down
 *     its `.sample` templates. Hook *files* stay denied: the deny above is
 *     `hooks/[^/]+$` and this allow matches only the directory, so an
 *     approved `git init` cannot be turned into a hook write.
 *
 * `credentials` is not re-allowed, and neither is anything outside the
 * workspace.
 */
function gitConfigTrustedAllows(workspaceRoot: string): string[] {
  const ws = sbplQuote(regexQuote(workspaceRoot));
  return [
    `(allow file-write* (regex "^${ws}/(.*/)?\\.git(/.*)?/config(\\.lock)?$"))`,
    `(allow file-write* (regex "^${ws}/(.*/)?\\.git(/.*)?/hooks$"))`,
  ];
}

/**
 * Whether `$HOME` is a safe thing to subtract from `(allow file-read*)`.
 * A root of `/` (or an unset/garbage home) would make the deny rule swallow
 * the entire filesystem, including the toolchain and the workspace, so the
 * boundary is skipped entirely rather than emitted in a form that breaks
 * every command. Skipping is the honest degradation: no containment is
 * claimed for that session, matching the "sandbox unavailable" posture.
 */
function isUsableHomeDeny(home: string): boolean {
  return home.startsWith("/") && home !== "/" && home.split("/").length > 2;
}

/** Escapes a path for embedding in an SBPL double-quoted string. */
export function sbplQuote(path: string): string {
  return path.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * Escapes a path for use as a literal inside an SBPL `(regex "…")` pattern.
 * Applied *before* {@link sbplQuote}: the regex engine sees the decoded
 * string, so metacharacters in a workspace path must already be escaped by
 * the time the SBPL string is decoded — a workspace under a directory named
 * `foo+bar` or `a.b` must not match its neighbours.
 */
function regexQuote(path: string): string {
  return path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The SBPL profile source for a level, with the session workspace root
 * fixed at startup — never the per-call cwd (item 8.6) — as the
 * workspace-write write-set. `trustedRoot` is expected already
 * realpath-resolved (via {@link seatbeltWorkspaceRoot}); the sandbox
 * filters on resolved paths, so the subpath must be the physical form.
 * Verified empirically on macOS (2026-08-13): `ls`, `echo`, `git status`,
 * `node -e 'console.log(1)'` all run under the strict profile; writes and
 * network connects fail with EPERM-equivalent denials; the workspace-write
 * subpath is directory-boundary aware (a `(subpath "/a")` rule does not
 * match "/a2/..."). The carve-outs (temp + npm cache) are workspace-write
 * only, battery-proven 2026-08-15.
 *
 * `writeRoots` (optional) is the resolved-root list from
 * {@link resolveWriteRoots} (docs/unified-write-boundary.md) — the shared
 * source of truth also consulted by the file-tool containment check
 * (permissions/engine.ts), so a path either layer allows is allowed by the
 * other. When omitted, `resolveWriteRoots` is called here directly with no
 * configured `sandbox.writeRoots`, which reproduces exactly the trustedRoot +
 * carve-outs set this function has always emitted.
 */
export function buildSeatbeltProfile(
  level: SandboxLevel,
  trustedRoot: string,
  writeRoots?: string[],
  allowGitConfigWrite?: boolean,
): string {
  // The level's authorized write-set: empty for strict-sandbox, the shared
  // resolveWriteRoots set for workspace-write. The read boundary re-allows
  // reads for exactly this set, so the two layers stay in agreement about
  // which roots are "authorized" and strict-sandbox still ignores configured
  // writeRoots entirely (test: "emits no allow line even when a writeRoot is
  // configured").
  const roots = level === "workspace-write" ? (writeRoots ?? resolveWriteRoots(level, trustedRoot)) : [];
  const lines = ["(version 1)", "(deny default)", ...READ_ONLY_CORE];
  lines.push(...readBoundaryLines(trustedRoot, roots));
  for (const root of roots) {
    lines.push(`(allow file-write* (subpath "${sbplQuote(root)}"))`);
  }
  if (level === "workspace-write") {
    lines.push(...NETWORK_OUTBOUND_ALLOWS);
    // Last matching rule wins: the loopback deny must follow the IP allow.
    lines.push(...(allowLocalNetwork ? LOOPBACK_NETWORK_ALLOWS : [LOOPBACK_OUTBOUND_DENY]));
    lines.push(...browserAllows);
    // User-granted capabilities: after every default allow, and before the
    // toolchain secret and git denies below — last matching rule wins, so a
    // grant can never reopen what those protect.
    lines.push(...grantLines());
  }
  // Toolchain credentials/startup config: after every read and write allow.
  const home = realpathNearestAncestor(homedir());
  if (isUsableHomeDeny(home)) {
    lines.push(...toolchainSecretDenyLines(home));
    // Same reason: Gradle's extracted distributions/native/JDKs are writable
    // through the `~/.gradle` cache grant, so they must be re-denied after it.
    lines.push(...gradleExecutableDenyLines(home));
    // The `native` deny's one carve-out (see {@link GRADLE_NATIVE_LOCK_ALLOW}).
    if (level === "workspace-write") lines.push(GRADLE_NATIVE_LOCK_ALLOW);
  }
  // Git integrity last: last-matching-rule-wins means a deny only bites if it
  // follows the write-root grants above.
  lines.push(...GIT_INTEGRITY_DENIES);
  // The approved-operation variant must follow those denies to take effect.
  // workspace-write only: emitting it under strict-sandbox would widen a
  // read-only level into "may write .git/config", which is a different
  // level's contract, not this one's.
  if (allowGitConfigWrite && level === "workspace-write") {
    lines.push(...gitConfigTrustedAllows(trustedRoot));
  }
  return lines.join("\n");
}

/**
 * The child read boundary — SBPL's last-matching-rule-wins makes this an
 * ordering problem, so the sequence is deliberate:
 *
 *   1. `(allow file-read*)`      (in READ_ONLY_CORE) — toolchain + system work
 *   2. `(deny  file-read* $HOME)` — subtracts the whole home directory
 *   3. `(allow file-read* ...)`   — re-allows the workspace (which normally
 *                                   *lives under* $HOME) and the narrow
 *                                   {@link HOME_READ_ALLOWS} entries
 *
 * Emitted only when {@link isUsableHomeDeny} says `$HOME` is a real path.
 *
 * Scope note: this is a `$HOME`-shaped boundary, not a general filesystem
 * allowlist. Reads outside `$HOME` (system paths, temp, other volumes) stay
 * broad on purpose — enumerating every read root a macOS toolchain needs was
 * attempted and abandoned on 2026-09-16 because the profile aborts before
 * exec (the dyld shared cache alone lives on a separate volume). Residual
 * risks of the home-shaped boundary are recorded in
 * docs/security-architecture-plan.md: other-user homes under `/Users` are not
 * covered, and metadata/existence outside $HOME is readable.
 */
function readBoundaryLines(trustedRoot: string, authorizedRoots: string[]): string[] {
  const home = realpathNearestAncestor(homedir());
  if (!isUsableHomeDeny(home)) return [];
  const lines = [`(deny file-read* (subpath "${sbplQuote(home)}"))`];
  const seen = new Set<string>();
  const allowRead = (path: string) => {
    // Resolve the exact path, and skip an entry that does not exist. Using
    // nearest-existing-ancestor resolution here would be a boundary bypass:
    // an absent `~/.cache` resolves to `$HOME` and would emit an allow for
    // the whole home directory *after* the deny above, and last-matching-
    // rule-wins means that silently re-opens the entire read boundary. A
    // path that does not exist needs no read grant, so skipping is both
    // safer and sufficient.
    let real: string;
    try {
      real = realpathSync(path);
    } catch {
      return;
    }
    if (seen.has(real)) return;
    seen.add(real);
    lines.push(`(allow file-read* (subpath "${sbplQuote(real)}"))`);
  };
  // The workspace must stay readable even though it normally sits under
  // $HOME; so must any root the user explicitly authorized (a second project
  // added via sandbox.writeRoots), matching the shared write-boundary set.
  allowRead(trustedRoot);
  for (const root of authorizedRoots) allowRead(root);
  for (const name of HOME_READ_ALLOWS) allowRead(join(home, name));
  for (const name of TOOLCHAIN_READ_ALLOWS) allowRead(join(home, name));
  for (const root of extraReadRoots) allowRead(root);
  return lines;
}

/**
 * Realpath-resolves a path via its nearest existing ancestor (the D1
 * pattern from security-spec T6): walk up to the deepest existing
 * component, resolve that with realpath, re-append the missing tail. The
 * physical form is what the kernel matches SBPL subpaths against, and it is
 * what the cwd containment check needs — a symlink escaping the trusted
 * root resolves to its target and is caught. A leading "~" expands to the
 * home directory (matching Node's spawn-cwd expansion), so a model-passed
 * `cwd: "~"` is checked against the home directory rather than treated as
 * a literal relative dir. Falls back to the lexical absolute when nothing
 * on the path exists — the spawn would fail anyway.
 */
export function seatbeltWorkspaceRoot(path: string): string {
  const abs = path === "~" || path.startsWith("~/") ? join(homedir(), path.slice(1)) : resolve(path);
  let existing = abs;
  const missing: string[] = [];
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) return abs; // nothing on the path exists
    missing.unshift(basename(existing));
    existing = parent;
  }
  let real: string;
  try {
    real = realpathSync(existing);
  } catch {
    real = existing; // vanished between existsSync and realpathSync — keep the lexical form
  }
  return missing.length ? join(real, ...missing) : real;
}

/**
 * Whether a level would produce a Seatbelt prefix on this platform — the
 * same gate {@link sandboxPrefix} applies. The trusted-root cwd containment
 * check is gated on this too, so level absent/`unrestricted` or a non-macOS
 * host keeps today's spawn behavior exactly.
 */
export function isSandboxedLevel(level: ProfileLevel | undefined): level is SandboxLevel {
  return level !== undefined && level !== "unrestricted" && process.platform === "darwin";
}

/**
 * The trusted-root cwd containment check (item 8.6): the requested spawn
 * cwd, realpath-resolved via its nearest existing ancestor, must equal or
 * be a descendant of the trusted workspace root. A cwd outside the root —
 * or a symlink resolving outside it — is rejected before spawning (tool
 * error, no spawn, no profile).
 */
export function validateCwdWithinTrustedRoot(
  cwd: string,
  trustedRoot: string,
  authorizedRoots: string[] = [],
): { ok: true } | { ok: false; error: string } {
  const resolvedCwd = seatbeltWorkspaceRoot(cwd);
  const roots = [trustedRoot, ...authorizedRoots].map(seatbeltWorkspaceRoot);
  for (const root of roots) {
    const rel = relative(root, resolvedCwd);
    if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) {
      return { ok: true };
    }
  }
  return {
    ok: false,
    error: `Working directory escapes the sandbox workspace root: ${cwd} (root: ${trustedRoot}). Sandboxed commands must run inside the workspace or an explicitly added directory.`,
  };
}

/**
 * The spawn-time prefix for a bash child. Returns null when no sandbox
 * applies — the caller keeps today's `spawn(command, { shell: true })`
 * exactly: level absent/`unrestricted` (flag off, no profile, or the level
 * is unrestricted), or a non-macOS platform (policy-only).
 *
 * `cwd` is the child's actual working directory (passed to spawn unchanged);
 * `trustedRoot` is the workspace-write profile's write-set root — the
 * session workspace root fixed at startup (`ctx.workingDir`), never the
 * per-call cwd. Callers run {@link validateCwdWithinTrustedRoot} (when
 * {@link isSandboxedLevel} says a profile applies) before spawning.
 *
 * `writeRoots` is the configured `sandbox.writeRoots` list (GLOBAL-only,
 * unresolved paths — resolution happens inside {@link buildSeatbeltProfile}
 * via {@link resolveWriteRoots}), threaded through from `ctx.writeRoots`
 * (docs/unified-write-boundary.md) so a shell write into a configured root
 * is allowed by the same set the file tools consult.
 *
 * `allowGitConfigWrite` is the approved-operation grant (release gate 2) —
 * see {@link gitConfigTrustedAllows}. It widens this one spawn's profile;
 * nothing about it persists.
 */
export function sandboxPrefix(
  command: string,
  cwd: string,
  trustedRoot: string,
  level: ProfileLevel | undefined,
  writeRoots?: string[],
  sessionTempDir?: string,
  allowGitConfigWrite?: boolean,
): SandboxSpawn | null {
  if (!isSandboxedLevel(level)) return null; // macOS-only; startup notice from the loader
  return {
    file: SANDBOX_EXEC,
    args: [
      "-p",
      buildSandboxProfile(level, trustedRoot, writeRoots, sessionTempDir, allowGitConfigWrite),
      "/bin/sh",
      "-c",
      command,
    ],
  };
}

/**
 * The profile text for a launch — the single expression of "which profile does
 * this launch get". {@link sandboxPrefix} and the session-grant envelope hash
 * both derive from it, so the bytes a grant was approved against are the bytes
 * Seatbelt is handed. A second, hand-maintained description of the envelope is
 * exactly what this avoids (docs/permission-ux-redesign.md).
 *
 * Takes an already-narrowed {@link SandboxLevel}: the `ProfileLevel | undefined`
 * shape belongs to {@link sandboxPrefix}, which gates on
 * {@link isSandboxedLevel} before calling here.
 *
 * The root is resolved once and used for both the read boundary and the
 * write-set computation, so the two cannot disagree about which directory they
 * describe.
 */
export function buildSandboxProfile(
  level: SandboxLevel,
  trustedRoot: string,
  writeRoots?: string[],
  sessionTempDir?: string,
  allowGitConfigWrite?: boolean,
): string {
  return buildSeatbeltProfile(
    level,
    seatbeltWorkspaceRoot(trustedRoot),
    profileWriteSet(level, trustedRoot, writeRoots, sessionTempDir),
    allowGitConfigWrite,
  );
}

/**
 * The write-set this level's profile actually grants, in the exact bytes
 * {@link buildSandboxProfile} hands Seatbelt — the workspace root, the session
 * scratch directory or the shared carve-outs when there is none, and the
 * configured roots, all realpath-resolved, deduplicated and in the profile's
 * order. Empty for `strict-sandbox`, which grants no writes at all.
 *
 * Exported for the session-grant consent text: the user is approving a profile,
 * so the limits the prompt states must be this list and not the requested one
 * (docs/permission-ux-redesign.md).
 */
export function profileWriteSet(
  level: SandboxLevel,
  trustedRoot: string,
  writeRoots?: string[],
  sessionTempDir?: string,
): string[] {
  if (level !== "workspace-write") return [];
  // Toolchain caches join the Seatbelt write-set only — not resolveWriteRoots,
  // which also bounds nib's own file tools; those have no reason to edit
  // ~/.gradle. Kept in this list so the consent text names them.
  const roots = resolveWriteRoots(level, seatbeltWorkspaceRoot(trustedRoot), writeRoots, sessionTempDir);
  for (const root of toolchainWriteRoots(realpathNearestAncestor(homedir()))) {
    if (!roots.includes(root)) roots.push(root);
  }
  return roots;
}

/**
 * The session-grant envelope key for a profile: sha256 of the exact profile
 * text passed to the spawn.
 *
 * Hashing the text rather than enumerating envelope fields is deliberate. The
 * write-set is computed per launch, so two launches of the same level can
 * produce different profiles, and an enumerated field list can disagree with
 * what Seatbelt was actually handed. Keying on the real bytes means a newly
 * added profile rule — or a changed write root, workspace, or network policy —
 * changes the hash and invalidates a stale grant with no extra bookkeeping.
 */
export function sandboxEnvelopeHash(profile: string): string {
  return createHash("sha256").update(profile).digest("hex");
}

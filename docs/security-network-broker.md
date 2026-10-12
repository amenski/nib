# Future network broker

**Status:** deferred security feature. Since 2026-10-11 `workspace-write`
children have outbound network by default; no host-scoped policy exists.

## Decision (revised 2026-10-11)

The original decision was to deny sandboxed children all direct egress and to
add no network approval, because any network grant is broad authority: an
allowed program can start another program, resolve any hostname, and
exfiltrate any file its sandbox read rules allow. Matching command names such
as `curl`, `npm`, or `git` does not close that route. The analysis still holds.

It was reversed by the user's decision: a new user hit a dead end — a skill
that needed the network simply stopped, and the fix was a settings file they
had never seen. So `workspace-write` now allows outbound network, with no
prompt and no per-call flag:

- **IP destinations only, plus name resolution.** The profile adds
  `(allow network-outbound (remote ip "*:*"))` and the mDNSResponder socket —
  never an unscoped `network-outbound`, which Seatbelt also applies to Unix
  sockets. Measured 2026-10-11: unscoped, a child reached a Unix socket under
  `$HOME`; IP-scoped, it got EPERM. Docker's API socket (host root) is the
  case this protects.
- **Everything else stands:** the write boundary, the `$HOME` read boundary,
  the toolchain-secret denies and the `.git` denies. Git over ssh still fails
  because `~/.ssh` is unreadable.
- **Loopback is its own switch.** `sandbox.allowLocalNetwork: false` denies
  127.0.0.1 while other hosts stay reachable.
- **`strict-sandbox` is the no-network level.** Users who want egress denied
  choose it, or turn the profile level down there.
- **Risk accepted:** a sandboxed command — or a package install script it
  runs — can send anything it can read, project `.env` files included, to any
  host. The session-grant consent text says so.

## Future feature boundary

A scoped network exception may ship only with a host-aware broker that is the
sole network path available to every egress-capable child process. Seatbelt's
network rules operate on IP addresses, so they cannot provide this boundary.

The broker design must prove all of the following before implementation:

1. Sandboxed children cannot connect directly, including via DNS, proxies,
   Unix helpers, or spawned descendants.
2. The broker validates canonical destinations and ports before connecting,
   resolves redirects safely, and enforces byte/time limits.
3. The approval UI names the requested destination, operation, duration, and
   the fact that remote effects are irreversible.
4. The permission audit records the brokered destination, decision, expiry,
   bytes transferred, and final outcome without retaining secrets.
5. The same containment applies to foreground/background Bash, timeout-
   migrated jobs, subagents, MCP servers, hooks, statusline providers, and
   notification scripts.
6. Broker unavailability, parsing ambiguity, DNS/rebinding uncertainty, and
   unsupported protocols fail closed.

Until those acceptance criteria are demonstrated with adversarial integration
tests, no host-scoped policy ships; `workspace-write` egress is unscoped and
the documentation says so.

**Criterion 1 verified 2026-09-16, for the mechanism half of criterion 5.**
(Since 2026-10-11 these rows run with `allowLocalNetwork: false` against
loopback fixtures, so they now prove the loopback deny and the Unix-socket
deny, not a general egress deny — the default allows other hosts.)
`src/sandbox/egress.test.ts` measures ten egress mechanisms against local
fixtures, each with an unsandboxed control and a destination-side connection
counter (error text cannot distinguish denial from refusal — git's contained
failure and a refused connection are the same message): Node `fetch`, Python
sockets, Git over HTTP, an npm lifecycle script, a local stdio MCP server, curl
through a local proxy, UDP to loopback and to reserved TEST-NET-1, a Unix-domain
daemon socket under `$HOME`, and a DNS A query via a local c-ares resolver. All
are denied when contained and all succeed when not. No public endpoint is
contacted. Foreground and background Bash and timeout-migrated jobs are covered
by the same launcher as the npm/MCP rows; subagent tool calls route through it
structurally and are not separately probed. One residual is recorded rather than
closed in `docs/security-architecture-plan.md` (gate 4): `dns.lookup`, which
resolves in mDNSResponder outside the contained process, so this document's
claim is "a direct connect is denied", not "no name can be resolved". Criteria
2–4 and 6 describe the undelivered broker itself and remain unmet.

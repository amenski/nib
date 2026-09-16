# Future network broker

**Status:** deferred security feature. No broad-egress exception is shipped.

## Decision

Sandboxed Nib sessions deny direct network egress. We will not add a
"temporary network access" approval for Bash, package managers, interpreters,
MCP processes, hooks, or notification scripts.

That approval would be broad authority in disguise: any allowed program can
start another program, resolve any hostname, and exfiltrate any file that its
sandbox read rules allow. Matching command names such as `curl`, `npm`, or
`git` does not close that route.

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
tests, a user who needs unrestricted networking must run outside the sandbox
deliberately; Nib will not present that as a narrowly scoped approval.

**Criterion 1 verified 2026-09-16, for the mechanism half of criterion 5.**
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

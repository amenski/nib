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

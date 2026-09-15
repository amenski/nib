# Unified write boundary — design

**Status:** design, not yet built. Approved direction: model on Claude Code's
single-decision permission spine; hold the file-tool fix and the widening
together (user, 2026-08-17).

## Problem

Nib contains writes two ways that draw the boundary in **different
places**, so the effective limit depends on which tool the model picks:

- **Seatbelt** (`run_bash`, jobs): kernel-enforced, writes allowed only under
  `trustedRoot` + hardcoded carve-outs (`/tmp`, `$TMPDIR`, `~/.npm`).
  `src/sandbox/seatbelt.ts`. Does **not** read `permissionProfile.fs`.
- **File tools** (`write_to_file`, `edit`): `src/tools/edit.ts:29` is a bare
  `writeFile(path, content)` with **zero** containment. Gated only by the
  permission prompt.

Consequences:
1. `run_bash` write to `~/foo` → kernel EPERM. `write_to_file` to `~/foo` →
   one approval away. The mechanical boundary is bypassable by tool choice.
2. `permissionProfile.fs` cannot widen the Seatbelt write-set: an out-of-tree
   `write` entry is a **fatal config error** by design (`validatePermissionProfile`,
   loader.ts ~567; `isWorkspaceRelativePattern`, ~497; docs/permission-profile.md
   §3, "explicit rules narrow only"). So the SecondBrain case
   (`~/SecondBrain/AgentMemory`) is unreachable while sandboxed, from either tool.

## Why the invariant is right — and where it over-reaches

"Explicit rules narrow only" exists so an **untrusted project** `.nib/
settings.json` cannot grant itself the filesystem — the same escalation gated in
`1bc871c`. That must stay.

But it conflates two sources. The user widening the write-set in their **global**
`~/.nib/settings.json` is trusted; a **project** doing it is not. The
invariant rejects both. Claude Code's model already draws exactly this line:
user settings can grant what project settings cannot.

## Design

### 1. One shared write-set

`resolveWriteRoots(trustedRoot, config): string[]` — the single source of truth,
consulted by **both** enforcement points. Returns realpath-resolved dirs
writable under `workspace-write`:

- `trustedRoot` (session workspace root)
- carve-outs (`/tmp`, `$TMPDIR`, `~/.npm`) — unchanged
- `config.sandbox.writeRoots` (new; see §3), each realpath-resolved

`strict-sandbox` returns read-only (no writes) — the new roots apply to
`workspace-write` only, matching how carve-outs already work.

### 2. Two enforcement points, same set

- **Seatbelt** (`buildSeatbeltProfile`): emit `(allow file-write* (subpath …))`
  for each write-root, realpath'd (the SBPL filters on resolved paths).
- **File tools**: when `ctx.sandboxLevel` is workspace-write-class, realpath the
  target and check against the set. Inside → allow silently. Outside → **ask**
  (not silent write, not hard-deny) — matching the `search`/`glob` containment
  shipped in `3f8fc31`. Route the decision through `PermissionEngine` so the
  prompt and audit are consistent with every other tool. `strict-sandbox` →
  read-only, deny/ask on write, both sides.

The point, asserted directly in tests: **a path Seatbelt allows for a shell
write is allowed for a file-tool write, and vice versa.** The layers agree.

### 3. `sandbox.writeRoots` — global-only, the trusted grant

New setting, distinct from `permissionProfile.fs` on purpose: overloading `fs`
would punch a hole in a rule *defined* as narrowing-only. Keeping it separate
keeps the project-narrowing semantics clean and self-documenting.

    // ~/.nib/settings.json  (GLOBAL only)
    "sandbox": { "enabled": true, "writeRoots": ["~/SecondBrain/AgentMemory"] }

- **Read from `globalRaw` only.** `sandbox.writeRoots` in a **project** file is
  ignored with a warning — the first global-only key in the loader; enforcement
  pattern mirrors how execution-capable project keys are stripped+warned today.
  This is the load-bearing security property: a hostile repo cannot use it.
- `permissionProfile.fs` `read`/`deny`/in-tree-`write` semantics stay exactly as
  they are. This setting does not touch that path.

## Plumbing gap to solve

`ToolContext` (`src/tools/types.ts`) carries `workingDir` and `sandboxLevel` but
NOT the write-roots or `trustedRoot`. Thread the resolved write-roots into
`ctx`, set at the same startup point `sandboxLevel` is (via a setter in
`src/tools/index.ts`, following the `setSandboxLevel`/`setWebSearchConfig`
idiom). `src/cli.tsx` and `src/exec-runner.ts` both call it.

## Non-goals / invariants preserved

- Do not weaken or remove Seatbelt — this unifies, it doesn't delete a layer.
- Project `.nib/settings.json` gains **no** new widening power.
- `strict-sandbox` stays read-only on both paths.
- Realpath discipline: a symlink inside the workspace pointing out must not
  escape, on either path.
- In-workspace writes stay silent — no new prompts for the common case.

## Test matrix

- `resolveWriteRoots`: includes trustedRoot + carve-outs + global writeRoots
  (realpath'd); a symlinked writeRoot resolves to its target.
- Seatbelt profile contains an allow line for a configured writeRoot;
  strict-sandbox does not.
- File write inside workspace → silent allow.
- File write outside, no writeRoot → ask.
- File write outside but covered by a global writeRoot → allow.
- Symlink inside workspace → outside → ask (realpath).
- strict-sandbox file write → read-only (deny/ask).
- **Agreement:** for the same path, shell-write allowed ⇔ file-write allowed.
- `sandbox.writeRoots` in a PROJECT file → ignored + warned; write still asks.
- Global `sandbox.writeRoots` → honored.

## Why this is the honest fix

It closes the disagreement at its root (one set, two enforcers), makes the user's
own trusted config able to widen the boundary (the SecondBrain need), and gives a
hostile project exactly zero new power — the distinction Claude Code's model draws
and nib's current invariant misses. Nothing here relaxes project-side
narrowing; it adds a trusted, global, clearly-named grant alongside it.

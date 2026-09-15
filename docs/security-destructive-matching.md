# Blocking destructive commands — matching-strategy research

**Status:** implemented and closed · verified 2026-08-13 · companion to [security-spec.md](./security-spec.md)

## 1. Overview

The deep-dive behind the destructive-tier matching hardening (formerly
D3/T2, "`rm -rf` evadable via flag reordering"). Nib has no sandbox —
**the permission prompt is the only control** (security-spec §6) — so the
matcher that classifies a shell command as destructive/guarded is
load-bearing, and must not be evadable by trivially rewriting a command
into a semantically-identical form.

All identified evasions are closed (2026-07-31): flag-reordering,
absolute-path, case, and long-form-flag variants. Verified by
`destructive.test.ts`'s evasion-resistance suite.

## 2. The problem

The canonical case: a rule for `rm -rf /` must also catch every equivalent:

| Variant | Why it evades ordered-prefix matching |
|---|---|
| `rm -fr /` | flags reordered within the cluster |
| `rm -r -f /` | flag cluster split into separate tokens |
| `rm --recursive --force /` | long-form flags, different tokens entirely |
| `rm /tmp -rf` | target before flags — order differs |
| `/usr/bin/rm -rf /` | absolute path → first token isn't `rm` |
| `RM -RF /` | case |
| `FOO=bar rm -rf /` | leading env-assignment |
| `\rm -rf /`, `command rm -rf /` | escape / builtin indirection |
| `echo / \| xargs rm -rf` | indirection — `rm` never appears as first token |

## 3. What nib does today

Three cooperating pieces (all in `src/permissions/`):

1. **`bash-normalize.ts` — pre-processing.** Before matching, a command is:
   unwrapped one level from `bash -c`/`sh -c`/`eval` (`detectWrapper`),
   split into segments on top-level `&&`/`||`/`;`/`|`/newline/`&`
   (`splitCompound`, quote-aware), and `sudo`-stripped (`stripSudo`).
   Segments containing constructs it *can't* safely resolve — `$(…)`,
   backticks, `<(…)`/`>(…)`, leading `VAR=`, or a command-carrying wrapper
   (`env`/`nice`/`nohup`/`timeout`/`command`/`xargs`/`find -exec`/bare
   `sh`/`bash`) — are flagged `wasUnresolved` (`isUnresolved`) and force an
   **ask** rather than falling through to whatever rule matches the visible
   first token.

2. **`destructive.ts` — the deny seed.** A short built-in list of
   `origin: "builtin-destructive"` rules: `rm -rf /`, `rm -rf ~`,
   `git push --force`, `git push -f`, `git reset --hard`, `git clean -fdx`,
   `mkfs`, `dd if=`, and the fork-bomb literal.

3. **`rules.ts` — the matcher.** Ordinary user rules use `matchesPrefix`
   (ordered tokens at the start, final token at a **word boundary**, so
   `mkfs` catches `mkfs.ext4`). Builtin rules instead use
   `matchesBuiltinPrefix`, which first **normalizes**:
   `normalizeCommandToken` resolves the command to its lowercase
   **basename** (`/usr/bin/RM` → `rm`), `LONG_FLAG_MAP` folds known
   long-form flags to their short equivalent per command
   (`--recursive`/`--force` → `-r`/`-f` for `rm`; extended to `git` after a
   real gap: `git clean --force -dx` escaped `git clean -fdx`), and
   `normalizeShortFlagCluster` merges the leading short-flag run and
   **sorts its letters lowercased** (`-fr`/`-rf`/`-r -f`/`--recursive
   --force` → one canonical `-fr`) before comparing. A single-token
   pattern (`curl`, `mkfs`) requires an exact command-name match by default
   — boundary extension (matching `mkfs.ext4`) is opt-in per command
   (`COMMAND_NAME_BOUNDARY_EXTENDABLE`), since applying it uniformly would
   let `curl` incorrectly match the real, unrelated `curl-config` tool
   (caught-and-fixed false positive).

## 4. Approaches evaluated

- **A. Token-set membership** — unordered token set/multiset. Catches
  reordering, but a bundled cluster is *one token*: `{"rm","-rf","/"}` ≠
  `{"rm","-r","-f","/"}` unless flags are de-clustered first — and once you
  de-cluster, you have built approach B.
- **B. Flag-cluster normalization (chosen)** — parse argv, canonicalize
  flags (de-bundle, long→short map, basename+lowercase), match on a
  structured predicate. Catches everything in the table. Cost: a
  getopt-style model per guarded binary. **Verdict: B strictly dominates
  A, and the difference is exactly the flags.** `thefuck` proves it
  empirically: its `rm_root` rule checks only `{'rm','/'}.issubset(...)`
  and pointedly puts **no flag** in the set — a dodge unavailable to a
  *pre-execution* gate, which must reason about flags.

## 5. Prior art

**Consensus (Anthropic, OpenAI, academia): string/regex/prefix matching is
fragile and is NOT a security boundary.** The industry has converged on two
tiers: (1) argv-level parse-then-normalize for the permission/UX layer, and
(2) **OS-level sandboxing as the actual enforcement boundary**.

| Approach | `-rf`/`-r -f`? | `--recursive`? | `/usr/bin/rm`, `RM`? | Resolves wrappers? | Real boundary? |
|---|---|---|---|---|---|
| Ordered string-prefix (naive) | ❌ | ❌ | ❌ | ❌ | No |
| Token-set membership | ⚠️ if declustered | ⚠️ needs map | ⚠️ | ❌ | Weak |
| **Flag-cluster normalization** ← Nib | ✅ | ✅ with map | ✅ | ❌ | Weak/UX |
| Full shell parse / AST | ✅ | ✅ | ✅ | ✅ | Better UX, still not enforcement |
| Deny-by-default / allowlist | ✅ | ✅ | ✅ | ✅ | Stronger posture |
| **OS sandbox / capability isolation** | contains, not matches | — | — | — | **Yes** |
| LLM/semantic classification | usually | usually | usually | often | **No** (injectable) |

Who does what: **Claude Code** — argv-aware prefix matching + compound
split + wrapper strip, circuit-breaker denies for `rm`/`rmdir` on `/`/`~`
*even through* `$()`/backticks, fail-closed on unparseable commands, plus
an OS sandbox. **Codex CLI** — sandbox-first (`sandbox_mode` ×
`approval_policy`; Seatbelt/bubblewrap), fails closed if the platform
can't enforce. **aider** — human-in-the-loop only. **Warp** — regex + LLM
`is_risky` flag; cautionary leak: `dconf reset -f /` tagged
`is_risky:false`. **thefuck** — token-set. **OPA/Rego** — parse-then-policy.

## 6. Recommendation (all implemented)

For a no-sandbox single-user agent, be honest that there is no hard
boundary — an adversarial or prompt-injected model can always reach
execution via a construct you didn't parse. The goal is to catch **model
*error* and obvious catastrophe** with a fail-closed, low-false-negative
gate, and to point users at real isolation:

1. **Deny-by-default posture** — auto-allow only a small read-only set;
   else ask. ✅ (`defaultMode: askAll` + builtin-allow fallback)
2. **Argv parse-then-normalize for the deny list** — compound-split,
   wrapper strip, long→short flag folding, decluster+sort, basename.
   ✅
3. **Fail closed on anything unresolved** — `$()`, backticks, process
   substitution, leading `VAR=`, escaped `\rm`, command-carrying wrappers
   ⇒ ask, never silent allow. ✅ `isUnresolved`
4. **Hard circuit-breakers** for the catastrophic set that fire even
   through substitution and any auto-approve mode. ✅ `destructive.ts`
5. **Do NOT rely on an LLM classifier as the boundary** (Warp's cautionary
   tale). Fine as an *extra* ask-trigger, never the sole gate.
6. **Document the limitation + offer the real fix** — matching is
   model-error mitigation, not adversary containment; a future OS sandbox
   (Seatbelt/bubblewrap) is the step that actually changes the security
   model. Roadmap-tier, currently a stated v1 non-goal.

## 7. Verification

`src/permissions/destructive.test.ts`'s "evasion resistance" block covers
every row in the problem table (absolute path, case, flag reordering,
combined evasion, long-form flags, mixed short/long-form), plus the named
negative cases: `git reset --soft` (not `--hard`), `ddrescue` (not `dd`),
and unrelated safe commands. `bash-normalize.test.ts` separately covers the
`isUnresolved` fail-closed side. All green as of the hardening pass.

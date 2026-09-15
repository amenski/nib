## 4. Token Optimization Strategies

**Status:** current · verified 2026-08-13 · covers `src/prompt.ts`, `src/agent.ts`, `src/compaction/`

### 4a. Immutable prefix caching

The stable preamble does not change between turns. It is byte-stable by
construction and sits at `messages[0]` (`src/agent.ts`); a module-level
cache keyed on mode/skills/memory/workingDir reuses the previous string
when inputs are unchanged. Volatile content (plan-mode instruction, env,
todo block) is injected into the trailing user message per request — never
mutating the cached prefix (system-prompt.md §2).

DeepSeek/OpenAI-compatible APIs have no native prefix-cache API; keeping
the prefix byte-identical lets the provider's internal cache hit.
Anthropic's native prompt caching is available but not currently wired.

### 4b. Mode-gated tool definitions

Only tools in the active mode's groups are sent (mode-spec.md §3); `ask`
mode carries none of the edit/shell text, and the `workflow` group gets no
tool guide at all (`getToolGuide` returns `""`).

### 4c. Parallel tool execution

When the model issues multiple independent read calls in one turn, they
execute concurrently (`Promise.allSettled` fast path in `src/agent.ts`).

### 4d. Concise system prompt

Every token in the system prompt costs every turn:

- Remove fluff ("You are a helpful AI assistant…")
- Remove rules the model already follows
- Test: remove a sentence, does quality drop? If not, keep it removed.

Aider's system prompt is remarkably terse — that's intentional. Change
protocol: system-prompt.md §11.

### 4e. Tool output caps

Resource limits live in the tools themselves (tool-spec.md §2): 2,000-line
`read_file`, 50-match `search`, 512 KB `run_bash` buffer, 40,000-char
`web_fetch`, 8,000-char `web_search`. The agent can always request more
detail with a follow-up call.

### 4f. RepoMap budgeting

Given a fixed token budget, include as many high-rank symbols as fit, then
stop. Nib caps the whole map at 4 KB (`REPOMAP_BYTE_BUDGET`,
`src/prompt.ts`) and snapshots it per session so it never breaks prefix
caching.

---

_Part of the [subsystems deep dive](../subsystems.md)._

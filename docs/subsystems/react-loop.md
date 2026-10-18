## 3. ReAct Implementation — The Right Variant

**Status:** current · verified 2026-08-13 · covers `src/agent.ts`, `src/selfreflection/`, `src/tools/todo.ts`

### Standard ReAct

```
Thought: I need to read the auth module first.
Action: read_file("src/auth/index.ts")
Observation: [file contents]
Thought: The issue is in the token validation function.
Action: edit("src/auth/index.ts", old_string, new_string)
Observation: Edit applied successfully.
Thought: Let me verify by running the tests.
Action: run_bash("npm test -- src/auth")
Observation: 12 tests passing, 0 failing.
```

### Why standard ReAct falls short

1. **No backtracking** — no structured way to undo a wrong edit.
2. **No planning** — dives into implementation without a plan.
3. **No reflection** — doesn't verify actions achieved the goal.

### Decision: ReAct + Plan + Reflect

```
Phase 1: PLAN
  Thought: Refactor auth. Plan:
    1. Understand current auth implementation
    2. Design JWT-based replacement
    3. Implement JWT utilities
    4. Update middleware
    5. Migrate tests
    6. Verify everything passes
  Action: update_todo_list([...6 items...])

Phase 2: EXECUTE (ReAct loop per todo item)
  Action: read_file("src/auth/index.ts")
  Action: search("authenticate|login|session")
  [LLM processes results, marks the step complete]

Phase 3: VERIFY
  Action: run_bash("npm test")
  Observation: All tests pass.
  [Final summary to the user]
```

Backtracking is provided by shadow-Git checkpoints (`/undo`) rather than a
loop construct.

### Reflection loop rules

After every tool action, the agent asks itself:
1. Did the tool succeed? If not → try a different approach (max 1 retry)
2. Did the tool produce expected output? If not → investigate why
3. Does the output change the plan? If yes → update the todo list

This is Aider's self-reflection pattern, formalized (implementation:
`src/selfreflection/`).

### Who owns the loop

The loop shape (ReAct + Plan + Reflect) is core engine code, not user
configuration. Users shape *behavior* — through modes, custom instructions,
skills, and permissions — never by swapping loop implementations. No
shipping agent (opencode, Aider, RooCode, Claude Code) exposes loop choice;
the loop is the product, and a pluggable loop is an abstraction with one
implementation.

Planning intensity is at the model's discretion, not a config knob:
`update_todo_list` (tool-spec.md) is always available, and the system prompt
says to plan multi-step tasks and skip planning for trivial ones. Fallback
if model discretion proves unreliable: a `planning: always | auto | off`
mode field — deferred until observed need.

### Todo list mechanics (shipped)

The current list reaches the model every sub-turn: the loop re-reads the
store at the request-build site (`src/agent.ts`) and prepends a
`# Current todo list` block to the volatile prefix; the tool result also
returns the full list, so the model sees state after every update. The TUI
renders the list as a live checklist panel above the input
(`src/ui/TodoPanel.tsx`), cleared at each turn start. Sub-agents spawned via
`new_task` run with their own isolated store — the orchestrator threads a
fresh `TodoStore` through each per-call tool context (no shared global
pointer is mutated) and wires the sub-run's `getTodos` to it — so a
sub-agent's plan updates never clobber the parent's panel, and the
sub-agent's own context gets its own plan.

### Mid-turn steering (shipped 2026-08-13)

The volatile prefix is assembled at the request-build site each sub-turn
(`src/agent.ts`); the agent also polls an optional mailbox there —
`AgentOptions.pollSteeringMessage: () => string | null`, once per decision
point (before each provider call, never mid-stream). The returned string can
be a payload the user never typed — a mid-turn `/skill <name> <text>` injects
the skill body plus the instruction (App.tsx), while the queue and the echo
show the command line. A hit is pushed to `messages` as a real user message at
the poll site, and the volatile prefix gains a fixed note saying a message
arrived and to answer it once (agent.ts `STEERING_NOTE`) — it deliberately does
not repeat the message, since the message is right there: echoing even its
first line put the same text in the request twice and the model answered it
twice, once to the note and once to the message (onramp 1117-ecdc,
2026-10-10). Pushing at the poll site keeps the conversation order honest (the
message sits before the assistant/tool messages that respond to it) and
`newMessages`/`onNewMessages` persistence picks it up automatically. The TUI's queue (`App.tsx`
`messageQueueRef`) is the mailbox: the poll consumes message-kind items only
(slash commands stay queued for the turn-end drain, preserving FIFO order),
and Esc interrupt never touches the queue — anything not consumed mid-turn
(e.g. typed during the final stream) drains into the next turn. Sub-agents
get no mailbox (optional contract).

### Batch execution (shipped 2026-08-13)

The loop pre-resolves a multi-call assistant batch once, **only to
partition it**: allowed reads run through `Promise.allSettled`, writes and
asks run sequentially afterwards in original call order; every call is
re-resolved at execution time, so a mid-batch "yes, for session" approval
still applies to later calls in the batch. Tool results (and denies) are
replayed to the provider in the assistant's original `toolCalls` order —
the provider contract requires it. Both paths share one `processCall`
body, so the fast path and the sequential fallback are
behavior-identical: audit rows, `failedStreak` escalation (5 consecutive),
repeat-call detection, and reflection retry. The ask branch resolves
`askUser` to `boolean | "posture"` — `"posture"` means the UI allowed an edit
inside the profile write set without a prompt, emitted as the
`allow-by-posture` audit value (permission-spec.md §11). When the auto posture is
active the ask branch asks the judge before `askUser`
(`decideAuto`; permission-spec.md §9): an allow is the `allow-by-classifier`
value, a block a `deny-by-classifier` tool result, and a judge that cannot decide
falls through to `askUser`.

### Error taxonomy

Tool errors are plain strings with informal prefixes (tool-spec.md §7);
there is no formal enum. `TYPE_ERROR` and `TEST_FAILURE` are not tool error
codes — they are *content classifications* the diagnostics/reflection
machinery applies to `run_bash` output (compilation failures, failing test
runs), fed back to the model as a system note rather than a tool error.

### What a tool result carries on failure

A failing call keeps its output. The loop composes the tool message as
`Error: <error>` then the result's `content` (`toolResultForHistory`,
`src/agent.ts`), and the TUI previews that same string under `⎿` — the user
sees what the model sees. Content is used verbatim: handlers wrapped command
or page text in the untrusted delimiters already, and nib's own notes (the
sandbox hint, src/tools/sandbox-hint.ts) sit after them. A result with empty
content is exactly the single `Error: <error>` line it always was.

So the bounded fix-reminder is only the reminder
(`ErrorReflector.formatError`): it dropped the `<error_analysis>` block it
used to re-append, because the tool result now carries that block itself
(2026-10-10 — before the change, every error reached the model as a bare
`Error: Exit code: N`, with stderr and hints discarded on the way).

---

_Part of the [subsystems deep dive](../subsystems.md)._

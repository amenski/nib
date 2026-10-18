# Auto Mode

**Status:** current · verified 2026-10-17 · covers `src/permissions/risk/{auto,rules,features,reasons}.ts`, `src/permissions/command-classifier.ts`, `src/providers/risk-judge.ts`, `decideAuto` in `src/agent.ts`

A user guide to nib's `auto` permission posture: what it does, how to turn it
on, how to check it is working, and what it does not protect you from. It is
nib's version of Claude Code's `defaultMode: "auto"`. For the engineering
detail, read [command-risk-classifier.md](./command-risk-classifier.md) §15 and
[permission-spec.md](./permission-spec.md) §9; this page links there instead of
repeating them.

## 1. What auto mode is

Normally nib asks you before it runs anything that is not already covered by
an allow rule. Auto mode replaces most of those questions with a decision made
for you, in four layers:

- Calls that only read run silently.
- Everything else is judged by a model: it sees your messages and what the
  agent has done so far, and says allow or block.
- A short list of things always stops and asks you, never the judge:
  credential files, git configuration changes, anything that would run
  outside the OS sandbox, and any call that one of your own `ask` rules
  matches.
- A list of dangerous patterns (`rm -rf /`, `curl ... | sh`, a force push,
  `git reset --hard`, and similar) is always denied, whatever the judge would
  have said.

You do not have to write a list of allow rules first. That is the point: it
makes a session with the sandbox switched off usable, where otherwise every
`npm test` is a prompt.

## 2. Turning it on

**For one session.** Press `Shift+Tab`. It cycles `normal → auto → plan` and
back to `normal`. The status bar shows a dot and the word `auto`. If the judge
has blocked too much it reads `auto · paused` (section 6).

**Every session.** Put this in `~/.nib/settings.json`:

```json
{
  "classifier": { "defaultPosture": "auto" }
}
```

This key is global-only. A `classifier.defaultPosture` (or `mode`, or `model`)
in a project's `.nib/settings.json` is ignored, and nib prints a warning
telling you to set it in `~/.nib/settings.json`, so a repository you open
cannot switch the mode on for you. `plan` is never a starting posture.

**It replaced `autoApprove`.** Older builds had an `autoApprove` posture that
waved ordinary asks through in the UI but never worked for Bash without a
sandbox. It is gone. In lifecycle hook payloads, `permission_mode` now reads
`"auto"` where it used to read `"autoApprove"` ([hooks-spec.md](./hooks-spec.md)).

**Headless runs.** `nib -p` does not use auto mode at all, and
`defaultPosture` has no effect there. Nothing in the headless runner builds a
judge. Any call that would ask is denied with one stderr line
(`permission denied (headless): <tool> <subject>`), so scripted runs need
explicit allow rules ([troubleshooting.md](./troubleshooting.md)).

## 3. Sandbox on or off

nib's OS sandbox (a macOS Seatbelt profile around Bash) is on by default, and
it changes what auto mode has to judge. See
[config-spec.md](./config-spec.md) for the sandbox keys.

**Sandbox on (the default on macOS).** With `sandbox.autoAllowBash` at its
default of `true`, an ordinary sandboxed `run_bash` is covered by the session
grant and runs without a question. That happens before auto mode is asked, so
auto mostly judges what the grant does not cover:

- tools that are not Bash (`web_search`, MCP tools, `kill_job`, `new_task`
  and so on),
- Bash the grant refuses to cover: guarded commands (`curl`, anything naming a
  secret path, `node_modules` reads), and a call whose deciding rule is one you
  wrote or approved earlier. An `ask` rule you wrote is a hard stop (4.3): the
  call always prompts and the judge is not asked.

Two things still apply to sandboxed Bash while auto is on. The always-denied
list (section 4) is enforced for every call, so `git reset --hard` is denied
even though the grant would have covered it. And the OS sandbox keeps limiting
writes and network whatever the judge allows.

```json
{
  "classifier": { "defaultPosture": "auto" }
}
```

**Sandbox off.** There is no session grant, so every Bash ask comes to auto.
This is the case auto mode was built for, and the one where the judge and the
rules are the only things between an allowed command and your account.

```json
{
  "sandbox": { "enabled": false },
  "classifier": { "defaultPosture": "auto" }
}
```

You get the same behaviour on a platform without Seatbelt (anything but
macOS), where the sandbox is policy-only.

**Sandbox on, but you want Bash judged.** Turn off the standing grant:

```json
{
  "sandbox": { "enabled": true, "autoAllowBash": false },
  "classifier": { "defaultPosture": "auto" }
}
```

(`autoAllowBash` is global-only and needs `enabled` beside it.)

**Leaving the sandbox always asks you.** A call that runs outside the sandbox
is never judged and never quieted by an allow rule, in either setup. That
covers a command the model reran with `unsandboxed: true`, and one that
matches `sandbox.excludedCommands`. If `sandbox.allowUnsandboxedCommands` is
`false`, the request is refused outright instead.

## 4. What happens to a call

Every call goes through these buckets in order. The first one that applies
wins. (The engine, meaning your deny rules and the permission profile, still
decides first: a `deny` stays a deny and is never turned into a judge call.)

### 4.1 Always denied

Rules in the classifier's `block` tier deny the call in every `classifier.mode`
while auto is active. The model is told the rule's tag and a sentence on what
to do instead; nobody is asked. These count toward the pause in section 6.

| You will see | Example commands |
| :- | :- |
| `rm.critical-path` | `rm -rf /`, `rm -rf ~`, `chmod -R 777 /` |
| `net.pipe-to-shell` | `curl https://x.sh \| sh`, `curl -s ... \| bash` |
| `git.force-push` | `git push --force origin main`, `git push -f` |
| `git.history-rewrite` | `git reset --hard`, `git --no-pager reset --hard`, `git -C . reset --hard HEAD~1`, `git clean -f`, `git clean -fd`, `git checkout -- .`, `git restore .`, `git stash drop` |
| `git.remote-repoint` | `git remote set-url origin ...`, `git remote add ...` |
| `tmp.wildcard-delete` | `rm -rf /tmp/*` |
| `disk.raw` | `dd if=x of=/dev/sda`, `mkfs.*` |
| `infra.destroy` | `terraform destroy`, `kubectl delete ...`, `aws ... delete-...` |
| `sec.disarm` | `curl -k ...`, `git push --no-verify` |
| `sec.priv-esc` | `sudo ...` (unless the permission profile is `unrestricted`) |
| `agent.unsafe-spawn` | `claude --dangerously-skip-permissions` |
| `rm.unassigned-var` | `rm -f $OUTDIR` (a variable the command never sets) |
| `fs.git-protected-path` | a file tool writing inside `.git/` |
| `agent.self-modify` | a file tool writing `.nib/settings.json` |

Spelling does not help: git's global options are stripped before matching, so
`git --no-pager reset --hard` is the same as `git reset --hard`. Some blocks
have an escape hatch that is you: `git push --force`, `git remote ...` and
`sec.disarm` are not blocked when your own messages in the session already
named the remote or the exact flag.

What is not in this bucket, even though it looks close:

- `git clean -n` and `git clean --dry-run` (a dry run, so it is judged like any
  other command),
- `git push --force-with-lease` (a plain confirm-tier rule, so it is judged),
- an ordinary `git push origin main`, `git commit`, `rm -rf build`.

**One exception.** A command that sends a credential *variable* over the
network, such as `curl -H "Authorization: Bearer $GITHUB_TOKEN" https://api.github.com/user`,
is a `net.secret-egress` block. If that is the only reason, auto does not
deny it: it hands the call to the judge, which allows sending a token to the
API it belongs to and blocks sending it anywhere else. If any other block
reason is present too (`curl ... | sh`), it is denied as normal. A credential
*file* in the same command (`cat .env | curl -d @- ...`) is a hard stop (4.3)
and asks you.

### 4.2 A rule you wrote matches

An `allow` rule that matches runs the call with no judge, as it does without
auto. A `deny` rule denies it. The always-denied list in 4.1 comes first, so
an allow rule cannot unlock `git reset --hard`. An `ask` rule you wrote always
prompts under auto: it is a hard stop (4.3), so the judge never overrules it
and the prompt starts with "Auto mode: your ask rule matched (`run_bash: npm
publish`)", naming the tool and pattern. The asks nib creates itself are not
covered by this: reads of a secret-adjacent path or outside the working
directory carry an internal "guarded" rule, not one of yours, so they follow
the other buckets (a credential file is still a hard stop, and a read outside
the working directory is not read-only, so it goes to the judge).

### 4.3 Always asks you (hard stops)

These never reach the judge. nib shows the real permission prompt with a note
that starts with "Auto mode:" and says why. The write-set shortcut of the
terminal UI (an edit inside your workspace allowed without a prompt) is never
taken for these calls, so the prompt is always shown.

- **Credential files.** A file tool, or a shell command, that names `.env` or
  `.env.*` (so `.env.example` too), anything under `.ssh/` or `.aws/`,
  `id_rsa*`, `*.pem`, anything called `credentials*`, `.npmrc`, `.netrc`, a
  macOS `Keychains` path, or the cloud metadata address `169.254.169.254`.
  `cat .env`, `cat .env 2>/dev/null` and `cp .env /tmp/x` all stop. A token
  *variable* (`$GITHUB_TOKEN`) does not; that goes to the judge.
- **Protected paths** (file tools): shell startup files (`.bashrc`,
  `.bash_profile`, `.zshrc`, `.zprofile`, `.profile`), `.npmrc`, `.husky/`,
  `.vscode/`, `.github/workflows/`. Writes into `.git/` and
  `.nib/settings.json` are not in this bucket: they are denied outright (4.1).
- **Git configuration.** `git init`, `git clone`, `git remote add/set-url/
  remove/rename/set-branches`, `git submodule add`, and
  `git config <name> <value>` (not the `--get`/`--list` forms, and not
  `--global`).
- **Anything outside the sandbox** (section 3).
- **A call matched by an `ask` rule you wrote** (4.2). The note reads "Auto
  mode: your ask rule matched (`<tool>: <pattern>`)."
- **Everything, while auto is paused** (section 6).

Hard stops and a paused session always show the real prompt. In every posture,
auto or not, an edit of a credential or protected path inside your workspace
(`.env`, `.env.local`, `.husky/pre-commit`, `.vscode/settings.json`,
`.github/workflows/ci.yml`, `.zshrc`, `id_rsa`, `*.pem`, `credentials*`) also
prompts: it is never treated as silently inside the write set. The match is on
the path, so `src/credentials.ts` prompts too. Ordinary edits inside the
workspace run silently (4.4).

### 4.4 Runs silently, no judge

- **The read-only tier.** Shell commands the classifier can prove only read:
  `cat`, `ls`, `grep`, `rg`, `head`, `tail`, `wc`, `find` (without
  `-exec`/`-delete`), `diff`, `du`, `df`, `stat`, `sort`, `uniq`, `cut`,
  `file`, `pwd`, `which`, `echo`, `printf` and similar, plus:
  - read-only git: `status`, `diff`, `log`, `show`, `blame`, `ls-files`,
    `rev-parse` and the like, including `git --no-pager log` and `git -P diff`;
  - `sed -n '10,40p' file` (line printing only);
  - `sort` without `-o`;
  - `cd` into a directory inside the working directory, joined to read-only
    commands;
  - output sent to `/dev/null` (`2>/dev/null`);
  - globs for `grep`, `ls`, `cat`, `head`, `tail`, `wc`, if the part before
    the first `*` stays inside the working directory (`cat src/*.ts`).
- **Edits inside the profile write set** (your workspace, plus any
  `sandbox.writeRoots`).
- **Two tools:** `ask_user_question` (you answer it anyway) and `check_job`
  (a status read). `kill_job` is judged.

File reads and listings (`read_file`, `list_files` and the like) of a path
inside the working directory are in the read-only tier too, unless the path is
a credential or protected path (those are hard stops, 4.3). `glob` and
`search` are allowed by nib's default rules, so auto mode never has to look at
them either. A read of a path outside the working directory is judged.

What is **not** read-only, even when it looks like it:

| Command | Why it is judged instead |
| :- | :- |
| `cat /etc/hosts`, `ls ..` | reads outside the working directory (compared as text, symlinks are not followed) |
| `cat ../*.ts` | the glob climbs out of the working directory |
| `cd src && git status` | git after a `cd` into a subdirectory can pick up a nested repository's config |
| `git -C dir status`, `git -c k=v log` | `-C` and `-c` are never read-only |
| `rg --pre cmd ...` | `--pre` runs a program |
| `git diff --output=file` | writes a file |
| `uniq in out` | the second operand is an output file |
| `file -C` | writes a compiled magic file |
| `sort -o out in` | writes a file |
| `find . -exec ...` / `-delete` | runs or deletes |
| `git branch`, `git remote -v` | not on the read-only git list |

### 4.5 Everything else is judged

Examples: `npm test`, `./gradlew build`, `mkdir out`, `rm -rf build`,
`npm ci`, `git commit -m x`, `git push origin feature`, `npm install left-pad`,
`python -c "..."`, and a curl with a token variable. The next section says how.

## 5. The judge

**Which model.** `classifier.model.id` if you set it, otherwise the model your
session is using right now. The choice is made on every request, so `/model`
switches apply to the very next judgement. Nothing else needs to be enabled.

```json
{
  "classifier": {
    "defaultPosture": "auto",
    "model": { "id": "deepseek/deepseek-flash" }
  }
}
```

`id` is `provider/model`. You do not need `"enabled": true` for auto mode; that
flag belongs to an older, separate second stage and setting only `id` does not
turn it on. The key is global-only like the rest of `classifier`.

**How it is asked.** One non-streaming completion, no tools, temperature 0,
and the lowest reasoning effort the model lists (`none` if it has it, otherwise
the lowest level it offers). A model with no effort list gets none sent.
Some providers drop the temperature when an effort level is set.

**Two stages.**

| Stage | Question | Answer | Limits |
| :- | :- | :- | :- |
| 1 | Quick yes or no, told to lean toward block | `ALLOW` or `BLOCK` | 1024 output tokens, 10 s |
| 2 | Only if stage 1 said `BLOCK` or could not be read. Reason briefly, then decide. It is not told what stage 1 said | last line `DECISION: ALLOW` or `DECISION: BLOCK [tag] reason` | 2048 output tokens, 30 s |

Stage 2 can overturn stage 1, so stage 1 is a cheap filter and stage 2 the
arbiter. An `ALLOW` at stage 1 is final. In stage 2 the `DECISION:` line must
be the last non-empty line; one earlier in the text does not count. A tag the
judge invents that is not on the known list is dropped. Both stages share the
same prefix (system prompt and context), so a provider with prompt caching can
serve the second request's prefix from cache.

**What it sees.**

- Your last 10 messages (each cut at 2,000 characters). A finished sub-agent's
  report is not counted as one of yours.
- For a sub-agent, the task the main agent gave it, labelled as written by the
  agent and carrying no authority from you.
- The agent's earlier tool calls: tool name and arguments only, the last 30,
  each cut at 300 characters, with file bodies replaced by a length.
- The pending call, declared to be data, and a short summary of what the
  rules extracted from it (programs, targets, whether it deletes or reaches
  the network).
- The whole context is held to about 40,000 characters; the oldest calls and
  then the oldest messages are dropped first.

**What it never sees.** Tool results, and the assistant's prose. A poisoned
file, web page or command output cannot address the judge, and the agent
cannot talk it round. It also means the judge cannot check where a path or
URL came from, and is told to lean toward block when a risky call depends on
one you never wrote.

**What the agent is told when it blocks.** Only a fixed sentence for the tag,
never the judge's own words: `Blocked by nib auto mode [tag]: <sentence>`. If
the judge gave no usable tag the sentence is generic ("a safety review judged
this call too risky to run without the user's approval..."). You see the
judge's one-line reason in the terminal; the agent does not. The judge picks
from the always-denied and confirm rule tags
([reasons.ts](../src/permissions/risk/reasons.ts)) or one of these:

| Tag | Sentence the agent receives |
| :- | :- |
| `auto.destruction` | the reviewer judged this would destroy work that cannot be recovered from the conversation (files that predate the session, history, or deployed resources). Name only what this session created, or ask the user to approve it. |
| `auto.exfiltration` | the reviewer judged this would send data off the machine that the task does not call for (credentials, private files, or a download piped into a shell). Keep the data local, or ask the user to approve the destination. |
| `auto.security-degrade` | the reviewer judged this would weaken a safeguard (skipped verification, a disabled check or sandbox, a relaxed test, or another agent started without permission checks). Fix the underlying problem instead, or ask the user to accept the risk. |
| `auto.trust-boundary` | the reviewer judged this would cross a trust boundary (a force push, a different remote, registry or API base URL, a third-party repository, or a tunnel). Stay inside this repository's own branches, or ask the user to confirm the target. |
| `auto.bypass-review` | the reviewer judged this would skip human review or act on others' behalf (merging or approving a change, a production flag, a shared-cluster operation, or a bot command). Leave the final step to the user. |
| `auto.user-boundary` | the reviewer judged this crosses a limit the user stated earlier in the conversation. Respect that limit, or ask the user whether it still applies. |
| `auto.out-of-scope` | the reviewer judged this goes beyond what the user asked for, which does not authorise a riskier action than the request named. Do what was asked, or ask the user before going further. |

`auto.user-boundary` is how "don't push" or "read only" said earlier in the
conversation is enforced; `auto.out-of-scope` is how "clean up the PR" stops
short of a force push.

**When the judge fails.** A timeout, an error (including a provider error such
as a missing key), or an answer nobody can parse does not decide anything. You
get the normal prompt with a note: "Auto mode could not decide (timeout)." and
the call is not counted as a block. Pressing Esc while the judge is thinking
cancels it at once and denies the call.

**Cost and speed.** Each judged call is one short model request, two when
stage 1 blocks. Read-only calls and edits cost nothing extra. Speed is your
judge model's round trip, bounded by the 10 s and 30 s limits; measure yours
with the recipe in section 7. A weak model, or one that cannot switch its
thinking off, tends to spend its token budget reasoning and returns empty or
rambling text; that shows up as `unparseable` and turns into extra prompts.
Pin a small, instruction-following model with `classifier.model.id` if that
happens.

## 6. Pausing

If the judge (or the always-denied list) keeps saying no, auto stops deciding
and asks you instead:

- **3 blocks in a row**, or
- **20 blocks in total** in the session.

When that happens you get a notice once, the status bar changes to
`auto · paused`, and every ask shows the real prompt, hard stops included as before. Always-
denied calls are still denied. The count is shared with sub-agents. A block
from the always-denied list counts the same as a judge block; an allow (a
read-only call or a judge `ALLOW`) resets the streak.

How it ends:

- **After a streak of 3:** approve any call at a prompt. Approval resets the
  consecutive count.
- **After 20 in total:** approving a call is not enough, because the total is
  not reset by it. Re-enter auto (`Shift+Tab` around to `auto` again), or run
  `/clear`, `/new` or `/resume`.

Both counters also reset when you enter auto, and on `/clear`, `/new` and
`/resume`. `/clear` and `/new` forget your earlier messages as far as the
judge is concerned; `/resume` re-learns them from the resumed transcript.

Pauses usually mean the agent keeps trying something the policy forbids, or the
judge disagrees with your task. Read the blocks (section 7) before resuming.

## 7. Checking that it works

**In the terminal.** `/permissions` opens the Permission History panel. Its
first line gains `auto N allowed · N blocked · N asked` once auto has made any
decision (`asked` is every time auto handed the call back to you). In the
list, an auto decision is labelled `[auto allow]` or `[auto block]`, with the
rule tier and first tag after it for calls the rules read. Everything below
needs the session files.

**In the session file.** Each session is one JSON-lines file:

```
~/.nib/sessions/<project path>/<session id>.jsonl
```

`<project path>` is the working directory with every character that is not a
letter or digit replaced by `-` and repeated dashes squashed, so
`/Users/me/proj_x/nib` becomes `-Users-me-proj-x-nib`. (`NIB_HOME` replaces
`~/.nib` if you set it.) Because those names start with `-`, pass `--` to `ls`
so it is not read as a flag. Auto's decisions are rows with
`"type":"permission"`. Auto allows have `decision` `allow-by-classifier`,
auto blocks `deny-by-classifier`, and both carry an `auto` object:

```json
{"type":"permission","tool":"run_bash","subject":"npm test",
 "decision":"allow-by-classifier","reason":"auto mode judge allowed the call",
 "auto":{"stage":"stage1","outcome":"allow","latencyMs":900,
         "judge":"deepseek/deepseek-flash"},
 "at":"2026-10-17T10:00:05.000Z"}
```

| Field | Values |
| :- | :- |
| `auto.stage` | `readonly` (no judge needed), `rules` (the always-denied list), `stage1`, `stage2`, `fallback` (a hard stop or a paused session) |
| `auto.outcome` | `allow`, `block`, `timeout`, `error`, `unparseable`, `suspended`, `hard-stop` |
| `auto.tag` | the block tag, when there is one |
| `auto.reason` | the judge's one-line reason, or `raw: ...` for an unparseable answer, or an error message. Redacted and cut to 200 characters |
| `auto.judge` | which model judged |
| `auto.latencyMs` | time spent on the judgement |

When the judge fails, or a hard stop or a pause hands the call to you, the
`auto` object rides on the row that records your answer (`ask-approved`,
`ask-denied`), not on an `allow-by-classifier` row. Judge failures keep the
stage they failed in (`stage1` or `stage2`) with `outcome` `timeout`, `error`
or `unparseable`; `stage: "fallback"` is only for hard stops and pauses.

Recipes (`jq` 1.6 or newer):

```sh
# This project's session directory, and its newest session file
dir=~/.nib/sessions/$(pwd | sed 's/[^a-zA-Z0-9]/-/g; s/--*/-/g')
f=$(ls -t -- "$dir"/*.jsonl | head -1)

# How many decisions of each kind
jq -r 'select(.type=="permission") | .decision' "$f" | sort | uniq -c | sort -rn

# Auto rows by stage and outcome
jq -r 'select(.auto) | "\(.auto.stage)/\(.auto.outcome)"' "$f" \
  | sort | uniq -c | sort -rn

# Every block, with its tag and reason
jq -r 'select(.auto.outcome=="block")
       | [.at, .tool, (.auto.tag // "-"), (.auto.reason // "-"), .subject]
       | @tsv' "$f"

# Unparseable answers, with what the model actually said
jq -r 'select(.auto.outcome=="unparseable") | [.subject, .auto.reason] | @tsv' "$f"

# p50 and p95 judge latency in milliseconds
jq -s 'def pct($p): sort | .[((length*$p)|ceil)-1];
       [.[] | select(.auto.stage=="stage1" or .auto.stage=="stage2")
            | .auto.latencyMs]
       | if length==0 then "no judged calls"
         else {n: length, p50: pct(0.5), p95: pct(0.95)} end' "$f"
```

To look across all of the project's sessions, replace `"$f"` with
`"$dir"/*.jsonl` (the `-s` recipe then works on every session at once).

**What healthy looks like.**

| Rows | Healthy | Worry if |
| :- | :- | :- |
| `readonly/allow` | a large share of the total | - |
| `stage1/allow` | most of the judged calls | - |
| `stage2/*` | a few (stage 1 blocked something and stage 2 reconsidered) | most judged calls reach stage 2: the judge is too jumpy for your work |
| `rules/block`, `stage2/block` | a few, each one explainable by its tag | many repeats of the same call: the agent is stuck, a pause is coming |
| `fallback/hard-stop` | occasional (a `.env`, a `git clone`, an unsandboxed run) | - |
| `fallback/suspended` | none | any: auto paused |
| `stage1/*` or `stage2/*` with `timeout`, `error` or `unparseable` | close to none | more than a handful: see below |

Many `unparseable` rows mean the judge model is unsuitable: it is not
answering in the `ALLOW`/`BLOCK` or `DECISION:` format, or it is spending its
whole token budget on thinking. Each such row has `reason: "raw: ..."` with the
first part of what it said (`raw: <empty>` if nothing came back). Set
`classifier.model.id` to a small, fast, non-reasoning model. Many `timeout`
rows mean the model is too slow for the 10 s and 30 s limits.

## 8. Troubleshooting

**Auto never seems to do anything.**
- The sandbox is on, so the session grant runs Bash before auto is asked
  (section 3). Look for `session grant` rows in `/permissions`. Use
  `"sandbox": {"enabled": false}`, or `"autoAllowBash": false`, if you want
  Bash judged.
- The status bar does not say `auto`. Press `Shift+Tab` until it does, or check
  that `defaultPosture` is in `~/.nib/settings.json`, not the project file (a
  warning at startup says when it was ignored).
- You are running `nib -p`, which never uses auto.
- If you run nib from a source checkout, the installed `nib` may be an old
  build. Run `npm run build` in the repository and start nib again.

**It keeps asking me.**
- It is paused (`auto · paused`): section 6.
- The prompt starts with "Auto mode: ..." and names a hard stop: a credential
  file, git configuration, a call outside the sandbox, or one of your own `ask`
  rules (4.3). That is by design; remove or narrow the `ask` rule if it is the
  one asking.
- The judge is failing. Check for `timeout`, `error` and `unparseable` rows
  (section 7); the prompt says "Auto mode could not decide (...)".

**It blocked something that should have run.**
- Read the tag (the terminal shows it; the jq block recipe lists it). It says
  which rule or reason applied.
- A `rules` block (4.1) cannot be approved from auto, because it is denied, not
  asked. Switch to `normal` with `Shift+Tab` and approve the prompt there, or
  run the command yourself. In the default `shadow` classifier mode the
  normal posture asks rather than denies.
- A judge block (`auto.*` or a rule tag at `stage2`) is denied too, but you can
  change the outcome by telling the agent what you want in plain words: the
  judge reads your last 10 messages, and "yes, force-push this branch to my
  fork" is what authorises it. A standing `allow` rule for the command also
  works, unless it is on the always-denied list.
- A call that always lands on a hard stop that you are tired of (a `git
  clone`, say) is working as designed; use `normal` or run it yourself.

**Judge timeouts.** The limits are 10 seconds for stage 1 and 30 for stage 2.
Measure with the latency recipe in section 7. Pin a faster model with
`classifier.model.id`, or one on a provider closer to you. A timeout is never
an allow; it is one extra prompt.

## 9. What auto mode protects you from, and what it does not

**It protects against** the ordinary mistakes and the obvious abuses: the
agent deleting or overwriting things it did not create, history rewrites,
piping a download into a shell, force pushes, sending a credential to the wrong
place, and doing something riskier than you asked. Those are caught by fixed
rules before any model is involved, by the judge for the grey cases, and by
you for credentials, git configuration and leaving the sandbox.

**It does not give you containment.**

- With the sandbox off, nothing limits what an allowed command can do beyond
  the judge's decision and the rules. An allowed call runs as you, with your
  account's full access.
- The judge is a model reading text that a hostile repository can influence. It
  never sees tool output, and treats the command and earlier arguments as
  data, but a malicious project can still try to get the agent to write a
  command that looks like ordinary work. Treat this as a residual risk, not a
  solved one ([security-spec.md](./security-spec.md) T1).
- Credential files and credential-path edits always ask you, but a credential in an environment
  variable goes to the judge. There is no list of hosts a token may go to; the
  judge decides whether `$GITHUB_TOKEN` is going to "the API it belongs to"
  from the command and your words, and an injected command naming a
  plausible host can pass.
- Path checks compare text. Symlinks are not followed, so a symlink inside the
  workspace that points somewhere else can make a read look like it stays
  inside.
- A judge allow is not a promise the command is safe, only that it looked
  consistent with what you asked.

**Recommendation.** On code you did not write, or anything you would not run
by hand, use the sandbox (leave it on and, if you like, let auto judge the rest)
or stay in `normal`. Use auto with the sandbox off on your own projects, where
the prompts were costing you more than the residual risk.

## Where to read more

- [command-risk-classifier.md](./command-risk-classifier.md) §15 (how auto is
  built), §5.4 (the read-only tier in full), §5.1 (the block rules)
- [permission-spec.md](./permission-spec.md) §9 (posture) and §11 (audit trail)
- [security-spec.md](./security-spec.md) T1 (prompt injection and the judge)
- [config-spec.md](./config-spec.md) (`classifier`, `sandbox`)
- [troubleshooting.md](./troubleshooting.md) (permissions FAQ)

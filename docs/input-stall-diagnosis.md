# Input stall while the agent is working — diagnosis

Status: **resolved — kept as the freeze-taxonomy reference.** Fix D (committed/
active render split) shipped 2026-08-03; fix A (`<Static>` one-shot flush of
committed output) shipped 2026-08-06 (`src/ui/OutputArea.tsx`). If a stall
reappears, this doc's symptom/root-cause taxonomy is the starting point —
watchdog: `NIB_PROFILE=1`.

## Symptom

While the model is streaming a response, typing into the prompt stutters — the
CLI "freezes" for some milliseconds per keystroke, then catches up. Gets worse
the longer the conversation.

## Related bug: Enter keys dropped around modal open/close

A distinct but adjacent bug (found during live pty verification 2026-08-03):
`\r` (Enter) presses were intermittently **dropped entirely** right after a
menu/dropdown open/close — the buffer kept its text and "later Enters work."
Two code-verified mechanisms, both fixed:

1. **stdin-listener churn race.** `PromptInput` unmounts whenever a modal is
   open, so its per-mount `data` listener was removed/re-added on every
   open/close. On Node sockets the last-attached of `data`/`readable` governs
   stream mode; a keypress in that transition went to Ink's permanent
   `readable` drain and was dropped. **Fix:** `useTerminalInput` now attaches
   ONE listener for the process lifetime and hands ownership to Ink by toggling
   `pause()`/`resume()` in a layout effect (settles before paint).
2. **Slash-menu Enter trap.** The menu branch consumed Enter as a "selection";
   for kinds with no handler case (`clear`/`help`/`skills`/`raw`) it replaced
   the buffer and submitted nothing, and args were discarded. **Fix:** Enter
   always submits the buffer (Tab completes from the menu); exact matches route
   only for bare commands, args are preserved (`/permissions history`,
   `/raw normal`).

Verification: 10/10 + 5/5 + 30/30 pty-driven transition loops clean; a residual
loss only appears under heavy scrollback + a sub-100 ms Esc→Enter gap, which is
the render contention below (the `<Static>` fix), not the race.

## It is not a blocked thread

Node's main loop is single-threaded; there is no worker being blocked. The stall
is **main-loop contention**: heavy synchronous **render** work runs on timers
while the agent streams, and a keystroke has to wait its turn behind that render
pass. More transcript → heavier each pass → longer the wait.

## Root cause: the whole transcript re-renders as live elements, on a timer

Three findings combine:

1. **Committed output is NOT static.** `src/ui/OutputArea.tsx` renders every
   past line as a normal live Ink element, *not* via Ink's `<Static>` — done
   deliberately so the pinned `WelcomeScreen` banner can stay above the
   conversation (the header comment at `OutputArea.tsx:172` explains this;
   note the file's top comment still claims `<Static>` is used — it is not).
   Consequence: on every render, **all N committed lines re-render and Ink
   re-diffs the entire frame.**

2. **Per-line work on every render.** Each `OutputLine` runs `MarkdownText`
   (`parseInline`, `MarkdownText.tsx:275`) and the tree runs `mergeTableLines`
   over the full list (`OutputArea.tsx:156`). `mergeTableLines` is `useMemo`'d
   on `lines`, but `lines` gets a **new array reference on every append**
   (`setOutputLines(prev => [...prev, …])`), so it recomputes throughout
   streaming. `MarkdownText` is `React.memo`'d, which helps for unchanged lines
   — but the full-frame re-diff and table re-scan still scale with N.

3. **Timers force those renders continuously.** During a turn:
   - flush queue `setInterval(flushOutputQueue, 50)` (`App.tsx:290`) — appends
     batched lines → new `outputLines` reference → re-render,
   - spinner `setInterval(…, 80)` (`App.tsx:304`),
   - elapsed clock `setInterval(…, 1000)` (`App.tsx:323`).

   `WelcomeScreen`, `OutputArea`, and `PromptInput` are **siblings in one live
   tree** (`App.tsx:1047–1218`). So a spinner/flush tick repaints the growing
   output frame **in the same synchronous pass** that must also apply your
   keystroke to `PromptInput`. The keystroke waits.

Net: cost per repaint ≈ O(transcript size), and repaints fire every 50–80 ms
while working — exactly when you're most likely typing a follow-up.

## Fix options (roughly increasing effort)

### A. Move committed output back into Ink `<Static>` — biggest win
`<Static>` renders each item **once**, flushes it to scrollback, and never
re-renders or re-diffs it. This removes the O(N) cost from every frame; only the
active streaming line + prompt stay live.
- **Blocker to solve:** the reason it was turned off is the pinned
  `WelcomeScreen` banner fighting `<Static>` for the top rows. Options: drop the
  banner into the `<Static>` stream as the *first* static item (print-once,
  scrolls away naturally — the common Ink pattern), or stop pinning it. This is
  a small UX decision, and it's the highest-leverage fix.

### B. Decouple the prompt from the output frame
Ensure typing doesn't ride the same render pass as streaming output — e.g. keep
`PromptInput` above a `<Static>` output region, or split so prompt state updates
don't invalidate the output subtree. Largely falls out of (A).

### C. Throttle/coalesce render triggers
- Raise the flush interval (50 → ~100–120 ms) and/or only flush when the batch
  is non-empty (skip empty `setOutputLines` that still churn a new reference).
- Pause the spinner/elapsed re-render cadence, or render the spinner in a leaf
  component so its tick doesn't invalidate the output subtree.
Palliative, not a cure — reduces frequency, not per-frame cost.

### D. Stabilize memoization
- Give `OutputLine` a stable identity so `React.memo` reliably skips unchanged
  lines (keys are index-based today; fine, but verify no churn).
- Cache `mergeTableLines`/`needsSummary`/`parseInline` results per line so
  appends don't re-scan the whole history. Helps, but (A) makes most of it moot.

## Recommendation

Do **(A)** — return committed output to `<Static>`, resolving the banner
placement (print the banner as the first static item). That alone converts
per-frame cost from O(transcript) to O(1) and should eliminate the typing
stutter regardless of conversation length. Treat (C)/(D) as follow-ups only if
any stutter remains.

### Verify
- Repro first: long session (e.g. 200+ committed lines), start a stream, type a
  follow-up — observe the stutter. This is the baseline.
- After (A): the same test types smoothly while streaming; committed scrollback
  is unaffected by later frames; the welcome banner still appears once at top.

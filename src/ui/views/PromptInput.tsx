import React, { useEffect, useMemo, useRef, useState } from "react";
import { Box, Text } from "ink";
import { PROMPT_PREFIX_WIDTH, PROMPT_CHEVRON } from "../constants.js";
import {
  EMPTY_BUFFER,
  backspace, deleteForward, deleteWordBefore, deleteWordAfter,
  insertText, isEmpty, moveLeft, moveRight, moveLineStart, moveLineEnd,
  moveWordLeft, moveWordRight, killLine,
  getCurrentSlashToken,
  getCurrentFileMentionToken,
  type PromptBufferState,
} from "../core/prompt-buffer.js";
import {
  createPromptUndoRedoState, recordPromptEdit, undoPromptEdit, redoPromptEdit, clearPromptUndoRedoState,
} from "../core/prompt-undo-redo.js";
import {
  shouldCollapse, applyEditToSpans, clampSpans, collapseForDisplay, type PasteSpan,
} from "../core/paste-spans.js";
import { getSlashCommands, filterSlashCommands, type SlashCommandItem } from "../core/slash-commands.js";
import { resolveSlashSubmit } from "../core/slash-submit.js";
import { scanFileMentionItems, filterFileMentionItems } from "../core/file-mentions.js";
import { useHistoryNavigation } from "../hooks/useHistoryNavigation.js";
import { readClipboardImageAsync } from "../core/clipboard.js";
import { useTerminalInput, type InputKey } from "../hooks/useTerminalInput.js";
import SlashCommandMenu from "./SlashCommandMenu.js";
import FileMentionMenu from "../components/FileMentionMenu/index.js";
import { useTheme } from "../contexts.js";
import { ansi256 } from "../theme.js";

export type PromptSubmission = {
  text: string;
  command?: "new" | "resume" | "continue" | "undo" | "mcp" | "usage" | "exit";
  imageUrls?: string[];
};

interface Props {
  screenWidth: number;
  promptHistory: string[];
  busy: boolean;
  placeholder?: string;
  /**
   * Status line rendered inside the input box, under the typed text. Lives here
   * rather than as a separate row below so the box reads as one unit and the
   * frame keeps its only animating line (the hint bar) at the very bottom.
   */
  statusLine?: React.ReactNode;
  promptDraft?: { nonce: number; text: string } | null;
  onSubmit: (submission: PromptSubmission) => void;
  onInterrupt?: () => void;
  onExitShortcut?: () => void;
  onModelPickerOpen?: () => void;
  onCyclePosture?: () => void;
  onOpenModePicker?: () => void;
  /**
   * Context completion engine (ctx.completer, cli.tsx): slash commands at the
   * start of the line, path completion for mid-word tokens. Applied on a bare
   * Tab when neither the slash menu nor the @-file picker is open. Returns
   * [hits, base] where base is the typed stem — a suffix of the line — to
   * replace with the chosen hit.
   */
  completer?: (line: string) => [string[], string];
  /**
   * Fires with the buffer text on every change (async-subagents.md §2): App
   * tracks whether the user is mid-typing so a sub-agent result queues behind
   * the submission instead of preempting it with an auto-started turn.
   */
  onDraftChange?: (text: string) => void;
  /**
   * Draw one blank row above the composer. The host sets this only when the
   * transcript (or a panel) has not already left a blank row there, so the gap
   * is never doubled — see core/composer-gap.ts.
   */
  gapAbove?: boolean;
}

const PromptInput = React.memo(function PromptInput({
  screenWidth, promptHistory, busy, placeholder, statusLine,
  promptDraft, onSubmit, onInterrupt, onExitShortcut, onModelPickerOpen, onCyclePosture, onOpenModePicker, completer, onDraftChange, gapAbove,
}: Props): React.ReactElement {
  const theme = useTheme();
  const undoRedoRef = useRef(createPromptUndoRedoState());
  const wasBusyRef = useRef(busy);
  const appliedDraftNonceRef = useRef<number | null>(null);
  // Latest onDraftChange for the observer effect below — App re-creates the
  // prop every render, and the effect must not refire on its identity.
  const onDraftChangeRef = useRef(onDraftChange);
  onDraftChangeRef.current = onDraftChange;
  const prevDraftTextRef = useRef("");

  const [buffer, setBuffer] = useState<PromptBufferState>(EMPTY_BUFFER);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [pendingExit, setPendingExit] = useState(false);
  const [menuIndex, setMenuIndex] = useState(0);
  const [mentionIndex, setMentionIndex] = useState(0);
  // The @-file menu closes itself by remembering the query it was dismissed on:
  // after Esc, or after inserting a file ("@src/foo.ts " must not re-open while
  // the user keeps typing past it), the menu stays closed for that exact token.
  // A different token reopens it. State (not a ref) so Esc — which changes no
  // buffer text — still triggers the re-render that closes the menu.
  const [dismissedMention, setDismissedMention] = useState<string | null>(null);
  const [attachedImages, setAttachedImages] = useState<string[]>([]);
  const bufferRef = useRef(buffer);
  bufferRef.current = buffer;
  // Display-only: ranges of `buffer.text` that came from a large paste and are
  // drawn as "[pasted N chars]". The buffer itself always holds the real text.
  const [pasteSpans, setPasteSpans] = useState<PasteSpan[]>([]);
  const pasteSpansRef = useRef(pasteSpans);
  pasteSpansRef.current = pasteSpans;
  const attachedImagesRef = useRef(attachedImages);
  attachedImagesRef.current = attachedImages;

  const {
    historyCursor, navigateHistory: navigateHistoryRaw, exitHistoryBrowsing,
  } = useHistoryNavigation(buffer, setBuffer, promptHistory);

  // Recalling a history entry swaps the whole buffer, so any spans pointing into
  // the previous text would collapse unrelated ranges.
  function navigateHistory(direction: -1 | 1): void {
    navigateHistoryRaw(direction);
    setPasteSpansChecked([]);
  }

  const slashToken = getCurrentSlashToken(buffer);
  const slashItems = useMemo(() => getSlashCommands(), []);
  // The completion menu is a TYPING aid — it must not exist while the user is
  // walking history with the arrows. Gated HERE (not at showMenu) because the
  // list feeds both the rendered <SlashCommandMenu> and the key handler; a
  // display-only gate once silenced the keys while the panel kept rendering.
  // Without this, recalling "/model" opened the menu, whose branch consumed
  // the next Up-arrow for MENU navigation — history browsing silently stopped
  // at the first command it hit. Any other key exits browsing and restores it.
  const slashMenu = useMemo(
    () => (slashToken && historyCursor === -1) ? filterSlashCommands(slashItems, slashToken) : [],
    [slashToken, slashItems, historyCursor],
  );
  const showMenu = slashMenu.length > 0;

  const mentionToken = getCurrentFileMentionToken(buffer);
  // Same history-gating as the slash menu: recalling an old prompt with the
  // arrows must not pop the picker open.
  const mentionOpen = !!mentionToken &&
    mentionToken.query !== dismissedMention &&
    historyCursor === -1;
  // Scan once per open, not per keystroke: walking the whole tree with
  // readdir on every character would stall the input on large repos.
  const mentionItems = useMemo(
    () => (mentionOpen ? scanFileMentionItems(process.cwd()) : []),
    [mentionOpen],
  );
  const mentionMenu = useMemo(
    () => (mentionOpen && mentionToken ? filterFileMentionItems(mentionItems, mentionToken.query) : []),
    [mentionOpen, mentionToken, mentionItems],
  );

  const lastCtrlDAt = useRef<number>(0);
  const inputContentWidth = Math.max(1, screenWidth - PROMPT_PREFIX_WIDTH);
  // Footer shows only transient messages (e.g. "press ctrl+d again to exit").
  // The busy/"working" hint lives in the turn-scoped Spinner above the input,
  // so duplicating it here would show two working indicators — hidden when idle
  // so the status bar below is the only line under the input.
  const footerText = statusMessage || "";

  useEffect(() => {
    if (!statusMessage) return;
    const timer = setTimeout(() => setStatusMessage(null), 2500);
    return () => clearTimeout(timer);
  }, [statusMessage]);

  useEffect(() => {
    if (!showMenu) { setMenuIndex(0); return; }
    if (menuIndex >= slashMenu.length) setMenuIndex(slashMenu.length - 1);
  }, [slashMenu, showMenu, menuIndex]);

  // Keep the @-picker's highlight inside the list as the query filters it.
  useEffect(() => {
    if (!mentionOpen) { setMentionIndex(0); return; }
    if (mentionMenu.length > 0 && mentionIndex >= mentionMenu.length) {
      setMentionIndex(mentionMenu.length - 1);
    }
  }, [mentionMenu.length, mentionOpen, mentionIndex]);

  useEffect(() => {
    if (wasBusyRef.current && !busy) setStatusMessage(null);
    wasBusyRef.current = busy;
  }, [busy]);

  useEffect(() => {
    if (!promptDraft || appliedDraftNonceRef.current === promptDraft.nonce) return;
    appliedDraftNonceRef.current = promptDraft.nonce;
    setBuffer({ text: promptDraft.text, cursor: promptDraft.text.length });
    setPasteSpansChecked([]); // wholesale replacement — old offsets are meaningless
    exitHistoryBrowsing();
    clearPromptUndoRedoState(undoRedoRef.current);
  }, [promptDraft, exitHistoryBrowsing]);

  const promptHistoryKey = useMemo(() => promptHistory.join("\0"), [promptHistory]);

  useEffect(() => { exitHistoryBrowsing(); }, [promptHistoryKey, exitHistoryBrowsing]);

  // Report draft changes upward. One observer covers every mutation path
  // (typing, paste, history recall, @-mention insert, promptDraft restore,
  // clear) — they all flow through setBuffer.
  useEffect(() => {
    if (buffer.text === prevDraftTextRef.current) return;
    prevDraftTextRef.current = buffer.text;
    onDraftChangeRef.current?.(buffer.text);
  }, [buffer.text]);

  function updateBuffer(updater: (state: PromptBufferState) => PromptBufferState): void {
    exitHistoryBrowsing();
    // bufferRef is the synchronous source of truth: a single stdin chunk can
    // carry many keys (e.g. paste + Enter), all handled before React re-renders.
    // setState updaters are deferred by React, so applying the edit against the
    // ref (not inside the updater) keeps same-tick reads coherent.
    const current = bufferRef.current;
    const next = updater(current);
    recordPromptEdit(undoRedoRef.current, current, next);
    bufferRef.current = next;
    setBuffer(next);
    setPasteSpansChecked(applyEditToSpans(pasteSpansRef.current, current.text, next.text));
  }

  // Keep the ref in lockstep with state so several edits inside one stdin chunk
  // (paste + Enter, held-key repeats) each see the previous edit's spans.
  function setPasteSpansChecked(spans: PasteSpan[]): void {
    pasteSpansRef.current = spans;
    setPasteSpans(spans);
  }

  function handleSlashSelection(item: SlashCommandItem): void {
    // No blanket busy guard: every branch below routes through onSubmit or
    // onModelPickerOpen, and App is the one decision point — it opens a modal
    // picker now (MODAL_COMMANDS) or queues the command behind the turn. The
    // old guard refused the whole menu while busy, so `/model` could be typed
    // but not picked from the menu, even though App already allows it mid-turn.
    if (item.kind === "new") { onSubmit({ text: "", command: "new" }); resetInput(); return; }
    if (item.kind === "resume") { onSubmit({ text: "", command: "resume" }); resetInput(); return; }
    if (item.kind === "continue") { onSubmit({ text: "/continue", command: "continue" }); resetInput(); return; }
    if (item.kind === "undo") { onSubmit({ text: "/undo", command: "undo" }); resetInput(); return; }
    if (item.kind === "mcp") { onSubmit({ text: "/mcp", command: "mcp" }); resetInput(); return; }
    if (item.kind === "tasks") { onSubmit({ text: "/tasks" }); resetInput(); return; }
    if (item.kind === "theme") { onSubmit({ text: "/theme" }); resetInput(); return; }
    if (item.kind === "permissions") { onSubmit({ text: "/permissions" }); resetInput(); return; }
    if (item.kind === "usage") { onSubmit({ text: "/usage", command: "usage" }); resetInput(); return; }
    if (item.kind === "plan") { onSubmit({ text: "/plan" }); resetInput(); return; }
    if (item.kind === "exit") { onSubmit({ text: "/exit", command: "exit" }); return; }
    if (item.kind === "clear") { onSubmit({ text: item.label }); resetInput(); return; }
    if (item.kind === "help") { onSubmit({ text: item.label }); resetInput(); return; }
    if (item.kind === "doctor") { onSubmit({ text: item.label }); resetInput(); return; }
    if (item.kind === "context") { onSubmit({ text: item.label }); resetInput(); return; }
    if (item.kind === "skills") { onSubmit({ text: item.label }); resetInput(); return; }
    if (item.kind === "model") { onModelPickerOpen?.(); return; }
    if (item.kind === "mode") { onSubmit({ text: "/modes" }); resetInput(); return; }
    if (item.kind === "effort") { onSubmit({ text: "/effort" }); resetInput(); return; }
    if (item.kind === "raw") { onSubmit({ text: item.label }); resetInput(); return; }
    if (item.kind === "compact") { onSubmit({ text: item.label }); resetInput(); return; }
  }

  function submitCurrent(): void {
    const trimmed = bufferRef.current.text.trim();
    if (!trimmed) return;
    // While busy we still submit — App enqueues it to run after the current
    // turn. Slash commands that open a modal view (model picker, etc.) are the
    // exception: those don't make sense to fire mid-turn, so route them through
    // onSubmit as text and let App decide (it queues them).
    const decision = resolveSlashSubmit(trimmed, slashItems, busy);
    if (decision?.action === "routeKind") {
      handleSlashSelection(decision.kind);
      return;
    }
    const imageUrls = attachedImagesRef.current;
    onSubmit({ text: trimmed, ...(imageUrls.length ? { imageUrls } : {}) });
    resetInput();
  }

  function resetInput(): void {
    bufferRef.current = EMPTY_BUFFER;
    setBuffer(EMPTY_BUFFER);
    setPasteSpansChecked([]);
    clearPromptUndoRedoState(undoRedoRef.current);
    setAttachedImages([]);
    attachedImagesRef.current = [];
    setDismissedMention(null);
  }

  // Insert a selected file/directory at the mention token, replacing the "@…"
  // the user typed, and close the menu for that token. A directory keeps its
  // trailing "/" so the picker reopens filtered inside it on the next char
  // (drill-down); a file is followed by a space so the next word starts fresh.
  function handleMentionSelection(item: { path: string; type: "file" | "directory" }): void {
    if (!mentionToken) return;
    const { start } = mentionToken;
    const suffix = item.type === "directory" ? "/" : " ";
    const cur = bufferRef.current;
    const nextText = cur.text.slice(0, start) + "@" + item.path + suffix + cur.text.slice(cur.cursor);
    const nextCursor = start + 1 + item.path.length + suffix.length;
    const next = { text: nextText, cursor: nextCursor };
    recordPromptEdit(undoRedoRef.current, cur, next);
    bufferRef.current = next;
    setBuffer(next);
    setPasteSpansChecked([]);
    // Dismiss the NEW token, not the old query: after inserting a file the
    // buffer reads "@package.json " whose token query is exactly `item.path` —
    // dismissing that keeps the menu shut. A directory's new token is
    // "dir/" which differs from `item.path`, so it reopens as drill-down.
    setDismissedMention(item.path);
    setMentionIndex(0);
  }

  useTerminalInput((key: InputKey) => {
    const curText = bufferRef.current;

    if (key.paste) {
      const sanitized = key.paste.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
      const start = bufferRef.current.cursor;
      updateBuffer((s) => insertText(s, sanitized));
      // Record AFTER the edit: updateBuffer has already shifted existing spans
      // past the insertion point, so appending here can't be double-adjusted.
      if (shouldCollapse(sanitized)) {
        setPasteSpansChecked([...pasteSpansRef.current, { start, end: start + sanitized.length }]);
      }
      return;
    }

    // While busy, Esc (or Ctrl+C on an empty buffer) interrupts the running
    // turn. Everything else falls through so the user can keep typing and queue
    // follow-up messages. When idle, Esc also interrupts (no-op if nothing runs).
    // Exception: with the @-file picker open, Esc closes the picker instead —
    // its own branch below handles that; a second Esc then interrupts.
    if (key.escape && !mentionOpen) {
      if (busy) { onInterrupt?.(); setStatusMessage("Interrupting…"); return; }
      onInterrupt?.();
      return;
    }
    if (busy && key.ctrl && key.value === "c" && isEmpty(curText)) {
      onInterrupt?.(); setStatusMessage("Interrupting…"); return;
    }

    if (key.ctrl && key.value === "d") {
      if (isEmpty(curText)) {
        const now = Date.now();
        if (pendingExit && now - lastCtrlDAt.current < 2000) { onExitShortcut?.(); return; }
        lastCtrlDAt.current = now;
        setPendingExit(true); setStatusMessage("press ctrl+d again to exit"); return;
      }
    }

    if (pendingExit) setPendingExit(false);

    if (key.ctrl && key.value === "c") {
      if (!isEmpty(curText)) { resetInput(); } else { setStatusMessage("press ctrl+d to exit"); }
      return;
    }

    if (historyCursor !== -1 && !key.upArrow && !key.downArrow) exitHistoryBrowsing();

    if (showMenu) {
      if (key.upArrow) { setMenuIndex((i) => (i - 1 + slashMenu.length) % slashMenu.length); return; }
      if (key.downArrow) { setMenuIndex((i) => (i + 1) % slashMenu.length); return; }
      // Enter selects the highlighted command — but only when the buffer holds
      // just the slash token. With trailing args ("/raw normal") the whole line
      // must submit so the args survive; that falls through to submitCurrent.
      // This restores the "↑↓ navigate · Enter select" the menu footer
      // advertises; before it, Enter on "/" submitted a bare slash, which App
      // answered with "Unknown: /".
      if (key.return && slashToken && bufferRef.current.text.trim() === slashToken) {
        const selected = slashMenu[menuIndex];
        if (selected) { handleSlashSelection(selected); return; }
      }
      // Tab completes the highlighted command into the buffer so the user can
      // append args; Enter with args falls through to submit the full buffer
      // below (the menu is a completion aid, not an Enter trap).
      if (key.tab && !key.shift) {
        const selected = slashMenu[menuIndex];
        if (selected) {
          const label = selected.label;
          setBuffer({ text: label, cursor: label.length });
          setPasteSpansChecked([]);
        }
        return;
      }
    }

    // @-file picker. Handled in the SAME handler as everything else — Ink's
    // useInput has no stop-propagation, so a second useInput in the menu
    // component would fire alongside this one: Enter would both insert a file
    // AND submit the prompt, Esc would both close the menu AND interrupt the
    // turn, and ↑↓ would both navigate the list AND walk history.
    if (mentionOpen) {
      if (key.upArrow) { if (mentionMenu.length > 0) setMentionIndex((i) => (i - 1 + mentionMenu.length) % mentionMenu.length); return; }
      if (key.downArrow) { if (mentionMenu.length > 0) setMentionIndex((i) => (i + 1) % mentionMenu.length); return; }
      if (key.tab || key.return) {
        const selected = mentionMenu[mentionIndex];
        if (selected) { handleMentionSelection(selected); return; }
        // No matches: Tab is still swallowed so it never falls through to
        // submit-as-tab; Enter falls through to submit the buffer as typed.
        if (key.tab) return;
      }
      if (key.escape) {
        // Close for this token only. The raw escape is consumed here too, so
        // closing the picker never ALSO interrupts a running turn.
        if (mentionToken) setDismissedMention(mentionToken.query);
        setMentionIndex(0);
        return;
      }
      // Any other key (typing a char, backspacing into a new token, an arrow
      // with no list) falls through to normal editing below; the picker stays
      // open and re-filters on the next render.
    }

    const noMod = !key.shift && !key.ctrl && !key.meta;

    if (key.shift && key.tab) {
      onCyclePosture?.();
      return;
    }

    // Bare Tab with no menu open: fall back to ctx.completer — slash commands
    // at the start of the line, path completion for mid-word tokens. The
    // slash menu and @-picker above keep precedence; this fires only when
    // neither applies. The completer sees the line up to the cursor, so a
    // mid-line Tab completes the token at the cursor, not the line's end.
    if (key.tab && !key.shift && completer) {
      const lineUpToCursor = curText.text.slice(0, curText.cursor);
      const [hits, base] = completer(lineUpToCursor);
      if (hits.length > 0) {
        const head = lineUpToCursor.slice(0, lineUpToCursor.length - base.length);
        const completion = head + hits[0];
        updateBuffer((s) => ({
          text: completion + s.text.slice(s.cursor),
          cursor: completion.length,
        }));
      }
      return;
    }

    // Swallow a bare Tab with no menu open. parseTerminalInput gives Tab a
    // `value` of "\t", so without this it fell through to the catch-all insert
    // below and typed a literal tab into the prompt — which widened the row
    // past the input box and wrapped the model pill onto its own line, once per
    // press. Tab is a completion key here, never a character.
    if (key.tab) return;

    if (key.shift && key.return) { updateBuffer((s) => insertText(s, "\n")); return; }
    if (key.return) { submitCurrent(); return; }

    if (key.delete) { updateBuffer((s) => deleteForward(s)); return; }
    if (key.meta && key.backspace) { updateBuffer((s) => deleteWordBefore(s)); return; }
    if (key.backspace) { updateBuffer((s) => backspace(s)); return; }

    if ((key.ctrl || key.meta) && key.leftArrow) { updateBuffer((s) => moveWordLeft(s)); return; }
    if ((key.ctrl || key.meta) && key.rightArrow) { updateBuffer((s) => moveWordRight(s)); return; }
    if (key.leftArrow) { updateBuffer((s) => moveLeft(s)); return; }
    if (key.rightArrow) { updateBuffer((s) => moveRight(s)); return; }
    if (key.home) { updateBuffer((s) => moveLineStart(s)); return; }
    if (key.end) { updateBuffer((s) => moveLineEnd(s)); return; }

    if (key.upArrow) {
      if (noMod && (historyCursor !== -1 || curText.cursor === 0) && promptHistory.length > 0) { navigateHistory(-1); return; }
      return;
    }
    if (key.downArrow) {
      if (noMod && (historyCursor !== -1 || curText.cursor === curText.text.length)) { navigateHistory(1); return; }
      return;
    }

    if (key.ctrl && key.value === "p") { navigateHistory(-1); return; }
    if (key.ctrl && key.value === "n") { navigateHistory(1); return; }
    if (key.ctrl && key.value === "a") { updateBuffer((s) => moveLineStart(s)); return; }
    if (key.ctrl && key.value === "e") { updateBuffer((s) => moveLineEnd(s)); return; }
    if (key.ctrl && key.value === "b") { updateBuffer((s) => moveLeft(s)); return; }
    if (key.ctrl && key.value === "f") { updateBuffer((s) => moveRight(s)); return; }
    if (key.ctrl && key.value === "k") { updateBuffer((s) => killLine(s)); return; }
    if (key.ctrl && key.value === "u") { updateBuffer(() => EMPTY_BUFFER); return; }
    if (key.ctrl && key.value === "w") { updateBuffer((s) => deleteWordBefore(s)); return; }
    // ctrl+j (0x0A) genuinely arrives as a ctrl chord. Its neighbours do NOT:
    // Ctrl+M is 0x0D (Enter) and Ctrl+I is 0x09 (Tab) — the parser consumes
    // both before ctrl detection, so handlers for them are unreachable. A
    // ctrl+m model-picker handler sat here dead until 2026-08-06.
    if (key.ctrl && key.value === "j") { updateBuffer((s) => insertText(s, "\n")); return; }

    // Ctrl+O opens the persona-mode picker. Lives here (not in App's
    // useInput) because the single input wire routes all idle keystrokes
    // through PromptInput — App's useInput only sees keys while a modal is
    // mounted. Same placement rule as the ⇧Tab posture cycle.
    if (key.ctrl && key.value === "o") { onOpenModePicker?.(); return; }

    if (key.ctrl && key.value === "v") {
      setStatusMessage("Reading clipboard image…");
      readClipboardImageAsync()
        .then((image) => {
          if (!image) { setStatusMessage("No image found in clipboard"); return; }
          setAttachedImages((prev) => [...prev, image.dataUrl]);
          setStatusMessage(null);
        })
        .catch(() => setStatusMessage("Failed to read clipboard image"));
      return;
    }
    if (key.ctrl && key.value === "x") {
      if (attachedImagesRef.current.length > 0) { setAttachedImages([]); setStatusMessage("Cleared attached images"); }
      return;
    }

    if (key.value && !key.ctrl && !key.meta) {
      const sanitized = key.value.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
      updateBuffer((s) => insertText(s, sanitized));
    }
  }, { isActive: true });

  // A transient notice (attachment count, or a status message like "press
  // ctrl+d again to exit") TAKES OVER the status row rather than adding one of
  // its own. Both are the same kind of information — one line of dim context —
  // and a notice is short-lived, so borrowing the row costs nothing and keeps
  // the composer's height constant. That matters beyond tidiness: Ink's
  // incremental diff can only skip rows that keep their index, so a row that
  // appears or disappears forces everything below it to repaint.
  const notice = attachedImages.length > 0
    ? { text: `📎 ${attachedImages.length} image${attachedImages.length === 1 ? "" : "s"} attached (ctrl+x to clear)`, color: theme.colorEnabled ? ansi256(theme.theme.warning) : undefined }
    : footerText !== ""
      ? { text: footerText, color: undefined }
      : null;

  return (
    <Box flexDirection="column" width={screenWidth} marginTop={gapAbove ? 1 : 0}>
      {/* The INPUT is the raised element — a bright rounded box — because that
          is where attention belongs. Everything else (status, hints) sits flat
          and dim outside it. Only the rules above and below are drawn (Claude
          Code's prompt): no side borders, so the text column is not inset
          twice. */}
      <Box
        width={screenWidth}
        borderStyle="round"
        borderLeft={false}
        borderRight={false}
        borderColor={theme.colorEnabled ? ansi256(theme.theme.border) : undefined}
        paddingX={1}
      >
        <Box width={2} flexShrink={0}>
          <Text color={theme.colorEnabled ? ansi256(theme.theme.textDim) : undefined}>{`${PROMPT_CHEVRON} `}</Text>
        </Box>
        <Box flexGrow={1} flexShrink={1}>
          <Text wrap="hard">
            {renderBufferWithCursor(buffer, placeholder, pasteSpans)}
          </Text>
        </Box>
      </Box>

      {/* Status row: flat, outside the box, one line. A notice borrows this row
          rather than adding one, so the composer's height is constant — which
          is what lets Ink's incremental diff skip these rows instead of
          repainting everything below them. */}
      <Box>
        {notice
          ? <Text color={notice.color === undefined ? (theme.colorEnabled ? ansi256(theme.theme.textDim) : undefined) : notice.color}>{notice.text}</Text>
          : statusLine ?? <Text> </Text>}
      </Box>

      {/* The slash menu is intentionally still height-variable: it only opens on
          an explicit "/" and closes on the next keystroke, so its cost is a
          deliberate, user-initiated repaint rather than a continuous one. */}
      <SlashCommandMenu width={screenWidth} items={slashMenu} activeIndex={menuIndex} />
      {mentionOpen && (
        <FileMentionMenu
          width={screenWidth}
          items={mentionMenu}
          activeIndex={mentionIndex}
          query={mentionToken?.query ?? ""}
        />
      )}
    </Box>
  );
});

function renderBufferWithCursor(
  state: PromptBufferState,
  placeholder?: string,
  pasteSpans: PasteSpan[] = [],
): string {
  const raw = state.text || "";
  const rawCursor = Math.max(0, Math.min(state.cursor, raw.length));
  // Collapse pasted blocks for display only; `state` keeps the real text.
  const collapsed = pasteSpans.length > 0
    ? collapseForDisplay(raw, rawCursor, clampSpans(pasteSpans, raw.length))
    : { text: raw, cursor: rawCursor };
  const text = collapsed.text;
  const cursor = Math.max(0, Math.min(collapsed.cursor, text.length));

  if (text.length === 0 && placeholder) {
    return `\u001B[7m \u001B[27m\u001B[2m ${placeholder}\u001B[22m`;
  }

  if (text.length === 0) return "\u001B[7m \u001B[27m";

  const before = text.slice(0, cursor);
  const at = text[cursor] ?? " ";
  const after = text.slice(cursor + 1);
  return `${before}\u001B[7m${at}\u001B[27m${after}`;
}

export default PromptInput;

import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import type { IncomingPeerMessage } from "../../peers/service.js";
import { fromLabel } from "../../peers/inbox.js";
import { useTheme } from "../contexts.js";
import { ansi256 } from "../theme.js";

export type PeerApprovalChoice = "once" | "sender" | "decline";

/**
 * `messaging.receive: ask` (cross-session-inbox.md §7.3): accept one inter-session
 * message, accept this sender for the rest of the session, or decline.
 * `guardUntil` is the permission prompt's typing guard: opened over a
 * half-typed draft, y/a/Enter wait it out so composer keys can't answer it.
 */
interface Props {
  incoming: IncomingPeerMessage;
  guardUntil: number;
  resolve: (choice: PeerApprovalChoice) => void;
}

const OPTIONS: { choice: PeerApprovalChoice; label: string }[] = [
  { choice: "once", label: "Yes — run this message" },
  { choice: "sender", label: "Yes — and accept this sender for this session" },
  { choice: "decline", label: "No — decline" },
];

export default function PeerApprovalPrompt({ incoming, guardUntil, resolve }: Props) {
  const theme = useTheme();
  const accentColor = theme.colorEnabled ? ansi256(theme.theme.accent) : undefined;
  const borderColor = theme.colorEnabled ? ansi256(theme.theme.border) : undefined;
  const dimColor = theme.colorEnabled ? ansi256(theme.theme.textDim) : undefined;
  const [cursor, setCursor] = useState(0);
  const { msg } = incoming;
  const from = msg.from.type === "session" ? `${fromLabel(msg.from)} (${msg.from.sessionId})` : fromLabel(msg.from);
  const preview = msg.body.split("\n").slice(0, 5);

  useInput((value, key) => {
    if (key.escape) return resolve("decline");
    if (key.upArrow) return setCursor((c) => (c + OPTIONS.length - 1) % OPTIONS.length);
    if (key.downArrow) return setCursor((c) => (c + 1) % OPTIONS.length);
    if (Date.now() < guardUntil) return;
    const v = value.toLowerCase();
    if (v === "y") return resolve("once");
    if (v === "a") return resolve("sender");
    if (v === "n") return resolve("decline");
    if (key.return) resolve(OPTIONS[cursor].choice);
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={accentColor ?? borderColor} paddingX={1} marginY={1}>
      <Text bold color={accentColor}>Message from another session</Text>
      <Box marginTop={1}>
        <Text wrap="wrap">From: <Text bold>{from}</Text> · mode {msg.mode}{msg.wantReply ? " · reply expected" : ""}</Text>
      </Box>
      <Box flexDirection="column" marginTop={1}>
        {preview.map((line, i) => (
          <Text key={i} wrap="truncate-end">{line || " "}</Text>
        ))}
        {msg.body.split("\n").length > 5 ? <Text color={dimColor}>…</Text> : null}
      </Box>
      <Text color={dimColor}>Another agent wrote this, not you. It runs under this session's permissions.</Text>
      <Box flexDirection="column" marginTop={1}>
        {OPTIONS.map((o, i) => (
          <Text key={o.choice} color={cursor === i ? accentColor : undefined}>
            {cursor === i ? "> " : "  "}{o.label}
          </Text>
        ))}
      </Box>
      <Text color={dimColor}>↑↓ navigate · Enter choose · y/a/n · Esc decline</Text>
    </Box>
  );
}

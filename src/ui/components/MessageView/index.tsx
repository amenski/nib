import React from "react";
import { Box, Text } from "ink";
import { useTheme } from "../../contexts.js";
import { ansi256 } from "../../theme.js";

export interface MessageItem {
  id: string;
  role: "user" | "assistant" | "tool" | "system";
  content: string;
  toolName?: string;
}

interface Props {
  message: MessageItem;
  width: number;
}

const MessageView = React.memo(function MessageView({ message, width }: Props) {
  const theme = useTheme();
  const promptFg = theme.colorEnabled ? ansi256(theme.theme.promptFg) : undefined;
  const textDim = theme.colorEnabled ? ansi256(theme.theme.textDim) : undefined;
  const content = message.content || "";
  const lines = content.split("\n");
  const maxLines = 200;
  const truncated = lines.length > maxLines;
  const visible = truncated ? lines.slice(0, maxLines) : lines;

  const roleColor = message.role === "user" ? promptFg : message.role === "tool" ? undefined : undefined;
  const dim = message.role === "tool" || message.role === "system";

  return (
    <Box flexDirection="column" width={width} marginBottom={1}>
      {message.role === "user" && (
        <Box>
          <Text color={promptFg} bold>{"\u276F"} </Text>
        </Box>
      )}
      {message.toolName && (
        <Box>
          <Text color={textDim}>[{message.toolName}]</Text>
        </Box>
      )}
      {visible.map((line, i) => (
        <Text key={i} color={dim ? textDim : roleColor} wrap="wrap">
          {line || " "}
        </Text>
      ))}
      {truncated && (
        <Text color={textDim}>... ({content.length - maxLines} more lines)</Text>
      )}
    </Box>
  );
});

export default MessageView;

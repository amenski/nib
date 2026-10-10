import React, { useState, useEffect } from "react";
import { Box, Text, useInput } from "ink";
import { getMCPServerStatuses, getMCPServerTools, reconnectMCPServer, getServerConfigs, type McpServerStatus, type McpServerStatusEntry } from "../../mcp/connector.js";
import { useTheme } from "../contexts.js";
import { ansi256 } from "../theme.js";

interface Props {
  onClose: () => void;
  width: number;
}

const STATUS_ICONS: Record<McpServerStatus, string> = {
  connected: "\u2713",
  failed: "\u2717",
  reconnecting: "\u21BB",
  starting: "\u25CF",
};

export default function McpStatusList({ onClose, width }: Props) {
  const theme = useTheme();
  const [statuses, setStatuses] = useState<McpServerStatusEntry[]>([]);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [drillDown, setDrillDown] = useState<string | null>(null);
  // Server awaiting the re-approval confirmation for changed tool defs (T10).
  const [pinReapprove, setPinReapprove] = useState<string | null>(null);

  function refresh() {
    setStatuses(getMCPServerStatuses());
  }

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 2000);
    return () => clearInterval(interval);
  }, []);

  const servers = statuses.length > 0 ? statuses : Object.keys(getServerConfigs()).map((n) => ({
    name: n,
    status: "starting" as McpServerStatus,
    toolCount: 0,
    pinChanged: false,
  }));

  useInput((value, key) => {
    if (pinReapprove) {
      // Tool-definition re-approval confirmation (T10): y = accept the
      // changed defs (reconnect re-pins and re-registers), anything else
      // cancels and the server stays flagged.
      if (value.toLowerCase() === "y") {
        const name = pinReapprove;
        setPinReapprove(null);
        const configs = getServerConfigs();
        const config = configs[name];
        if (config) {
          reconnectMCPServer(name, config, { approvePinChange: true }).then(() => refresh());
        }
        return;
      }
      setPinReapprove(null);
      return;
    }

    if (drillDown) {
      if (key.escape) {
        setDrillDown(null);
        return;
      }
      return;
    }

    if (key.escape) {
      onClose();
      return;
    }
    if (key.upArrow) { setSelectedIdx((i) => Math.max(0, i - 1)); return; }
    if (key.downArrow) { setSelectedIdx((i) => Math.min(servers.length - 1, i + 1)); return; }

    if (key.return) {
      const s = servers[selectedIdx];
      if (s) setDrillDown(s.name);
      return;
    }

    if ((value === "r" || value === "R") && !key.ctrl && !key.meta) {
      const s = servers[selectedIdx];
      if (!s) return;
      if (s.pinChanged) {
        // Changed defs are not re-registered until the user approves.
        setPinReapprove(s.name);
        return;
      }
      if (s.status === "failed") {
        const configs = getServerConfigs();
        if (configs[s.name]) {
          reconnectMCPServer(s.name, configs[s.name]).then(() => refresh());
        }
      }
      return;
    }
  });

  const drillDownTools = drillDown ? getMCPServerTools(drillDown) : [];

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={ansi256(theme.theme.secondary)} paddingX={1} marginY={1} width={width}>
      {drillDown ? (
        <Box flexDirection="column">
          <Box marginBottom={1}>
            <Text color={ansi256(theme.theme.secondary)} bold>MCP: {drillDown}</Text>
            <Text> — {drillDownTools.length} tools</Text>
          </Box>
          {drillDownTools.length === 0 ? (
            <Text color={ansi256(theme.theme.textDim)}>No tools registered.</Text>
          ) : (
            <Box flexDirection="column">
              {drillDownTools.map((t: any) => (
                <Box key={t.name}>
                  <Text color={ansi256(theme.theme.textDim)}>  </Text>
                  <Text>{t.name}</Text>
                </Box>
              ))}
            </Box>
          )}
          <Box marginTop={1}><Text color={ansi256(theme.theme.textDim)}>Esc to go back</Text></Box>
        </Box>
      ) : (
        <Box flexDirection="column">
          <Box marginBottom={1}>
            <Text color={ansi256(theme.theme.secondary)} bold>MCP Servers</Text>
          </Box>

          {servers.length === 0 ? (
            <Text color={ansi256(theme.theme.textDim)}>No MCP servers configured.</Text>
          ) : (
            <Box flexDirection="column">
              {servers.map((s, i) => {
                const isSelected = i === selectedIdx;
                const icon = STATUS_ICONS[s.status] ?? "?";
                return (
                  <Box key={s.name}>
                    <Text color={isSelected ? ansi256(theme.theme.secondary) : ansi256(theme.theme.textDim)}>
                      {isSelected ? "> " : "  "}
                      {icon} {s.name} ({s.toolCount} tools)
                      {s.status === "failed" && isSelected ? (
                        <Text color={ansi256(theme.theme.warning)}> — press R to reconnect</Text>
                      ) : s.status === "failed" ? (
                        <Text color={ansi256(theme.theme.warning)}> (failed)</Text>
                      ) : null}
                      {s.pinChanged ? (
                        <Text color={ansi256(theme.theme.warning)}>{isSelected ? " — " : " "}pinned-defs changed — re-approve</Text>
                      ) : null}
                      {s.status === "reconnecting" ? (
                        <Text color={ansi256(theme.theme.warning)}> reconnecting...</Text>
                      ) : null}
                      {s.status === "starting" ? (
                        <Text color={ansi256(theme.theme.textDim)}> starting...</Text>
                      ) : null}
                    </Text>
                  </Box>
                );
              })}
            </Box>
          )}

          {pinReapprove ? (
            <Box flexDirection="column" marginTop={1}>
              <Text color={ansi256(theme.theme.warning)}>Tool definitions for {pinReapprove} changed since last approval — re-approve? (y/n)</Text>
            </Box>
          ) : null}

          <Box flexDirection="column" marginTop={1}>
            <Text color={ansi256(theme.theme.textDim)}>↑↓ navigate · Enter drill-down · R reconnect · Esc close</Text>
          </Box>
        </Box>
      )}
    </Box>
  );
}

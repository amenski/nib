import React, { useState, useEffect } from "react";
import { Box, Text, useInput } from "ink";
import type { ProviderBalance } from "../../providers/types.js";
import { useTheme } from "../contexts.js";
import { ansi256 } from "../theme.js";

interface ModelUsageRow {
  input: number;
  output: number;
  cached: number;
}

interface Props {
  providerName: string;
  /**
   * Live balance query for the active provider. Resolves to null when the
   * provider has no balance endpoint or the query failed. Queried once per
   * open — decision I (feature-plans.md §7): live every time, no caching.
   */
  getBalance: () => Promise<ProviderBalance | null>;
  /** Per-model token totals accumulated this session (MutableState.modelUsage). */
  modelUsage?: Record<string, ModelUsageRow>;
  sessionInput: number;
  sessionOutput: number;
  onClose: () => void;
  width: number;
}

const fmtTokens = (n: number) => n.toLocaleString("en-US");
const fmtMoney = (n: number) => `$${n.toFixed(2)}`;

export default function UsageView({
  providerName,
  getBalance,
  modelUsage = {},
  sessionInput,
  sessionOutput,
  onClose,
  width,
}: Props) {
  const theme = useTheme();
  // undefined = still querying; null = not supported / query failed.
  const [balance, setBalance] = useState<ProviderBalance | null | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    getBalance().then((b) => {
      if (cancelled) return;
      setBalance(b);
    });
    return () => {
      cancelled = true;
    };
    // Query once on open; re-renders (e.g. queued-input updates) must not
    // re-fetch — the view is mounted per /usage and unmounted on close.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useInput((_value, key) => {
    if (key.escape) {
      onClose();
      return;
    }
  });

  const modelKeys = Object.keys(modelUsage);

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={ansi256(theme.theme.secondary)} paddingX={1} marginY={1} width={width}>
      <Box marginBottom={1}>
        <Text color={ansi256(theme.theme.secondary)} bold>Usage</Text>
        <Text color={ansi256(theme.theme.textDim)}> — {providerName}</Text>
      </Box>

      <Box flexDirection="column" marginBottom={1}>
        <Text bold>Balance</Text>
        {balance === undefined ? (
          <Text color={ansi256(theme.theme.textDim)}>Querying…</Text>
        ) : balance === null ? (
          <Text color={ansi256(theme.theme.textDim)}>Balance not supported for {providerName}.</Text>
        ) : (
          <Box flexDirection="column">
            <Text color={ansi256(theme.theme.textDim)}>{`  Currency   ${balance.currency}`}</Text>
            <Text color={ansi256(theme.theme.textDim)}>{`  Total      ${fmtMoney(balance.total)}`}</Text>
            <Text color={ansi256(theme.theme.textDim)}>{`  Granted    ${fmtMoney(balance.granted)}`}</Text>
            <Text color={ansi256(theme.theme.textDim)}>{`  Remaining  ${fmtMoney(balance.total - balance.granted)}`}</Text>
          </Box>
        )}
      </Box>

      <Box flexDirection="column" marginBottom={1}>
        <Text bold>Tokens by model</Text>
        {modelKeys.length === 0 ? (
          <Text color={ansi256(theme.theme.textDim)}>No token usage recorded yet this session.</Text>
        ) : (
          <Box flexDirection="column">
            {modelKeys.map((model) => {
              const u = modelUsage[model];
              return (
                <Text key={model} color={ansi256(theme.theme.textDim)}>
                  {`  ${model}: ${fmtTokens(u.input)} in / ${fmtTokens(u.output)} out / ${fmtTokens(u.cached)} cached`}
                </Text>
              );
            })}
          </Box>
        )}
        <Text color={ansi256(theme.theme.textDim)}>
          {`  Session total: ${(sessionInput / 1000).toFixed(1)}k in / ${(sessionOutput / 1000).toFixed(1)}k out`}
        </Text>
      </Box>

      <Box>
        <Text color={ansi256(theme.theme.textDim)}>Esc close</Text>
      </Box>
    </Box>
  );
}

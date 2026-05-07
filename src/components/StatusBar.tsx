import { Box, Text } from "ink";
import { getTheme } from "../lib/theme.js";
import type { AppState, TokenUsage } from "../lib/types.js";

interface StatusBarProps {
  messageCount: number;
  appState: AppState;
  error?: string;
  info?: string;
  totalUsage: TokenUsage;
}

export function StatusBar({ messageCount, appState, error, info, totalUsage }: StatusBarProps) {
  const theme = getTheme();
  const costDisplay = totalUsage.totalCost > 0 ? `$${totalUsage.totalCost.toFixed(4)}` : "";

  return (
    <Box justifyContent="space-between" paddingX={1}>
      {error ? (
        <Text color={theme.error} wrap="truncate">
          {error}
        </Text>
      ) : appState === "streaming" ? (
        <Text color={theme.accent}>Streaming response...</Text>
      ) : appState === "awaiting-approval" ? (
        <Text color={theme.accent}>Awaiting approval — press y to approve, n to deny</Text>
      ) : (
        <Text color={theme.dim}>
          {messageCount} message{messageCount !== 1 ? "s" : ""}
          {info ? ` · ${info}` : ""}
          {costDisplay ? ` · ${costDisplay}` : ""}
        </Text>
      )}
      <Text color={theme.dim}>
        {appState === "streaming"
          ? "Esc to stop · "
          : appState === "awaiting-approval"
            ? "y/n · Esc to deny · "
            : "/help · "}
        Ctrl+C to exit
      </Text>
    </Box>
  );
}

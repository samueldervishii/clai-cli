import { Box, Text } from "ink";
import { getTheme } from "../lib/theme.js";
import { renderMarkdown } from "../lib/markdown.js";
import type { ChatMessage } from "../lib/types.js";

const TOOL_LABELS: Record<string, string> = {
  read_file: "Read",
  list_dir: "List",
  search_files: "Search",
  write_file: "Write",
  run_command: "Run",
};

interface MessageProps {
  message: ChatMessage;
}

export function Message({ message }: MessageProps) {
  const theme = getTheme();
  const isUser = message.role === "user";
  const bulletColor = isUser ? theme.prompt : theme.system;

  return (
    <Box flexDirection="column" marginTop={1}>
      <Box>
        <Text color={bulletColor}>• </Text>
        <Text bold color={isUser ? theme.userColor : theme.accent}>
          {isUser ? "You" : "Clai"}
        </Text>
      </Box>
      <Box flexDirection="column" marginLeft={3}>
        {!isUser && message.segments ? (
          message.segments.map((seg, i) => {
            if (seg.type === "text") {
              return (
                <Text key={i} color={theme.assistantColor} wrap="wrap">
                  {renderMarkdown(seg.content)}
                </Text>
              );
            }
            const label = TOOL_LABELS[seg.name] ?? seg.name;
            const target =
              (seg.input.path as string) ??
              (seg.input.pattern as string) ??
              (seg.input.command as string) ??
              "";
            return (
              <Text key={i} color={theme.dim} dimColor>
                {seg.isError ? "✗" : "✓"} {label} {target}
              </Text>
            );
          })
        ) : (
          <>
            {isUser && message.images?.length ? (
              <Text color={theme.dim}>[image attached]</Text>
            ) : null}
            <Text color={isUser ? undefined : theme.assistantColor} wrap="wrap">
              {isUser || message.id.startsWith("system-")
                ? message.content
                : renderMarkdown(message.content)}
            </Text>
          </>
        )}
      </Box>
    </Box>
  );
}

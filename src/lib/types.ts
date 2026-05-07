// Ordered segments for interleaved text + tool display
export type MessageSegment =
  | { type: "text"; content: string }
  | {
      type: "tool";
      name: string;
      input: Record<string, unknown>;
      output?: string;
      isError?: boolean;
    };

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  model?: string;
  segments?: MessageSegment[];
  images?: ChatImage[];
}

export type AppState = "idle" | "streaming" | "awaiting-approval" | "error";

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalCost: number;
}

export interface ToolCallInfo {
  name: string;
  input: Record<string, unknown>;
  output?: string;
  isError?: boolean;
}

export interface ChatImage {
  data: string; // base64
  mediaType: string;
}

export type ToolPermission = "always" | "ask" | "never";

export interface ClaiConfig {
  defaultModel?: string;
  systemPrompt?: string;
  maxTokens?: number;
  lifetimeSpend?: number;
  presets?: Record<string, string>;
  theme?: string;
  toolPermissions?: Record<string, ToolPermission>;
}

// Events yielded by the streaming chat generator
export type StreamEvent =
  | { type: "text_delta"; text: string }
  | { type: "tool_start"; tool: ToolCallInfo }
  | { type: "tool_done"; tool: ToolCallInfo }
  | { type: "tool_approve"; tool: ToolCallInfo; approve: () => void; deny: () => void }
  | { type: "warning"; message: string };

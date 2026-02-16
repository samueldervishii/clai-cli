/**
 * Groq provider implementation (OpenAI-compatible API)
 * Groq provides fast inference with models like Llama, GPT-OSS, Mixtral
 */

import OpenAI from "openai";
import type {
  ChatCompletionChunk,
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions";
import { TOOL_DEFINITIONS, executeTool } from "./tools.js";
import type { ChatMessage, StreamEvent } from "./types.js";
import type { AIProvider, StreamResult } from "./providers.js";
import { getModelConfig, DEFAULT_MAX_TOKENS } from "./providers.js";
import { getToolPermission } from "./config.js";
import { checkRateLimit, retryWithBackoff } from "./retry.js";
import { logToolCall, logToolApproved, logToolDenied, logSensitiveFileAccess } from "./audit.js";

let _client: OpenAI | null = null;

function getClient(): OpenAI {
  if (!_client) {
    if (!process.env.GROQ_API_KEY) {
      throw new Error(
        "GROQ_API_KEY is not set. Use `/model <groq-model>` to be prompted for the API key.",
      );
    }
    _client = new OpenAI({
      apiKey: process.env.GROQ_API_KEY,
      baseURL: "https://api.groq.com/openai/v1",
    });
  }
  return _client;
}

/** Reset cached client (e.g. after API key change) */
export function resetGroqClient(): void {
  _client = null;
}

// Convert Anthropic tool format to OpenAI format
function convertToolsToOpenAI(): ChatCompletionTool[] {
  return TOOL_DEFINITIONS.map((tool) => ({
    type: "function" as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.input_schema,
    },
  }));
}

const MAX_TOOL_ROUNDS = 10;

export class GroqProvider implements AIProvider {
  getApiKeyName(): string {
    return "GROQ_API_KEY";
  }

  hasApiKey(): boolean {
    return !!process.env.GROQ_API_KEY;
  }

  async *streamChat(
    messages: ChatMessage[],
    model: string,
    maxTokens: number = DEFAULT_MAX_TOKENS,
    systemPrompt?: string,
    signal?: AbortSignal,
  ): AsyncGenerator<StreamEvent, StreamResult, unknown> {
    // Convert messages to OpenAI format
    let apiMessages: ChatCompletionMessageParam[] = messages.map((m) => {
      // Groq supports vision through OpenAI-compatible API
      if (m.images?.length) {
        const content: OpenAI.Chat.ChatCompletionContentPart[] = m.images.map((img) => ({
          type: "image_url" as const,
          image_url: {
            url: `data:${img.mediaType};base64,${img.data}`,
          },
        }));
        if (m.content) {
          content.unshift({ type: "text" as const, text: m.content });
        }
        return {
          role: m.role as "user" | "assistant",
          content,
        } as ChatCompletionMessageParam;
      }
      return {
        role: m.role as "user" | "assistant",
        content: m.content,
      } as ChatCompletionMessageParam;
    });

    // Add system prompt as first message if provided
    if (systemPrompt) {
      apiMessages = [{ role: "system" as const, content: systemPrompt }, ...apiMessages];
    }

    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let finalText = "";

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      // Check if aborted before starting a new round
      if (signal?.aborted) break;

      let stream: AsyncIterable<ChatCompletionChunk>;

      try {
        stream = await retryWithBackoff(
          async () => {
            return await getClient().chat.completions.create(
              {
                model,
                max_tokens: maxTokens,
                messages: apiMessages,
                tools: convertToolsToOpenAI(),
                stream: true,
              },
              { signal },
            );
          },
          {
            maxRetries: 2,
            initialDelay: 1000,
            signal,
            onRetry: (attempt, delay) => {
              console.error(`Retrying API call (attempt ${attempt}) after ${delay}ms...`);
            },
          },
        );
      } catch (error) {
        // Check for rate limiting
        const rateLimitInfo = checkRateLimit(error);
        if (rateLimitInfo.isRateLimited) {
          const waitTime = rateLimitInfo.retryAfter
            ? `Wait ${rateLimitInfo.retryAfter} seconds`
            : "Try again later";
          yield {
            type: "warning",
            message: `Rate limit exceeded. ${waitTime}. ${rateLimitInfo.message}`,
          };
        }
        throw error;
      }

      let currentToolCalls: Record<number, { id: string; name: string; arguments: string }> = {};
      let stopReason: string | null = null;
      let roundInputTokens = 0;
      let roundOutputTokens = 0;

      for await (const chunk of stream as AsyncIterable<ChatCompletionChunk>) {
        if (signal?.aborted) break;

        const choice = chunk.choices[0];
        if (!choice) continue;

        // Track token usage — Groq may send usage in multiple chunks per round,
        // so take the latest value (not cumulative) to avoid double-counting
        if (chunk.usage) {
          roundInputTokens = chunk.usage.prompt_tokens ?? 0;
          roundOutputTokens = chunk.usage.completion_tokens ?? 0;
        }

        // Handle text deltas
        if (choice.delta.content) {
          finalText += choice.delta.content;
          yield { type: "text_delta", text: choice.delta.content };
        }

        // Handle tool calls
        if (choice.delta.tool_calls) {
          for (const toolCall of choice.delta.tool_calls) {
            const idx = toolCall.index;
            if (!currentToolCalls[idx]) {
              currentToolCalls[idx] = {
                id: toolCall.id ?? "",
                name: toolCall.function?.name ?? "",
                arguments: "",
              };
            }
            if (toolCall.function?.arguments) {
              currentToolCalls[idx]!.arguments += toolCall.function.arguments;
            }
          }
        }

        if (choice.finish_reason) {
          stopReason = choice.finish_reason;
        }
      }

      // Add this round's token usage to totals
      totalInputTokens += roundInputTokens;
      totalOutputTokens += roundOutputTokens;

      // Execute tool calls
      const toolResults: ChatCompletionMessageParam[] = [];
      const toolCallsArray = Object.values(currentToolCalls);

      if (toolCallsArray.length > 0) {
        // Add assistant message with tool calls
        apiMessages.push({
          role: "assistant",
          content: null,
          tool_calls: toolCallsArray.map((tc) => ({
            id: tc.id,
            type: "function" as const,
            function: { name: tc.name, arguments: tc.arguments },
          })),
        });

        for (const toolCall of toolCallsArray) {
          let toolInput: Record<string, unknown>;
          try {
            toolInput = JSON.parse(toolCall.arguments || "{}");
          } catch {
            toolInput = {};
          }

          // Log tool call attempt
          logToolCall(toolCall.name, toolInput);

          // Check tool permission from config
          const permission = getToolPermission(toolCall.name);

          // If permission is "never", deny immediately
          if (permission === "never") {
            logToolDenied(toolCall.name, toolInput);
            toolResults.push({
              role: "tool",
              content: `Tool "${toolCall.name}" is disabled by user configuration.`,
              tool_call_id: toolCall.id,
            });
            yield {
              type: "tool_done",
              tool: {
                name: toolCall.name,
                input: toolInput,
                output: "Disabled by configuration",
                isError: true,
              },
            };
            continue;
          }

          // Check if tool requires approval based on permission setting and content
          let needsApproval = permission === "ask";

          // For write_file and run_command, always require approval unless permission is "always"
          if (
            (toolCall.name === "write_file" || toolCall.name === "run_command") &&
            permission !== "always"
          ) {
            needsApproval = true;
          }

          // For read_file, check if it's a sensitive file
          let isSensitiveFile = false;
          if (toolCall.name === "read_file" && permission !== "always") {
            const checkResult = executeTool(toolCall.name, toolInput, false);
            isSensitiveFile = checkResult.requiresApproval ?? false;
            needsApproval = needsApproval || isSensitiveFile;
          }

          if (needsApproval) {
            let resolveApproval!: (approved: boolean) => void;
            const approvalPromise = new Promise<boolean>((r) => {
              resolveApproval = r;
            });

            yield {
              type: "tool_approve" as const,
              tool: { name: toolCall.name, input: toolInput },
              approve: () => resolveApproval(true),
              deny: () => resolveApproval(false),
            };

            const approved = await approvalPromise;

            if (!approved) {
              logToolDenied(toolCall.name, toolInput);
              if (isSensitiveFile && typeof toolInput.path === "string") {
                logSensitiveFileAccess(toolCall.name, toolInput.path, false);
              }

              const action =
                toolCall.name === "write_file"
                  ? "file write"
                  : toolCall.name === "run_command"
                    ? "command execution"
                    : "file read";
              toolResults.push({
                role: "tool",
                content: `User denied this ${action}.`,
                tool_call_id: toolCall.id,
              });
              yield {
                type: "tool_done",
                tool: {
                  name: toolCall.name,
                  input: toolInput,
                  output: "Denied by user",
                  isError: true,
                },
              };
              continue;
            }

            // Log approval
            if (isSensitiveFile && typeof toolInput.path === "string") {
              logSensitiveFileAccess(toolCall.name, toolInput.path, true);
            }
          }

          yield {
            type: "tool_start",
            tool: { name: toolCall.name, input: toolInput },
          };

          const result = executeTool(toolCall.name, toolInput, true); // Skip approval check on execution

          // Log tool execution result
          logToolApproved(toolCall.name, toolInput, !result.isError, result.output);

          yield {
            type: "tool_done",
            tool: {
              name: toolCall.name,
              input: toolInput,
              output: result.output,
              isError: result.isError,
            },
          };

          toolResults.push({
            role: "tool",
            content: result.output,
            tool_call_id: toolCall.id,
          });
        }

        apiMessages.push(...toolResults);
      }

      if (stopReason !== "tool_calls" || toolCallsArray.length === 0) {
        break;
      }

      if (round === MAX_TOOL_ROUNDS - 1) {
        yield {
          type: "warning",
          message: `Reached maximum tool call rounds (${MAX_TOOL_ROUNDS}). Response may be incomplete.`,
        };
      }
    }

    const modelConfig = getModelConfig(model);
    const pricing = modelConfig?.pricing ?? { input: 0, output: 0 };
    const totalCost =
      (totalInputTokens / 1_000_000) * pricing.input +
      (totalOutputTokens / 1_000_000) * pricing.output;

    return {
      text: finalText,
      usage: {
        inputTokens: totalInputTokens,
        outputTokens: totalOutputTokens,
        totalCost,
      },
    };
  }
}

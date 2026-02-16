/**
 * Anthropic Claude provider implementation
 */

import Anthropic from "@anthropic-ai/sdk";
import type {
  RawMessageStreamEvent,
  ContentBlock,
  TextBlock,
  ToolUseBlock,
} from "@anthropic-ai/sdk/resources/messages/messages";
import { TOOL_DEFINITIONS, executeTool } from "./tools.js";
import type { ChatMessage, StreamEvent } from "./types.js";
import type { AIProvider, StreamResult } from "./providers.js";
import { getModelConfig, DEFAULT_MAX_TOKENS } from "./providers.js";
import { getToolPermission } from "./config.js";
import { checkRateLimit, retryWithBackoff } from "./retry.js";
import { logToolCall, logToolApproved, logToolDenied, logSensitiveFileAccess } from "./audit.js";

let _client: Anthropic | null = null;

function getClient(): Anthropic {
  if (!_client) {
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new Error("ANTHROPIC_API_KEY is not set. Run `clai` interactively to configure it.");
    }
    _client = new Anthropic();
  }
  return _client;
}

/** Reset cached client (e.g. after API key change) */
export function resetAnthropicClient(): void {
  _client = null;
}

const MAX_TOOL_ROUNDS = 10;

export class AnthropicProvider implements AIProvider {
  getApiKeyName(): string {
    return "ANTHROPIC_API_KEY";
  }

  hasApiKey(): boolean {
    return !!process.env.ANTHROPIC_API_KEY;
  }

  async *streamChat(
    messages: ChatMessage[],
    model: string,
    maxTokens: number = DEFAULT_MAX_TOKENS,
    systemPrompt?: string,
    signal?: AbortSignal,
  ): AsyncGenerator<StreamEvent, StreamResult, unknown> {
    let apiMessages: Anthropic.MessageParam[] = messages.map((m) => {
      if (m.images?.length) {
        const content: Anthropic.ContentBlockParam[] = m.images.map((img) => ({
          type: "image" as const,
          source: {
            type: "base64" as const,
            media_type: img.mediaType as "image/jpeg" | "image/png" | "image/gif" | "image/webp",
            data: img.data,
          },
        }));
        if (m.content) {
          content.push({ type: "text" as const, text: m.content });
        }
        return { role: m.role, content };
      }
      return { role: m.role, content: m.content };
    });

    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let finalText = "";

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      // Check if aborted before starting a new round
      if (signal?.aborted) break;

      let stream: AsyncIterable<RawMessageStreamEvent>;

      try {
        stream = await retryWithBackoff(
          async () => {
            return await getClient().messages.create(
              {
                model,
                max_tokens: maxTokens,
                messages: apiMessages,
                tools: TOOL_DEFINITIONS,
                ...(systemPrompt ? { system: systemPrompt } : {}),
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
              // Note: Can't yield from inside retry callback
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

      const contentBlocks: ContentBlock[] = [];
      let currentToolJson = "";
      let stopReason: string | null = null;

      for await (const event of stream as AsyncIterable<RawMessageStreamEvent>) {
        if (signal?.aborted) break;

        switch (event.type) {
          case "message_start":
            totalInputTokens += event.message.usage.input_tokens;
            break;

          case "content_block_start":
            contentBlocks[event.index] = event.content_block;
            if (event.content_block.type === "tool_use") {
              currentToolJson = "";
            }
            break;

          case "content_block_delta":
            if (event.delta.type === "text_delta") {
              finalText += event.delta.text;
              const textBlock = contentBlocks[event.index];
              if (textBlock?.type === "text") {
                (textBlock as TextBlock).text += event.delta.text;
              }
              yield { type: "text_delta", text: event.delta.text };
            } else if (event.delta.type === "input_json_delta") {
              currentToolJson += event.delta.partial_json;
            }
            break;

          case "content_block_stop": {
            const block = contentBlocks[event.index];
            if (block?.type === "tool_use") {
              try {
                (block as ToolUseBlock).input = JSON.parse(currentToolJson || "{}");
              } catch {
                (block as ToolUseBlock).input = {};
              }
            }
            break;
          }

          case "message_delta":
            stopReason = event.delta.stop_reason;
            totalOutputTokens += event.usage.output_tokens;
            break;
        }
      }

      // Execute tool calls
      const toolResults: Anthropic.ToolResultBlockParam[] = [];

      for (const block of contentBlocks) {
        if (block.type === "tool_use") {
          const toolInput = block.input as Record<string, unknown>;

          // Log tool call attempt
          logToolCall(block.name, toolInput);

          // Check tool permission from config
          const permission = getToolPermission(block.name);

          // If permission is "never", deny immediately
          if (permission === "never") {
            logToolDenied(block.name, toolInput);
            toolResults.push({
              type: "tool_result",
              tool_use_id: block.id,
              content: `Tool "${block.name}" is disabled by user configuration.`,
              is_error: true,
            });
            yield {
              type: "tool_done",
              tool: {
                name: block.name,
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
            (block.name === "write_file" || block.name === "run_command") &&
            permission !== "always"
          ) {
            needsApproval = true;
          }

          // For read_file, check if it's a sensitive file
          let isSensitiveFile = false;
          if (block.name === "read_file" && permission !== "always") {
            const checkResult = executeTool(block.name, toolInput, false);
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
              tool: { name: block.name, input: toolInput },
              approve: () => resolveApproval(true),
              deny: () => resolveApproval(false),
            };

            const approved = await approvalPromise;

            if (!approved) {
              logToolDenied(block.name, toolInput);
              if (isSensitiveFile && typeof toolInput.path === "string") {
                logSensitiveFileAccess(block.name, toolInput.path, false);
              }

              const action =
                block.name === "write_file"
                  ? "file write"
                  : block.name === "run_command"
                    ? "command execution"
                    : "file read";
              toolResults.push({
                type: "tool_result",
                tool_use_id: block.id,
                content: `User denied this ${action}.`,
                is_error: true,
              });
              yield {
                type: "tool_done",
                tool: {
                  name: block.name,
                  input: toolInput,
                  output: "Denied by user",
                  isError: true,
                },
              };
              continue;
            }

            // Log approval
            if (isSensitiveFile && typeof toolInput.path === "string") {
              logSensitiveFileAccess(block.name, toolInput.path, true);
            }
          }

          yield {
            type: "tool_start",
            tool: { name: block.name, input: toolInput },
          };

          const result = executeTool(block.name, toolInput, true); // Skip approval check on execution

          // Log tool execution result
          logToolApproved(block.name, toolInput, !result.isError, result.output);

          yield {
            type: "tool_done",
            tool: {
              name: block.name,
              input: toolInput,
              output: result.output,
              isError: result.isError,
            },
          };

          toolResults.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: result.output,
            is_error: result.isError,
          });
        }
      }

      if (stopReason !== "tool_use" || toolResults.length === 0) {
        break;
      }

      const assistantContent = contentBlocks.filter(
        (block) => !(block.type === "text" && !block.text),
      );

      apiMessages = [
        ...apiMessages,
        { role: "assistant", content: assistantContent },
        { role: "user", content: toolResults },
      ];

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

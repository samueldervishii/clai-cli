/**
 * Multi-provider AI chat interface
 * Routes requests to appropriate provider (Anthropic or Groq)
 */

import { AnthropicProvider, resetAnthropicClient } from "./provider-anthropic.js";
import { GroqProvider, resetGroqClient } from "./provider-groq.js";
import type { ChatMessage, StreamEvent } from "./types.js";
import {
  MODELS,
  DEFAULT_MODEL,
  DEFAULT_MAX_TOKENS,
  getModelConfig,
  getProviderForModel,
  type ModelConfig,
  type StreamResult,
} from "./providers.js";

// Export for backwards compatibility
export { MODELS, DEFAULT_MODEL, DEFAULT_MAX_TOKENS };
export type { StreamResult };

// Create provider instances
const providers = {
  anthropic: new AnthropicProvider(),
  groq: new GroqProvider(),
};

/**
 * Get provider instance for a model
 */
function getProvider(modelNameOrId: string) {
  const providerType = getProviderForModel(modelNameOrId);
  if (!providerType) {
    throw new Error(`Unknown model: ${modelNameOrId}`);
  }
  return providers[providerType];
}

/**
 * Create display name mapping for /model command
 */
export const MODEL_DISPLAY: Record<string, string> = Object.fromEntries(
  Object.entries(MODELS).map(([_name, config]) => [config.id, config.displayName]),
);

/**
 * Stream chat responses from the appropriate AI provider
 */
export async function* streamChat(
  messages: ChatMessage[],
  model: string = DEFAULT_MODEL,
  maxTokens: number = DEFAULT_MAX_TOKENS,
  systemPrompt?: string,
  signal?: AbortSignal,
): AsyncGenerator<StreamEvent, StreamResult, unknown> {
  // Get model config - model param can be short name or full ID
  const config = getModelConfig(model);
  const modelId = config?.id ?? model;

  const provider = getProvider(modelId);

  // Check if API key is configured
  if (!provider.hasApiKey()) {
    const keyName = provider.getApiKeyName();
    throw new Error(
      `${keyName} is not set. Run \`clai\` interactively and select this model to configure it.`,
    );
  }

  return yield* provider.streamChat(messages, modelId, maxTokens, systemPrompt, signal);
}

/**
 * Reset cached provider clients (call after API key changes or model switches)
 */
export function resetClients(): void {
  resetAnthropicClient();
  resetGroqClient();
}

/**
 * Get all available models grouped by provider
 */
export function getAvailableModels(): {
  anthropic: ModelConfig[];
  groq: ModelConfig[];
} {
  const modelList = Object.values(MODELS);
  return {
    anthropic: modelList.filter((m) => m.provider === "anthropic"),
    groq: modelList.filter((m) => m.provider === "groq"),
  };
}

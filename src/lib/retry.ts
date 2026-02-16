/**
 * Retry utilities for API calls with exponential backoff
 */

export interface RetryOptions {
  maxRetries?: number;
  initialDelay?: number; // ms
  maxDelay?: number; // ms
  backoffMultiplier?: number;
  signal?: AbortSignal;
  onRetry?: (attempt: number, delay: number, error: unknown) => void;
}

export interface RateLimitInfo {
  isRateLimited: boolean;
  retryAfter?: number; // seconds
  message?: string;
}

/**
 * Check if an error is a rate limit error (429)
 */
export function checkRateLimit(error: unknown): RateLimitInfo {
  if (!error || typeof error !== "object") {
    return { isRateLimited: false };
  }

  // Anthropic API error format
  if ("status" in error && error.status === 429) {
    const apiError = error as { error?: { message?: string }; headers?: Record<string, string> };
    const retryAfter = apiError.headers?.["retry-after"];
    const retrySeconds = retryAfter ? parseInt(retryAfter, 10) : undefined;

    return {
      isRateLimited: true,
      retryAfter: retrySeconds,
      message: apiError.error?.message ?? "Rate limit exceeded",
    };
  }

  // OpenAI/Groq error format
  if ("code" in error && error.code === "rate_limit_exceeded") {
    return {
      isRateLimited: true,
      message: "Rate limit exceeded",
    };
  }

  return { isRateLimited: false };
}

/**
 * Check if an error is retryable (network errors, 5xx errors)
 */
export function isRetryableError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;

  // Network errors
  if (error instanceof Error) {
    const networkErrors = ["ECONNRESET", "ENOTFOUND", "ETIMEDOUT", "ECONNREFUSED"];
    if (networkErrors.some((code) => error.message.includes(code))) {
      return true;
    }
  }

  // 5xx server errors (but not 429 - handled separately)
  if ("status" in error && typeof error.status === "number") {
    return error.status >= 500 && error.status < 600;
  }

  return false;
}

/**
 * Retry a function with exponential backoff
 */
export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const {
    maxRetries = 3,
    initialDelay = 1000,
    maxDelay = 30000,
    backoffMultiplier = 2,
    signal,
    onRetry,
  } = options;

  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    // Don't retry if aborted
    if (signal?.aborted) {
      throw signal.reason ?? new DOMException("Aborted", "AbortError");
    }

    try {
      return await fn();
    } catch (error) {
      lastError = error;

      // Don't retry if aborted
      if (signal?.aborted) {
        throw error;
      }

      // Don't retry if not a retryable error
      if (!isRetryableError(error)) {
        throw error;
      }

      // Don't retry on last attempt
      if (attempt === maxRetries) {
        throw error;
      }

      // Calculate delay with exponential backoff
      const delay = Math.min(initialDelay * Math.pow(backoffMultiplier, attempt), maxDelay);

      if (onRetry) {
        onRetry(attempt + 1, delay, error);
      }

      // Wait before retrying
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw lastError;
}

const ATTEMPTS = 4;
const BASE_DELAY_MS = 5_000;
const MAX_DELAY_MS = 30_000;

const NON_RETRYABLE_MARKERS = [
  "unauthorized",
  "authentication required",
  "insufficient_scope",
  "access denied",
  "invalid reference",
  "name invalid",
  "manifest invalid",
] as const;

const RETRYABLE_MARKERS = [
  "connection reset",
  "connection refused",
  "context canceled",
  "unexpected eof",
  "short read",
  "timeout",
  "timed out",
  "temporary failure",
  "server misbehaving",
  "too many requests",
  "429",
  "500 internal server error",
  "502 bad gateway",
  "503 service unavailable",
  "504 gateway timeout",
  "unknown error while requesting data via graphql",
] as const;

interface RetryDependencies {
  sleep?: (delayMs: number) => Promise<void>;
  random?: () => number;
  warn?: (message: string) => void;
}

export function registryErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isRetryableRegistryError(error: unknown): boolean {
  const message = registryErrorMessage(error).toLowerCase();
  if (NON_RETRYABLE_MARKERS.some((marker) => message.includes(marker))) {
    return false;
  }

  return (
    RETRYABLE_MARKERS.some((marker) => message.includes(marker)) ||
    message === "eof" ||
    message.endsWith(": eof")
  );
}

export async function retryRegistryOperation<T>(
  description: string,
  operation: () => Promise<T>,
  dependencies: RetryDependencies = {},
): Promise<T> {
  const sleep = dependencies.sleep ?? ((delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)));
  const random = dependencies.random ?? Math.random;
  const warn = dependencies.warn ?? console.warn;

  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (attempt >= ATTEMPTS || !isRetryableRegistryError(error)) {
        throw error;
      }

      const exponentialDelay = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** (attempt - 1));
      const delayMs = Math.round(exponentialDelay * (0.8 + random() * 0.4));
      warn(
        `${description} failed on attempt ${attempt}/${ATTEMPTS}: ${registryErrorMessage(error)}; retrying in ${(delayMs / 1_000).toFixed(1)}s`,
      );
      await sleep(delayMs);
    }
  }

  throw new Error(`${description} exhausted its retry budget`);
}

const DEFAULT_RETRY_COUNT = 3;
const DEFAULT_BASE_DELAY_MS = 5_000;
const DEFAULT_MAX_DELAY_MS = 30_000;

const NON_RETRYABLE_MARKERS = [
  "unauthorized",
  "authentication required",
  "insufficient_scope",
  "access denied",
  "denied: requested access",
  "invalid reference",
  "name invalid",
  "manifest invalid",
  "unsupported media type",
] as const;

const RETRYABLE_MARKERS = [
  "connection reset",
  "connection refused",
  "connection closed",
  "context canceled",
  "broken pipe",
  "dial tcp",
  "i/o timeout",
  "proxyconnect",
  "stream error",
  "received from peer",
  "tls handshake timeout",
  "unexpected eof",
  "short read",
  "timeout",
  "timed out",
  "temporary failure",
  "server misbehaving",
  "too many requests",
  "unknown error while requesting data via graphql",
] as const;

type RetryDependencies = {
  sleep?: (delayMs: number) => Promise<void>;
  random?: () => number;
  warn?: (message: string) => void;
};

export function retryPolicy(
  retryCount = DEFAULT_RETRY_COUNT,
  baseDelayMs = DEFAULT_BASE_DELAY_MS,
  maxDelayMs = DEFAULT_MAX_DELAY_MS,
) {
  if (!Number.isInteger(retryCount) || retryCount < 0 || retryCount > 10) {
    throw new Error("retryCount must be an integer between 0 and 10");
  }
  if (!Number.isInteger(baseDelayMs) || baseDelayMs < 1) {
    throw new Error("baseDelayMs must be a positive integer");
  }
  if (!Number.isInteger(maxDelayMs) || maxDelayMs < baseDelayMs) {
    throw new Error("maxDelayMs must be an integer greater than or equal to baseDelayMs");
  }
  return { retryCount, baseDelayMs, maxDelayMs };
}

export function registryErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error);
  }

  const execError = error as Error & {
    stdout?: unknown;
    stderr?: unknown;
  };
  return [error.message, execError.stdout, execError.stderr]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .join("\n");
}

export function isRetryableRegistryError(
  error: unknown,
  retryNotFound = false,
): boolean {
  const message = registryErrorMessage(error).toLowerCase();
  if (NON_RETRYABLE_MARKERS.some((marker) => message.includes(marker))) {
    return false;
  }
  if (retryNotFound && /\b(404|manifest unknown|name unknown|not found)\b/.test(message)) {
    return true;
  }
  return (
    RETRYABLE_MARKERS.some((marker) => message.includes(marker))
    || /\b(408|425|429|5\d\d)\b/.test(message)
    || message === "eof"
    || message.endsWith(": eof")
  );
}

export async function retryRegistryOperation<T>(
  description: string,
  operation: (attempt: number) => Promise<T>,
  policy: {
    retryCount: number;
    baseDelayMs: number;
    maxDelayMs: number;
  } = retryPolicy(),
  retryNotFound = false,
  dependencies: RetryDependencies = {},
): Promise<T> {
  const sleep = dependencies.sleep
    ?? ((delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)));
  const random = dependencies.random ?? Math.random;
  const warn = dependencies.warn ?? console.warn;
  const attempts = policy.retryCount + 1;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation(attempt);
    } catch (error) {
      if (
        attempt >= attempts
        || !isRetryableRegistryError(error, retryNotFound)
      ) {
        throw error;
      }

      const exponentialDelay = Math.min(
        policy.maxDelayMs,
        policy.baseDelayMs * 2 ** (attempt - 1),
      );
      const delayMs = Math.round(exponentialDelay * (0.5 + random() * 0.5));
      warn(
        `${description} failed on attempt ${attempt}/${attempts}: `
        + `${registryErrorMessage(error)}; retrying in `
        + `${(delayMs / 1_000).toFixed(1)}s`,
      );
      await sleep(delayMs);
    }
  }

  throw new Error(`${description} exhausted its retry budget`);
}

const DEFAULT_RETRY_COUNT = 3;
const DEFAULT_BASE_DELAY_MS = 5_000;
const DEFAULT_MAX_DELAY_MS = 30_000;

const NON_RETRYABLE_MARKERS = [
  "unauthorized",
  "authentication required",
  "insufficient_scope",
  "access denied",
  "403 forbidden",
  "denied: requested access",
  "invalid reference",
  "name invalid",
  "manifest invalid",
  "unsupported media type",
] as const;

function isTerminalRegistryMessage(message: string): boolean {
  return NON_RETRYABLE_MARKERS.some((marker) => message.includes(marker));
}

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
  retryWhen?: (error: unknown) => boolean;
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

export function isMissingRegistryError(error: unknown): boolean {
  return /\b(404|manifest unknown|manifest_unknown|name unknown|name_unknown|not found)\b/i.test(
    registryErrorMessage(error),
  );
}

function hasRetryableHttpStatus(message: string): boolean {
  if (/\b(?:get|head|post|put|patch|delete) request to https?:\/\/\S+:\s+(?:408|425|429|5\d\d)\b/.test(message)) {
    return true;
  }
  // Registry URLs and artifact sizes are not HTTP response statuses.
  const response = message.replace(/https?:\/\/\S+/g, "");
  return /\b(?:http(?:\/\d+(?:\.\d+)?)?(?:\s+status)?|status(?:\s+code)?)\b\s*[:=]?\s*(?:408|425|429|5\d\d)\b/.test(response)
    || /\b(?:408|425|429|5\d\d)\s+(?:response\b|request timeout\b|too early\b|too many requests\b|internal server error\b|not implemented\b|bad gateway\b|service unavailable\b|gateway timeout\b|http version not supported\b|variant also negotiates\b|insufficient storage\b|loop detected\b|not extended\b|network authentication required\b)/.test(response);
}

export function isRetryableRegistryError(
  error: unknown,
  retryNotFound = false,
): boolean {
  const message = registryErrorMessage(error).toLowerCase();
  if (isTerminalRegistryMessage(message)) {
    return false;
  }
  if (retryNotFound && isMissingRegistryError(error)) {
    return true;
  }
  return (
    RETRYABLE_MARKERS.some((marker) => message.includes(marker))
    || hasRetryableHttpStatus(message)
    || message === "eof"
    || message.endsWith(": eof")
  );
}

/** A new image push can restart an ambiguous blob upload with a fresh session. */
export function isImageUploadRangeError(error: unknown): boolean {
  return /\bPUT request to https?:\/\/[^\s/]+\/v2\/[^\s?#]+\/blobs\/uploads\/[^\s?#]+(?:\?[^\s]*)?: (?:416\b|404\b(?:[ \t]+Not Found)?[ \t]*(?::[ \t]*)?(?:\r?\n[ \t]*)?(?:unknown:[ \t]*)?(?:BLOB_UPLOAD_UNKNOWN\b|blob upload unknown to registry\b))/i.test(
    registryErrorMessage(error),
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
        || isTerminalRegistryMessage(registryErrorMessage(error).toLowerCase())
        || (!isRetryableRegistryError(error, retryNotFound) && !dependencies.retryWhen?.(error))
      ) {
        throw error;
      }

      const exponentialDelay = Math.min(
        policy.maxDelayMs,
        policy.baseDelayMs * 2 ** (attempt - 1),
      );
      const delayMs = Math.round(exponentialDelay * (0.5 + random() * 0.5));
      warn(
        `${description} failed on attempt ${attempt}/${attempts}; retrying in `
        + `${(delayMs / 1_000).toFixed(1)}s`,
      );
      await sleep(delayMs);
    }
  }

  throw new Error(`${description} exhausted its retry budget`);
}

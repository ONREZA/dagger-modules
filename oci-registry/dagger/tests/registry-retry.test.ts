import { describe, expect, test } from "bun:test";
import {
  isRetryableRegistryError,
  retryPolicy,
  retryRegistryOperation,
} from "../src/registry-retry.js";

describe("OCI registry retries", () => {
  test("uses the configured retry count with bounded exponential backoff", async () => {
    let calls = 0;
    const delays: number[] = [];
    const result = await retryRegistryOperation(
      "validate layers",
      async () => {
        calls += 1;
        if (calls === 1) throw new Error("502 Bad Gateway");
        if (calls === 2) throw new Error("stream error: received from peer");
        if (calls === 3) throw new Error("unexpected EOF");
        return "PASS";
      },
      retryPolicy(3, 5_000, 30_000),
      false,
      {
        random: () => 1,
        sleep: async (delayMs) => {
          delays.push(delayMs);
        },
        warn: () => {},
      },
    );

    expect(result).toBe("PASS");
    expect(calls).toBe(4);
    expect(delays).toEqual([5_000, 10_000, 20_000]);
  });

  test("retries failures reported in Dagger ExecError output", async () => {
    let calls = 0;
    const result = await retryRegistryOperation(
      "validate layers",
      async () => {
        calls += 1;
        if (calls === 1) {
          throw Object.assign(new Error("process exited with code 1"), {
            stdout: "FAIL: validating layers: 502 Bad Gateway",
            stderr: "",
          });
        }
        return "PASS";
      },
      retryPolicy(3, 5_000, 30_000),
      false,
      {
        random: () => 1,
        sleep: async () => {},
        warn: () => {},
      },
    );

    expect(result).toBe("PASS");
    expect(calls).toBe(2);
  });

  test("classifies operation-aware registry failures", () => {
    expect(isRetryableRegistryError(new Error("HTTP 503 Service Unavailable"))).toBeTrue();
    expect(isRetryableRegistryError(new Error("TLS handshake timeout"))).toBeTrue();
    expect(isRetryableRegistryError(new Error("404 manifest unknown"))).toBeFalse();
    expect(isRetryableRegistryError(new Error("404 manifest unknown"), true)).toBeTrue();
    expect(isRetryableRegistryError(new Error("401 Unauthorized"))).toBeFalse();
  });
});

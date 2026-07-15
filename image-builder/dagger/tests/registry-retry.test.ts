import { describe, expect, test } from "bun:test";
import { isRetryableRegistryError, retryRegistryOperation } from "../src/registry-retry.js";

describe("registry retry", () => {
  test("retries transient failures with bounded exponential backoff", async () => {
    let calls = 0;
    const delays: number[] = [];

    const result = await retryRegistryOperation(
      "publish image",
      async () => {
        calls += 1;
        if (calls === 1) throw new Error("connection reset by peer");
        if (calls === 2) throw new Error("unexpected EOF");
        if (calls === 3) throw new Error("503 Service Unavailable");
        return "registry.example/image@sha256:digest";
      },
      {
        random: () => 0.5,
        sleep: async (delayMs) => {
          delays.push(delayMs);
        },
        warn: () => {},
      },
    );

    expect(result).toContain("@sha256:");
    expect(calls).toBe(4);
    expect(delays).toEqual([5_000, 10_000, 20_000]);
  });

  test("does not retry credential failures", async () => {
    let calls = 0;

    await expect(
      retryRegistryOperation(
        "publish image",
        async () => {
          calls += 1;
          throw new Error("401 Unauthorized: authentication required");
        },
        { sleep: async () => {}, warn: () => {} },
      ),
    ).rejects.toThrow("401 Unauthorized");

    expect(calls).toBe(1);
    expect(isRetryableRegistryError(new Error("403 access denied"))).toBeFalse();
  });
});

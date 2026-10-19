import { describe, expect, test } from "bun:test";
import {
  isImageUploadRangeError,
  isMissingRegistryError,
  isRetryableRegistryError,
  retryPolicy,
  retryRegistryOperation,
} from "../src/registry-retry.js";

const uploadRangeError = () => new Error(
  "unexpected status from PUT request to https://registry.example/v2/team/image/blobs/uploads/session-1?_state=private-upload-token&digest=sha256%3Aabc: 416 Range Not Satisfiable",
);

describe("image upload session recovery", () => {
  test("retries a native upload range rejection only with the publisher policy", async () => {
    let calls = 0;
    const result = await retryRegistryOperation("publish image", async () => {
      if (++calls === 1) throw uploadRangeError();
      return "sha256:published";
    }, retryPolicy(1, 1, 1), false, {
      retryWhen: isImageUploadRangeError,
      sleep: async () => {},
      warn: () => {},
    });
    expect(result).toBe("sha256:published");
    expect(calls).toBe(2);
  });

  test("a non-publisher operation does not retry the same upload error", async () => {
    let calls = 0;
    await expect(retryRegistryOperation("copy", async () => {
      calls++;
      throw uploadRangeError();
    }, retryPolicy(1, 1, 1))).rejects.toThrow("416");
    expect(calls).toBe(1);
  });

  test.each([
    "unexpected status from GET request to https://registry.example/v2/team/image/blobs/sha256:abc: 416 Range Not Satisfiable",
    "unexpected status from PUT request to https://registry.example/v2/team/image/manifests/latest: 416 Range Not Satisfiable",
    "unexpected status from PUT request to https://registry.example/other/blobs/uploads/session-1: 416 Range Not Satisfiable",
    "HTTP 416 Range Not Satisfiable",
  ])("does not classify an unrelated range rejection: %s", (message) => {
    expect(isImageUploadRangeError(new Error(message))).toBeFalse();
  });

  test("keeps authentication failures terminal even for an additional policy", async () => {
    let calls = 0;
    await expect(retryRegistryOperation("publish image", async () => {
      calls++;
      throw new Error("401 Unauthorized");
    }, retryPolicy(1, 1, 1), false, {
      retryWhen: () => true,
      sleep: async () => {},
    })).rejects.toThrow("401 Unauthorized");
    expect(calls).toBe(1);
  });

  test("exhausts the bounded image upload retry budget and preserves the final error", async () => {
    let calls = 0;
    const error = uploadRangeError();
    await expect(retryRegistryOperation("publish image", async () => {
      calls++;
      throw error;
    }, retryPolicy(2, 1, 1), false, {
      retryWhen: isImageUploadRangeError,
      sleep: async () => {},
      warn: () => {},
    })).rejects.toBe(error);
    expect(calls).toBe(3);
  });

  test("retry warnings omit signed upload URLs and tokens", async () => {
    const warnings: string[] = [];
    let calls = 0;
    await retryRegistryOperation("publish image registry.example/team/image:tag", async () => {
      if (++calls === 1) throw new Error("500 response from https://registry.example/upload?_state=private-upload-token");
    }, retryPolicy(1, 1, 1), false, {
      sleep: async () => {},
      warn: (message) => warnings.push(message),
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("publish image registry.example/team/image:tag");
    expect(warnings[0]).not.toContain("_state");
    expect(warnings[0]).not.toContain("private-upload-token");
  });
});

describe("OCI registry retries", () => {
  test.each([
    "push content sha256:abc (550 bytes): unexpected status from PUT request to https://registry.example/v2/team/image/blobs/uploads/session-1: 416 Range Not Satisfiable",
    "registry request failed for https://registry.example:503/v2/team/image",
    "unexpected status from PUT request to https://registry.example:503/v2/team/image",
    "PUT request to https://registry.example/v2/team/image?status=:503",
    "registry request failed for https://registry.example/v2/503/image",
    "registry request failed for https://registry.example/v2/image?attempt=502",
    "registry request failed for https://registry.example/v2/image?status=503",
    "content sha256:500: could not be uploaded",
    "image has 429 layers",
  ])("does not interpret artifact numbers or URL digits as HTTP status: %s", (message) => {
    expect(isRetryableRegistryError(new Error(message))).toBeFalse();
  });

  test.each([
    "HTTP 503 Service Unavailable",
    "HTTP/1.1 503 Service Unavailable",
    "HTTP status: 503",
    "502 Bad Gateway",
    "FAIL: validating layers: 502 Bad Gateway",
    "unexpected status from PUT request to https://registry.example/v2/team/image/blobs/uploads/session-1?offset=0: 500",
    "500 response from https://registry.example/upload",
    "408 Request Timeout",
    "425 Too Early",
    "429 Too Many Requests",
  ])("preserves HTTP status response forms: %s", (message) => {
    expect(isRetryableRegistryError(new Error(message))).toBeTrue();
  });

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

  test("classifies missing registry references independently from retries", () => {
    expect(isMissingRegistryError(new Error("MANIFEST_UNKNOWN: manifest unknown"))).toBeTrue();
    expect(isMissingRegistryError(new Error("404 Not Found"))).toBeTrue();
    expect(isMissingRegistryError(new Error("503 Service Unavailable"))).toBeFalse();
    expect(isMissingRegistryError(new Error("401 Unauthorized"))).toBeFalse();
  });
});

import { describe, expect, test } from "bun:test";
import {
  assertPushReference,
  canonicalReference,
  parseReference,
} from "../src/registry-reference.js";

describe("OCI references", () => {
  test("parses tag and digest references", () => {
    expect(parseReference("cr.example.test/team/image:v1")).toEqual({
      reference: "cr.example.test/team/image:v1",
      registry: "cr.example.test",
      repository: "team/image",
      tag: "v1",
      digest: undefined,
    });
    expect(
      parseReference(`cr.example.test/team/image@sha256:${"a".repeat(64)}`),
    ).toEqual({
      reference: `cr.example.test/team/image@sha256:${"a".repeat(64)}`,
      registry: "cr.example.test",
      repository: "team/image",
      tag: undefined,
      digest: `sha256:${"a".repeat(64)}`,
    });
  });

  test("normalizes canonical digest references", () => {
    expect(
      canonicalReference(
        "cr.example.test/team/image:v1",
        `sha256:${"b".repeat(64)}`,
      ),
    ).toBe(`cr.example.test/team/image@sha256:${"b".repeat(64)}`);
    expect(assertPushReference("cr.example.test/team/image:v1").tag).toBe("v1");
  });
});

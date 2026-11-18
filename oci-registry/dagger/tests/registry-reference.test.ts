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

  test.each([
    ["cr.selcloud.ru", "kaiki/engine", "candidate-v17"],
    ["registry.example.test:5000", "team/nested/image", "v1.2_Release"],
  ])("uses the digest for %s/%s:%s", (registry, repository, tag) => {
    const digest = `sha256:${"a".repeat(64)}`;
    expect(parseReference(`oci://${registry}/${repository}:${tag}@${digest}`)).toEqual({
      reference: `${registry}/${repository}@${digest}`,
      registry,
      repository,
      tag,
      digest,
    });
  });

  test("validates the tag separately from the digest", () => {
    for (const tag of ["", "-invalid", ".invalid", "x".repeat(129)]) {
      expect(() => parseReference(`cr.example.test/team/image:${tag}@sha256:${"a".repeat(64)}`))
        .toThrow("invalid tag");
    }
  });

  test("preserves digest and repository validation for tagged digests", () => {
    for (const digest of ["", "sha256:not-hex", `sha256:${"a".repeat(31)}`]) {
      expect(() => parseReference(`cr.example.test/team/image:v1@${digest}`))
        .toThrow("invalid digest");
    }
    for (const repository of ["Team/image", "team//image", "team:other/image", "team/image:invalid"]) {
      expect(() => parseReference(`cr.example.test/${repository}:v1@sha256:${"a".repeat(64)}`))
        .toThrow("invalid repository");
    }
  });

  test("push destinations reject both digest forms", () => {
    const digest = `sha256:${"a".repeat(64)}`;
    expect(assertPushReference("cr.example.test/team/image:v1").reference)
      .toBe("cr.example.test/team/image:v1");
    for (const suffix of [`@${digest}`, `:v1@${digest}`]) {
      expect(() => assertPushReference(`cr.example.test/team/image${suffix}`))
        .toThrow("must use a tag");
    }
  });

  test("repository-only references reject tags and both digest forms", () => {
    const repository = "registry.example.test:5000/team/nested/image";
    const digest = `sha256:${"a".repeat(64)}`;
    expect(parseReference(repository, true).repository).toBe("team/nested/image");
    for (const suffix of [":v1", `@${digest}`, `:v1@${digest}`]) {
      expect(() => parseReference(`${repository}${suffix}`, true))
        .toThrow("must not include a tag or digest");
    }
  });

  test("canonical references replace both the old tag and digest", () => {
    expect(canonicalReference(
      `cr.example.test/team/image:v1@sha256:${"a".repeat(64)}`,
      `sha256:${"b".repeat(64)}`,
    )).toBe(`cr.example.test/team/image@sha256:${"b".repeat(64)}`);
    expect(() => canonicalReference("cr.example.test/team/image:v1", "sha256:invalid"))
      .toThrow("registry returned invalid digest");
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

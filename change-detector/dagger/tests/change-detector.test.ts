import { describe, expect, test } from "bun:test";
import { detectChangesForFiles, resolveExplicitBaseRef, toDetectResult } from "../src/index.js";

const METADATA = {
  commitSha: "0123456789abcdef",
  shortSha: "01234567",
  timestamp: "20260613-120000",
  lastTag: "s-20260613-000000-00000000",
};

const GROUPS = [
  { name: "shared", detectPaths: ["packages/shared/**"] },
  { name: "migrations", detectPaths: ["db/migrations/**"] },
];

const SERVICES = [
  { name: "api", detectPaths: ["apps/api/**"], dependsOn: ["shared"] },
  { name: "worker", detectPaths: ["apps/worker/**"], dependsOn: ["api"] },
];

describe("change-detector", () => {
  test("reports group-only changes without service rebuilds", () => {
    const result = detectChangesForFiles(["db/migrations/001.sql"], SERVICES, GROUPS, METADATA);

    expect(result.groups.migrations).toBe(true);
    expect(result.services.api).toBe(false);
    expect(result.services.worker).toBe(false);
    expect(result.anyChanged).toBe(true);
    expect(result.reasons.groups.migrations.paths).toEqual(["db/migrations/001.sql"]);
  });

  test("propagates dependencies in service order", () => {
    const result = detectChangesForFiles(["packages/shared/logger.ts"], SERVICES, GROUPS, METADATA);

    expect(result.groups.shared).toBe(true);
    expect(result.services.api).toBe(true);
    expect(result.services.worker).toBe(true);
    expect(result.reasons.services.api.dependencies).toEqual(["shared"]);
    expect(result.reasons.services.worker.dependencies).toEqual(["api"]);
  });

  test("keeps direct paths and dependency reasons separate", () => {
    const result = detectChangesForFiles(
      ["packages/shared/logger.ts", "apps/api/router.ts"],
      SERVICES,
      GROUPS,
      METADATA,
    );

    expect(result.services.api).toBe(true);
    expect(result.reasons.services.api.paths).toEqual(["apps/api/router.ts"]);
    expect(result.reasons.services.api.dependencies).toEqual(["shared"]);
  });

  test("keeps compact detect output backward-compatible", () => {
    const result = detectChangesForFiles(["packages/shared/logger.ts"], SERVICES, GROUPS, METADATA);
    const compact = toDetectResult(result);

    expect(compact).toEqual({
      services: { api: true, worker: true },
      groups: { shared: true, migrations: false },
      commitSha: METADATA.commitSha,
      shortSha: METADATA.shortSha,
      timestamp: METADATA.timestamp,
      anyChanged: true,
    });
    expect("changedFiles" in compact).toBe(false);
    expect("reasons" in compact).toBe(false);
  });

  test("rejects unsupported glob syntax", () => {
    expect(() =>
      detectChangesForFiles(["apps/api/router.ts"], [{ name: "api", detectPaths: ["apps/*"] }], GROUPS, METADATA),
    ).toThrow("Unsupported glob pattern");
  });

  test("accepts an explicitly resolved base from a divergent history", async () => {
    const resolved = "f".repeat(40);

    expect(await resolveExplicitBaseRef("p-20260613-120000-deadbeef", async () => resolved)).toBe(resolved);
  });

  test("rejects invalid and unresolved explicit bases", async () => {
    expect(resolveExplicitBaseRef("../main", async () => "f".repeat(40))).rejects.toThrow("Invalid base ref");
    expect(resolveExplicitBaseRef("missing", async () => "")).rejects.toThrow(
      "Base ref does not resolve to a commit",
    );
  });
});

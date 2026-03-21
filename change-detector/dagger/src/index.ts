import { dag, type Directory, func, object, type Secret } from "@dagger.io/dagger";

interface ServiceDef {
  name: string;
  detectPaths: string[];
  dependsOn?: string[];
}

interface GroupDef {
  name: string;
  detectPaths: string[];
}

/**
 * Generic git-diff based change detection with glob patterns.
 *
 * Compares HEAD against the last tag matching a given prefix to determine
 * which services and dependency groups have changed. Supports glob-based
 * path matching, cross-service dependency propagation, version file reading,
 * and CalVer version generation.
 */
@object()
export class ChangeDetector {
  /**
   * Detect which services changed based on git diff.
   *
   * Compares HEAD against the last tag matching the given prefix.
   * Returns a JSON object with per-service and per-group change flags,
   * commit metadata, and a summary `anyChanged` boolean.
   *
   * @param source - Git repository source directory
   * @param tagPrefix - Tag prefix to search for (e.g., "s", "p", "v")
   * @param forceAll - Force all services as changed
   * @param servicesJson - JSON array of {name, detectPaths, dependsOn?} objects
   * @param groupsJson - JSON array of {name, detectPaths} objects (virtual dependency groups)
   * @returns JSON string with detection results
   */
  @func()
  async detect(
    source: Directory,
    tagPrefix: string,
    forceAll: boolean = false,
    servicesJson: string = "[]",
    groupsJson: string = "[]",
  ): Promise<string> {
    const services = JSON.parse(servicesJson) as ServiceDef[];
    const groups = JSON.parse(groupsJson) as GroupDef[];

    // Validate dependencies early — catch config errors even with forceAll
    const groupNames = new Set(groups.map((g) => g.name));
    const seenServices = new Set<string>();
    for (const svc of services) {
      for (const dep of svc.dependsOn ?? []) {
        if (!groupNames.has(dep) && !seenServices.has(dep)) {
          throw new Error(
            `Service "${svc.name}" depends on "${dep}" which is neither a group nor a service defined earlier in the list.`,
          );
        }
      }
      seenServices.add(svc.name);
    }

    const gitCtr = dag
      .container()
      .from("alpine:3.21")
      .withExec(["apk", "add", "--no-cache", "git"])
      .withMountedDirectory("/src", source)
      .withWorkdir("/src")
      .withExec(["git", "config", "--global", "--add", "safe.directory", "/src"]);

    const commitSha = (await gitCtr.withExec(["git", "rev-parse", "HEAD"]).stdout()).trim();
    const shortSha = commitSha.slice(0, 8);
    const timestamp = (
      await gitCtr.withExec(["git", "log", "-1", "--format=%cd", "--date=format:%Y%m%d-%H%M%S", commitSha]).stdout()
    ).trim();

    if (forceAll) {
      return JSON.stringify({
        services: Object.fromEntries(services.map((s) => [s.name, true])),
        groups: Object.fromEntries(groups.map((g) => [g.name, true])),
        commitSha,
        shortSha,
        timestamp,
        anyChanged: true,
      });
    }

    // Find last tag matching the prefix
    const allTagsRaw = (
      await gitCtr.withExec(["git", "tag", "-l", `${tagPrefix}-*`, "--sort=-creatordate"]).stdout()
    ).trim();
    const lastTag = allTagsRaw.split("\n")[0] ?? "";

    if (!lastTag) {
      return JSON.stringify({
        services: Object.fromEntries(services.map((s) => [s.name, true])),
        groups: Object.fromEntries(groups.map((g) => [g.name, true])),
        commitSha,
        shortSha,
        timestamp,
        anyChanged: true,
      });
    }

    const changedFilesRaw = (
      await gitCtr.withExec(["git", "diff", "--name-only", lastTag, "HEAD"]).stdout()
    ).trim();

    if (!changedFilesRaw) {
      return JSON.stringify({
        services: Object.fromEntries(services.map((s) => [s.name, false])),
        groups: Object.fromEntries(groups.map((g) => [g.name, false])),
        commitSha,
        shortSha,
        timestamp,
        anyChanged: false,
      });
    }

    const changedFiles = changedFilesRaw.split("\n").filter(Boolean);

    // Match groups first (services may depend on them)
    const groupChanges: Record<string, boolean> = {};
    for (const group of groups) {
      const patterns = group.detectPaths.map(globToRegex);
      groupChanges[group.name] = changedFiles.some((f) => patterns.some((p) => p.test(f)));
    }

    // Match services (direct path match + dependency propagation)
    const serviceChanges: Record<string, boolean> = {};
    for (const svc of services) {
      const patterns = svc.detectPaths.map(globToRegex);
      const directMatch = changedFiles.some((f) => patterns.some((p) => p.test(f)));
      const depMatch = svc.dependsOn?.some((dep) => groupChanges[dep] || serviceChanges[dep]) ?? false;
      serviceChanges[svc.name] = directMatch || depMatch;
    }

    const anyServiceChanged = Object.values(serviceChanges).some(Boolean);
    const anyGroupChanged = Object.values(groupChanges).some(Boolean);

    return JSON.stringify({
      services: serviceChanges,
      groups: groupChanges,
      commitSha,
      shortSha,
      timestamp,
      anyChanged: anyServiceChanged || anyGroupChanged,
    });
  }

  /**
   * Read a version file from the source directory.
   *
   * Returns the trimmed content, or the default value if the file doesn't exist.
   * Useful for reading `.bun-version`, `.node-version`, `.rust-toolchain`, etc.
   *
   * @param source - Source directory
   * @param filePath - Path to version file (e.g., ".bun-version", ".node-version")
   * @param defaultVersion - Default version if file doesn't exist
   */
  @func()
  async readVersionFile(
    source: Directory,
    filePath: string = ".bun-version",
    defaultVersion: string = "1",
  ): Promise<string> {
    try {
      const content = await source.file(filePath).contents();
      return content.trim() || defaultVersion;
    } catch {
      return defaultVersion;
    }
  }

  /**
   * Generate a CalVer bundle version by querying an OCI registry for existing tags.
   *
   * Format: `vYYYY.MMDD.NNN` (e.g., `v2026.0302.001`). Automatically increments
   * the sequence number to avoid collisions with existing tags.
   *
   * @param registry - Container registry URL (e.g., "ghcr.io")
   * @param repo - Repository path (e.g., "my-org/release-production")
   * @param registryAuth - Docker registry auth (dockerconfigjson format)
   */
  @func({ cache: "never" })
  async generateCalver(
    registry: string,
    repo: string,
    registryAuth: Secret,
  ): Promise<string> {
    const craneCtr = dag
      .container()
      .from("cgr.dev/chainguard/crane:latest-dev@sha256:e0b9051884102836e487ab9a707c510d5fb8d6688b4c9d05441b4d136f2a31ee")
      .withMountedSecret("/run/secrets/dockerconfig", registryAuth, { mode: 0o444 })
      .withExec(["sh", "-c", "mkdir -p ~/.docker && cat /run/secrets/dockerconfig > ~/.docker/config.json"]);

    const now = new Date();
    const year = now.getUTCFullYear();
    const mmdd = `${String(now.getUTCMonth() + 1).padStart(2, "0")}${String(now.getUTCDate()).padStart(2, "0")}`;
    const datePrefix = `v${year}.${mmdd}`;
    const versionPattern = /^v\d{4}\.\d{4}\.\d{3}$/;

    const existingRaw = await craneCtr
      .withExec(["sh", "-c", `crane ls "${registry}/${repo}" 2>/dev/null || echo ""`])
      .stdout();

    const existing = existingRaw.trim().split("\n").filter(Boolean);
    const todayTags = existing.filter((t) => t.startsWith(datePrefix) && versionPattern.test(t)).sort();
    const lastSeqStr = todayTags.at(-1)?.split(".").at(-1);
    const baseSeq = lastSeqStr ? Number(lastSeqStr) + 1 : 1;

    for (let attempt = 0; attempt < 10; attempt++) {
      const version = `${datePrefix}.${String(baseSeq + attempt).padStart(3, "0")}`;
      const checkResult = (
        await craneCtr
          .withEnvVariable("_CACHE_BUST", `${Date.now()}-${attempt}`)
          .withExec([
            "sh",
            "-c",
            `crane manifest "${registry}/${repo}:${version}" > /dev/null 2>&1 && echo "exists" || echo "free"`,
          ])
          .stdout()
      ).trim();
      if (checkResult === "free") return version;
    }

    throw new Error(`Failed to generate unique CalVer version after 10 attempts (prefix: ${datePrefix})`);
  }
}

/**
 * Convert a simple glob pattern to a RegExp.
 *
 * Supported patterns:
 *   - `path/to/dir/**`  — matches everything inside the directory
 *   - `path/to/file.ext` — exact file match
 *
 * Throws on unsupported glob syntax (*, ?, [...]) to prevent silent mismatches.
 */
function globToRegex(pattern: string): RegExp {
  if (pattern.endsWith("/**")) {
    const prefix = pattern.slice(0, -3);
    if (prefix.includes("*") || prefix.includes("?") || prefix.includes("[")) {
      throw new Error(
        `Unsupported glob pattern: "${pattern}". Only "path/**" (directory) and exact paths are supported.`,
      );
    }
    const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`^${escaped}/.+`);
  }
  if (pattern.includes("*") || pattern.includes("?") || pattern.includes("[")) {
    throw new Error(
      `Unsupported glob pattern: "${pattern}". Only "path/**" (directory) and exact paths are supported.`,
    );
  }
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escaped}$`);
}

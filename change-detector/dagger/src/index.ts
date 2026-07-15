import { argument, dag, type Directory, func, object, type Secret } from "@dagger.io/dagger";

const SHELL = "sh";
const CRANE_IMAGE = "gcr.io/go-containerregistry/crane:debug@sha256:22de5fee4326edae01a568c5a53b69c755901c5f5aa1c06a7c907bef18937356";
const GIT_IMAGE = "alpine/git:2.54.0";

interface ServiceDef {
  name: string;
  detectPaths: string[];
  dependsOn?: string[];
}

interface GroupDef {
  name: string;
  detectPaths: string[];
}

interface DirectReason {
  paths: string[];
}

interface ServiceReason extends DirectReason {
  dependencies: string[];
}

interface ChangeMetadata {
  commitSha: string;
  shortSha: string;
  timestamp: string;
  lastTag: string;
}

export interface DetailedChangeDetectionResult {
  services: Record<string, boolean>;
  groups: Record<string, boolean>;
  commitSha: string;
  shortSha: string;
  timestamp: string;
  anyChanged: boolean;
  lastTag: string;
  changedFiles: string[];
  reasons: {
    services: Record<string, ServiceReason>;
    groups: Record<string, DirectReason>;
  };
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
    @argument({
      ignore: [
        "target",
        "**/target",
        "node_modules",
        "**/node_modules",
        "dist",
        "**/dist",
        "out",
        "**/out",
        ".private",
        ".cache",
        "**/.cache",
      ],
    })
    source: Directory,
    tagPrefix: string,
    forceAll: boolean = false,
    servicesJson: string = "[]",
    groupsJson: string = "[]",
    baseRef: string = "",
  ): Promise<string> {
    const result = await detectChangesFromGit(source, tagPrefix, servicesJson, groupsJson, forceAll, baseRef);
    return JSON.stringify(toDetectResult(result));
  }

  /**
   * Explain why services and groups changed.
   *
   * Keeps `detect` compact and backward-compatible while exposing tag,
   * changed files, direct path matches, and propagated dependencies for debugging.
   */
  @func()
  async explain(
    @argument({
      ignore: [
        "target",
        "**/target",
        "node_modules",
        "**/node_modules",
        "dist",
        "**/dist",
        "out",
        "**/out",
        ".private",
        ".cache",
        "**/.cache",
      ],
    })
    source: Directory,
    tagPrefix: string,
    forceAll: boolean = false,
    servicesJson: string = "[]",
    groupsJson: string = "[]",
    baseRef: string = "",
  ): Promise<string> {
    const result = await detectChangesFromGit(source, tagPrefix, servicesJson, groupsJson, forceAll, baseRef);
    return JSON.stringify(result, null, 2);
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
    @argument({
      ignore: [
        "target",
        "**/target",
        "node_modules",
        "**/node_modules",
        "dist",
        "**/dist",
        "out",
        "**/out",
        ".private",
        ".cache",
        "**/.cache",
      ],
    })
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
      .from(CRANE_IMAGE)
      .withUser("root")
      .withMountedSecret("/root/.docker/config.json", registryAuth, { mode: 0o400 });

    const now = new Date();
    const year = now.getUTCFullYear();
    const mmdd = `${String(now.getUTCMonth() + 1).padStart(2, "0")}${String(now.getUTCDate()).padStart(2, "0")}`;
    const datePrefix = `v${year}.${mmdd}`;
    const versionPattern = /^v\d{4}\.\d{4}\.\d{3}$/;

    const existingRaw = await craneCtr.withExec([SHELL, "-c", `crane ls "${registry}/${repo}"`]).stdout();

    const existing = existingRaw.trim().split("\n").filter(Boolean);
    const todayTags = existing.filter((t) => t.startsWith(datePrefix) && versionPattern.test(t)).sort();
    const lastSeqStr = todayTags.at(-1)?.split(".").at(-1);
    const baseSeq = lastSeqStr ? Number(lastSeqStr) + 1 : 1;

    for (let attempt = 0; attempt < 10; attempt++) {
      const version = `${datePrefix}.${String(baseSeq + attempt).padStart(3, "0")}`;
      const checkResult = (
        await craneCtr
          .withExec([
            SHELL,
            "-c",
            [
              `if crane manifest "${registry}/${repo}:${version}" >/dev/null 2>/tmp/crane-manifest.err; then`,
              '  echo "exists"',
              "elif grep -Eiq '(manifest unknown|manifest_unknown|name unknown|name_unknown|not found|404)' /tmp/crane-manifest.err; then",
              '  echo "free"',
              "else",
              "  cat /tmp/crane-manifest.err >&2",
              "  exit 1",
              "fi",
            ].join("\n"),
          ])
          .stdout()
      ).trim();
      if (checkResult === "free") return version;
    }

    throw new Error(`Failed to generate unique CalVer version after 10 attempts (prefix: ${datePrefix})`);
  }
}

async function detectChangesFromGit(
  source: Directory,
  tagPrefix: string,
  servicesJson: string,
  groupsJson: string,
  forceAll: boolean,
  baseRef: string,
): Promise<DetailedChangeDetectionResult> {
  const services = JSON.parse(servicesJson) as ServiceDef[];
  const groups = JSON.parse(groupsJson) as GroupDef[];
  validateDependencies(services, groups);

  const gitCtr = dag
    .container()
    .from(GIT_IMAGE)
    .withMountedDirectory("/src", source)
    .withWorkdir("/src")
    .withExec(["git", "config", "--global", "--add", "safe.directory", "/src"]);

  const commitSha = (await gitCtr.withExec(["git", "rev-parse", "HEAD"]).stdout()).trim();
  const shortSha = commitSha.slice(0, 8);
  const timestamp = (
    await gitCtr.withExec(["git", "log", "-1", "--format=%cd", "--date=format:%Y%m%d-%H%M%S", commitSha]).stdout()
  ).trim();

  const lastTag = forceAll
    ? ""
    : baseRef
      ? await resolveBaseRef(gitCtr, baseRef)
      : await findLastTag(gitCtr, tagPrefix);
  if (forceAll || !lastTag) {
    return forcedResult(services, groups, commitSha, shortSha, timestamp, lastTag);
  }

  const changedFiles = await listChangedFiles(gitCtr, lastTag);
  return detectChangesForFiles(changedFiles, services, groups, { commitSha, shortSha, timestamp, lastTag });
}

export function detectChangesForFiles(
  changedFiles: string[],
  services: ServiceDef[],
  groups: GroupDef[],
  metadata: ChangeMetadata,
): DetailedChangeDetectionResult {
  if (changedFiles.length === 0) {
    return {
      services: Object.fromEntries(services.map((svc) => [svc.name, false])),
      groups: Object.fromEntries(groups.map((group) => [group.name, false])),
      commitSha: metadata.commitSha,
      shortSha: metadata.shortSha,
      timestamp: metadata.timestamp,
      anyChanged: false,
      lastTag: metadata.lastTag,
      changedFiles,
      reasons: { services: {}, groups: {} },
    };
  }

  const groupChanges: Record<string, boolean> = {};
  const groupReasons: Record<string, DirectReason> = {};
  for (const group of groups) {
    const paths = matchingFiles(changedFiles, group.detectPaths);
    groupChanges[group.name] = paths.length > 0;
    if (paths.length > 0) {
      groupReasons[group.name] = { paths };
    }
  }

  const serviceChanges: Record<string, boolean> = {};
  const serviceReasons: Record<string, ServiceReason> = {};
  for (const svc of services) {
    const paths = matchingFiles(changedFiles, svc.detectPaths);
    const dependencies = (svc.dependsOn ?? []).filter((dep) => groupChanges[dep] || serviceChanges[dep]);
    const changed = paths.length > 0 || dependencies.length > 0;
    serviceChanges[svc.name] = changed;
    if (changed) {
      serviceReasons[svc.name] = { paths, dependencies };
    }
  }

  const anyServiceChanged = Object.values(serviceChanges).some(Boolean);
  const anyGroupChanged = Object.values(groupChanges).some(Boolean);

  return {
    services: serviceChanges,
    groups: groupChanges,
    commitSha: metadata.commitSha,
    shortSha: metadata.shortSha,
    timestamp: metadata.timestamp,
    anyChanged: anyServiceChanged || anyGroupChanged,
    lastTag: metadata.lastTag,
    changedFiles,
    reasons: { services: serviceReasons, groups: groupReasons },
  };
}

export function toDetectResult(result: DetailedChangeDetectionResult) {
  return {
    services: result.services,
    groups: result.groups,
    commitSha: result.commitSha,
    shortSha: result.shortSha,
    timestamp: result.timestamp,
    anyChanged: result.anyChanged,
  };
}

function validateDependencies(services: ServiceDef[], groups: GroupDef[]): void {
  const groupNames = new Set<string>();
  for (const group of groups) {
    if (!group.name || groupNames.has(group.name)) throw new Error(`Duplicate or empty group name: ${group.name}`);
    groupNames.add(group.name);
    group.detectPaths.forEach(globToRegex);
  }
  const seenServices = new Set<string>();
  for (const svc of services) {
    if (!svc.name || seenServices.has(svc.name) || groupNames.has(svc.name)) {
      throw new Error(`Duplicate, empty, or ambiguous service name: ${svc.name}`);
    }
    svc.detectPaths.forEach(globToRegex);
    for (const dep of svc.dependsOn ?? []) {
      if (!groupNames.has(dep) && !seenServices.has(dep)) {
        throw new Error(
          `Service "${svc.name}" depends on "${dep}" which is neither a group nor a service defined earlier in the list.`,
        );
      }
    }
    seenServices.add(svc.name);
  }
}

async function findLastTag(gitCtr: ReturnType<typeof dag.container>, tagPrefix: string): Promise<string> {
  const allTagsRaw = (
    await gitCtr.withExec(["git", "tag", "--merged", "HEAD", "-l", `${tagPrefix}-*`, "--sort=-creatordate"]).stdout()
  ).trim();
  return allTagsRaw.split("\n")[0] ?? "";
}

async function resolveBaseRef(gitCtr: ReturnType<typeof dag.container>, baseRef: string): Promise<string> {
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(baseRef) ||
    baseRef.includes("..") ||
    baseRef.includes("//") ||
    baseRef.endsWith("/")
  ) {
    throw new Error(`Invalid base ref: ${baseRef}`);
  }

  let resolved: string;
  try {
    resolved = (
      await gitCtr.withExec(["git", "rev-parse", "--verify", "--end-of-options", `${baseRef}^{commit}`]).stdout()
    ).trim();
  } catch {
    throw new Error(`Base ref does not resolve to a commit: ${baseRef}`);
  }

  try {
    await gitCtr.withExec(["git", "merge-base", "--is-ancestor", resolved, "HEAD"]).sync();
  } catch {
    throw new Error(`Base ref is not an ancestor of HEAD: ${baseRef}`);
  }
  return resolved;
}

async function listChangedFiles(gitCtr: ReturnType<typeof dag.container>, lastTag: string): Promise<string[]> {
  const changedFilesRaw = (await gitCtr.withExec(["git", "diff", "--name-only", lastTag, "HEAD"]).stdout()).trim();
  if (!changedFilesRaw) return [];
  return changedFilesRaw.split("\n").filter(Boolean);
}

function forcedResult(
  services: ServiceDef[],
  groups: GroupDef[],
  commitSha: string,
  shortSha: string,
  timestamp: string,
  lastTag: string,
): DetailedChangeDetectionResult {
  return {
    services: Object.fromEntries(services.map((svc) => [svc.name, true])),
    groups: Object.fromEntries(groups.map((group) => [group.name, true])),
    commitSha,
    shortSha,
    timestamp,
    anyChanged: true,
    lastTag,
    changedFiles: [],
    reasons: {
      services: Object.fromEntries(services.map((svc) => [svc.name, { paths: [], dependencies: ["forceAll"] }])),
      groups: Object.fromEntries(groups.map((group) => [group.name, { paths: ["forceAll"] }])),
    },
  };
}

function matchingFiles(files: string[], patterns: string[]): string[] {
  const regexes = patterns.map(globToRegex);
  return files.filter((file) => regexes.some((regex) => regex.test(file)));
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

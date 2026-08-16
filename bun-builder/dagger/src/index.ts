import {
  CacheSharingMode,
  type CacheVolume,
  type Container,
  type Directory,
  dag,
  func,
  object,
} from "@dagger.io/dagger";

const SHELL = "/bin/sh";
const DEFAULT_BUN_IMAGE = "oven/bun:1.3.14@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4";
const PACKAGE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const ENVIRONMENT_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

function cacheSharingMode(value: string): CacheSharingMode {
  switch (value.toLowerCase()) {
    case "locked":
      return CacheSharingMode.Locked;
    case "private":
      return CacheSharingMode.Private;
    case "shared":
      return CacheSharingMode.Shared;
    default:
      throw new Error(`Unsupported cache sharing mode: ${value}`);
  }
}

function withPackageManagerCache(
  ctr: Container,
  alpine: boolean,
  cacheId: string,
  sharing: CacheSharingMode,
): Container {
  if (alpine) {
    return ctr.withMountedCache("/var/cache/apk", dag.cacheVolume(`apk-cache-${cacheId}`), { sharing });
  }

  return ctr.withMountedCache("/var/cache/apt/archives", dag.cacheVolume(`apt-archives-${cacheId}`), { sharing });
}

function installCaCertificates(ctr: Container, alpine: boolean): Container {
  if (alpine) {
    return ctr.withExec(["apk", "add", "--cache-dir", "/var/cache/apk", "--update-cache", "ca-certificates"]);
  }

  return ctr.withExec([
    SHELL,
    "-c",
    [
      "rm -f /etc/apt/apt.conf.d/docker-clean",
      "apt-get update -qq",
      "apt-get install -y -qq --no-install-recommends ca-certificates",
      "rm -rf /var/lib/apt/lists/*",
    ].join(" && "),
  ]);
}

function bunBuildContainer(container?: Container): Container {
  return container ?? dag.container().from(DEFAULT_BUN_IMAGE);
}

function validatePackageName(pkg: string): void {
  if (!PACKAGE_NAME_PATTERN.test(pkg)) {
    throw new Error(`Invalid Bun package build name: ${pkg}`);
  }
}

function parseEnvironmentVariables(raw: string): Record<string, string> {
  const value = JSON.parse(raw) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("envVarsJson must contain a JSON object");
  }
  for (const [key, entry] of Object.entries(value)) {
    if (!ENVIRONMENT_NAME_PATTERN.test(key) || typeof entry !== "string") {
      throw new Error(`Invalid environment variable entry: ${key}`);
    }
  }
  return value as Record<string, string>;
}

/**
 * Generic Bun build module.
 *
 * Provides dependency installation, frontend builds with environment variable
 * injection, and standalone binary compilation via `bun build --compile`.
 */
@object()
export class BunBuilder {
  /**
   * Run `bun install --frozen-lockfile` with persistent cache.
   * Returns the source directory with node_modules populated.
   *
   * @param source - Source directory containing bun.lock and package.json
   * @param bunContainer - Prepared Bun build container. Defaults to the pinned upstream Bun image.
   */
  @func()
  async install(
    source: Directory,
    bunContainer?: Container,
    installCache?: CacheVolume,
    cacheSharing: string = "locked",
  ): Promise<Directory> {
    const dependencyInput = source.filter({
      include: ["package.json", "bun.lock", "bunfig.toml", "**/package.json", "**/bunfig.toml"],
      exclude: ["**/node_modules/**"],
    });
    const installed = bunBuildContainer(bunContainer)
      .withDirectory("/app", dependencyInput)
      .withWorkdir("/app")
      .withMountedCache("/root/.bun/install/cache", installCache ?? dag.cacheVolume("bun-install-cache"), {
        sharing: cacheSharingMode(cacheSharing),
      })
      .withExec(["bun", "install", "--frozen-lockfile", "--ignore-scripts"])
      .directory("/app");

    return source.withDirectory(".", installed);
  }

  /**
   * Build a frontend package with environment variables.
   *
   * Runs `bun run build:{pkg}` inside a container with the given environment
   * variables.
   *
   * @param source - Source directory (should have node_modules from install step or will auto-install)
   * @param pkg - Package name (used as `bun run build:{pkg}`)
   * @param envVarsJson - JSON object of environment variables to set (e.g. '{"VITE_API_URL":"https://api.example.com"}')
   * @param databaseUrl - Database URL for Prisma generate (if needed)
   * @param bunContainer - Prepared Bun build container. Defaults to the pinned upstream Bun image.
   */
  @func()
  async build(
    source: Directory,
    pkg: string,
    bunContainer?: Container,
    envVarsJson: string = "{}",
    databaseUrl: string = "",
    installCache?: CacheVolume,
    cacheSharing: string = "private",
    systemPackagesInstalled: boolean = false,
  ): Promise<Directory> {
    validatePackageName(pkg);
    const envVars = parseEnvironmentVariables(envVarsJson);

    let ctr = bunBuildContainer(bunContainer);

    const sharing = cacheSharingMode(cacheSharing);
    if (!systemPackagesInstalled) {
      const alpine = await ctr.exists("/etc/alpine-release");
      ctr = installCaCertificates(withPackageManagerCache(ctr, alpine, "bun-ca-certificates", sharing), alpine);
    }

    ctr = ctr
      .withMountedDirectory("/app", source)
      .withWorkdir("/app")
      .withMountedCache("/root/.bun/install/cache", installCache ?? dag.cacheVolume("bun-install-cache"), {
        sharing,
      })
      .withEnvVariable("NODE_ENV", "production");

    if (databaseUrl) {
      ctr = ctr.withEnvVariable("DATABASE_URL", databaseUrl);
    }

    for (const [key, value] of Object.entries(envVars)) {
      ctr = ctr.withEnvVariable(key, value);
    }

    ctr = ctr.withExec(["bun", "run", `build:${pkg}`]);

    return ctr.directory("/app");
  }

  /**
   * Compile a standalone Bun binary.
   *
   * Uses `bun build --compile` via the package's build script
   * (`bun run build:{pkg}`). Returns the source directory with the compiled
   * binary.
   *
   * @param source - Source directory with node_modules
   * @param pkg - Package name (used as `bun run build:{pkg}`)
   * @param databaseUrl - Database URL for Prisma generate (if needed)
   * @param bunContainer - Prepared Bun build container. Defaults to the pinned upstream Bun image.
   */
  @func()
  async buildBinary(
    source: Directory,
    pkg: string,
    bunContainer?: Container,
    databaseUrl: string = "",
    installCache?: CacheVolume,
    cacheSharing: string = "private",
  ): Promise<Directory> {
    validatePackageName(pkg);
    let ctr = bunBuildContainer(bunContainer)
      .withMountedDirectory("/app", source)
      .withWorkdir("/app")
      .withMountedCache("/root/.bun/install/cache", installCache ?? dag.cacheVolume("bun-install-cache"), {
        sharing: cacheSharingMode(cacheSharing),
      });

    if (databaseUrl) {
      ctr = ctr.withEnvVariable("DATABASE_URL", databaseUrl);
    }

    ctr = ctr.withExec(["bun", "run", `build:${pkg}`]);

    return ctr.directory("/app");
  }
}

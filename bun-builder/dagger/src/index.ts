import {
  CacheSharingMode,
  type CacheVolume,
  type Container,
  type Directory,
  dag,
  func,
  object,
  type Secret,
} from "@dagger.io/dagger";

const SHELL = "/bin/sh";

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

function isAlpineImage(image: string): boolean {
  return image.includes("alpine");
}

function withPackageManagerCache(ctr: Container, image: string, cacheId: string): Container {
  if (isAlpineImage(image)) {
    return ctr.withMountedCache("/var/cache/apk", dag.cacheVolume(`apk-cache-${cacheId}`));
  }

  return ctr.withMountedCache("/var/cache/apt/archives", dag.cacheVolume(`apt-archives-${cacheId}`));
}

function installCaCertificates(ctr: Container, image: string): Container {
  if (isAlpineImage(image)) {
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

function validatePackageName(pkg: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(pkg)) {
    throw new Error(`Invalid Bun package build name: ${pkg}`);
  }
}

function parseEnvironmentVariables(raw: string): Record<string, string> {
  const value = JSON.parse(raw) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("envVarsJson must contain a JSON object");
  }
  for (const [key, entry] of Object.entries(value)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof entry !== "string") {
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
   * @param source - Source directory containing bun.lockb and package.json
   * @param bunImage - Bun Docker image to use
   */
  @func()
  async install(
    source: Directory,
    bunImage: string = "oven/bun:1-debian",
    installCache?: CacheVolume,
    cacheSharing: string = "shared",
  ): Promise<Directory> {
    const dependencyInput = source.filter({
      include: ["package.json", "bun.lock", "bunfig.toml", "**/package.json", "**/bunfig.toml"],
      exclude: ["**/node_modules/**"],
    });
    const installed = dag
      .container()
      .from(bunImage)
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
   * variables. Optionally sets up Sentry release and auth token for sourcemap
   * uploads.
   *
   * @param source - Source directory (should have node_modules from install step or will auto-install)
   * @param pkg - Package name (used as `bun run build:{pkg}`)
   * @param envVarsJson - JSON object of environment variables to set (e.g. '{"VITE_API_URL":"https://api.example.com"}')
   * @param databaseUrl - Database URL for Prisma generate (if needed)
   * @param bunImage - Bun Docker image to use
   * @param sentryRelease - Sentry release tag (sets SENTRY_RELEASE and VITE_SENTRY_RELEASE env vars)
   * @param sentryToken - Sentry auth token for sourcemap uploads
   */
  @func()
  async build(
    source: Directory,
    pkg: string,
    envVarsJson: string = "{}",
    databaseUrl: string = "",
    bunImage: string = "oven/bun:1-debian",
    sentryRelease: string = "",
    sentryToken?: Secret,
    installCache?: CacheVolume,
    cacheSharing: string = "shared",
  ): Promise<Directory> {
    validatePackageName(pkg);
    const envVars = parseEnvironmentVariables(envVarsJson);

    let ctr = dag
      .container()
      .from(bunImage);

    ctr = installCaCertificates(withPackageManagerCache(ctr, bunImage, "bun-ca-certificates"), bunImage);

    ctr = ctr
      .withMountedDirectory("/app", source)
      .withWorkdir("/app")
      .withMountedCache("/root/.bun/install/cache", installCache ?? dag.cacheVolume("bun-install-cache"), {
        sharing: cacheSharingMode(cacheSharing),
      })
      .withEnvVariable("NODE_ENV", "production");

    if (databaseUrl) {
      ctr = ctr.withEnvVariable("DATABASE_URL", databaseUrl);
    }

    for (const [key, value] of Object.entries(envVars)) {
      ctr = ctr.withEnvVariable(key, value);
    }

    if (sentryRelease) {
      ctr = ctr
        .withEnvVariable("SENTRY_RELEASE", sentryRelease)
        .withEnvVariable("VITE_SENTRY_RELEASE", sentryRelease);
    }

    if (sentryToken) {
      ctr = ctr.withSecretVariable("SENTRY_AUTH_TOKEN", sentryToken);
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
   * @param bunImage - Bun Docker image to use
   */
  @func()
  async buildBinary(
    source: Directory,
    pkg: string,
    databaseUrl: string = "",
    bunImage: string = "oven/bun:1-debian",
    installCache?: CacheVolume,
    cacheSharing: string = "shared",
  ): Promise<Directory> {
    validatePackageName(pkg);
    let ctr = dag
      .container()
      .from(bunImage)
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

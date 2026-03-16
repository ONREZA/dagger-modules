import { dag, type Directory, func, object, type Secret } from "@dagger.io/dagger";

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
  async install(source: Directory, bunImage: string = "oven/bun:1-debian"): Promise<Directory> {
    return dag
      .container()
      .from(bunImage)
      .withMountedDirectory("/app", source)
      .withWorkdir("/app")
      .withMountedCache("/root/.bun/install/cache", dag.cacheVolume("bun-install-cache"))
      .withExec(["bun", "install", "--frozen-lockfile", "--ignore-scripts"])
      .directory("/app");
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
  ): Promise<Directory> {
    const envVars = JSON.parse(envVarsJson) as Record<string, string>;

    let ctr = dag
      .container()
      .from(bunImage)
      .withMountedDirectory("/app", source)
      .withWorkdir("/app")
      .withMountedCache("/root/.bun/install/cache", dag.cacheVolume("bun-install-cache"))
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

    // Install CA certs for HTTPS requests during build (e.g., Sentry sourcemap upload)
    ctr = ctr.withExec(["sh", "-c", "apt-get update -qq && apt-get install -y -qq ca-certificates > /dev/null 2>&1"]);

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
  ): Promise<Directory> {
    let ctr = dag
      .container()
      .from(bunImage)
      .withMountedDirectory("/app", source)
      .withWorkdir("/app")
      .withMountedCache("/root/.bun/install/cache", dag.cacheVolume("bun-install-cache"));

    if (databaseUrl) {
      ctr = ctr.withEnvVariable("DATABASE_URL", databaseUrl);
    }

    ctr = ctr.withExec(["bun", "run", `build:${pkg}`]);

    return ctr.directory("/app");
  }
}

import { type Container, dag, type Directory, func, object, type Secret, type Service } from "@dagger.io/dagger";

const SHELL = "/bin/sh";

function isAlpineImage(image: string): boolean {
  return image.includes("alpine");
}

function withPackageManagerCache(ctr: Container, buildImage: string, cacheId: string): Container {
  if (isAlpineImage(buildImage)) {
    return ctr.withMountedCache("/var/cache/apk", dag.cacheVolume(`apk-cache-${cacheId}`));
  }

  return ctr.withMountedCache("/var/cache/apt/archives", dag.cacheVolume(`apt-archives-${cacheId}`));
}

function installSystemPackages(ctr: Container, buildImage: string, packages: string[]): Container {
  if (packages.length === 0) return ctr;

  if (isAlpineImage(buildImage)) {
    return ctr.withExec(["apk", "add", "--cache-dir", "/var/cache/apk", "--update-cache", ...packages]);
  }

  return ctr.withExec([
    SHELL,
    "-c",
    [
      "rm -f /etc/apt/apt.conf.d/docker-clean",
      "apt-get update",
      `apt-get install -y --no-install-recommends ${packages.join(" ")}`,
      "rm -rf /var/lib/apt/lists/*",
    ].join(" && "),
  ]);
}

/**
 * Generic Cargo (Rust) build module.
 *
 * Compiles Rust binaries with persistent cache volumes for cargo registry,
 * git dependencies, and build artifacts. Supports both musl (Alpine) and
 * glibc (Debian) targets, workspace manifests, SSH private dependencies,
 * and database service bindings for compile-time verification (e.g., sqlx).
 */
@object()
export class CargoBuilder {
  /**
   * Build Rust binaries via `cargo build --release`.
   *
   * Uses Dagger cache volumes for cargo registry and target directory to
   * speed up incremental builds. Returns the source directory with built
   * binaries copied to `.production/binaries/{cacheId}/`.
   *
   * @param source - Source directory containing Cargo workspace
   * @param buildImage - Rust build image (e.g., "rust:1.93-alpine" or "rust:1.93")
   * @param targets - Comma-separated cargo targets (e.g., "my-server,my-cli")
   * @param cacheId - Cache directory identifier (e.g., "musl" or "glibc") — used for cache volume naming
   * @param workspaceManifest - Path to workspace Cargo.toml relative to source root (empty = root)
   * @param extraPackages - Space-separated system packages to install (auto-detects Alpine vs Debian)
   * @param buildEnv - Comma-separated env vars for build (e.g., "DATABASE_URL=postgres://...,SQLX_OFFLINE=true")
   * @param binFlags - If true, use `--bin <target>` instead of `-p <target>`
   * @param sshKey - SSH private key for private git dependencies
   * @param sshHost - SSH host to keyscan for known_hosts (e.g., "github.com")
   * @param sshPort - SSH port for the host (default: 22)
   * @param dbService - Dagger Service for database access during build (sqlx compile-time verification)
   * @param dbHostname - Hostname for the database service binding (default: "db")
   */
  @func()
  async build(
    source: Directory,
    buildImage: string,
    targets: string,
    cacheId: string,
    workspaceManifest: string = "",
    extraPackages: string = "",
    buildEnv: string = "",
    binFlags: boolean = false,
    sshKey?: Secret,
    sshHost: string = "github.com",
    sshPort: number = 22,
    dbService?: Service,
    dbHostname: string = "db",
  ): Promise<Directory> {
    const packageSet = new Set(extraPackages.split(/\s+/).filter(Boolean));
    if (sshKey) {
      packageSet.add("git");
      packageSet.add("git-lfs");
      packageSet.add("openssh-client");
    }

    let ctr = dag
      .container()
      .from(buildImage)
      // Persistent cargo cache volumes
      .withMountedCache("/cargo-cache/registry", dag.cacheVolume(`cargo-registry-${cacheId}`))
      .withMountedCache("/cargo-cache/git", dag.cacheVolume(`cargo-git-${cacheId}`))
      .withMountedCache("/cargo-cache/target", dag.cacheVolume(`cargo-target-${cacheId}`))
      .withEnvVariable("CARGO_HOME", "/cargo-cache")
      .withEnvVariable("CARGO_TARGET_DIR", "/cargo-cache/target");

    ctr = withPackageManagerCache(ctr, buildImage, cacheId);

    // Bind database service for sqlx compile-time verification
    if (dbService) {
      ctr = ctr.withServiceBinding(dbHostname, dbService);
    }

    ctr = installSystemPackages(ctr, buildImage, [...packageSet]);

    // Setup SSH for private git dependencies
    if (sshKey) {
      ctr = ctr.withExec(["git", "lfs", "install"]);

      const sshPortStr = String(sshPort);
      const sshCmd =
        sshPort === 22
          ? "ssh -i /root/.ssh/id_rsa -o StrictHostKeyChecking=accept-new"
          : `ssh -p ${sshPortStr} -i /root/.ssh/id_rsa -o StrictHostKeyChecking=accept-new -o HostKeyAlgorithms=+ssh-rsa`;

      ctr = ctr
        .withMountedSecret("/root/.ssh/id_rsa", sshKey, { mode: 0o400 })
        .withExec([
          SHELL,
          "-c",
          `ssh-keyscan -p ${sshPortStr} ${sshHost} >> /root/.ssh/known_hosts 2>/dev/null || true`,
        ])
        .withEnvVariable("GIT_SSH_COMMAND", sshCmd)
        // Tell cargo to use system git (which has SSH access)
        .withExec([
          SHELL,
          "-c",
          `mkdir -p /cargo-cache && printf '[net]\\ngit-fetch-with-cli = true\\n' > /cargo-cache/config.toml`,
        ]);
    }

    ctr = ctr.withMountedDirectory("/src", source).withWorkdir("/src");

    // Set build environment variables
    if (buildEnv) {
      for (const pair of buildEnv.split(",")) {
        const eqIdx = pair.indexOf("=");
        if (eqIdx > 0) {
          const key = pair.slice(0, eqIdx);
          const value = pair.slice(eqIdx + 1);
          ctr = ctr.withEnvVariable(key, value);
        }
      }
    }

    // Setup workspace manifest if specified
    if (workspaceManifest) {
      ctr = ctr
        .withExec([
          SHELL,
          "-c",
          [
            "mkdir -p /tmp/cargo-build-workspace",
            `cp /src/${workspaceManifest} /tmp/cargo-build-workspace/Cargo.toml`,
            "cp /src/Cargo.lock /tmp/cargo-build-workspace/Cargo.lock",
            "ln -sf /src/packages /tmp/cargo-build-workspace/packages",
            "ln -sf /src/crates /tmp/cargo-build-workspace/crates",
          ].join(" && "),
        ])
        .withWorkdir("/tmp/cargo-build-workspace");
    }

    // Build cargo flags
    const targetList = targets.split(",").map((t) => t.trim());
    const cargoFlags = targetList.map((t) => (binFlags ? `--bin ${t}` : `-p ${t}`)).join(" ");

    ctr = ctr.withExec([SHELL, "-c", `cargo build --release ${cargoFlags}`]);

    // Copy binaries to output directory
    const outputDir = `/src/.production/binaries/${cacheId}`;
    ctr = ctr.withExec(["mkdir", "-p", outputDir]);
    for (const target of targetList) {
      const targetPath = `${outputDir}/${target}`;
      ctr = ctr
        .withExec(["cp", `/cargo-cache/target/release/${target}`, targetPath])
        .withExec(["chmod", "+x", targetPath]);
    }

    return ctr.directory("/src");
  }
}

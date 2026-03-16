import { dag, type Directory, func, object, type Secret, type Service } from "@dagger.io/dagger";

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
    let ctr = dag
      .container()
      .from(buildImage)
      .withMountedDirectory("/src", source)
      .withWorkdir("/src")
      // Persistent cargo cache volumes
      .withMountedCache("/cargo-cache/registry", dag.cacheVolume(`cargo-registry-${cacheId}`))
      .withMountedCache("/cargo-cache/git", dag.cacheVolume(`cargo-git-${cacheId}`))
      .withMountedCache("/cargo-cache/target", dag.cacheVolume(`cargo-target-${cacheId}`))
      .withEnvVariable("CARGO_HOME", "/cargo-cache")
      .withEnvVariable("CARGO_TARGET_DIR", "/cargo-cache/target");

    // Bind database service for sqlx compile-time verification
    if (dbService) {
      ctr = ctr.withServiceBinding(dbHostname, dbService);
    }

    // Install system packages (auto-detect Alpine vs Debian by image name)
    if (extraPackages) {
      const pkgs = extraPackages.split(/\s+/).filter(Boolean);
      const isAlpine = buildImage.includes("alpine");
      if (isAlpine) {
        ctr = ctr.withExec(["apk", "add", "--no-cache", ...pkgs]);
      } else {
        ctr = ctr.withExec([
          "sh",
          "-c",
          `apt-get update && apt-get install -y --no-install-recommends ${pkgs.join(" ")} && rm -rf /var/lib/apt/lists/*`,
        ]);
      }
    }

    // Setup SSH for private git dependencies
    if (sshKey) {
      const isAlpine = buildImage.includes("alpine");
      if (isAlpine) {
        ctr = ctr.withExec(["apk", "add", "--no-cache", "git", "git-lfs", "openssh-client"]);
      } else {
        ctr = ctr.withExec([
          "sh",
          "-c",
          "apt-get update && apt-get install -y --no-install-recommends git git-lfs openssh-client && rm -rf /var/lib/apt/lists/*",
        ]);
      }
      ctr = ctr.withExec(["git", "lfs", "install"]);

      const sshPortStr = String(sshPort);
      const sshCmd =
        sshPort === 22
          ? "ssh -i /root/.ssh/id_rsa -o StrictHostKeyChecking=accept-new"
          : `ssh -p ${sshPortStr} -i /root/.ssh/id_rsa -o StrictHostKeyChecking=accept-new`;

      ctr = ctr
        .withMountedSecret("/root/.ssh/id_rsa", sshKey, { mode: 0o400 })
        .withExec([
          "sh",
          "-c",
          `ssh-keyscan -p ${sshPortStr} ${sshHost} >> /root/.ssh/known_hosts 2>/dev/null || true`,
        ])
        .withEnvVariable("GIT_SSH_COMMAND", sshCmd)
        // Tell cargo to use system git (which has SSH access)
        .withExec([
          "sh",
          "-c",
          `mkdir -p /cargo-cache && printf '[net]\\ngit-fetch-with-cli = true\\n' > /cargo-cache/config.toml`,
        ]);
    }

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
          "sh",
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

    ctr = ctr.withExec(["sh", "-c", `cargo build --release ${cargoFlags}`]);

    // Copy binaries to output directory
    const outputDir = `/src/.production/binaries/${cacheId}`;
    const copyCommands = targetList.map(
      (t) =>
        `mkdir -p ${outputDir} && cp /cargo-cache/target/release/${t} ${outputDir}/${t} && chmod +x ${outputDir}/${t}`,
    );
    ctr = ctr.withExec(["sh", "-c", copyCommands.join(" && ")]);

    return ctr.directory("/src");
  }
}

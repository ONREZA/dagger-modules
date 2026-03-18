import {
  dag,
  type Container,
  type Directory,
  type Secret,
  type Socket,
  func,
  object,
} from "@dagger.io/dagger";

/**
 * Extract hostname from an SSH-style Git URL.
 *
 * Handles both scp-like (`git@host:path`) and protocol
 * (`ssh://[user@]host[:port]/path`) formats.
 * Returns empty string if the URL doesn't match either format.
 */
function extractSshHost(url: string): string {
  const proto = url.match(/^ssh:\/\/(?:[^@]+@)?([^:/]+)/);
  if (proto) return proto[1];
  const scp = url.match(/^(?:[^@]+@)?([^:]+):/);
  if (scp) return scp[1];
  return "";
}

/** Check if a Git URL uses SSH transport. */
function isSshUrl(url: string): boolean {
  return url.startsWith("ssh://") || /^[^/]+@[^:]+:/.test(url);
}

/**
 * Full-featured Git module with SSH key support, custom host configuration,
 * and common Git operations.
 *
 * Complements Dagger's built-in `dag.git()` with direct SSH private key
 * support, custom SSH ports, and a complete set of Git operations for
 * CI/CD pipelines.
 */
@object()
export class GitTools {
  /** Base container image for Git operations */
  gitImage: string;
  /** Git user.name for commits */
  userName: string;
  /** Git user.email for commits */
  userEmail: string;

  constructor(
    /** Base container image for Git operations */
    gitImage: string = "alpine:3.21",
    /** Git user.name for commits */
    userName: string = "Dagger",
    /** Git user.email for commits */
    userEmail: string = "dagger@localhost",
  ) {
    if (!gitImage) throw new Error("gitImage must not be empty");
    this.gitImage = gitImage;
    this.userName = userName;
    this.userEmail = userEmail;
  }

  // ── Private helpers ─────────────────────────────────────────────────

  /** Create a base container with git, openssh, and lfs installed. */
  private base(): Container {
    return dag
      .container()
      .from(this.gitImage)
      .withExec(["apk", "add", "--no-cache", "git", "openssh-client", "git-lfs"])
      .withExec(["git", "lfs", "install"])
      .withExec(["git", "config", "--global", "user.name", this.userName])
      .withExec(["git", "config", "--global", "user.email", this.userEmail])
      .withExec(["git", "config", "--global", "init.defaultBranch", "main"]);
  }

  /**
   * Configure SSH key, known_hosts, and GIT_SSH_COMMAND on a container.
   *
   * When knownHosts is empty and host is empty, no host verification is
   * configured; StrictHostKeyChecking=accept-new provides TOFU semantics.
   */
  private withSsh(
    ctr: Container,
    sshKey: Secret,
    port: number,
    knownHosts: string | undefined,
    host: string,
  ): Container {
    if (port < 1 || port > 65535) throw new Error(`Invalid SSH port: ${port}`);
    const p = String(port);

    ctr = ctr
      .withExec(["mkdir", "-p", "/root/.ssh"])
      .withMountedSecret("/root/.ssh/id_rsa", sshKey, { mode: 0o400 });

    if (knownHosts) {
      ctr = ctr
        .withEnvVariable("__KNOWN_HOSTS", knownHosts)
        .withExec(["sh", "-c", 'printf "%s\\n" "$__KNOWN_HOSTS" > /root/.ssh/known_hosts'])
        .withoutEnvVariable("__KNOWN_HOSTS");
    } else if (host) {
      ctr = ctr
        .withEnvVariable("__KEYSCAN_HOST", host)
        .withExec([
          "sh",
          "-c",
          `ssh-keyscan -p ${p} "$__KEYSCAN_HOST" >> /root/.ssh/known_hosts`,
        ])
        .withoutEnvVariable("__KEYSCAN_HOST");
    }

    const sshCmd =
      port === 22
        ? "ssh -i /root/.ssh/id_rsa -o StrictHostKeyChecking=accept-new"
        : `ssh -p ${p} -i /root/.ssh/id_rsa -o StrictHostKeyChecking=accept-new`;

    return ctr.withEnvVariable("GIT_SSH_COMMAND", sshCmd);
  }

  /**
   * Extract SSH host from the named git remote's URL and run keyscan.
   * Silently skips if the remote has no URL or URL is not SSH.
   */
  private withAutoKeyscan(ctr: Container, remote: string, port: number): Container {
    return ctr.withExec([
      "sh",
      "-c",
      `RURL=$(git remote get-url "${remote}" 2>/dev/null || true); `
        + `HOST=$(echo "$RURL" | sed -nE 's/.*@([^:/]+).*/\\1/p'); `
        + `if [ -n "$HOST" ]; then ssh-keyscan -p ${port} "$HOST" >> /root/.ssh/known_hosts; fi`,
    ]);
  }

  // ── Repository setup ────────────────────────────────────────────────

  // NOTE: SSH parameters (sshKey, sshPort, knownHosts, sshHost) are repeated
  // across clone/container/push/fetch because the Dagger TypeScript SDK does
  // not support custom input object types for function parameters.

  /**
   * Clone a remote Git repository.
   *
   * Supports three authentication methods:
   * - **SSH key** (direct private key as Secret) — for private repos in CI/CD
   * - **SSH auth socket** — forwards host SSH agent ($SSH_AUTH_SOCK)
   * - **HTTP token** — for HTTPS repos with token-based auth
   *
   * For SSH keys, custom ports and known_hosts are fully supported.
   * The `ref` parameter accepts branch and tag names when using SSH key auth;
   * when using dag.git() (SSH socket / HTTP), it also accepts commit SHAs
   * and fully-qualified refs.
   */
  @func({ cache: "never" })
  async clone(
    /** Repository URL (SSH or HTTPS) */
    url: string,
    /** Git reference — branch or tag name (SSH key); also commit SHA (dag.git path) */
    ref: string = "main",
    /** SSH private key for authentication */
    sshKey?: Secret,
    /** SSH auth socket (alternative to sshKey, e.g., host $SSH_AUTH_SOCK) */
    sshAuthSocket?: Socket,
    /** HTTP auth token for HTTPS repositories */
    httpAuthToken?: Secret,
    /** HTTP auth username (used with httpAuthToken, e.g., "x-access-token" for GitHub) */
    httpAuthUsername: string = "",
    /** SSH port for custom Git hosts (default: 22) */
    sshPort: number = 22,
    /** Custom known_hosts content (skips ssh-keyscan when provided) */
    knownHosts?: string,
    /** Clone depth (0 = full history) */
    depth: number = 0,
    /** Keep .git directory in output (required for subsequent commit/push/tag operations) */
    keepGitDir: boolean = true,
  ): Promise<Directory> {
    // sshKey requires an SSH URL — fail explicitly on mismatch
    if (sshKey && !isSshUrl(url)) {
      throw new Error(
        `sshKey was provided but the URL "${url}" is not an SSH URL. `
          + "Use httpAuthToken for HTTPS repositories, or change the URL to SSH format.",
      );
    }

    // SSH key auth → container-based clone (dag.git() doesn't support raw keys)
    if (sshKey && isSshUrl(url)) {
      const host = extractSshHost(url);
      if (!host && !knownHosts) {
        throw new Error(
          `Could not extract SSH hostname from URL "${url}". `
            + "Provide knownHosts explicitly or use a standard SSH URL format "
            + "(git@host:path or ssh://user@host/path).",
        );
      }

      let ctr = this.base();
      ctr = this.withSsh(ctr, sshKey, sshPort, knownHosts, host);

      const args = ["git", "clone"];
      if (depth > 0) args.push("--depth", String(depth));
      args.push("--branch", ref, url, "/repo");

      ctr = ctr.withExec(args);

      let dir = ctr.directory("/repo");
      if (!keepGitDir) dir = dir.withoutDirectory(".git");
      return dir;
    }

    // All other cases (SSH socket, HTTP auth, or public repos) → delegate to dag.git()
    const gitOpts: {
      sshAuthSocket?: Socket;
      sshKnownHosts?: string;
      httpAuthToken?: Secret;
      httpAuthUsername?: string;
    } = {};
    if (sshAuthSocket) gitOpts.sshAuthSocket = sshAuthSocket;
    if (knownHosts) gitOpts.sshKnownHosts = knownHosts;
    if (httpAuthToken) {
      gitOpts.httpAuthToken = httpAuthToken;
      if (httpAuthUsername) gitOpts.httpAuthUsername = httpAuthUsername;
    }

    const treeOpts: { discardGitDir?: boolean; depth?: number } = {};
    if (!keepGitDir) treeOpts.discardGitDir = true;
    if (depth > 0) treeOpts.depth = depth;

    const hasGitOpts = Object.keys(gitOpts).length > 0;
    return dag.git(url, hasGitOpts ? gitOpts : undefined).ref(ref).tree(treeOpts);
  }

  /**
   * Initialize a new Git repository in the source directory.
   */
  @func()
  async init(
    /** Source directory */
    source: Directory,
    /** Initial branch name */
    initialBranch: string = "main",
  ): Promise<Directory> {
    return this.base()
      .withMountedDirectory("/src", source)
      .withWorkdir("/src")
      .withExec(["git", "init", "--initial-branch", initialBranch])
      .directory("/src");
  }

  /**
   * Get a container with Git and SSH fully configured.
   *
   * Source is mounted at /src. Use for custom Git operations
   * not covered by other methods.
   */
  @func()
  container(
    /** Source directory (mounted at /src) */
    source: Directory,
    /** SSH private key for remote operations */
    sshKey?: Secret,
    /** SSH port (default: 22) */
    sshPort: number = 22,
    /** Custom known_hosts content */
    knownHosts?: string,
    /** SSH host for keyscan (required when sshKey is set and knownHosts is not) */
    sshHost: string = "",
  ): Container {
    let ctr = this.base()
      .withMountedDirectory("/src", source)
      .withWorkdir("/src");

    if (sshKey) {
      ctr = this.withSsh(ctr, sshKey, sshPort, knownHosts, sshHost);
    }

    return ctr;
  }

  // ── Remote management ───────────────────────────────────────────────

  /**
   * Add a new remote.
   */
  @func()
  async remoteAdd(
    /** Source directory with .git */
    source: Directory,
    /** Remote name (e.g., "origin") */
    name: string,
    /** Remote URL */
    url: string,
  ): Promise<Directory> {
    return this.base()
      .withMountedDirectory("/src", source)
      .withWorkdir("/src")
      .withExec(["git", "remote", "add", name, url])
      .directory("/src");
  }

  /**
   * Change URL of an existing remote.
   */
  @func()
  async remoteSetUrl(
    /** Source directory with .git */
    source: Directory,
    /** Remote name */
    name: string,
    /** New remote URL */
    url: string,
  ): Promise<Directory> {
    return this.base()
      .withMountedDirectory("/src", source)
      .withWorkdir("/src")
      .withExec(["git", "remote", "set-url", name, url])
      .directory("/src");
  }

  // ── Branch operations ───────────────────────────────────────────────

  /**
   * Create and checkout a new branch.
   */
  @func()
  async branch(
    /** Source directory with .git */
    source: Directory,
    /** New branch name */
    name: string,
  ): Promise<Directory> {
    return this.base()
      .withMountedDirectory("/src", source)
      .withWorkdir("/src")
      .withExec(["git", "checkout", "-b", name])
      .directory("/src");
  }

  /**
   * Checkout an existing ref (branch, tag, or commit).
   */
  @func()
  async checkout(
    /** Source directory with .git */
    source: Directory,
    /** Ref to checkout */
    ref: string,
  ): Promise<Directory> {
    return this.base()
      .withMountedDirectory("/src", source)
      .withWorkdir("/src")
      .withExec(["git", "checkout", ref])
      .directory("/src");
  }

  /**
   * Merge a ref into the current branch.
   */
  @func()
  async merge(
    /** Source directory with .git */
    source: Directory,
    /** Ref to merge */
    ref: string,
    /** Merge commit message */
    message: string = "",
    /** Create a merge commit even for fast-forward merges */
    noFf: boolean = false,
  ): Promise<Directory> {
    const args = ["git", "merge"];
    if (noFf) args.push("--no-ff");
    if (message) args.push("-m", message);
    args.push(ref);

    return this.base()
      .withMountedDirectory("/src", source)
      .withWorkdir("/src")
      .withExec(args)
      .directory("/src");
  }

  // ── Commit operations ───────────────────────────────────────────────

  /**
   * Stage and commit changes.
   */
  @func()
  async commit(
    /** Source directory with .git */
    source: Directory,
    /** Commit message */
    message: string,
    /** Path or glob to stage — passed directly to `git add` (default: "." = all changes) */
    add: string = ".",
    /** Allow empty commits */
    allowEmpty: boolean = false,
  ): Promise<Directory> {
    const args = ["git", "commit", "-m", message];
    if (allowEmpty) args.push("--allow-empty");

    return this.base()
      .withMountedDirectory("/src", source)
      .withWorkdir("/src")
      .withExec(["git", "add", add])
      .withExec(args)
      .directory("/src");
  }

  /**
   * Create a Git tag.
   */
  @func()
  async tag(
    /** Source directory with .git */
    source: Directory,
    /** Tag name */
    name: string,
    /** Annotation message (empty = lightweight tag) */
    message: string = "",
  ): Promise<Directory> {
    let ctr = this.base()
      .withMountedDirectory("/src", source)
      .withWorkdir("/src");

    if (message) {
      ctr = ctr.withExec(["git", "tag", "-a", name, "-m", message]);
    } else {
      ctr = ctr.withExec(["git", "tag", name]);
    }

    return ctr.directory("/src");
  }

  // ── Remote sync ─────────────────────────────────────────────────────

  /**
   * Push refs to a remote repository.
   */
  @func({ cache: "never" })
  async push(
    /** Source directory with .git */
    source: Directory,
    /** Remote name */
    remote: string = "origin",
    /** Refs to push (e.g., "main", "--tags", "v1.0.0"). Empty = current branch */
    refs: string = "",
    /** SSH private key for authentication */
    sshKey?: Secret,
    /** SSH port (default: 22) */
    sshPort: number = 22,
    /** Custom known_hosts content */
    knownHosts?: string,
    /** SSH host for keyscan (auto-detected from remote URL when empty) */
    sshHost: string = "",
  ): Promise<string> {
    let ctr = this.base()
      .withMountedDirectory("/src", source)
      .withWorkdir("/src");

    if (sshKey) {
      ctr = this.withSsh(ctr, sshKey, sshPort, knownHosts, sshHost);
      if (!sshHost && !knownHosts) {
        ctr = this.withAutoKeyscan(ctr, remote, sshPort);
      }
    }

    const args = ["git", "push", remote];
    if (refs) args.push(...refs.split(/\s+/).filter(Boolean));

    const result = ctr.withExec(args);
    const [out, err] = await Promise.all([result.stdout(), result.stderr()]);
    return (out + err).trim();
  }

  /**
   * Fetch from a remote repository.
   */
  @func({ cache: "never" })
  async fetch(
    /** Source directory with .git */
    source: Directory,
    /** Remote name */
    remote: string = "origin",
    /** Refspec to fetch (empty = default) */
    refspec: string = "",
    /** SSH private key for authentication */
    sshKey?: Secret,
    /** SSH port (default: 22) */
    sshPort: number = 22,
    /** Custom known_hosts content */
    knownHosts?: string,
    /** SSH host for keyscan */
    sshHost: string = "",
  ): Promise<Directory> {
    let ctr = this.base()
      .withMountedDirectory("/src", source)
      .withWorkdir("/src");

    if (sshKey) {
      ctr = this.withSsh(ctr, sshKey, sshPort, knownHosts, sshHost);
      if (!sshHost && !knownHosts) {
        ctr = this.withAutoKeyscan(ctr, remote, sshPort);
      }
    }

    const args = ["git", "fetch", remote];
    if (refspec) args.push(...refspec.split(/\s+/).filter(Boolean));

    return ctr.withExec(args).directory("/src");
  }

  // ── Info ────────────────────────────────────────────────────────────

  /**
   * Show diff output.
   */
  @func()
  async diff(
    /** Source directory with .git */
    source: Directory,
    /** Base ref */
    base: string = "",
    /** Head ref */
    head: string = "",
    /** Show staged changes (--cached) */
    cached: boolean = false,
  ): Promise<string> {
    const args = ["git", "diff"];
    if (cached) args.push("--cached");
    if (base) args.push(base);
    if (head) args.push(head);

    return this.base()
      .withMountedDirectory("/src", source)
      .withWorkdir("/src")
      .withExec(args)
      .stdout();
  }

  /**
   * Show commit log.
   */
  @func()
  async log(
    /** Source directory with .git */
    source: Directory,
    /** Maximum number of commits */
    maxCount: number = 10,
    /** Custom format string (e.g., "%H %s") */
    format: string = "",
    /** Ref or range (e.g., "main..HEAD") */
    ref: string = "",
  ): Promise<string> {
    const args = ["git", "log", `--max-count=${maxCount}`];
    if (format) args.push(`--format=${format}`);
    if (ref) args.push(ref);

    return this.base()
      .withMountedDirectory("/src", source)
      .withWorkdir("/src")
      .withExec(args)
      .stdout();
  }

  /**
   * Show working tree status.
   */
  @func()
  async status(
    /** Source directory with .git */
    source: Directory,
    /** Use short format */
    short: boolean = false,
  ): Promise<string> {
    const args = ["git", "status"];
    if (short) args.push("--short");

    return this.base()
      .withMountedDirectory("/src", source)
      .withWorkdir("/src")
      .withExec(args)
      .stdout();
  }

  /**
   * Show details of a commit or object.
   */
  @func()
  async show(
    /** Source directory with .git */
    source: Directory,
    /** Object to show (default: HEAD) */
    ref: string = "HEAD",
    /** Custom format string */
    format: string = "",
    /** Suppress diff output (show only commit info) */
    noPatch: boolean = false,
  ): Promise<string> {
    const args = ["git", "show"];
    if (format) args.push(`--format=${format}`);
    if (noPatch) args.push("--no-patch");
    args.push(ref);

    return this.base()
      .withMountedDirectory("/src", source)
      .withWorkdir("/src")
      .withExec(args)
      .stdout();
  }

  /**
   * Resolve a revision to its commit hash.
   */
  @func()
  async revParse(
    /** Source directory with .git */
    source: Directory,
    /** Revision to resolve (default: HEAD) */
    rev: string = "HEAD",
    /** Return short hash */
    short: boolean = false,
  ): Promise<string> {
    const args = ["git", "rev-parse"];
    if (short) args.push("--short");
    args.push(rev);

    const out = await this.base()
      .withMountedDirectory("/src", source)
      .withWorkdir("/src")
      .withExec(args)
      .stdout();

    return out.trim();
  }
}

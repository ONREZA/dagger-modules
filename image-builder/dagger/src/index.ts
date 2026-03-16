import { dag, type Directory, func, object, type Secret } from "@dagger.io/dagger";

/**
 * Generic Docker image build and registry push module.
 *
 * Builds Docker images from a Dockerfile and publishes them to any
 * container registry. Supports build arguments, organization namespacing,
 * and dockerconfigjson-based authentication.
 */
@object()
export class ImageBuilder {
  /** Docker registry URL (e.g., "ghcr.io", "docker.io", "registry.example.com") */
  registry: string;

  constructor(
    /** Docker registry URL (e.g., "ghcr.io", "docker.io", "registry.example.com") */
    registry: string = "",
  ) {
    this.registry = registry;
  }

  /**
   * Build a Docker image and push to registry.
   *
   * Builds using the specified Dockerfile, tags the image as
   * `{registry}/{organization}/{name}:{tag}`, and pushes it. Returns the
   * full image reference including the digest.
   *
   * @param source - Source directory containing the Dockerfile
   * @param name - Image name (e.g., "my-service")
   * @param dockerfile - Path to Dockerfile relative to source root
   * @param tag - Image tag
   * @param registryAuth - Docker registry auth (dockerconfigjson format)
   * @param organization - Registry organization/namespace (e.g., "my-org")
   * @param buildArgs - Comma-separated build args (e.g., "KEY1=VAL1,KEY2=VAL2")
   * @returns Full image reference with digest
   */
  @func()
  async buildAndPublish(
    source: Directory,
    name: string,
    dockerfile: string,
    tag: string,
    registryAuth: Secret,
    organization: string = "",
    buildArgs: string = "",
  ): Promise<string> {
    const orgPrefix = organization ? `${organization}/` : "";
    const imageRef = `${this.registry}/${orgPrefix}${name}:${tag}`;

    const args: Record<string, string> = {};
    if (buildArgs) {
      for (const pair of buildArgs.split(",")) {
        const eqIdx = pair.indexOf("=");
        if (eqIdx > 0) {
          args[pair.slice(0, eqIdx)] = pair.slice(eqIdx + 1);
        }
      }
    }

    const { username, password } = await this.getRegistryCredentials(registryAuth);

    const ref = await source
      .dockerBuild({
        dockerfile,
        buildArgs: Object.entries(args).map(([n, value]) => ({ name: n, value })),
      })
      .withRegistryAuth(this.registry, username, password)
      .publish(imageRef);

    return ref;
  }

  private cachedCredentials: { username: string; password: Secret } | null = null;

  private async getRegistryCredentials(registryAuth: Secret): Promise<{ username: string; password: Secret }> {
    if (this.cachedCredentials) {
      return this.cachedCredentials;
    }

    const ctr = dag
      .container()
      .from("alpine:3.21")
      .withExec(["apk", "add", "--no-cache", "jq"])
      .withMountedSecret("/tmp/config.json", registryAuth);

    const username = (
      await ctr
        .withExec(["sh", "-c", `jq -r '.auths["${this.registry}"].auth' /tmp/config.json | base64 -d | cut -d: -f1`])
        .stdout()
    ).trim();

    const passwordPlaintext = (
      await ctr
        .withExec(["sh", "-c", `jq -r '.auths["${this.registry}"].auth' /tmp/config.json | base64 -d | cut -d: -f2-`])
        .stdout()
    ).trim();

    this.cachedCredentials = {
      username,
      password: dag.setSecret(`${this.registry}-password`, passwordPlaintext),
    };

    return this.cachedCredentials;
  }
}

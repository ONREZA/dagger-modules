import { type Directory, func, object, type Secret } from "@dagger.io/dagger";

/**
 * Generic Docker image build and registry push module.
 */
@object()
export class ImageBuilder {
  /** Docker registry URL (e.g., "ghcr.io", "docker.io", "registry.example.com") */
  registry: string;

  constructor(
    /** Docker registry URL */
    registry: string = "",
  ) {
    this.registry = registry;
  }

  /**
   * Build a Docker image and push to registry.
   */
  @func()
  async buildAndPublish(
    source: Directory,
    name: string,
    dockerfile: string,
    tag: string,
    registryUsername: string,
    registryPassword: Secret,
    organization: string = "",
    buildArgs: string = "",
  ): Promise<string> {
    const org = organization || "";
    const orgPrefix = org ? `${org}/` : "";
    const imageRef = `${this.registry}/${orgPrefix}${name}:${tag}`;

    const parsedArgs: { name: string; value: string }[] = [];
    if (buildArgs) {
      for (const pair of buildArgs.split(",")) {
        const eqIdx = pair.indexOf("=");
        if (eqIdx > 0) {
          parsedArgs.push({ name: pair.slice(0, eqIdx), value: pair.slice(eqIdx + 1) });
        }
      }
    }

    const buildOpts: { dockerfile: string; buildArgs?: { name: string; value: string }[] } = { dockerfile };
    if (parsedArgs.length > 0) {
      buildOpts.buildArgs = parsedArgs;
    }

    const ref = await source
      .dockerBuild(buildOpts)
      .withRegistryAuth(this.registry, registryUsername, registryPassword)
      .publish(imageRef);

    return ref;
  }
}

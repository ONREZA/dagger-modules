import { type Container, type Directory, func, object, type Secret } from "@dagger.io/dagger";

function parseBuildArgs(buildArgs: string): { name: string; value: string }[] {
  const parsed: { name: string; value: string }[] = [];
  for (const pair of buildArgs.split(",").filter(Boolean)) {
    const eqIdx = pair.indexOf("=");
    if (eqIdx < 1) throw new Error(`Invalid Docker build argument: ${pair}`);
    parsed.push({ name: pair.slice(0, eqIdx), value: pair.slice(eqIdx + 1) });
  }
  return parsed;
}

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
   * Build a Docker image without publishing it.
   *
   * Keeping the build as a pure function lets Dagger evaluate independent
   * images in parallel and reuse the resulting Container across destinations.
   */
  @func()
  build(source: Directory, dockerfile: string, buildArgs: string = ""): Container {
    const parsedArgs = parseBuildArgs(buildArgs);
    const buildOpts: { dockerfile: string; buildArgs?: { name: string; value: string }[] } = { dockerfile };
    if (parsedArgs.length > 0) {
      buildOpts.buildArgs = parsedArgs;
    }
    return source.dockerBuild(buildOpts);
  }

  /** Publish an already-built image to the configured registry. */
  @func({ cache: "never" })
  async publish(
    image: Container,
    name: string,
    tag: string,
    registryUsername: string,
    registryPassword: Secret,
    organization: string = "",
  ): Promise<string> {
    if (!this.registry.trim()) throw new Error("registry is required to publish an image");
    const orgPrefix = organization ? `${organization}/` : "";
    const imageRef = `${this.registry}/${orgPrefix}${name}:${tag}`;

    return image.withRegistryAuth(this.registry, registryUsername, registryPassword).publish(imageRef);
  }

  /** Build and publish in one call for backward compatibility. */
  @func({ cache: "never" })
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
    return this.publish(
      this.build(source, dockerfile, buildArgs),
      name,
      tag,
      registryUsername,
      registryPassword,
      organization,
    );
  }
}

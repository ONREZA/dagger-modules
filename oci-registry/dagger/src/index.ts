import {
  type Container,
  dag,
  type Directory,
  type File,
  func,
  object,
  type Secret,
} from "@dagger.io/dagger";
import {
  assertPushReference,
  canonicalReference,
  normalizeRegistry,
  parseReference,
} from "./registry-reference.js";
import {
  retryPolicy,
  retryRegistryOperation,
} from "./registry-retry.js";

const CRANE_IMAGE = "gcr.io/go-containerregistry/crane:debug@sha256:22de5fee4326edae01a568c5a53b69c755901c5f5aa1c06a7c907bef18937356";
const ORAS_IMAGE = "ghcr.io/oras-project/oras:v1.2.3@sha256:63266a046d1cf5ebebb1461733ed7548148f122e0d422096e177cfa70b521cb1";
const DOCKER_CONFIG_PATH = "/root/.docker/config.json";

type DockerConfigAuthEntry = {
  auth?: unknown;
  username?: unknown;
  password?: unknown;
};

type RegistryCredentials = {
  username: string;
  password: string;
};

type ArtifactLayer = {
  digest: string;
  mediaType: string;
};

const DIRECTORY_LAYER_COMPRESSION = new Map<string, "gzip" | "tar">([
  ["application/vnd.oci.image.layer.v1.tar+gzip", "gzip"],
  ["application/vnd.cncf.flux.content.v1.tar+gzip", "gzip"],
  ["application/vnd.oci.image.layer.v1.tar", "tar"],
]);

function dockerConfigHost(key: string): string {
  const trimmed = key.trim().replace(/\/+$/, "");
  if (trimmed.includes("://")) {
    try {
      return new URL(trimmed).host;
    } catch {
      return "";
    }
  }
  return trimmed.split("/")[0] ?? "";
}

function registryAliases(registry: string): Set<string> {
  const aliases = new Set([registry]);
  if (
    registry === "docker.io"
    || registry === "index.docker.io"
    || registry === "registry-1.docker.io"
  ) {
    aliases.add("docker.io");
    aliases.add("index.docker.io");
    aliases.add("registry-1.docker.io");
  }
  return aliases;
}

export function parseDockerConfigCredentials(
  raw: string,
  registry: string,
): RegistryCredentials {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("invalid dockerconfigjson: expected JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("invalid dockerconfigjson: expected an object");
  }

  const auths = (parsed as { auths?: unknown }).auths;
  if (typeof auths !== "object" || auths === null || Array.isArray(auths)) {
    throw new Error("invalid dockerconfigjson: auths must be an object");
  }

  const host = normalizeRegistry(registry);
  const aliases = registryAliases(host);
  const matching = Object.entries(auths as Record<string, unknown>)
    .find(([key]) => aliases.has(dockerConfigHost(key)))?.[1];
  if (typeof matching !== "object" || matching === null || Array.isArray(matching)) {
    throw new Error(`dockerconfigjson has no auth for ${host}`);
  }

  const entry = matching as DockerConfigAuthEntry;
  let username = "";
  let password = "";
  if (typeof entry.auth === "string" && entry.auth.trim() !== "") {
    let decoded = "";
    try {
      decoded = atob(entry.auth.trim());
    } catch {
      throw new Error(`dockerconfigjson has invalid base64 auth for ${host}`);
    }
    const separator = decoded.indexOf(":");
    if (separator >= 0) {
      username = decoded.slice(0, separator);
      password = decoded.slice(separator + 1);
    }
  } else if (
    typeof entry.username === "string"
    && typeof entry.password === "string"
  ) {
    username = entry.username;
    password = entry.password;
  }

  if (username === "" || password === "") {
    throw new Error(`dockerconfigjson has incomplete auth for ${host}`);
  }
  return { username, password };
}

function normalizedAnnotations(value: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("annotationsJson must be valid JSON");
  }
  if (
    typeof parsed !== "object"
    || parsed === null
    || Array.isArray(parsed)
    || Object.values(parsed).some((annotation) => typeof annotation !== "string")
  ) {
    throw new Error("annotationsJson must be an object with string values");
  }
  if (Object.keys(parsed).length === 0) {
    return "{}";
  }
  return JSON.stringify({ $manifest: parsed });
}

function validateMediaType(value: string, field: string): string {
  const normalized = value.trim();
  if (!/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i.test(normalized)) {
    throw new Error(`${field} must be a valid media type`);
  }
  return normalized;
}

export function parseArtifactLayers(raw: string): ArtifactLayer[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("registry returned an invalid OCI manifest");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("registry returned an invalid OCI manifest");
  }
  const layers = (parsed as { layers?: unknown }).layers;
  if (!Array.isArray(layers) || layers.length === 0) {
    throw new Error("OCI artifact manifest has no layers");
  }
  return layers.map((layer, index) => {
    if (typeof layer !== "object" || layer === null || Array.isArray(layer)) {
      throw new Error(`OCI artifact layer ${index} is invalid`);
    }
    const descriptor = layer as { digest?: unknown; mediaType?: unknown };
    if (
      typeof descriptor.digest !== "string"
      || !/^[a-z][a-z0-9_+.-]*:[a-f0-9]{32,}$/i.test(descriptor.digest)
    ) {
      throw new Error(`OCI artifact layer ${index} has an invalid digest`);
    }
    if (
      typeof descriptor.mediaType !== "string"
      || !DIRECTORY_LAYER_COMPRESSION.has(descriptor.mediaType)
    ) {
      throw new Error(
        `OCI artifact layer ${index} has unsupported media type `
        + `${JSON.stringify(descriptor.mediaType)}`,
      );
    }
    return {
      digest: descriptor.digest.toLowerCase(),
      mediaType: descriptor.mediaType,
    };
  });
}

/**
 * Atomic, retry-aware OCI Distribution operations.
 */
@object()
export class OciRegistry {
  private readonly retryCount: number;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;

  constructor(
    /** Number of retries after the initial attempt. */
    retryCount = 3,
    /** Initial exponential-backoff delay in milliseconds. */
    baseDelayMs = 5_000,
    /** Maximum exponential-backoff delay in milliseconds. */
    maxDelayMs = 30_000,
  ) {
    const policy = retryPolicy(retryCount, baseDelayMs, maxDelayMs);
    this.retryCount = policy.retryCount;
    this.baseDelayMs = policy.baseDelayMs;
    this.maxDelayMs = policy.maxDelayMs;
  }

  private crane(registryAuth: Secret, attempt: number): Container {
    return dag
      .container()
      .from(CRANE_IMAGE)
      .withUser("root")
      .withMountedSecret(DOCKER_CONFIG_PATH, registryAuth, { mode: 0o400 })
      .withEnvVariable("_OCI_REGISTRY_ATTEMPT", String(attempt));
  }

  private oras(registryAuth: Secret, attempt: number): Container {
    return dag
      .container()
      .from(ORAS_IMAGE)
      .withEntrypoint([])
      .withUser("root")
      .withMountedSecret(DOCKER_CONFIG_PATH, registryAuth, { mode: 0o400 })
      .withEnvVariable("_OCI_REGISTRY_ATTEMPT", String(attempt));
  }

  private retry<T>(
    description: string,
    operation: (attempt: number) => Promise<T>,
    retryNotFound = false,
  ): Promise<T> {
    return retryRegistryOperation(
      description,
      operation,
      {
        retryCount: this.retryCount,
        baseDelayMs: this.baseDelayMs,
        maxDelayMs: this.maxDelayMs,
      },
      retryNotFound,
    );
  }

  /**
   * Build a dockerconfigjson Secret from explicit registry credentials.
   */
  @func()
  async authConfig(
    registry: string,
    username: string,
    password: Secret,
  ): Promise<Secret> {
    const host = normalizeRegistry(registry);
    if (username.trim() === "") {
      throw new Error("username must not be empty");
    }
    const plaintext = await password.plaintext();
    if (plaintext === "") {
      throw new Error("password must not be empty");
    }
    return dag.setSecret(
      `oci-registry-auth-${host.replace(/[^a-zA-Z0-9_-]/g, "-")}`,
      JSON.stringify({
        auths: {
          [host]: {
            username,
            password: plaintext,
          },
        },
      }),
    );
  }

  /**
   * Publish one Container to a tagged OCI reference.
   */
  @func({ cache: "never" })
  async publishImage(
    image: Container,
    reference: string,
    registryAuth: Secret,
  ): Promise<string> {
    const parsed = assertPushReference(reference);
    const credentials = parseDockerConfigCredentials(
      await registryAuth.plaintext(),
      parsed.registry,
    );
    const password = dag.setSecret(
      `oci-registry-password-${parsed.registry.replace(/[^a-zA-Z0-9_-]/g, "-")}`,
      credentials.password,
    );
    const authenticated = image.withRegistryAuth(
      parsed.registry,
      credentials.username,
      password,
    );
    return this.retry(
      `publish image ${parsed.reference}`,
      () => authenticated.publish(parsed.reference),
    );
  }

  /**
   * Pull and materialize one image as a Container.
   */
  @func({ cache: "never" })
  async pullImage(
    reference: string,
    registryAuth: Secret,
  ): Promise<Container> {
    const parsed = parseReference(reference);
    const credentials = parseDockerConfigCredentials(
      await registryAuth.plaintext(),
      parsed.registry,
    );
    const password = dag.setSecret(
      `oci-registry-password-${parsed.registry.replace(/[^a-zA-Z0-9_-]/g, "-")}`,
      credentials.password,
    );
    return this.retry(`pull image ${parsed.reference}`, async () => {
      const image = dag
        .container()
        .withRegistryAuth(parsed.registry, credentials.username, password)
        .from(parsed.reference);
      await image.sync();
      return image;
    });
  }

  /**
   * Resolve a tag or digest reference to its sha256 digest.
   */
  @func({ cache: "never" })
  async resolveDigest(
    reference: string,
    registryAuth: Secret,
  ): Promise<string> {
    const parsed = parseReference(reference);
    const digest = (
      await this.retry(`resolve digest ${parsed.reference}`, (attempt) =>
        this.crane(registryAuth, attempt)
          .withExec(["crane", "digest", parsed.reference])
          .stdout())
    ).trim().toLowerCase();
    if (!/^sha256:[a-f0-9]{64}$/.test(digest)) {
      throw new Error(`registry returned invalid digest for ${parsed.reference}`);
    }
    return digest;
  }

  /**
   * Read the raw OCI manifest JSON for a reference.
   */
  @func({ cache: "never" })
  async readManifest(
    reference: string,
    registryAuth: Secret,
  ): Promise<string> {
    const parsed = parseReference(reference);
    const raw = (
      await this.retry(`read manifest ${parsed.reference}`, (attempt) =>
        this.crane(registryAuth, attempt)
          .withExec(["crane", "manifest", parsed.reference])
          .stdout())
    ).trim();
    JSON.parse(raw);
    return raw;
  }

  /**
   * Read the raw image config JSON for a reference.
   */
  @func({ cache: "never" })
  async readConfig(
    reference: string,
    registryAuth: Secret,
  ): Promise<string> {
    const parsed = parseReference(reference);
    const raw = (
      await this.retry(`read config ${parsed.reference}`, (attempt) =>
        this.crane(registryAuth, attempt)
          .withExec(["crane", "config", parsed.reference])
          .stdout())
    ).trim();
    JSON.parse(raw);
    return raw;
  }

  /**
   * List repository tags.
   */
  @func({ cache: "never" })
  async listTags(
    repository: string,
    registryAuth: Secret,
  ): Promise<string[]> {
    const parsed = parseReference(repository, true);
    const raw = await this.retry(
      `list tags ${parsed.reference}`,
      (attempt) =>
        this.crane(registryAuth, attempt)
          .withExec(["crane", "ls", parsed.reference])
          .stdout(),
    );
    return raw.split(/\s+/).filter(Boolean);
  }

  /**
   * Verify that a manifest and every referenced remote blob are readable.
   */
  @func({ cache: "never" })
  async validateLayers(
    reference: string,
    registryAuth: Secret,
    retryNotFound = false,
  ): Promise<string> {
    const parsed = parseReference(reference);
    await this.retry(
      `validate layers ${parsed.reference}`,
      (attempt) =>
        this.crane(registryAuth, attempt)
          .withExec(["crane", "validate", "--remote", parsed.reference])
          .sync(),
      retryNotFound,
    );
    return `PASS: ${parsed.reference}`;
  }

  /**
   * Copy one OCI manifest and all referenced blobs to a tagged destination.
   */
  @func({ cache: "never" })
  async copy(
    source: string,
    destination: string,
    registryAuth: Secret,
  ): Promise<string> {
    const sourceRef = parseReference(source);
    const destinationRef = assertPushReference(destination);
    await this.retry(
      `copy ${sourceRef.reference} to ${destinationRef.reference}`,
      (attempt) =>
        this.crane(registryAuth, attempt)
          .withExec(["crane", "cp", sourceRef.reference, destinationRef.reference])
          .sync(),
    );
    return destinationRef.reference;
  }

  /**
   * Push one Directory as a single OCI artifact layer.
   */
  @func({ cache: "never" })
  async pushArtifact(
    content: Directory,
    reference: string,
    registryAuth: Secret,
    artifactType = "",
    layerMediaType = "application/vnd.oci.image.layer.v1.tar+gzip",
    imageSpec = "v1.1",
    annotationsJson = "{}",
  ): Promise<string> {
    const parsed = assertPushReference(reference);
    if (artifactType !== "") {
      validateMediaType(artifactType, "artifactType");
    }
    const normalizedLayerType = validateMediaType(layerMediaType, "layerMediaType");
    if (imageSpec !== "v1.0" && imageSpec !== "v1.1") {
      throw new Error("imageSpec must be v1.0 or v1.1");
    }
    const annotations = normalizedAnnotations(annotationsJson);

    const digest = (
      await this.retry(`push OCI artifact ${parsed.reference}`, (attempt) => {
        const args = [
          "/bin/oras",
          "push",
          "--registry-config",
          DOCKER_CONFIG_PATH,
          "--no-tty",
          "--image-spec",
          imageSpec,
          "--format",
          "go-template={{.digest}}",
        ];
        if (artifactType !== "") {
          args.push("--artifact-type", artifactType);
        }
        if (annotations !== "{}") {
          args.push("--annotation-file", "/workspace/annotations.json");
        }
        args.push(parsed.reference, `.:${normalizedLayerType}`);
        return this.oras(registryAuth, attempt)
          .withDirectory("/workspace/content", content)
          .withNewFile("/workspace/annotations.json", annotations)
          .withWorkdir("/workspace/content")
          .withExec(args)
          .stdout();
      })
    ).trim().toLowerCase();

    return canonicalReference(parsed.reference, digest);
  }

  /**
   * Pull one directory artifact and return its extracted content.
   */
  @func({ cache: "never" })
  async pullArtifact(
    reference: string,
    registryAuth: Secret,
  ): Promise<Directory> {
    const parsed = parseReference(reference);
    const layers = parseArtifactLayers(
      await this.readManifest(parsed.reference, registryAuth),
    );
    let output = dag.directory();

    for (const [index, layer] of layers.entries()) {
      const path = `/workspace/layers/${index}.tar`;
      const blobReference = `${parsed.registry}/${parsed.repository}@${layer.digest}`;
      const archive = await this.retry<File>(
        `pull OCI artifact layer ${layer.digest}`,
        async (attempt) => {
          const container = this.oras(registryAuth, attempt)
            .withExec(["mkdir", "-p", "/workspace/layers"])
            .withExec([
              "/bin/oras",
              "blob",
              "fetch",
              "--registry-config",
              DOCKER_CONFIG_PATH,
              "--no-tty",
              "--output",
              path,
              blobReference,
            ]);
          await container.sync();
          return container.file(path);
        },
      );
      const compression = DIRECTORY_LAYER_COMPRESSION.get(layer.mediaType);
      const tarFlag = compression === "gzip" ? "-xzf" : "-xf";
      output = dag
        .container()
        .from(ORAS_IMAGE)
        .withEntrypoint([])
        .withDirectory("/workspace/output", output)
        .withFile(path, archive)
        .withExec([
          "tar",
          tarFlag,
          path,
          "-C",
          "/workspace/output",
          "--no-same-owner",
        ])
        .directory("/workspace/output");
    }

    return output;
  }
}

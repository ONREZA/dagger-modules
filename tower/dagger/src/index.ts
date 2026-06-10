import { func, object } from "@dagger.io/dagger";

const RELEASE_SCHEMA = "tower.release.v1";
const CONTRACT_PREFIX = `${RELEASE_SCHEMA}: `;
const ARTIFACT_KINDS = new Set(["oci_bundle", "image", "manifest", "metadata", "other"]);

type JsonObject = Record<string, unknown>;

type ReleaseArtifact = {
  kind: string;
  name: string;
  ref: string;
  digest?: string;
  metadata_json?: JsonObject;
};

type ReleaseContract = {
  schema: typeof RELEASE_SCHEMA;
  source_commit?: string;
  source_ref?: string;
  promoted_from_release_id?: string;
  git_tag?: string;
  metadata_json?: JsonObject;
  artifacts: ReleaseArtifact[];
};

function optional(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function parseJson(value: string, field: string): unknown {
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new Error(`${field} must be valid JSON: ${String(error)}`);
  }
}

function parseObjectJson(value: string, field: string): JsonObject {
  const trimmed = value.trim();
  if (trimmed === "") {
    return {};
  }
  const parsed = parseJson(trimmed, field);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${field} must be a JSON object`);
  }
  return parsed as JsonObject;
}

function digestFromRef(ref: string): string | undefined {
  const marker = "@sha256:";
  const index = ref.lastIndexOf(marker);
  if (index < 0) {
    return undefined;
  }
  return ref.slice(index + 1);
}

function normalizeArtifact(
  kind: string,
  name: string,
  ref: string,
  digest = "",
  metadataJson = "{}",
): ReleaseArtifact {
  const normalizedKind = kind.trim();
  if (!ARTIFACT_KINDS.has(normalizedKind)) {
    throw new Error(
      `artifact kind ${JSON.stringify(kind)} is unsupported: expected ${[...ARTIFACT_KINDS].join(", ")}`,
    );
  }

  const normalizedName = name.trim();
  if (normalizedName === "") {
    throw new Error("artifact name must not be empty");
  }

  const normalizedRef = ref.trim();
  if (normalizedRef === "") {
    throw new Error("artifact ref must not be empty");
  }

  const metadata = parseObjectJson(metadataJson, "metadataJson");
  const normalizedDigest = optional(digest) ?? digestFromRef(normalizedRef);

  return {
    kind: normalizedKind,
    name: normalizedName,
    ref: normalizedRef,
    ...(normalizedDigest ? { digest: normalizedDigest } : {}),
    ...(Object.keys(metadata).length > 0 ? { metadata_json: metadata } : {}),
  };
}

function parseArtifactJson(value: string, field: string): ReleaseArtifact {
  const parsed = parseJson(value, field);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${field} must be a JSON object`);
  }
  const artifact = parsed as Partial<ReleaseArtifact>;
  return normalizeArtifact(
    String(artifact.kind ?? ""),
    String(artifact.name ?? ""),
    String(artifact.ref ?? ""),
    String(artifact.digest ?? ""),
    JSON.stringify(artifact.metadata_json ?? {}),
  );
}

function parseArtifactsJson(value: string, allowEmpty = false): ReleaseArtifact[] {
  const parsed = parseJson(value, "artifactsJson");
  if (!Array.isArray(parsed)) {
    throw new Error("artifactsJson must be a JSON array");
  }
  const artifacts = parsed.map((entry, index) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`artifactsJson[${index}] must be a JSON object`);
    }
    const artifact = entry as Partial<ReleaseArtifact>;
    return normalizeArtifact(
      String(artifact.kind ?? ""),
      String(artifact.name ?? ""),
      String(artifact.ref ?? ""),
      String(artifact.digest ?? ""),
      JSON.stringify(artifact.metadata_json ?? {}),
    );
  });
  if (!allowEmpty && artifacts.length === 0) {
    throw new Error("artifactsJson must contain at least one artifact");
  }
  return artifacts;
}

function buildReleaseContract(
  artifactsJson: string,
  sourceCommit = "",
  sourceRef = "",
  promotedFromReleaseId = "",
  gitTag = "",
  metadataJson = "{}",
): ReleaseContract {
  const metadata = parseObjectJson(metadataJson, "metadataJson");
  const sourceCommitValue = optional(sourceCommit);
  const sourceRefValue = optional(sourceRef);
  const promotedFromReleaseIdValue = optional(promotedFromReleaseId);
  const gitTagValue = optional(gitTag);
  return {
    schema: RELEASE_SCHEMA,
    ...(sourceCommitValue ? { source_commit: sourceCommitValue } : {}),
    ...(sourceRefValue ? { source_ref: sourceRefValue } : {}),
    ...(promotedFromReleaseIdValue ? { promoted_from_release_id: promotedFromReleaseIdValue } : {}),
    ...(gitTagValue ? { git_tag: gitTagValue } : {}),
    ...(Object.keys(metadata).length > 0 ? { metadata_json: metadata } : {}),
    artifacts: parseArtifactsJson(artifactsJson),
  };
}

/**
 * Generic helpers for Dagger pipelines orchestrated by Tower.
 *
 * The module intentionally does not build or deploy anything. It only provides
 * stable primitives for Dagger modules to emit Tower's machine-readable
 * release contract.
 */
@object()
export class Tower {
  /**
   * Build one release artifact JSON object.
   */
  @func()
  artifact(kind: string, name: string, ref: string, digest = "", metadataJson = "{}"): string {
    return JSON.stringify(normalizeArtifact(kind, name, ref, digest, metadataJson));
  }

  /**
   * Build an OCI release bundle artifact JSON object.
   */
  @func()
  ociBundle(name: string, ref: string, digest = "", metadataJson = "{}"): string {
    return this.artifact("oci_bundle", name, ref, digest, metadataJson);
  }

  /**
   * Build an image artifact JSON object.
   */
  @func()
  image(name: string, ref: string, digest = "", metadataJson = "{}"): string {
    return this.artifact("image", name, ref, digest, metadataJson);
  }

  /**
   * Append an artifact object to an artifacts JSON array.
   */
  @func()
  appendArtifact(artifactsJson: string, artifactJson: string): string {
    const artifacts = parseArtifactsJson(artifactsJson, true);
    artifacts.push(parseArtifactJson(artifactJson, "artifactJson"));
    return JSON.stringify(artifacts);
  }

  /**
   * Build a Tower release contract JSON object.
   */
  @func()
  release(
    artifactsJson: string,
    sourceCommit = "",
    sourceRef = "",
    promotedFromReleaseId = "",
    gitTag = "",
    metadataJson = "{}",
  ): string {
    return JSON.stringify(
      buildReleaseContract(artifactsJson, sourceCommit, sourceRef, promotedFromReleaseId, gitTag, metadataJson),
    );
  }

  /**
   * Build the stdout line parsed by Tower after a release Dagger step.
   */
  @func()
  emitRelease(
    artifactsJson: string,
    sourceCommit = "",
    sourceRef = "",
    promotedFromReleaseId = "",
    gitTag = "",
    metadataJson = "{}",
  ): string {
    return `${CONTRACT_PREFIX}${this.release(
      artifactsJson,
      sourceCommit,
      sourceRef,
      promotedFromReleaseId,
      gitTag,
      metadataJson,
    )}`;
  }
}

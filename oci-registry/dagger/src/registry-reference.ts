export type ParsedReference = {
  reference: string;
  registry: string;
  repository: string;
  tag?: string;
  digest?: string;
};

const REPOSITORY_SEGMENT = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
const TAG = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;
const DIGEST = /^[A-Za-z][A-Za-z0-9_+.-]*:[A-Fa-f0-9]{32,}$/;

export function normalizeRegistry(registry: string): string {
  const normalized = registry.trim().replace(/^oci:\/\//, "");
  if (
    normalized === ""
    || normalized.includes("/")
    || normalized.includes("@")
    || /\s/.test(normalized)
  ) {
    throw new Error("registry must be an explicit OCI registry host");
  }
  return normalized;
}

export function parseReference(
  value: string,
  repositoryOnly = false,
): ParsedReference {
  const reference = value.trim().replace(/^oci:\/\//, "");
  if (
    reference === ""
    || reference.includes("://")
    || reference.includes(",")
    || /[\s?#]/.test(reference)
  ) {
    throw new Error(`invalid OCI reference ${JSON.stringify(value)}`);
  }

  const firstSlash = reference.indexOf("/");
  if (firstSlash < 1 || firstSlash === reference.length - 1) {
    throw new Error(`OCI reference ${JSON.stringify(value)} must include registry and repository`);
  }

  const registry = normalizeRegistry(reference.slice(0, firstSlash));
  const pathAndReference = reference.slice(firstSlash + 1);
  const at = pathAndReference.lastIndexOf("@");
  const colon = pathAndReference.lastIndexOf(":");
  let repository = pathAndReference;
  let tag: string | undefined;
  let digest: string | undefined;

  if (at >= 0) {
    repository = pathAndReference.slice(0, at);
    digest = pathAndReference.slice(at + 1);
    if (!DIGEST.test(digest)) {
      throw new Error(`OCI reference ${JSON.stringify(value)} has an invalid digest`);
    }
  } else if (colon > pathAndReference.lastIndexOf("/")) {
    repository = pathAndReference.slice(0, colon);
    tag = pathAndReference.slice(colon + 1);
    if (!TAG.test(tag)) {
      throw new Error(`OCI reference ${JSON.stringify(value)} has an invalid tag`);
    }
  }

  if (
    repository === ""
    || repository.split("/").some((segment) => !REPOSITORY_SEGMENT.test(segment))
  ) {
    throw new Error(`OCI reference ${JSON.stringify(value)} has an invalid repository`);
  }
  if (!repositoryOnly && tag === undefined && digest === undefined) {
    throw new Error(`OCI reference ${JSON.stringify(value)} must include a tag or digest`);
  }
  if (repositoryOnly && (tag !== undefined || digest !== undefined)) {
    throw new Error(`OCI repository ${JSON.stringify(value)} must not include a tag or digest`);
  }

  return { reference, registry, repository, tag, digest };
}

export function canonicalReference(reference: string, digest: string): string {
  const parsed = parseReference(reference);
  if (!/^sha256:[a-f0-9]{64}$/.test(digest)) {
    throw new Error(`registry returned invalid digest for ${parsed.reference}`);
  }
  return `${parsed.registry}/${parsed.repository}@${digest}`;
}

export function assertPushReference(value: string): ParsedReference {
  const parsed = parseReference(value);
  if (parsed.tag === undefined) {
    throw new Error(`push destination ${JSON.stringify(value)} must use a tag`);
  }
  return parsed;
}

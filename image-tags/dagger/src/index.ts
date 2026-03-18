import { dag, func, object, type Secret } from "@dagger.io/dagger";

const MC_IMAGE = "minio/mc:RELEASE.2025-01-17T23-25-50Z";

/**
 * S3-backed image tag state management.
 *
 * Stores per-environment image tag mappings as JSON files in an S3 bucket
 * using the MinIO client. Provides read, write, merge, and validation
 * operations for managing which image tags are deployed per service.
 */
@object()
export class ImageTags {
  /** S3 endpoint URL (e.g., "https://s3.example.com") */
  s3Endpoint: string;
  /** S3 bucket name for storing tag state files */
  s3Bucket: string;

  constructor(
    /** S3 endpoint URL (e.g., "https://s3.example.com") */
    s3Endpoint: string = "",
    /** S3 bucket name for storing tag state files */
    s3Bucket: string = "artifacts",
  ) {
    this.s3Endpoint = s3Endpoint;
    this.s3Bucket = s3Bucket;
  }

  /**
   * Read current image tags from S3 state file.
   *
   * Returns the JSON content of `image-tags/{environment}.json` from the
   * configured S3 bucket. Returns `"{}"` if the file doesn't exist yet.
   *
   * @param environment - Environment name (used as filename: image-tags/{environment}.json)
   * @param s3AccessKey - S3 access key
   * @param s3SecretKey - S3 secret key
   */
  @func({ cache: "never" })
  async read(environment: string, s3AccessKey: Secret, s3SecretKey: Secret): Promise<string> {
    const s3Path = `s3/${this.s3Bucket}/image-tags/${environment}.json`;

    const raw = await dag
      .container()
      .from(MC_IMAGE)
      .withSecretVariable("S3_ACCESS_KEY", s3AccessKey)
      .withSecretVariable("S3_SECRET_KEY", s3SecretKey)
      .withExec(["sh", "-c", `mc alias set s3 "${this.s3Endpoint}" "$S3_ACCESS_KEY" "$S3_SECRET_KEY"`])
      .withExec(["sh", "-c", `mc cat "${s3Path}" 2>/dev/null || echo "{}"`])
      .stdout();

    return raw.trim();
  }

  /**
   * Write updated image tags to S3 state file.
   *
   * Writes the given JSON string to `image-tags/{environment}.json` in the
   * configured S3 bucket, overwriting any existing content.
   *
   * @param environment - Environment name
   * @param tagsJson - JSON string of image tags to write
   * @param s3AccessKey - S3 access key
   * @param s3SecretKey - S3 secret key
   */
  @func({ cache: "never" })
  async write(
    environment: string,
    tagsJson: string,
    s3AccessKey: Secret,
    s3SecretKey: Secret,
  ): Promise<void> {
    const s3Path = `s3/${this.s3Bucket}/image-tags/${environment}.json`;

    await dag
      .container()
      .from(MC_IMAGE)
      .withSecretVariable("S3_ACCESS_KEY", s3AccessKey)
      .withSecretVariable("S3_SECRET_KEY", s3SecretKey)
      .withExec(["sh", "-c", `mc alias set s3 "${this.s3Endpoint}" "$S3_ACCESS_KEY" "$S3_SECRET_KEY"`])
      .withNewFile("/tmp/image-tags.json", tagsJson)
      .withExec(["mc", "cp", "/tmp/image-tags.json", s3Path])
      .sync();
  }

  /**
   * Merge current tags with new tags for changed services.
   *
   * Takes the current state, a map of which services changed, and produces
   * a merged result where changed services get their new tag while unchanged
   * services keep their existing tag.
   *
   * @param currentTagsJson - Current state JSON (from read())
   * @param changedServicesJson - JSON object of {serviceName: true/false}
   * @param servicesJson - JSON array of {name, imageTag} where imageTag is a tag category key (e.g., "frontend", "universal")
   * @param frontendTag - Tag for services with imageTag="frontend" (e.g., "s-20260302-abcd1234")
   * @param universalTag - Tag for services with imageTag="universal" (e.g., "u-20260302-abcd1234")
   * @returns Merged tags JSON
   */
  @func()
  merge(
    currentTagsJson: string,
    changedServicesJson: string,
    servicesJson: string,
    frontendTag: string,
    universalTag: string,
  ): string {
    const current = JSON.parse(currentTagsJson) as Record<string, string>;
    const changed = JSON.parse(changedServicesJson) as Record<string, boolean>;
    const services = JSON.parse(servicesJson) as Array<{ name: string; imageTag: string }>;

    const merged = { ...current };

    for (const svc of services) {
      if (!changed[svc.name]) continue;
      merged[svc.name] = svc.imageTag === "frontend" ? frontendTag : universalTag;
    }

    return JSON.stringify(merged, null, 2);
  }

  /**
   * Validate that all services have tags.
   *
   * Checks that every service name in the provided list has a corresponding
   * tag in the tags JSON. Throws an error listing any missing services.
   *
   * @param tagsJson - Current tags JSON
   * @param serviceNamesJson - JSON array of service name strings
   */
  @func()
  validate(tagsJson: string, serviceNamesJson: string): string {
    const tags = JSON.parse(tagsJson) as Record<string, string>;
    const names = JSON.parse(serviceNamesJson) as string[];

    const missing = names.filter((name) => !tags[name]);
    if (missing.length > 0) {
      throw new Error(
        `Missing image tags for: ${missing.join(", ")}. Run pipeline with forceAll=true to bootstrap.`,
      );
    }

    return "OK";
  }
}

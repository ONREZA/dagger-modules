import { describe, expect, test } from "bun:test";
import { parseArtifactLayers } from "../src/index.js";

describe("artifact manifest", () => {
  test("accepts OCI and legacy Flux directory layers", () => {
    const digest = `sha256:${"a".repeat(64)}`;
    expect(parseArtifactLayers(JSON.stringify({
      layers: [
        {
          digest,
          mediaType: "application/vnd.oci.image.layer.v1.tar+gzip",
        },
        {
          digest,
          mediaType: "application/vnd.cncf.flux.content.v1.tar+gzip",
        },
      ],
    }))).toEqual([
      {
        digest,
        mediaType: "application/vnd.oci.image.layer.v1.tar+gzip",
      },
      {
        digest,
        mediaType: "application/vnd.cncf.flux.content.v1.tar+gzip",
      },
    ]);
  });

  test("rejects unsupported artifact layers", () => {
    expect(() => parseArtifactLayers(JSON.stringify({
      layers: [{
        digest: `sha256:${"b".repeat(64)}`,
        mediaType: "application/octet-stream",
      }],
    }))).toThrow("unsupported media type");
  });
});

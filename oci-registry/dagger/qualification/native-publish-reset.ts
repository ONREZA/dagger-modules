// Explicit qualification, outside normal gates:
// systemd-run --user --scope --collect --property=Slice=build.slice --property=OOMPolicy=kill -- \
//   dagger run -- bun oci-registry/dagger/qualification/native-publish-reset.ts
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { connect } from "../sdk/index.ts";
import { isImageUploadRangeError, retryPolicy, retryRegistryOperation } from "../src/registry-retry.ts";
import { digest, uploadResetRegistry } from "./upload-reset-registry.ts";

const directory = await mkdtemp("/var/tmp/oci-publish-reset-");
try {
  await connect(async (dag) => {
    const image = dag.container()
      .withNewFile("/qualification.txt", "frozen upload qualification bytes")
      .withLabel("org.opencontainers.image.revision", "upload-reset-qualification")
      .withAnnotation("org.opencontainers.image.description", "upload-reset-qualification")
      .withEnvVariable("QUALIFICATION", "preserved")
      .withUser("1234:1234")
      .withWorkdir("/qualification")
      .withDefaultArgs(["/qualification.txt"]);

    // The archive is evidence only; both publishes use the original native image.
    await image.asTarball().export(join(directory, "image.tar"));
    const extraction = Bun.spawn(["tar", "-xf", join(directory, "image.tar"), "-C", directory]);
    assert.equal(await extraction.exited, 0);
    const index = JSON.parse(await readFile(join(directory, "index.json"), "utf8"));
    assert.equal(index.manifests.length, 1);
    const blobPath = (hash: string) => join(directory, "blobs", ...hash.split(":"));
    const expectedManifest = await readFile(blobPath(index.manifests[0].digest));
    const manifest = JSON.parse(expectedManifest.toString());
    const expectedConfig = await readFile(blobPath(manifest.config.digest));
    const config = JSON.parse(expectedConfig.toString());
    assert.equal(config.config.Labels["org.opencontainers.image.revision"], "upload-reset-qualification");
    assert.equal(config.config.User, "1234:1234");
    assert.ok(config.config.Env.includes("QUALIFICATION=preserved"));
    assert.ok(config.architecture && config.os);
    assert.equal(manifest.annotations["org.opencontainers.image.description"], "upload-reset-qualification");
    assert.ok(manifest.layers.some((layer: { mediaType: string }) => layer.mediaType.endsWith("+gzip")));

    for (const [failure, recover] of [
      ["range", false], ["range", true],
      ["unknown", false], ["unknown", true],
    ] as const) {
      const fixture = uploadResetRegistry(failure);
      try {
        const registry = dag.address(`tcp://127.0.0.1:${fixture.server.port}`).service();
        const reference = `localhost:${fixture.server.port}/qualification:reset`;
        let calls = 0;
        const publish = () => retryRegistryOperation("publish qualification image", async () => {
          calls++;
          return image.publish(reference, { registryService: registry });
        }, retryPolicy(1, 1, 1), false, {
          retryWhen: recover ? isImageUploadRangeError : undefined,
          sleep: async () => {},
          warn: () => {},
        });
        if (!recover) {
          await assert.rejects(publish, (error: unknown) => isImageUploadRangeError(error));
          assert.equal(calls, 1);
          assert.equal(fixture.manifests.size, 0);
        } else {
          const published = await publish();
          assert.equal(calls, 2);
          const readback = await fetch(`http://127.0.0.1:${fixture.server.port}/v2/qualification/manifests/reset`);
          assert.equal(readback.status, 200);
          assert.equal(readback.headers.get("Docker-Content-Digest"), digest(expectedManifest));
          assert.deepEqual(Buffer.from(await readback.arrayBuffer()), expectedManifest);
          assert.ok(published.endsWith(`@${digest(expectedManifest)}`));
          for (const descriptor of [manifest.config, ...manifest.layers]) {
            const response = await fetch(`http://127.0.0.1:${fixture.server.port}/v2/qualification/blobs/${descriptor.digest}`);
            assert.equal(response.status, 200);
            const bytes = Buffer.from(await response.arrayBuffer());
            assert.deepEqual(bytes, await readFile(blobPath(descriptor.digest)));
            assert.equal(digest(bytes!), descriptor.digest);
            assert.equal(bytes!.length, descriptor.size);
          }
        }
        const failed = fixture.events.find((event) => event.status === (failure === "range" ? 500 : 404));
        assert.ok(failed);
        const terminalStatus = failure === "range" ? 416 : 404;
        assert.ok(fixture.events.some((event) => event.status === terminalStatus && event.session === failed.session));
        const rejected = fixture.events.findIndex((event) => event.status === terminalStatus);
        if (recover) {
          const fresh = fixture.events.slice(rejected + 1).find((event) => event.method === "POST");
          assert.ok(fresh && fresh.session !== failed.session);
          assert.ok(fixture.events.some((event) => event.status === 201 && event.session === fresh.session));
        } else {
          assert.ok(!fixture.events.slice(rejected + 1).some((event) => event.method === "POST"));
        }
        console.log(JSON.stringify({
          result: recover ? "GREEN: fresh upload session, exact manifest/config/compressed layers/platform/annotations" : "RED: no fresh upload recovery policy",
          failure,
          calls,
          digest: digest(expectedManifest),
          events: fixture.events,
        }));
      } finally {
        await fixture.server.stop(true);
      }
    }
  });
} finally {
  await rm(directory, { recursive: true, force: true });
}

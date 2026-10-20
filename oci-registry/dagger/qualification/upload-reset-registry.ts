// Explicit faults: reject a stale offset after 500, or forget a received upload with 404.
export function uploadResetRegistry(failure: "range" | "unknown" = "range") {
  const blobs = new Map<string, Buffer>();
  const manifests = new Map<string, Buffer>();
  const uploads = new Map<string, number>();
  const events: { method: string; session?: string; status: number; length?: number }[] = [];
  let failedSession: string | undefined;
  let counter = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const headers = { "Docker-Distribution-Api-Version": "registry/2.0" };
      const blob = url.pathname.match(/\/blobs\/(sha256:[a-f0-9]+)$/)?.[1];
      const manifest = url.pathname.match(/\/manifests\/([^/]+)$/)?.[1];
      const session = url.pathname.match(/\/uploads\/(\d+)$/)?.[1];
      if (url.pathname === "/v2/") return new Response(null, { headers });
      if (blob) {
        const bytes = blobs.get(blob);
        return new Response(req.method === "HEAD" ? null : bytes, {
          status: bytes ? 200 : 404,
          headers: { ...headers, ...(bytes ? { "Content-Length": String(bytes.length), "Docker-Content-Digest": blob } : {}) },
        });
      }
      if (req.method === "POST" && url.pathname.endsWith("/uploads/")) {
        const id = String(++counter);
        uploads.set(id, 0);
        events.push({ method: "POST", session: id, status: 202 });
        return new Response(null, { status: 202, headers: { ...headers, Location: `/v2/qualification/blobs/uploads/${id}?offset=0`, Range: "0-0" } });
      }
      if (req.method === "PUT" && session) {
        const offset = uploads.get(session);
        const unknownUpload = () => new Response(JSON.stringify({ errors: [{
          code: "BLOB_UPLOAD_UNKNOWN", message: "blob upload unknown to registry",
        }] }), { status: 404, headers });
        if (offset === undefined) return unknownUpload();
        if (Number(url.searchParams.get("offset")) !== offset) {
          events.push({ method: "PUT", session, status: 416 });
          return new Response("invalid content range", { status: 416, headers });
        }
        const bytes = Buffer.from(await req.arrayBuffer());
        uploads.set(session, bytes.length);
        if (!failedSession) {
          failedSession = session;
          if (failure === "unknown") {
            uploads.delete(session);
            events.push({ method: "PUT", session, status: 404, length: bytes.length });
            return unknownUpload();
          }
          events.push({ method: "PUT", session, status: 500, length: bytes.length });
          return new Response("injected failure after receiving bytes", { status: 500, headers });
        }
        const expected = url.searchParams.get("digest");
        if (digest(bytes) !== expected) return new Response("digest mismatch", { status: 400 });
        blobs.set(expected!, bytes);
        events.push({ method: "PUT", session, status: 201, length: bytes.length });
        return new Response(null, { status: 201, headers: { ...headers, "Docker-Content-Digest": expected! } });
      }
      if (manifest) {
        if (req.method === "PUT") {
          const bytes = Buffer.from(await req.arrayBuffer());
          const hash = digest(bytes);
          manifests.set(manifest, bytes);
          manifests.set(hash, bytes);
          return new Response(null, { status: 201, headers: { ...headers, "Docker-Content-Digest": hash } });
        }
        const bytes = manifests.get(manifest);
        return new Response(req.method === "HEAD" ? null : bytes, {
          status: bytes ? 200 : 404,
          headers: { ...headers, ...(bytes ? { "Content-Length": String(bytes.length), "Docker-Content-Digest": digest(bytes), "Content-Type": "application/vnd.oci.image.manifest.v1+json" } : {}) },
        });
      }
      return new Response(null, { status: 404 });
    },
  });
  return { server, blobs, manifests, events };
}

export const digest = (bytes: Uint8Array) =>
  `sha256:${new Bun.CryptoHasher("sha256").update(bytes).digest("hex")}`;

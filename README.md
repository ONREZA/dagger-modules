# Dagger Modules

Reusable [Dagger](https://dagger.io/) modules for CI/CD pipelines. Generic building blocks — not tied to any specific project.

Built with the **TypeScript SDK** and the Dagger **Node** runtime. The
`bun-builder` module runs Bun inside build containers for Bun-based projects.

## Modules

| Module | Description |
|--------|-------------|
| [`bun-builder`](#bun-builder) | Bun dependency install, frontend builds, standalone binary compilation |
| [`cargo-builder`](#cargo-builder) | Rust/Cargo builds with persistent caching, SSH deps, workspace manifests |
| [`oci-registry`](#oci-registry) | Atomic OCI image and artifact transport with retry policy |
| [`image-builder`](#image-builder) | Docker image build + registry push with auth extraction |
| [`change-detector`](#change-detector) | Git-diff change detection with glob patterns and dependency propagation |
| [`tower`](#tower) | Tower release and workflow contract builders for Dagger pipelines |

## Requirements

- [Dagger CLI](https://docs.dagger.io/install/) v0.21.7+
- Docker (for the Dagger engine)

## Usage

Each module can be used standalone via `dagger call` or composed into a larger pipeline by importing them as Dagger module dependencies.

---

### bun-builder

Install dependencies, build frontend packages, and compile standalone Bun binaries.

#### Install dependencies

```bash
dagger -m ./bun-builder call install --source=.
```

`install` filters its cache key to lockfiles and root/workspace `package.json` or
`bunfig.toml` files outside `node_modules`, then overlays the resulting install
output onto the full source.
Application-only edits therefore reuse the dependency-install layer. Composed
modules may also pass their own `CacheVolume` and `cache-sharing` mode.

#### Build a frontend package

```bash
dagger -m ./bun-builder call build \
  --source=. \
  --pkg=frontend \
  --env-vars-json='{"VITE_API_URL":"https://api.example.com"}'
```

#### Build with Sentry sourcemap upload

```bash
dagger -m ./bun-builder call build \
  --source=. \
  --pkg=frontend \
  --sentry-release=v1.2.3 \
  --sentry-token=env:SENTRY_AUTH_TOKEN
```

#### Compile a standalone binary

```bash
dagger -m ./bun-builder call build-binary \
  --source=. \
  --pkg=server
```

---

### cargo-builder

Build Rust binaries with persistent cargo cache volumes. Supports both Alpine (musl) and Debian (glibc) build images, workspace manifests, SSH private dependencies, and database service bindings for compile-time verification.

Composed modules may supply separate registry, git and target `CacheVolume`
objects. Keep target caches separate when profiles use incompatible compiler
flags; registry and git caches can normally be shared.

#### Basic build

```bash
dagger -m ./cargo-builder call build \
  --source=. \
  --build-image=rust:1.83-alpine \
  --targets=my-server \
  --cache-id=musl
```

#### Multi-target workspace build

```bash
dagger -m ./cargo-builder call build \
  --source=. \
  --build-image=rust:1.83-alpine \
  --targets="edge-server,image-optimizer" \
  --cache-id=musl \
  --workspace-manifest=packages/edge-server/Cargo.workspace.toml \
  --extra-packages="musl-dev pkgconfig openssl-dev openssl-libs-static"
```

#### Build with SSH private dependencies

```bash
dagger -m ./cargo-builder call build \
  --source=. \
  --build-image=rust:1.83 \
  --targets=my-binary \
  --cache-id=glibc \
  --ssh-key=file:~/.ssh/id_rsa \
  --ssh-host=github.com
```

#### Build with database service (sqlx compile-time checks)

```bash
dagger -m ./cargo-builder call build \
  --source=. \
  --build-image=rust:1.83 \
  --targets=my-api \
  --cache-id=glibc \
  --build-env="DATABASE_URL=postgres://user:pass@db:5432/mydb,SQLX_OFFLINE=true"
```

---

### oci-registry

Atomic OCI Distribution operations for images and directory artifacts. The
module owns authentication, transport, error classification and bounded
exponential retry with jitter. It does not own build, release, environment or
application-specific validation policy.

`retry-count` is the number of retries after the initial attempt and defaults
to `3`. Authentication and malformed-reference errors fail immediately;
timeouts, connection resets, HTTP/2 stream failures, `429` and `5xx` responses
are retried.

```bash
# Validate manifest/config integrity and remote layer existence.
dagger -m ./oci-registry call \
  --retry-count=3 \
  validate-layers \
    --reference=ghcr.io/example/app@sha256:... \
    --registry-auth=file:~/.docker/config.json

# Read an image config or resolve a tag to a digest.
dagger -m ./oci-registry call read-config \
  --reference=ghcr.io/example/app:v1 \
  --registry-auth=file:~/.docker/config.json

dagger -m ./oci-registry call resolve-digest \
  --reference=ghcr.io/example/app:v1 \
  --registry-auth=file:~/.docker/config.json
```

Composable pipelines call the concrete operations independently:

```typescript
const registry = dag.ociRegistry({ retryCount: 3 });
const published = await registry.publishImage(image, taggedRef, registryAuth);
await registry.validateLayers(published, registryAuth, {
  retryNotFound: true,
});
const config = await registry.readConfig(published, registryAuth);
```

Directory artifacts use ORAS-compatible OCI manifests and configurable media
types. `pushArtifact` returns a canonical digest reference; `pullArtifact`
returns the extracted `Directory`. Pulling reads layer descriptors directly,
so it also supports legacy Flux directory artifacts whose layers predate the
`org.opencontainers.image.title` annotation.

---

### image-builder

Build Docker images and push them to any container registry. Registry credentials are passed explicitly so the module never parses or logs dockerconfigjson secrets.

#### Build and publish

```bash
dagger -m ./image-builder call \
  --registry=ghcr.io \
  build-and-publish \
    --source=. \
    --name=my-service \
    --dockerfile=deploy/Dockerfile \
    --tag=v1.2.3 \
    --registry-username="$REGISTRY_USERNAME" \
    --registry-password=env:REGISTRY_PASSWORD \
    --organization=my-org
```

#### With build arguments

```bash
dagger -m ./image-builder call \
  --registry=docker.io \
  build-and-publish \
    --source=. \
    --name=my-app \
    --dockerfile=Dockerfile \
    --tag=latest \
    --registry-username="$REGISTRY_USERNAME" \
    --registry-password=env:REGISTRY_PASSWORD \
    --build-args="NODE_VERSION=20,ALPINE_VERSION=3.21"
```

#### Split build and publish in composed pipelines

`build` returns a pure `Container`; `publish` is marked `cache: never`. This
lets callers evaluate independent Docker builds concurrently and serialize only
registry pushes. `publish` delegates transport to `oci-registry`, which retries
transient registry/network failures three times after the initial attempt with
bounded exponential backoff and jitter. Authentication, invalid reference and
invalid manifest errors fail immediately:

```typescript
const builder = dag.imageBuilder({ registry: "ghcr.io" });
const images = services.map((service) =>
  builder.build(source, service.dockerfile, { buildArgs: service.buildArgs }),
);
await Promise.all(images.map((image) => image.sync()));
for (const [index, image] of images.entries()) {
  await builder.publish(image, services[index].name, tag, username, password, {
    organization: "my-org",
  });
}
```

---

### change-detector

Detect which services changed since the last tagged release. Uses git diff with glob-based path matching and supports cross-service dependency propagation.

#### Detect changes

```bash
dagger -m ./change-detector call detect \
  --source=. \
  --tag-prefix=v \
  --services-json='[
    {"name":"api","detectPaths":["packages/api/**"],"dependsOn":["shared"]},
    {"name":"web","detectPaths":["packages/web/**"],"dependsOn":["shared"]}
  ]' \
  --groups-json='[
    {"name":"shared","detectPaths":["packages/shared/**","prisma/**"]}
  ]'
```

**Output** (JSON):
```json
{
  "services": {"api": true, "web": false},
  "groups": {"shared": true},
  "commitSha": "abc12345...",
  "shortSha": "abc12345",
  "timestamp": "20260302-143022",
  "anyChanged": true
}
```

#### Force all services as changed

```bash
dagger -m ./change-detector call detect \
  --source=. \
  --tag-prefix=v \
  --force-all
```

#### Compare with an exact previous release commit

Pass an ancestor commit or ref through `base-ref` to avoid depending on tag
discovery. The detector rejects a ref that is not an ancestor of `HEAD`.

```bash
dagger -m ./change-detector call detect \
  --source=. \
  --tag-prefix=v \
  --base-ref=0123456789abcdef0123456789abcdef01234567 \
  --services-json='[{"name":"api","detectPaths":["packages/api/**"]}]'
```

#### Read a version file

```bash
dagger -m ./change-detector call read-version-file \
  --source=. \
  --file-path=.bun-version \
  --default-version=1.1.0
```

## Composing Modules

These modules are designed to be used together. A typical CI pipeline:

1. **change-detector** determines which services changed
2. **bun-builder** installs deps and builds frontend/binaries
3. **cargo-builder** compiles Rust services
4. **image-builder** builds Docker images
5. **oci-registry** publishes and validates OCI content
6. The release pipeline records exact image digests in its immutable OCI bundle

```typescript
// Example: using as Dagger module dependencies in your pipeline
import { dag } from "@dagger.io/dagger";

// Detect changes
const changes = await dag.changeDetector().detect(source, "v", false, servicesJson, groupsJson);
const parsed = JSON.parse(changes);

// Build what changed
if (parsed.services.api) {
  const bun = dag.container().from("oven/bun:1.3.14");
  const installed = await dag.bunBuilder().install(source, { bunContainer: bun });
  const built = await dag.bunBuilder().buildBinary(installed, "server", { bunContainer: bun });
  await dag.imageBuilder("ghcr.io").buildAndPublish(built, "api", "Dockerfile", tag, auth, "my-org");
}
```

Builder modules accept `Container` inputs rather than registry references. This
lets a caller compose a locally built base image directly into downstream build
graphs; pulling a public or private reference remains the caller's explicit
boundary.

---

### tower

Build Tower release contract lines and repo-owned workflow specs from Dagger
pipelines. The module does not build, deploy, or call Tower APIs; it emits the
generic `tower.release.v1` and `tower.workflow.v2` contracts consumed by Tower.

#### Emit a release contract line

```typescript
const artifacts = [
  JSON.parse(await dag.tower().ociBundle("release", "oci://registry.example/app:2026.0610.001")),
  JSON.parse(await dag.tower().image("api", "registry.example/app-api@sha256:...")),
];

return dag.tower().emitRelease(
  JSON.stringify(artifacts),
  {
    sourceCommit,
    sourceRef: "refs/heads/main",
    gitTag: "release-stage-20260610",
    metadataJson: JSON.stringify({ environment: "stage" }),
  },
);
```

#### Build typed workflow inputs and Dagger parameters

Use the chainable builders when generating `tower.workflow.v2` specs. JSON
Schema remains the wire contract consumed by Tower, but callers do not need to
construct or parse it by hand.

```typescript
const tower = dag.tower();

const paramsJson = await tower
  .daggerParams()
  .withInput("pg-versions", "pg_versions")
  .withInput("mode", "mode")
  .json();

const inputs = tower
  .inputSchema()
  .withChoice("pg_versions", ["v17", "v18", "v17,v18"], {
    title: "PostgreSQL versions",
    defaultValue: "v17,v18",
  })
  .withChoice("mode", ["verify", "smoke", "e2e"], {
    title: "Verification mode",
    defaultValue: "verify",
  })
  .withString("official_sha_18", {
    title: "PostgreSQL 18 commit",
    pattern: "^[0-9a-fA-F]{40}$",
  })
  .withRegistryImage(
    "compute_image_18",
    "kaiki-registry",
    "kaiki/compute-node-v18",
    {
      title: "PostgreSQL 18 compute image",
      pattern:
        "^cr\\.selcloud\\.ru/kaiki/compute-node-v18@sha256:[0-9a-f]{64}$",
    },
  });

const inputSchemaJson = await inputs.schemaJson();
const defaultInputsJson = await inputs.defaultsJson();

const stepJson = await tower.daggerStep("Verify candidate", "postgres candidate", {
  paramsJson,
});
const stepsJson = await tower.appendWorkflowStep(await tower.emptyArray(), stepJson);
return tower.workflow("postgres-candidate", "verify", stepsJson, "environment", {
  inputSchemaJson,
  defaultInputsJson,
});
```

`withInput`, `withValue`, `withSecret`, `withSecretValue`, and
`withConfigMap` cover Tower's Dagger parameter sources and delivery targets.
Input builders cover strings, registry-backed immutable images, choices,
booleans, integers, and numbers. A registry image selector names a global
registry resource and repository; it does not grant the workflow access to the
credential. Keep the matching `registry_credential` resource requirement
explicit on the Dagger step that needs it. The low-level `*Json` arguments
remain the wire-format escape hatch for API-driven contracts; Tower's
interactive UI intentionally accepts only its scalar schema subset.
Every workflow declares `target_scope`. Use `environment` for workflows launched
against stage/production, or `repository` for one repository-level maintenance
action without an environment. Repository targets require repository concurrency,
cannot use release/promote or `flux_wait`, and cannot reference
`{{environment}}`. Concurrency remains a safety lock; runner profile concurrency
limits remain capacity controls.

## Module Structure

Each module follows the same layout:

```
{module}/
├── dagger.json           # Module metadata (name, engine version, SDK)
└── dagger/
    ├── package.json      # Dependencies + Bun runtime config
    ├── tsconfig.json     # TypeScript config with Dagger SDK paths
    ├── .gitignore        # Ignores sdk/, node_modules/, .env
    └── src/
        └── index.ts      # Module implementation
```

## License

MIT

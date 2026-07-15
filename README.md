# Dagger Modules

Reusable [Dagger](https://dagger.io/) modules for CI/CD pipelines. Generic building blocks — not tied to any specific project.

Built with the **TypeScript SDK** and the **Bun** runtime.

## Modules

| Module | Description |
|--------|-------------|
| [`bun-builder`](#bun-builder) | Bun dependency install, frontend builds, standalone binary compilation |
| [`cargo-builder`](#cargo-builder) | Rust/Cargo builds with persistent caching, SSH deps, workspace manifests |
| [`image-builder`](#image-builder) | Docker image build + registry push with auth extraction |
| [`change-detector`](#change-detector) | Git-diff change detection with glob patterns and dependency propagation |
| [`image-tags`](#image-tags) | S3-backed image tag state management for deployment tracking |
| [`tower`](#tower) | Tower release contract helpers for Dagger pipelines |

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
registry pushes:

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

#### Generate CalVer version

```bash
dagger -m ./change-detector call generate-calver \
  --registry=ghcr.io \
  --repo=my-org/release-production \
  --registry-auth=file:~/.docker/config.json
# Output: v2026.0302.001
```

---

### image-tags

Manage per-environment image tag state in S3. Read, write, merge, and validate tag mappings stored as JSON files.

#### Read current tags

```bash
dagger -m ./image-tags call \
  --s3-endpoint=https://s3.example.com \
  --s3-bucket=ci-artifacts \
  read \
    --environment=production \
    --s3-access-key=env:S3_ACCESS_KEY \
    --s3-secret-key=env:S3_SECRET_KEY
```

#### Merge changed service tags

```bash
dagger -m ./image-tags call \
  --s3-endpoint=https://s3.example.com \
  merge \
    --current-tags-json='{"api":"v1.0.0","web":"v1.0.0"}' \
    --changed-services-json='{"api":true,"web":false}' \
    --services-json='[{"name":"api","imageTag":"universal"},{"name":"web","imageTag":"frontend"}]' \
    --frontend-tag=s-20260302-abc12345 \
    --universal-tag=u-20260302-abc12345
```

#### Validate all services have tags

```bash
dagger -m ./image-tags call \
  --s3-endpoint=https://s3.example.com \
  validate \
    --tags-json='{"api":"v1.0.0"}' \
    --service-names-json='["api","web"]'
# Error: Missing image tags for: web. Run pipeline with forceAll=true to bootstrap.
```

#### Write updated tags

```bash
dagger -m ./image-tags call \
  --s3-endpoint=https://s3.example.com \
  --s3-bucket=ci-artifacts \
  write \
    --environment=production \
    --tags-json='{"api":"u-20260302-abc12345","web":"s-20260302-abc12345"}' \
    --s3-access-key=env:S3_ACCESS_KEY \
    --s3-secret-key=env:S3_SECRET_KEY
```

---

## Composing Modules

These modules are designed to be used together. A typical CI pipeline:

1. **change-detector** determines which services changed
2. **bun-builder** installs deps and builds frontend/binaries
3. **cargo-builder** compiles Rust services
4. **image-builder** builds Docker images and pushes to registry
5. **image-tags** updates the deployment state in S3

```typescript
// Example: using as Dagger module dependencies in your pipeline
import { dag } from "@dagger.io/dagger";

// Detect changes
const changes = await dag.changeDetector().detect(source, "v", false, servicesJson, groupsJson);

// Build what changed
if (parsed.services.api) {
  const installed = await dag.bunBuilder().install(source);
  const built = await dag.bunBuilder().buildBinary(installed, "server");
  await dag.imageBuilder("ghcr.io").buildAndPublish(built, "api", "Dockerfile", tag, auth, "my-org");
}

// Update state
const current = await dag.imageTags("https://s3.example.com").read("production", accessKey, secretKey);
const merged = dag.imageTags("https://s3.example.com").merge(current, changedJson, servicesJson, feTag, uTag);
await dag.imageTags("https://s3.example.com").write("production", merged, accessKey, secretKey);
```

---

### tower

Build Tower release contract lines from Dagger pipelines. The module does not
build, deploy, or call Tower APIs; it only emits the generic `tower.release.v1`
stdout contract parsed by Tower after release steps.

#### Emit a release contract line

```typescript
const artifacts = [
  JSON.parse(dag.tower().ociBundle("release", "oci://registry.example/app:2026.0610.001")),
  JSON.parse(dag.tower().image("api", "registry.example/app-api@sha256:...")),
];

return dag.tower().emitRelease(
  JSON.stringify(artifacts),
  sourceCommit,
  "refs/heads/main",
  "",
  "release-stage-20260610",
  JSON.stringify({ environment: "stage" }),
);
```

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
